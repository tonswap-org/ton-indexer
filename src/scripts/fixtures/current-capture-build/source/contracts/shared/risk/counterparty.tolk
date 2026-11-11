tolk 1.5.0

// Pure arithmetic for an isolated LP counterparty. Callers must settle the
// returned cash movements against this position's actual vault reservation.
// collectedLoss is cash collected from this trader awaiting a real LP deposit;
// it never becomes reserved LP capital merely because a price changed.
// remainingEntitlement independently bounds gross positive price/funding claims.
const ERR_COUNTERPARTY_VALUE: int = 9140;
struct CounterpartyPosition {
    reserved: coins;
    pendingFunding: coins;
    collectedLoss: coins;
    remainingEntitlement: coins;
}
struct CounterpartyClosePlan {
    state: CounterpartyPosition;
    forceFullClose: bool;
    closedSize: uint128;
    realizedPnl: int128;
    userProfit: coins;
    userDebit: coins;
    lpReleased: coins;
    unpaidLoss: coins;
}
fun counterparty_ceil_div(numerator: int, denominator: int): int {
    assert (numerator >= 0 && denominator > 0) throw ERR_COUNTERPARTY_VALUE;
    return numerator / denominator + (numerator % denominator > 0 ? 1 : 0);
}
fun counterparty_reservation(notional: coins, marginBps: uint32, minimumReserve: coins): coins {
    assert (notional > 0 && marginBps > 0 && marginBps <= 1000000 && minimumReserve >= 0) throw ERR_COUNTERPARTY_VALUE;
    val amount = counterparty_ceil_div(notional * marginBps, 10000);
    return max(amount, minimumReserve) as coins;
}
fun counterparty_should_liquidate(state: CounterpartyPosition, fullPnl: int128, minimumReserve: coins): bool {
    assert (state.reserved >= 0 && state.pendingFunding >= 0 && state.collectedLoss >= 0
        && state.remainingEntitlement >= 0 && minimumReserve >= 0) throw ERR_COUNTERPARTY_VALUE;
    val liability = max(fullPnl as int, 0) + state.pendingFunding;
    // The physical reserve keeps its notional floor. Exhausted entitlement
    // independently retires a position even when surplus LP cash remains.
    return state.reserved <= liability + minimumReserve
        || min(state.reserved, state.remainingEntitlement) <= liability;
}
fun counterparty_plan_close(state: CounterpartyPosition, fullPnl: int128,
    closeSize: uint128, totalSize: uint128, userCash: coins, minimumReserve: coins, fundingDebt: coins): CounterpartyClosePlan {
    assert (totalSize > 0 && closeSize > 0 && closeSize <= totalSize && userCash >= 0 && fundingDebt >= 0) throw ERR_COUNTERPARTY_VALUE;
    // Unpaid funding cannot survive a partial close or be ignored while this
    // same position collects a funded price/funding claim from its LP.
    var forced = fundingDebt > 0 || counterparty_should_liquidate(state, fullPnl, minimumReserve);
    var closedSize = forced ? totalSize : closeSize;
    val fundingClaim = min(state.pendingFunding, min(state.reserved, state.remainingEntitlement));
    var remainingReserve: coins = 0;
    var remainingEntitlement: coins = 0;
    var closedEntitlement = state.remainingEntitlement - fundingClaim;
    if (!forced && closedSize < totalSize) {
        // Preserve the existing physical reserve fraction, after settling all
        // funding first. Closed capital rounds down and retained cash rounds up.
        remainingReserve = counterparty_ceil_div((state.reserved - fundingClaim) *
            ((totalSize - closedSize) as int), totalSize as int) as coins;
        val remainingFloor = counterparty_ceil_div(minimumReserve * ((totalSize - closedSize) as int), totalSize as int);
        if (remainingReserve <= remainingFloor) {
            forced = true; closedSize = totalSize; remainingReserve = 0;
        } else {
            // Funding consumes entitlement in full before its remainder is
            // allocated by quantity. Unused closed entitlement is retired.
            val availableEntitlement = state.remainingEntitlement - fundingClaim;
            closedEntitlement = availableEntitlement * (closedSize as int) / (totalSize as int);
            remainingEntitlement = (availableEntitlement - closedEntitlement) as coins;
        }
    }
    // TVM division floors signed values. Profit rounds down; a trader's loss
    // rounds away from zero. All products fit within the 257-bit arithmetic
    // bound because PnL and position sizes are signed/unsigned 128-bit values.
    val realized = ((fullPnl as int) * (closedSize as int) / (totalSize as int)) as int128;
    val priceProfit = max(realized as int, 0);
    val priceLoss = max(-(realized as int), 0);
    // Cap the gross positive claim BEFORE netting opposite price/funding loss.
    // Partial closes cannot spend the retained position's entitlement or cash.
    val fundedClaim = min(state.reserved - remainingReserve,
        min(fundingClaim + priceProfit, fundingClaim + closedEntitlement));
    val totalLoss = priceLoss + fundingDebt;
    val userProfit = max(fundedClaim - totalLoss, 0) as coins;
    val grossDebit = max(totalLoss - fundedClaim, 0);
    val userDebit = min(grossDebit, userCash) as coins;
    val unpaidLoss = (grossDebit - userDebit) as coins;
    val released = state.reserved - remainingReserve - userProfit;
    assert (released >= 0 && userProfit <= state.reserved
        && fundedClaim <= state.remainingEntitlement) throw ERR_COUNTERPARTY_VALUE;
    return CounterpartyClosePlan {
        state: CounterpartyPosition { reserved: remainingReserve, pendingFunding: 0,
            collectedLoss: state.collectedLoss + userDebit, remainingEntitlement },
        forceFullClose: forced, closedSize, realizedPnl: realized,
        userProfit, userDebit, lpReleased: released, unpaidLoss,
    };
}
// Invoke only after the RiskVault authenticates an actual position-scoped LP
// capital deposit. Moving a ledger number without the deposit is insufficient.
fun counterparty_credit_collected(state: CounterpartyPosition, amount: coins): CounterpartyPosition {
    assert (amount > 0 && amount <= state.collectedLoss) throw ERR_COUNTERPARTY_VALUE;
    return CounterpartyPosition { reserved: state.reserved + amount,
        pendingFunding: state.pendingFunding, collectedLoss: state.collectedLoss - amount,
        remainingEntitlement: state.remainingEntitlement };
}
