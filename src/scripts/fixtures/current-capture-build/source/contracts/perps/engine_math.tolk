tolk 1.5.0

import "engine_types"
import "../shared/risk/counterparty"
import "../shared/risk/exposure_cap"
import "../shared/oracle/evidence"
import "../shared/oracle/verdict"

fun px_ceil(n: int, d: int): int { return n / d + (n % d != 0 ? 1 : 0); }
fun px_clamp128(n: int): int128 { return max(-PX_SIZE_LIMIT, min(PX_SIZE_LIMIT - 1, n)) as int128; }
fun px_notional(size: int, price: int): int { return abs(size) * price / PX_PRICE_SCALE; }
fun px_params_valid(p: PxParams): bool {
    return p.depthUnit > 0 && p.oiCap <= FIRST_RELEASE_PERPS_GLOBAL_OI_CAP
        && p.impactAlpha >= 0 && p.impactAlpha <= PX_BPS && p.impactBeta >= 0 && p.impactBeta <= PX_BPS
        && p.maxLeverageBps > 0 && p.maxLeverageBps <= PX_BPS
        && p.maintenanceBps > 0 && p.maintenanceBps <= 20000
        && p.fundingCapBps > 0 && p.fundingCapBps <= 1000;
}
// Saturation precedes squaring: any nonzero integer coefficient reaches the 350 bps cap at ratio 351.
fun px_fill(params: PxParams, size: int, price: coins): int {
    val ratio = min(abs(size) * PX_PRICE_SCALE / params.depthUnit, (PX_IMPACT_CAP + 1) * PX_PRICE_SCALE);
    val linear = params.impactAlpha * ratio / PX_PRICE_SCALE;
    val square = ratio * ratio / PX_PRICE_SCALE;
    val impact = min(PX_IMPACT_CAP, linear + params.impactBeta * square / PX_PRICE_SCALE);
    return price + (size > 0 ? price * impact : -price * impact) / PX_BPS;
}
fun px_limit(size: int, price: coins, limit: coins): bool {
    return limit > 0 && (size > 0 ? price <= limit : price >= limit);
}
fun px_maintenance(params: PxParams, size: int, notional: int): int {
    val units = abs(size) / params.depthUnit;
    val initial = units <= 5 ? 800 : units <= 10 ? 1000 : 1200;
    val maintenance = min(initial, params.maintenanceBps + (units <= 5 ? 0 : units <= 10 ? 100 : 200));
    return px_ceil(notional * maintenance, PX_BPS);
}
fun px_pnl(p: PxPosition, price: coins): int128 {
    val value = abs(p.size) * price - p.entryNotional * PX_PRICE_SCALE;
    return px_clamp128((p.size > 0 ? value : -value) / PX_PRICE_SCALE);
}
// Returns unpaid funding separately so a full close remains possible after collateral exhaustion.
fun px_fund(p: PxPosition, index: int128): (PxPosition, coins, coins) {
    var next = p;
    next.lastFundingIndex = index;
    if (p.size == 0) { return (next, 0, 0); }
    val amount = p.entryNotional * (index - p.lastFundingIndex) * (p.size > 0 ? -1 : 1) / PX_BPS;
    var cp = p.counterparty.load();
    var collected: coins = 0;
    var unpaid: coins = 0;
    if (amount > 0) {
        cp.pendingFunding = min(cp.pendingFunding + amount, min(cp.reserved, cp.remainingEntitlement)) as coins;
    } else if (amount < 0) {
        val canceled = min(cp.pendingFunding, -amount) as coins;
        cp.pendingFunding -= canceled;
        cp.remainingEntitlement -= canceled;
        val debt = -amount - canceled;
        collected = min(debt, p.margin) as coins;
        unpaid = min(debt - collected, PX_COINS_LIMIT - 1) as coins;
        next.margin -= collected;
        cp.collectedLoss += collected;
    }
    next.counterparty = cp.toCell();
    return (next, collected, unpaid);
}
fun px_liquidatable(params: PxParams, p: PxPosition, price: coins, debt: coins): bool {
    val pnl = px_pnl(p, price);
    return debt > 0 || p.margin + pnl < px_maintenance(params, p.size, px_notional(p.size, price))
        || counterparty_should_liquidate(p.counterparty.load(), pnl, px_ceil(p.entryNotional * 1500, PX_BPS) as coins);
}
// Pending terms fix a price only; the position and its funding are re-read at reservation commit.
fun px_plan_open(params: PxParams, original: PxPosition, index: int128, delta: int128,
    deposit: coins, price: coins, limit: coins, leverage: uint32, feeBps: uint16, freshGen: uint64): PxPlan {
    if (!px_params_valid(params) || feeBps > PX_BPS || price <= 0 || delta == 0 || delta == -PX_SIZE_LIMIT || leverage == 0 || leverage > params.maxLeverageBps
        || (original.size != 0 && (original.size > 0) != (delta > 0))) { return px_refuse(original, PX_BAD_TERMS); }
    val sumSize = original.size + delta;
    if (abs(sumSize) >= PX_SIZE_LIMIT) { return px_refuse(original, PX_BAD_TERMS); }
    val (funded, collected, debt) = px_fund(original, index);
    if (debt != 0) { return px_refuse(original, PX_FUNDING); }
    if (original.size != 0 && px_liquidatable(params, funded, price, 0)) { return px_refuse(original, PX_LIQUIDATABLE); }
    val rawFill = px_fill(params, delta, price);
    if (rawFill <= 0 || rawFill >= PX_COINS_LIMIT) { return px_refuse(original, PX_BAD_TERMS); }
    val fill = rawFill as coins;
    if (!px_limit(delta, fill, limit)) { return px_refuse(original, PX_LIMIT); }
    val added = px_notional(delta, fill);
    val notional = original.entryNotional + added;
    if (added <= 0 || notional < MIN_PERPS_ENTRY_NOTIONAL || notional > params.oiCap) { return px_refuse(original, PX_CAP); }
    val fee = added * feeBps / PX_BPS;
    val margin = funded.margin + deposit - fee;
    val required = px_ceil(max(notional, px_notional(sumSize, price)) * PX_BPS, leverage);
    if (margin < required || margin >= PX_COINS_LIMIT) { return px_refuse(original, PX_MARGIN); }
    var next = funded;
    next.gen = original.size == 0 ? freshGen : original.gen;
    next.size = sumSize as int128;
    next.entryNotional = notional as coins;
    next.margin = margin as coins;
    var cp = next.counterparty.load();
    cp.reserved = max(cp.reserved, notional * 2) as coins;
    cp.remainingEntitlement += added as coins;
    next.counterparty = cp.toCell();
    var result = px_refuse(next, PX_OK);
    result.fee = fee as coins; result.notionalDelta = added; result.fillPrice = fill; result.fundingCollected = collected;
    return result;
}
fun px_plan_remove(params: PxParams, original: PxPosition, index: int128, amount: coins, price: coins): PxPlan {
    if (!px_params_valid(params) || original.size == 0 || amount == 0 || amount > original.margin || price <= 0) { return px_refuse(original, PX_BAD_TERMS); }
    val (funded, collected, debt) = px_fund(original, index);
    if (debt != 0 || amount > funded.margin) { return px_refuse(original, PX_FUNDING); }
    var next = funded;
    next.margin -= amount;
    val required = px_ceil(max(next.entryNotional, px_notional(next.size, price)) * PX_BPS, params.maxLeverageBps);
    if (next.margin < required || px_liquidatable(params, next, price, 0)) { return px_refuse(original, PX_MARGIN); }
    var result = px_refuse(next, PX_OK);
    result.payout = amount; result.fillPrice = price; result.fundingCollected = collected;
    return result;
}
// kind 1 voluntary close, 2 forced liquidation, 3 funding-only claim.
fun px_plan_close(params: PxParams, original: PxPosition, index: int128, requested: int128,
    price: coins, forcedPrice: coins, limit: coins, kind: int, feeBps: uint16): PxPlan {
    if (!px_params_valid(params) || feeBps > PX_BPS || original.size == 0 || price <= 0 || forcedPrice <= 0 || kind < 1 || kind > 3) { return px_refuse(original, PX_BAD_TERMS); }
    val (funded, collected, debt) = px_fund(original, index);
    val mustClose = px_liquidatable(params, funded, forcedPrice, debt);
    if (kind == 2 && !mustClose) { return px_refuse(original, PX_LIQUIDATABLE); }
    if (kind == 3) {
        if (mustClose) { return px_refuse(original, PX_LIQUIDATABLE); }
        var next = funded;
        var cp = next.counterparty.load();
        val paid = cp.pendingFunding;
        cp.reserved -= paid; cp.remainingEntitlement -= paid; cp.pendingFunding = 0;
        val loss = cp.collectedLoss; cp.collectedLoss = 0;
        next.counterparty = cp.toCell();
        var result = px_refuse(next, PX_OK);
        result.lpPayout = paid; result.loss = loss; result.fundingCollected = collected; result.fillPrice = price;
        return result;
    }
    if (requested != 0 && ((requested > 0) != (original.size > 0) || abs(requested) > abs(original.size))) {
        return px_refuse(original, PX_BAD_TERMS);
    }
    val total = abs(original.size);
    var size = kind == 2 || requested == 0 ? total : abs(requested);
    // A dust remainder is a complete exit and receives the complete-exit limit check.
    if (original.entryNotional - original.entryNotional * size / total < MIN_PERPS_ENTRY_NOTIONAL) { size = total; }
    if (size < total && mustClose) { return px_refuse(original, PX_LIQUIDATABLE); }
    val direction = original.size > 0 ? -size : size;
    val rawFill = kind == 2 ? forcedPrice as int : px_fill(params, direction, price);
    if (rawFill <= 0 || rawFill >= PX_COINS_LIMIT) { return px_refuse(original, PX_BAD_TERMS); }
    val fill = rawFill as coins;
    if (kind == 1 && !px_limit(direction, fill, limit)) { return px_refuse(original, PX_LIMIT); }
    val cp = counterparty_plan_close(funded.counterparty.load(), px_pnl(funded, fill), size as uint128,
        total as uint128, funded.margin, px_ceil(original.entryNotional * 1500, PX_BPS) as coins, debt);
    // A voluntary partial order cannot silently turn into a forced liquidation at another price.
    if (cp.closedSize != size) { return px_refuse(original, PX_LIQUIDATABLE); }
    val marginShare = funded.margin * size / total;
    var payout = max(marginShare - cp.userDebit, 0);
    var retained = funded.margin - marginShare - max(cp.userDebit - marginShare, 0);
    val quotedFee = px_notional(direction, fill) * feeBps / PX_BPS;
    val fee = size == total ? min(quotedFee, payout) : quotedFee;
    if (retained + payout < fee) { return px_refuse(original, PX_MARGIN); }
    val retainedFee = min(retained, fee);
    retained -= retainedFee; payout -= fee - retainedFee;
    val released = original.entryNotional * size / total;
    var next = funded;
    next.size = (original.size > 0 ? total - size : size - total) as int128;
    next.entryNotional -= released as coins; next.margin = retained as coins;
    var nextCp = cp.state;
    val loss = nextCp.collectedLoss; nextCp.collectedLoss = 0;
    next.counterparty = nextCp.toCell();
    var result = px_refuse(next, PX_OK);
    result.fee = fee as coins; result.payout = payout as coins; result.lpPayout = cp.userProfit;
    result.loss = loss; result.fundingCollected = collected; result.notionalDelta = -released;
    // Unpaid loss is a diagnostic, never a claim; an extreme price can exceed Coins.
    result.fillPrice = fill; result.unpaidLoss = min(cp.unpaidLoss, PX_COINS_LIMIT - 1) as coins;
    return result;
}
fun px_observe(old: PxFunding, params: PxParams, e: Evidence, nowTs: int): PxFunding {
    if (!oracle_fresh(e, nowTs) || e.servedAt <= old.observedAt) { return old; }
    var next = old;
    val until = min(e.servedAt, old.validUntil);
    if (until > old.accruedAt) {
        val numerator = old.rate * (until - old.accruedAt) + old.remainder;
        val change = numerator / PX_FUNDING_INTERVAL;
        next.index += change as int128;
        next.remainder = (numerator - change * PX_FUNDING_INTERVAL) as int64;
    }
    next.accruedAt = e.servedAt as uint64;
    next.observedAt = e.servedAt as uint64;
    if (verdict_admission(e, nowTs)) {
        val median = verdict_median(e);
        val raw = (e.short - median) * PX_BPS / median;
        next.rate = max(-params.fundingCapBps, min(params.fundingCapBps, raw)) as int64;
        next.validUntil = (e.servedAt + 600) as uint64;
    }
    return next;
}
