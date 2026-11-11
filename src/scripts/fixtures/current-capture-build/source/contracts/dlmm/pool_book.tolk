tolk 1.5.0

// Pure plans: callers commit these roots only after every row and funding check succeeds.
import "@stdlib/gas-payments";
import "./constants";
import "./math";
import "./pool_state_init";
import "./pool_storage";
import "./pool_positions";
import "../shared/dex/swap_payload";
import "../shared/jetton/jetton_quotes";

const BOOK_Q64 = 1 << 64;
const BOOK_MAX_COINS = (1 << 120) - 1;
const BOOK_MAX_SHARES = ((1 << 255) - 1) + (1 << 255);
const BOOK_PPM = 1000000;

struct BookState {
    activeBin: int32;
    binCount: uint16;
    positionCount: uint16;
    protocolFeesT3: coins;
    amm: PoolAmm;
    positions: map<uint128, PoolPositionBucket>;
}
struct SwapPlan {
    status: int;
    amountOut: coins;
    grossFeeT3: coins;
    protocolFeeT3: coins;
    lastBin: int32;
    loaded: int;
    amm: PoolAmm;
}
struct LiquidityChange { shares: uint256; amountT3: coins; amountX: coins }
struct LiquidityPlan {
    status: int;
    state: BookState;
    entryFee: coins;
    amountT3: coins;
    amountX: coins;
    changes: map<int32, LiquidityChange>;
}

fun pool_book_state(root: PoolStorage, amm: PoolAmm, cold: PoolCold): BookState {
    return { activeBin: root.activeBin, binCount: root.binCount, positionCount: root.positionCount,
        protocolFeesT3: root.protocolFeesT3, amm, positions: cold.positions };
}
fun pool_crowding(binCount: int, positionCount: int): int {
    return min(7, max(binCount * 8 / MAX_BINS, positionCount * 8 / MAX_POSITIONS));
}
fun pool_entry_fee(count: int, cap: int, units: int): coins {
    return (jetton_owed_rent() * units) << min(7, count * 8 / cap);
}
fun pool_position_value(shares: int, bin: PoolBin, pqRef: int): int {
    if (bin.shares == 0 || pqRef == 0) { return 0; }
    return mulDivFloor(shares, bin.t + mulDivFloor(bin.x, BOOK_Q64, pqRef), bin.shares);
}
fun pool_pointer_price(state: BookState, spacing: int, decimals: int): int {
    val entry = state.amm.bins.get(state.activeBin);
    return entry.isFound ? entry.loadValue().pq : dlmm_price_raw_q64(state.activeBin, spacing, decimals);
}
fun pool_protocol_fee(fee: int): int { return (fee * 17 + 99) / 100; }

// Minimal gross input for an integer net amount: n-floor(n*f/M) = ceil(n*(M-f)/M).
fun pool_gross_for_net(net: int, feePips: int): int {
    return net == 0 ? 0 : mulDivFloor(net - 1, BOOK_PPM, BOOK_PPM - feePips) + 1;
}
fun pool_x_nominal(n: int, pq: int, feePips: int): int {
    return pool_protocol_fee(mulDivFloor(n * feePips / BOOK_PPM, BOOK_Q64, pq));
}
fun pool_x_consumed(n: int, pq: int, feePips: int): int {
    val fee = n * feePips / BOOK_PPM;
    return mulDivFloor(n - fee, BOOK_Q64, pq) + pool_protocol_fee(mulDivFloor(fee, BOOK_Q64, pq));
}

fun pool_x_thresholds(p: int, t: coins, pq: int, feePips: int): (int, int) {
    val net = mulDivCeil(max(0, t - p), pq, BOOK_Q64);
    val netInput = pool_gross_for_net(net, feePips);
    if (p == 0) { return (netInput, 0); }
    val feeValue = (100 * (p - 1)) / 17 + 1;
    val feeUnits = mulDivCeil(feeValue, pq, BOOK_Q64);
    return (netInput, mulDivCeil(feeUnits, BOOK_PPM, feePips));
}

// Invert the actual integer consumption, not a continuous fee approximation. For r=Q64/pq,
// with f=feePips/1e6<=.1, consumption differs from n*r*(1-.83f) by a value in (-1.17, .83r+1). At r>=1 this
// confines the minimum to six adjacent integers. At r<1 its protocol share differs from
// the continuous candidate's by at most one; invert the net and fee thresholds for each.
@inline_ref
fun pool_x_capacity(t: coins, pq: int, feePips: int): int {
    if (t == 0 || pq < (1 << 32) || pq >= (1 << 128) || feePips < 0 || feePips > 100000) { return 0; }
    if (feePips == 0) { return mulDivCeil(t, pq, BOOK_Q64); }
    val continuous = mulDivCeil(t * pq, 100 * BOOK_PPM, BOOK_Q64 * (100 * BOOK_PPM - 83 * feePips));
    if (pq <= BOOK_Q64) {
        var n = max(1, continuous - 3);
        repeat (6) {
            if (pool_x_consumed(n, pq, feePips) >= t) { return n; }
            n += 1;
        }
        return 0;
    }
    val p = pool_x_nominal(continuous, pq, feePips);
    val (netInput, feeInput) = pool_x_thresholds(p, t, pq, feePips);
    var best = max(netInput, feeInput);
    // The net threshold decreases with p, and the fee threshold increases. The neighbor
    // away from their crossing cannot improve the center, so only the other is needed.
    val neighbor = netInput >= feeInput ? p + 1 : p - 1;
    if (neighbor >= 0 && neighbor <= t) {
        val (netNext, feeNext) = pool_x_thresholds(neighbor, t, pq, feePips);
        best = min(best, max(netNext, feeNext));
    }
    return best;
}

fun swap_refund_tail_rebate(): coins {
    // Subtracting only the tail fee difference is conservative even when a
    // configuration's flat gas region crosses one of these bounds.
    return calculateGasFee(BASECHAIN, APPLY_TAIL_GAS_MAX) - calculateGasFee(BASECHAIN, POOL_REFUND_SEND_TAIL_GAS);
}

// Fixed is the output leg or the rebased refund leg, plus shared expenses.
// Simulation caps its pessimistic virtual gas at the qualified whole handler;
// live checks always reserve the actual consumed gas and remaining apply tail.
fun swap_compute(state: BookState, side: int, amountIn: coins, feePips: int,
    budget: int, fixed: coins, simulation: bool): SwapPlan {
    var plan = SwapPlan { status: 0, amountOut: 0, grossFeeT3: 0, protocolFeeT3: 0,
        lastBin: state.activeBin, loaded: 0, amm: state.amm };
    if (feePips < 0 || feePips > 100000) { plan.status = SWAP_REASON_MATH; return plan; }
    if (amountIn == 0 || side < 0 || side > 1) { plan.status = SWAP_REASON_LIQUIDITY; return plan; }
    var remaining: int = amountIn;
    var k: int32 = state.activeBin;
    var have = false;
    var bin = PoolBin { t: 0, x: 0, shares: 0, pq: 0 };
    val first = plan.amm.bins.get(k);
    if (first.isFound) { bin = first.loadValue(); have = side == 0 ? bin.x > 0 : bin.t > 0; }
    while (remaining > 0) {
        if (plan.loaded >= MAX_SWAP_BINS) { plan.status = SWAP_REASON_LIQUIDITY; return plan; }
        val consumed = simulation ? min(SWAP_GAS_MAX - STEP_GAS_MAX - APPLY_TAIL_GAS_MAX,
            SWAP_PREWALK_GAS_MAX + plan.loaded * STEP_GAS_MAX) : getGasConsumedAtTheMoment();
        if (budget >= 0 && budget < calculateGasFee(BASECHAIN, consumed + STEP_GAS_MAX + APPLY_TAIL_GAS_MAX) + fixed) {
            plan.status = SWAP_REASON_VALUE; return plan;
        }
        if (!have) {
            val next = side == 0 ? plan.amm.bins.findKeyLess(k) : plan.amm.bins.findKeyGreater(k);
            if (!next.isFound) { plan.status = SWAP_REASON_LIQUIDITY; return plan; }
            k = next.getKey(); bin = next.loadValue();
        }
        plan.loaded += 1;
        if (bin.pq == 0) { plan.status = SWAP_REASON_MATH; return plan; }
        var spent = remaining;
        var got = 0;
        var protocol = 0;
        var grossFee = 0;
        if (side == 0) {
            val capacity = pool_gross_for_net(mulDivCeil(bin.x, BOOK_Q64, bin.pq), feePips);
            spent = min(remaining, capacity);
            grossFee = spent * feePips / BOOK_PPM;
            got = spent == capacity ? bin.x : min(bin.x, mulDivFloor(spent - grossFee, bin.pq, BOOK_Q64));
            protocol = pool_protocol_fee(grossFee);
            if (bin.t + spent - protocol > BOOK_MAX_COINS) { plan.status = SWAP_REASON_MATH; return plan; }
            bin.t += spent - protocol; bin.x -= got;
        } else {
            val capacity = pool_x_capacity(bin.t, bin.pq, feePips);
            if (capacity <= 0) { plan.status = SWAP_REASON_MATH; return plan; }
            spent = min(remaining, capacity);
            val feeX = spent * feePips / BOOK_PPM;
            grossFee = mulDivFloor(feeX, BOOK_Q64, bin.pq);
            val nominal = min(bin.t, pool_protocol_fee(grossFee));
            // Coarse X fee quanta cannot take away output already offered for less input.
            // At exhaustion the protocol receives only what remains after that net output.
            got = min(spent == capacity ? bin.t : bin.t - nominal, mulDivFloor(spent - feeX, BOOK_Q64, bin.pq));
            protocol = spent == capacity ? bin.t - got : nominal;
            if (bin.x + spent > BOOK_MAX_COINS) { plan.status = SWAP_REASON_MATH; return plan; }
            bin.x += spent; bin.t -= got + protocol;
        }
        if (plan.amountOut + got > BOOK_MAX_COINS || plan.grossFeeT3 + grossFee > BOOK_MAX_COINS
            || state.protocolFeesT3 + plan.protocolFeeT3 + protocol > BOOK_MAX_COINS) {
            plan.status = SWAP_REASON_MATH; return plan;
        }
        plan.amountOut += got; plan.grossFeeT3 += grossFee; plan.protocolFeeT3 += protocol;
        remaining -= spent; plan.lastBin = k;
        plan.amm.bins.set(k, bin);
        have = false;
    }
    if (plan.amountOut == 0) { plan.status = SWAP_REASON_LIQUIDITY; return plan; }
    if (side == 0) {
        if (plan.amm.reserveT + amountIn - plan.protocolFeeT3 > BOOK_MAX_COINS || plan.amm.reserveX < plan.amountOut) {
            plan.status = SWAP_REASON_MATH; return plan;
        }
        plan.amm.reserveT += amountIn - plan.protocolFeeT3; plan.amm.reserveX -= plan.amountOut;
    } else {
        if (plan.amm.reserveX + amountIn > BOOK_MAX_COINS || plan.amm.reserveT < plan.amountOut + plan.protocolFeeT3) {
            plan.status = SWAP_REASON_MATH; return plan;
        }
        plan.amm.reserveX += amountIn; plan.amm.reserveT -= plan.amountOut + plan.protocolFeeT3;
    }
    return plan;
}

fun pool_liquidity_plan(state: BookState): LiquidityPlan {
    return { status: 0, state, entryFee: 0, amountT3: 0, amountX: 0, changes: [] };
}

// Called only with a fully decoded canonical list whose amounts sum to the authenticated credit.
// Pure arithmetic failures are caught by the credit handler around this one call.
@inline_ref
fun add_compute(state: BookState, side: int, owner: address, count: int, rows: cell,
    spacing: int, decimals: int, feePips: int, campaigns: map<uint64, PoolCampaign>): LiquidityPlan {
    var plan = pool_liquidity_plan(state);
    if (feePips < 0 || feePips > 100000) { plan.status = SWAP_REASON_MATH; return plan; }
    var (room, owned) = pool_positions_load(state.positions, owner);
    if (!room) { plan.status = SWAP_REASON_CAPACITY; return plan; }
    var next = rows;
    repeat (count) {
        val row = LiqAddRow.fromCell(next);
        val found = plan.state.amm.bins.get(row.binId);
        var bin = PoolBin { t: 0, x: 0, shares: 0, pq: 0 };
        if (found.isFound) { bin = found.loadValue(); }
        else {
            val price = dlmm_price_raw_q64(row.binId, spacing, decimals);
            if (price == 0) { plan.status = SWAP_REASON_BIN; return plan; }
            if (plan.state.binCount >= MAX_BINS) { plan.status = SWAP_REASON_CAPACITY; return plan; }
            bin.pq = price;
        }
        var active = plan.state.activeBin;
        if (plan.state.binCount == 0) { active = row.binId; }
        else if (row.binId != active) {
            val pointer = plan.state.amm.bins.get(active);
            var t = 0; var x = 0;
            if (pointer.isFound) { val p = pointer.loadValue(); t = p.t; x = p.x; }
            if (side == 0 && row.binId < active) {
                val e = plan.state.amm.bins.findKeyLess(active);
                if (x > 0 || (e.isFound && e.getKey() > row.binId)) { plan.status = SWAP_REASON_WRONG_SIDE; return plan; }
                active = row.binId;
            }
            if (side == 1 && row.binId > active) {
                val e = plan.state.amm.bins.findKeyGreater(active);
                if (t > 0 || (e.isFound && e.getKey() < row.binId)) { plan.status = SWAP_REASON_WRONG_SIDE; return plan; }
                active = row.binId;
            }
        }
        val prior = owned.position(row.binId);
        var position = PoolPosition { shares: 0, farmId: 0, accSnap: 0, rewardCarry: null };
        if (prior != null) { position = prior!; }
        if (position.farmId != 0 && campaigns.exists(position.farmId)) { plan.status = SWAP_REASON_STAKED; return plan; }
        val value = side == 0 ? row.amount * bin.pq : row.amount * BOOK_Q64;
        val oldValue = bin.t * bin.pq + bin.x * BOOK_Q64;
        var minted = value;
        var protocol = 0;
        if (bin.shares > 0) {
            if (oldValue == 0) { plan.status = SWAP_REASON_MATH; return plan; }
            minted = mulDivFloor(bin.shares, value, oldValue);
            if (position.shares != bin.shares && (side == 0 ? bin.x : bin.t) > 0) {
                val ownReserve = side == 0 ? bin.t : bin.x;
                val back = mulDivFloor(ownReserve + row.amount, minted, bin.shares + minted);
                val fee = min(row.amount, mulDivCeil(row.amount - back, feePips, BOOK_PPM - feePips));
                protocol = side == 0 ? pool_protocol_fee(fee) : min(bin.t, pool_protocol_fee(mulDivFloor(fee, BOOK_Q64, bin.pq)));
                val net = side == 0 ? (row.amount - fee) * bin.pq : (row.amount - fee) * BOOK_Q64;
                val retained = side == 0 ? fee * bin.pq : fee * BOOK_Q64;
                minted = mulDivFloor(bin.shares, net, oldValue + retained - protocol * bin.pq);
            }
        }
        if (minted <= 0) { plan.status = SWAP_REASON_MIN_VALUE; return plan; }
        if (minted < row.minShares) { plan.status = SWAP_REASON_SLIPPAGE; return plan; }
        if (bin.shares > BOOK_MAX_SHARES - minted || position.shares > BOOK_MAX_SHARES - minted
            || plan.state.protocolFeesT3 + protocol > BOOK_MAX_COINS) { plan.status = SWAP_REASON_MATH; return plan; }
        if (side == 0) {
            if (bin.t + row.amount - protocol > BOOK_MAX_COINS || plan.state.amm.reserveT + row.amount - protocol > BOOK_MAX_COINS) {
                plan.status = SWAP_REASON_MATH; return plan;
            }
            bin.t += row.amount - protocol; plan.state.amm.reserveT += row.amount - protocol;
        } else {
            if (bin.x + row.amount > BOOK_MAX_COINS || plan.state.amm.reserveX + row.amount > BOOK_MAX_COINS || plan.state.amm.reserveT < protocol) {
                plan.status = SWAP_REASON_MATH; return plan;
            }
            bin.x += row.amount; bin.t -= protocol; plan.state.amm.reserveX += row.amount; plan.state.amm.reserveT -= protocol;
        }
        bin.shares += minted; position.shares += minted;
        if (!found.isFound || prior == null) {
            val reference = active == row.binId ? bin.pq as int : pool_pointer_price(plan.state, spacing, decimals);
            val minimum = MIN_ADD_VALUE << pool_crowding(plan.state.binCount, plan.state.positionCount);
            if (pool_position_value(position.shares, bin, reference) < minimum) { plan.status = SWAP_REASON_MIN_VALUE; return plan; }
            if (prior == null && plan.state.positionCount >= MAX_POSITIONS) { plan.status = SWAP_REASON_CAPACITY; return plan; }
        }
        if (!found.isFound) { plan.entryFee += pool_entry_fee(plan.state.binCount, MAX_BINS, 32); plan.state.binCount += 1; }
        if (prior == null) { plan.entryFee += pool_entry_fee(plan.state.positionCount, MAX_POSITIONS, 16); plan.state.positionCount += 1; }
        plan.state.amm.bins.set(row.binId, bin); owned.put(row.binId, position);
        plan.state.activeBin = active; plan.state.protocolFeesT3 += protocol;
        plan.changes.set(row.binId, { shares: minted, amountT3: side == 0 ? row.amount : 0, amountX: side == 1 ? row.amount : 0 });
        if (row.next != null) { next = row.next!; }
    }
    pool_positions_store(mutate plan.state.positions, owner, owned);
    return plan;
}

@inline_ref
fun remove_compute(state: BookState, owner: address, count: int, rows: cell, minT3: coins, minX: coins,
    spacing: int, decimals: int, campaigns: map<uint64, PoolCampaign>, evict: bool): LiquidityPlan {
    var plan = pool_liquidity_plan(state);
    var next = rows;
    var owned = pool_positions_owner(state.positions, owner);
    val reference = pool_pointer_price(state, spacing, decimals);
    val minimum = MIN_ADD_VALUE << pool_crowding(state.binCount, state.positionCount);
    repeat (count) {
        val row = LiqRemoveRow.fromCell(next);
        val prior = owned.position(row.binId);
        val found = plan.state.amm.bins.get(row.binId);
        if (prior == null || !found.isFound) { plan.status = SWAP_REASON_BIN; return plan; }
        var position = prior!; var bin = found.loadValue();
        if (position.farmId != 0 && campaigns.exists(position.farmId)) { plan.status = SWAP_REASON_STAKED; return plan; }
        if (evict && pool_position_value(position.shares, bin, reference) >= minimum) { plan.status = SWAP_REASON_MIN_VALUE; return plan; }
        val burned = row.shares == 0 || evict ? position.shares : row.shares;
        if (burned > position.shares || bin.shares == 0) { plan.status = SWAP_REASON_SLIPPAGE; return plan; }
        val t = mulDivFloor(bin.t, burned, bin.shares); val x = mulDivFloor(bin.x, burned, bin.shares);
        bin.t -= t; bin.x -= x; bin.shares -= burned; position.shares -= burned;
        if (position.shares > 0 && pool_position_value(position.shares, bin, reference) < minimum) { plan.status = SWAP_REASON_MIN_VALUE; return plan; }
        if (position.shares == 0) { owned.remove(row.binId); plan.state.positionCount -= 1; }
        else { owned.put(row.binId, position); }
        if (bin.shares == 0) { plan.state.amm.bins.delete(row.binId); plan.state.binCount -= 1; }
        else { plan.state.amm.bins.set(row.binId, bin); }
        plan.amountT3 += t; plan.amountX += x;
        plan.changes.set(row.binId, { shares: burned, amountT3: t, amountX: x });
        if (row.next != null) { next = row.next!; }
    }
    if (plan.amountT3 < minT3 || plan.amountX < minX) { plan.status = SWAP_REASON_SLIPPAGE; return plan; }
    plan.state.amm.reserveT -= plan.amountT3; plan.state.amm.reserveX -= plan.amountX;
    pool_positions_store(mutate plan.state.positions, owner, owned);
    return plan;
}
