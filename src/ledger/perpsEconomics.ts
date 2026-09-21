import { Address, beginCell } from "@ton/core";
import type { PerpsRequest } from "./perpsWire";
import { perpsAccount, perpsRiskAction, type PerpsRiskAction, perpsPosition, perpsPending, perpsOracleTradeTransition, type PerpsState, type PerpsMarket, type PerpsPosition, } from "./perpsState";
const abs = (v: bigint) => (v < 0n ? -v : v), min = (a: bigint, b: bigint) => (a < b ? a : b), max = (a: bigint, b: bigint) => (a > b ? a : b);
const clamp128 = (v: bigint) => max(-(1n << 127n), min((1n << 127n) - 1n, v));
/** TVM DIV floors toward negative infinity; native BigInt division truncates toward zero. */
export function tvmDiv(a: bigint, b: bigint) {
    if (b === 0n || a < -(1n << 256n) || a >= 1n << 256n)
        throw Error("TVM arithmetic unavailable");
    const q = a / b, r = a % b;
    return r !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
type FundingCheckpoint = Pick<PerpsMarket, 'fundingIndexRaw' | 'fundingRemainderRaw' | 'fundingRateBpsRaw' | 'fundingValidUntil' | 'lastFundingTs'>;
/** Accrue only the previously authenticated rate, stopping at its stored expiry.
 * The current release fixes the denominator to 3600 seconds. A new observation
 * can establish the next checkpoint; it cannot price an earlier idle interval. */
export function accruePerpsFunding(prior: FundingCheckpoint, timestamp: bigint) {
    const index = BigInt(prior.fundingIndexRaw), remainder = BigInt(prior.fundingRemainderRaw),
        rate = BigInt(prior.fundingRateBpsRaw), until = BigInt(prior.fundingValidUntil), last = BigInt(prior.lastFundingTs);
    if (index !== clamp128(index) || rate !== clamp128(rate) || remainder < 0n || remainder >= 3600n ||
        [timestamp, until, last].some(v => v < 0n || v >= 1n << 63n) || timestamp < last)
        throw Error('Invalid perps funding checkpoint');
    const elapsed = last === 0n ? 0n : max(0n, min(timestamp, until) - last);
    const numerator = rate * elapsed + remainder, delta = clamp128(tvmDiv(numerator, 3600n));
    return { fundingIndexRaw: clamp128(index + delta).toString(),
        fundingRemainderRaw: (numerator - tvmDiv(numerator, 3600n) * 3600n).toString(), elapsed };
}
function fundingCheckpointTransition(before: PerpsMarket, after: PerpsMarket) {
    const timestamp = BigInt(after.lastFundingTs), last = BigInt(before.lastFundingTs);
    if (timestamp === last) return before.fundingIndexRaw === after.fundingIndexRaw &&
        before.fundingRemainderRaw === after.fundingRemainderRaw && before.fundingRateBpsRaw === after.fundingRateBpsRaw &&
        before.fundingValidUntil === after.fundingValidUntil;
    const accrued = accruePerpsFunding(before, timestamp), until = BigInt(after.fundingValidUntil);
    return accrued.fundingIndexRaw === after.fundingIndexRaw && accrued.fundingRemainderRaw === after.fundingRemainderRaw &&
        until >= timestamp && until <= timestamp + 600n &&
        (after.oraclePriceHealthy || (after.fundingRateBpsRaw === '0' && until === timestamp));
}
function fill(m: PerpsMarket, delta: bigint) {
    const ratio = BigInt(m.depthRaw) === 0n
        ? 0n
        : tvmDiv(delta * 1000000000n, BigInt(m.depthRaw));
    if (ratio < -(1n << 127n) || ratio >= 1n << 127n)
        throw Error("Perps ratio overflow");
    const linear = tvmDiv(BigInt(m.alphaRaw) * abs(ratio), 1000000000n), square = tvmDiv(abs(ratio) ** 2n, 1000000000n), quadratic = tvmDiv(BigInt(m.betaRaw) * square, 1000000000n);
    let premium = clamp128((linear + quadratic) * (ratio < 0n ? -1n : 1n));
    if (m.clampBps > 0)
        premium = max(-BigInt(m.clampBps), min(BigInt(m.clampBps), premium));
    const price = max(0n, BigInt(m.markRaw) + tvmDiv(BigInt(m.markRaw) * premium, 10000n));
    return { price, notional: tvmDiv(abs(delta) * price, 1000000000n) };
}
export type CounterpartyCapital = {
    reserved: bigint;
    pendingFunding: bigint;
    collectedLoss: bigint;
};
const ceil = (a: bigint, b: bigint) => { if (a < 0n || b <= 0n)
    throw Error("Invalid ceiling"); return (a + b - 1n) / b; };
const capital = (p: PerpsPosition): CounterpartyCapital => ({ reserved: BigInt(p.counterparty.reservedRaw),
    pendingFunding: BigInt(p.counterparty.pendingFundingRaw), collectedLoss: BigInt(p.counterparty.collectedLossRaw) });
const storeCapital = (p: PerpsPosition, c: CounterpartyCapital) => {
    p.counterparty = {
        reservedRaw: c.reserved.toString(), pendingFundingRaw: c.pendingFunding.toString(), collectedLossRaw: c.collectedLoss.toString()
    };
};
export function counterpartyClose(c: CounterpartyCapital, fullPnl: bigint, closed: bigint, size: bigint, cash: bigint, minimum: bigint, fundingDebt: bigint) {
    if (size <= 0n || closed <= 0n || closed > size || cash < 0n || minimum < 0n || fundingDebt < 0n || Object.values(c).some(v => v < 0n))
        throw Error("Invalid isolated capital");
    let forced = fundingDebt > 0n || c.reserved <= max(fullPnl, 0n) + c.pendingFunding + minimum;
    if (forced)
        closed = size;
    let remaining = 0n;
    if (!forced && closed < size) {
        remaining = ceil((c.reserved - c.pendingFunding) * (size - closed), size);
        if (remaining <= ceil(minimum * (size - closed), size)) {
            forced = true;
            closed = size;
            remaining = 0n;
        }
    }
    const pnl = tvmDiv(fullPnl * closed, size), claim = min(c.reserved, c.pendingFunding + max(pnl, 0n)), loss = max(-pnl, 0n) + fundingDebt;
    const profit = max(claim - loss, 0n), debit = min(max(loss - claim, 0n), cash), unpaid = max(loss - claim, 0n) - debit;
    const released = c.reserved - remaining - profit;
    if (released < 0n)
        throw Error("Position capital overdraw");
    return { state: { reserved: remaining, pendingFunding: 0n, collectedLoss: c.collectedLoss + debit }, forced, closed, pnl, profit, debit, unpaid, released };
}
function initialReserve(state: PerpsState, m: PerpsMarket, size: bigint, notional: bigint) {
    if (m.maxLeverageBps <= 0)
        throw Error("No margin policy");
    const units = BigInt(m.depthRaw) === 0n ? 11n : abs(tvmDiv(size * 1000000000n, BigInt(m.depthRaw))) / 1000000000n;
    const bps = BigInt((units <= 5n ? 800 : units <= 10n ? 1000 : 1200) + (state.risk.oracleDegraded ? 200 : 0) +
        (state.risk.oracleDriftLevel >= 1 ? 150 : 0) + (state.risk.tvlDegraded ? 300 : 0));
    return max(ceil(notional * bps, 10000n), ceil(notional * 10000n, BigInt(m.maxLeverageBps)));
}
function maintenance(state: PerpsState, m: PerpsMarket, p: PerpsPosition) {
    const size = BigInt(p.sizeRaw), depth = BigInt(m.depthRaw);
    const units = depth === 0n ? 11n : abs(tvmDiv(size * 1000000000n, depth)) / 1000000000n;
    const tier = units <= 5n ? 1 : units <= 10n ? 2 : 3;
    const initialBps = (tier === 1 ? 800 : tier === 2 ? 1000 : 1200) + (state.risk.oracleDegraded ? 200 : 0)
        + (state.risk.oracleDriftLevel >= 1 ? 150 : 0) + (state.risk.tvlDegraded ? 300 : 0);
    const maintenanceBps = Math.min(20000, initialBps, m.maintenanceBps + (tier === 1 ? 0 : tier === 2 ? 100 : 200)
        + (state.risk.oracleDegraded ? 100 : 0) + (state.risk.oracleDriftLevel >= 1 ? 75 : 0) + (state.risk.tvlDegraded ? 150 : 0));
    return ceil(tvmDiv(abs(size) * BigInt(m.markRaw), 1000000000n) * BigInt(maintenanceBps), 10000n);
}
function pricePnl(p: PerpsPosition, price: bigint) {
    const size = BigInt(p.sizeRaw), notional = BigInt(p.entryNotionalRaw);
    return clamp128(tvmDiv((price * abs(size) - notional * 1000000000n) * (size > 0n ? 1n : -1n), 1000000000n));
}
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
const lossKey = beginCell().storeUint(0x43504c53, 32).endCell().hash().toString('hex');
const lossBalance = (state: PerpsState) => {
    const p = state.pending.get(lossKey);
    if (!p)
        return 0n;
    if (![16, 17, 18, 19, 20].includes(p.kind))
        throw Error("Invalid LP loss journal");
    return BigInt(p.amountRaw) + BigInt(p.queuedRaw);
};
function riskTarget(action: PerpsRiskAction) {
    const s = action.requestBody.beginParse(), op = s.loadUint(32), id = s.loadUintBig(64).toString(), bucket = s.loadUint(16), subject = s.loadUintBig(256).toString(16).padStart(64, '0');
    if (id !== action.actionId || subject !== action.subjectId || action.requestHash !== action.requestBody.hash().toString('hex'))
        throw Error("Invalid reservation identity");
    let priorId = '0', priorHash = '', payout = 0n, target = s;
    if (op === 0x52565053) {
        priorId = s.loadUintBig(64).toString();
        priorHash = s.loadUintBig(256).toString(16).padStart(64, '0');
        payout = s.loadCoins();
        target = s.loadRef().beginParse();
        if (s.remainingBits || s.remainingRefs)
            throw Error("Malformed RVPS");
    }
    else if (op !== 0x52564c54)
        throw Error("Unsupported position reservation");
    const notional = target.loadCoins(), reserved = target.loadCoins(), cm = target.loadCoins();
    let beneficiary: string | null = null, marketId: number | null = null;
    if (op === 0x52565053) {
        beneficiary = target.loadAddress().toRawString();
        const metadata = target.loadRef().beginParse();
        marketId = metadata.loadUint(32);
        if (metadata.loadAddress().toRawString() !== beneficiary || metadata.remainingBits || metadata.remainingRefs)
            throw Error("Unbound RVPS beneficiary");
    }
    if (target.remainingBits || target.remainingRefs)
        throw Error("Malformed reservation target");
    return { op, id, bucket, subject, priorId, priorHash, payout, notional, reserved, cm, beneficiary, marketId };
}
export type PerpsEconomics = {
    outcome: "accepted" | "rejected" | "retry";
    fundingRaw: string;
    realizedPnlRaw: string;
    tradeFeeRaw: string;
    depositCollateralRaw: string;
    excessRaw: string;
    payoutContributionRaw: string;
    adlAbsorbedRaw: string;
    badDebtRaw: string;
    tradedNotionalRaw: string;
    executedSizeRaw: string;
    counterpartyProfitRaw: string;
    counterpartyLossRaw: string;
    uncollectedLossRaw: string;
    counterpartySettlement: {
        actionId: string;
        requestHash: string;
        beneficiary: string;
        amountRaw: string;
    } | null;
};
export function perpsEconomics(before: PerpsState, after: PerpsState, owner: string, wallet: string, r: PerpsRequest, depositRaw: string): PerpsEconomics | null {
    try {
        const oracle = perpsOracleTradeTransition(before, after, owner, r), ba = perpsAccount(before, owner), aa = perpsAccount(after, owner), bp = perpsPosition(before, owner, r.marketId), ap = perpsPosition(after, owner, r.marketId), bm = before.markets.get(r.marketId), am = after.markets.get(r.marketId), pricing = (oracle?.after.status === 2 ? after : before).markets.get(r.marketId), bt = perpsPending(before, wallet), at = perpsPending(after, wallet);
        const debt = (v: typeof bt) => v && [2, 3, 12, 13].includes(v.kind) ? BigInt(v.amountRaw) + BigInt(v.queuedRaw) : 0n;
        const payoutDelta = debt(at) - debt(bt), deposit = BigInt(depositRaw);
        if (before.configHash !== after.configHash || (bt && bt.owner !== owner) || (at && at.owner !== owner) ||
            (bt && [1, 10, 11].includes(bt.kind)) || (at && [1, 10, 11].includes(at.kind)))
            return null;
        const otherAccounts = (state: PerpsState) => [...state.accounts].filter(([key]) => key !== owner).sort(([a], [b]) => a.localeCompare(b));
        const otherPositions = (state: PerpsState) => [...state.positions].filter(([, p]) => p.owner !== owner || p.marketId !== r.marketId).sort(([a], [b]) => a.localeCompare(b));
        if (!same(otherAccounts(before), otherAccounts(after)) || !same(otherPositions(before), otherPositions(after)))
            return null;
        const isolated = (state: PerpsState) => [...state.accounts].every(([accountOwner, account]) =>
            [...state.positions.values()].filter(position => position.owner === accountOwner).reduce((sum, position) => sum + BigInt(position.marginRaw), 0n) <= BigInt(account.collateralRaw));
        if (!isolated(before) || !isolated(after)) return null;
        const result: PerpsEconomics = { outcome: 'accepted', fundingRaw: '0', realizedPnlRaw: '0', tradeFeeRaw: '0', depositCollateralRaw: '0', excessRaw: '0',
            payoutContributionRaw: '0', adlAbsorbedRaw: '0', badDebtRaw: '0', tradedNotionalRaw: '0', executedSizeRaw: '0', counterpartyProfitRaw: '0',
            counterpartyLossRaw: '0', uncollectedLossRaw: '0', counterpartySettlement: null };
        if (r.operation === 'close' && oracle?.after.order?.outcome === 3 && deposit === 0n && same(ba, aa) && same(bp, ap) && payoutDelta === 0n)
            return { ...result, outcome: 'rejected' };
        if (deposit > 0n && same(ba, aa) && same(bp, ap) && payoutDelta === deposit)
            return { ...result, outcome: 'rejected', excessRaw: depositRaw, payoutContributionRaw: depositRaw };
        if (r.operation === 'claim' && bt && same(ba, aa) && same(bp, ap) && payoutDelta === 0n)
            return { ...result, outcome: 'retry' };
        if (!bm || !am || !pricing || !before.riskVault || before.riskVault !== after.riskVault ||
            bm.pool !== am.pool || bm.depthRaw !== am.depthRaw || bm.alphaRaw !== am.alphaRaw || bm.betaRaw !== am.betaRaw ||
            pricing.fundingIndexRaw !== am.fundingIndexRaw || pricing.markRaw !== am.markRaw || pricing.fundingRemainderRaw !== am.fundingRemainderRaw ||
            pricing.fundingRateBpsRaw !== am.fundingRateBpsRaw || pricing.fundingValidUntil !== am.fundingValidUntil ||
            pricing.lastFundingTs !== am.lastFundingTs || !fundingCheckpointTransition(bm, am) ||
            pricing.clampBps !== am.clampBps || pricing.controlFeeDeltaBps !== am.controlFeeDeltaBps || (r.operation !== 'add_margin' && !pricing.oraclePriceHealthy))
            return null;
        let collateral = BigInt(ba.collateralRaw), pending = BigInt(ba.pendingFundingRaw), count = ba.openPositionCount, position = bp ? { ...bp, counterparty: { ...bp.counterparty } } : null, funding = 0n, pnl = 0n, fee = 0n, depositCollateral = 0n, excess = 0n, payout = 0n, traded = 0n, lpProfit = 0n, lpLoss = 0n, unpaid = 0n, grossNew = 0n, fundingDebt = 0n;
        const settle = (allowUnpaid: boolean) => {
            if (!position)
                return;
            const size = BigInt(position.sizeRaw), c = capital(position);
            funding = clamp128(tvmDiv(BigInt(position.entryNotionalRaw) * (BigInt(pricing.fundingIndexRaw) - BigInt(position.lastFundingIndexRaw)) * (size > 0n ? -1n : size < 0n ? 1n : 0n), 10000n));
            if (funding > 0n) {
                const claim = min(c.reserved, c.pendingFunding + funding);
                funding = claim - c.pendingFunding;
                c.pendingFunding = claim;
                pending += funding;
            }
            if (funding < 0n) {
                const canceled = min(c.pendingFunding, -funding);
                c.pendingFunding -= canceled;
                pending -= canceled;
                const owed = -funding - canceled;
                const available = min(collateral, BigInt(position.marginRaw));
                if (!allowUnpaid && available < owed)
                    throw Error('Unfunded voluntary funding');
                const debit = min(owed, available);
                collateral -= debit;
                c.collectedLoss += debit;
                fundingDebt = owed - debit;
                position.marginRaw = max(0n, BigInt(position.marginRaw) - debit).toString();
            }
            position.lastFundingIndexRaw = pricing.fundingIndexRaw;
            storeCapital(position, c);
        };
        const assess = (capped = false, available = collateral) => {
            const bps = BigInt(Math.max(0, Math.min(10000, before.feeBps + pricing.controlFeeDeltaBps)));
            fee = tvmDiv(traded * bps, 10000n);
            if (capped)
                fee = min(fee, available);
            if (available < fee)
                throw Error('Unfunded fee');
        };
        const flushLoss = () => { if (!position)
            return; const c = capital(position); lpLoss += c.collectedLoss; c.collectedLoss = 0n; storeCapital(position, c); };
        const close = (quantity: bigint, price: bigint, floor: bigint) => {
            if (!position)
                throw Error('Missing position');
            const c = capital(position), plan = counterpartyClose(c, pricePnl(position, price), quantity, abs(BigInt(position.sizeRaw)), min(collateral, BigInt(position.marginRaw)), floor, fundingDebt);
            if (plan.closed !== quantity)
                throw Error('Partial close bypasses compulsory liquidation');
            collateral -= plan.debit;
            pending -= c.pendingFunding;
            pnl += plan.pnl;
            lpProfit += plan.profit;
            unpaid += plan.unpaid;
            fundingDebt = 0n;
            storeCapital(position, plan.state);
            return plan;
        };
        const fullClose = () => {
            if (!position)
                throw Error('Missing close');
            const size = BigInt(position.sizeRaw);
            if (size === 0n)
                throw Error('Empty close');
            const f = fill(pricing, -size);
            const ownCash = min(collateral, BigInt(position.marginRaw)), plan = close(abs(size), f.price, 0n);
            const ownResidual = ownCash - plan.debit;
            traded = f.notional;
            assess(true, ownResidual);
            const marginPayout = ownResidual - fee;
            collateral -= fee + marginPayout;
            payout += marginPayout;
            count--;
            flushLoss();
            position = null;
        };
        if (r.operation === 'open') {
            if (bp || deposit <= 0n || BigInt(r.sizeRaw ?? '0') === 0n)
                return null;
            const f = fill(pricing, BigInt(r.sizeRaw!));
            traded = f.notional;
            const bps = BigInt(Math.max(0, Math.min(10000, before.feeBps + pricing.controlFeeDeltaBps)));
            fee = tvmDiv(traded * bps, 10000n);
            depositCollateral = BigInt(r.marginRaw!);
            excess = deposit - depositCollateral - fee;
            if (excess < 0n)
                return null;
            collateral += depositCollateral;
            count++;
            payout = excess;
            const reserve = initialReserve(after, pricing, BigInt(r.sizeRaw!), f.notional);
            if (depositCollateral < reserve)
                return null;
            position = { owner, marketId: r.marketId, sizeRaw: r.sizeRaw!, marginRaw: r.marginRaw!, entryNotionalRaw: f.notional.toString(), lastFundingIndexRaw: pricing.fundingIndexRaw,
                counterparty: { reservedRaw: reserve.toString(), pendingFundingRaw: '0', collectedLossRaw: '0' } };
            if (reserve <= max(pricePnl(position, BigInt(pricing.markRaw)), 0n) + ceil(f.notional * 1500n, 10000n)) return null;
        }
        else if (r.operation === 'modify') {
            if (!position)
                return null;
            const change = BigInt(r.marginRaw!);
            if (change > 0n) {
                if (deposit < change)
                    return null;
                depositCollateral = change;
                excess = deposit - change;
                collateral += change;
                position.marginRaw = (BigInt(position.marginRaw) + change).toString();
            }
            else if (deposit > 0n)
                return null;
            settle(false);
            let remaining = BigInt(r.sizeRaw!), released = 0n;
            for (let i = 0; remaining !== 0n && i < 2; i++) {
                const current = BigInt(position.sizeRaw);
                let chunk = remaining;
                if (current * chunk < 0n && abs(chunk) > abs(current))
                    chunk = -current;
                const f = fill(pricing, chunk);
                traded += f.notional;
                if (current === 0n || current * chunk > 0n) {
                    if (current === 0n && released > 0n) {
                        position.marginRaw = (BigInt(position.marginRaw) + released).toString();
                        released = 0n;
                    }
                    grossNew += f.notional;
                    position.sizeRaw = (current + chunk).toString();
                    position.entryNotionalRaw = (BigInt(position.entryNotionalRaw) + f.notional).toString();
                }
                else {
                    const margin = BigInt(position.marginRaw), notional = BigInt(position.entryNotionalRaw), share = tvmDiv(margin * abs(chunk), abs(current)), basis = tvmDiv(notional * abs(chunk), abs(current));
                    const plan = close(abs(chunk), f.price, ceil(notional * 1500n, 10000n));
                    released += max(0n, share - plan.debit);
                    position.marginRaw = max(0n, margin - share - max(0n, plan.debit - share)).toString();
                    position.entryNotionalRaw = (notional - basis).toString();
                    position.sizeRaw = (current + chunk).toString();
                    if (position.sizeRaw === '0') {
                        position.marginRaw = '0';
                        position.entryNotionalRaw = '0';
                    }
                }
                position.lastFundingIndexRaw = pricing.fundingIndexRaw;
                remaining -= chunk;
            }
            if (remaining !== 0n)
                return null;
            if (grossNew > 0n) {
                const c = capital(position);
                c.reserved = max(c.reserved, initialReserve(after, pricing, BigInt(position.sizeRaw), BigInt(position.entryNotionalRaw)));
                storeCapital(position, c);
                if (c.reserved <= max(pricePnl(position, BigInt(pricing.markRaw)), 0n) + c.pendingFunding + ceil(BigInt(position.entryNotionalRaw) * 1500n, 10000n)) return null;
            }
            const liveMargin = BigInt(position.marginRaw);
            assess(position.sizeRaw === '0', min(collateral, liveMargin + released));
            collateral -= fee;
            released -= max(0n, fee - liveMargin);
            position.marginRaw = max(0n, liveMargin - fee).toString();
            if (change < 0n) {
                if (collateral < -change) return null;
                if (position.sizeRaw === '0') {
                    if (released < -change) return null;
                    released += change;
                } else {
                    if (BigInt(position.marginRaw) < -change) return null;
                    position.marginRaw = (BigInt(position.marginRaw) + change).toString();
                }
                collateral += change;
                payout = -change;
            }
            const release = min(released, collateral);
            collateral -= release;
            payout += release + excess;
            if (bp?.sizeRaw === '0' && position.sizeRaw !== '0')
                count++;
            if (bp?.sizeRaw !== '0' && position.sizeRaw === '0')
                count--;
            flushLoss();
            if (position.sizeRaw === '0')
                position = null;
        }
        else if (r.operation === 'add_margin') {
            if (!position)
                return null;
            depositCollateral = BigInt(r.marginRaw!);
            if (deposit < depositCollateral)
                return null;
            excess = deposit - depositCollateral;
            collateral += depositCollateral;
            position.marginRaw = (BigInt(position.marginRaw) + depositCollateral).toString();
            settle(false);
            payout = excess;
        }
        else if (r.operation === 'remove_margin') {
            if (!position || deposit)
                return null;
            settle(false);
            const amount = BigInt(r.marginRaw!);
            if (amount <= 0n || collateral < amount || BigInt(position.marginRaw) < amount)
                return null;
            collateral -= amount;
            position.marginRaw = (BigInt(position.marginRaw) - amount).toString();
            payout = amount;
            flushLoss();
        }
        else {
            if (!position || deposit)
                return null;
            settle(true);
            if (r.operation === 'claim') {
                const c = capital(position);
                if (fundingDebt > 0n || BigInt(position.marginRaw) + pricePnl(position, BigInt(pricing.markRaw)) < maintenance(before, pricing, position)
                    || c.reserved <= max(pricePnl(position, BigInt(pricing.markRaw)), 0n) + c.pendingFunding + ceil(BigInt(position.entryNotionalRaw) * 1500n, 10000n))
                    fullClose();
                else {
                    if (c.pendingFunding <= 0n || bt) return null;
                    lpProfit = c.pendingFunding;
                    c.reserved -= lpProfit;
                    c.pendingFunding = 0n;
                    pending -= lpProfit;
                    storeCapital(position, c);
                    flushLoss();
                }
            }
            else if (['close', 'liquidation', 'adl'].includes(r.operation)) {
                if (r.operation !== 'close' && BigInt(r.sizeRaw ?? '0') < abs(BigInt(position.sizeRaw)))
                    return null;
                if (r.operation === 'adl') {
                    const c = capital(position);
                    if (fundingDebt === 0n && c.reserved > max(pricePnl(position, BigInt(pricing.markRaw)), 0n) + c.pendingFunding + ceil(BigInt(position.entryNotionalRaw) * 1500n, 10000n))
                        return null;
                }
                fullClose();
            }
            else
                return null;
        }
        if (pending < 0n || collateral.toString() !== aa.collateralRaw || pending.toString() !== aa.pendingFundingRaw || count !== aa.openPositionCount ||
            !same(position, ap) || payout !== payoutDelta || bm.adlDeficitRaw !== am.adlDeficitRaw || lossBalance(after) - lossBalance(before) !== lpLoss)
            return null;
        const subject = beginCell().storeAddress(Address.parse(owner)).storeUint(r.marketId, 32).endCell().hash().toString('hex'), previous = perpsRiskAction(before, 1, subject), next = perpsRiskAction(after, 1, subject);
        if (!previous || previous.status !== 4 || !next)
            return null;
        const prior = riskTarget(previous), target = riskTarget(next), reserve = position ? capital(position).reserved : 0n, notional = BigInt(position?.entryNotionalRaw ?? '0');
        if (prior.bucket !== before.riskVaultBucketId || prior.cm !== 0n || target.bucket !== prior.bucket || prior.reserved < reserve + lpProfit)
            return null;
        if (next.requestHash === previous.requestHash) {
            if (lpProfit !== 0n || target.reserved !== reserve || target.notional !== notional)
                return null;
        }
        else {
            if (target.op !== 0x52565053 || target.priorId !== previous.actionId || target.priorHash !== previous.requestHash || next.previousActionId !== previous.actionId ||
                target.beneficiary !== owner || target.marketId !== r.marketId || target.payout !== lpProfit || target.reserved !== reserve || target.notional !== notional || target.cm !== 0n || next.status !== 2)
                return null;
            result.counterpartySettlement = { actionId: next.actionId, requestHash: next.requestHash, beneficiary: owner, amountRaw: lpProfit.toString() };
        }
        return { ...result, fundingRaw: funding.toString(), realizedPnlRaw: pnl.toString(), tradeFeeRaw: fee.toString(), depositCollateralRaw: depositCollateral.toString(), excessRaw: excess.toString(),
            payoutContributionRaw: payout.toString(), tradedNotionalRaw: traded.toString(), executedSizeRaw: ((ap ? BigInt(ap.sizeRaw) : 0n) - (bp ? BigInt(bp.sizeRaw) : 0n)).toString(),
            counterpartyProfitRaw: lpProfit.toString(), counterpartyLossRaw: lpLoss.toString(), uncollectedLossRaw: unpaid.toString() };
    }
    catch {
        return null;
    }
}
