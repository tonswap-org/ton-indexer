tolk 1.5.0
import "@gen/op/perps"

import "engine_state"
import "engine_types"
import "../shared/jetton/jetton_slots"
import "../shared/risk/settle"
import "../shared/risk/counterparty"
import "@stdlib/gas-payments"

import "native_budget"

fun px_reserve(value: coins, delta: int) {
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value + delta, 0), RESERVE_MODE_AT_MOST);
}
fun px_return(to: address) {
    createMessage({bounce: BounceMode.NoBounce, value: 0, dest: to, body: createEmptyCell()})
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun px_pay(ledger: JettonLedger, owner: address, amount: coins, queryId: uint64, leg: coins) {
    if (amount > 0) { ledger.sendTransfer(0, {queryId, amount, destination: owner, excessTo: owner,
        forwardGram: 0, forwardPayload: null}, leg, SEND_MODE_PAY_FEES_SEPARATELY); }
}
fun px_event(kind: int, reason: int, owner: address, marketId: uint32, queryId: uint64, plan: PxPlan, old: PxPosition) {
    val detail = beginCell().storeInt(plan.position.size, 128).storeCoins(plan.fillPrice)
        .storeInt(plan.position.margin - old.margin, 128).storeCoins(plan.fee)
        .storeCoins(plan.lpPayout).storeCoins(plan.unpaidLoss).endCell();
    createExternalLogMessage({dest: createAddressNone(), body: beginCell().storeUint(OP_PX_EVENT, 32)
        .storeUint(kind, 8).storeUint(reason, 16).storeAddress(owner).storeUint(marketId, 32)
        .storeUint(queryId, 64).storeRef(detail).endCell()}).send(SEND_MODE_IGNORE_ERRORS);
}
// Economic effects are applied once, before any action. A failed required send
// rolls these effects back; retries always use the exact stored RVST body.
fun px_close_commit(mutate b: PxBook, peers: PxPeers, ledger: JettonLedger,
    key: uint256, owner: address, marketId: uint32, queryId: uint64, old: PxPosition, plan: PxPlan, leg: coins) {
    b.apply_plan(key, old, plan, marketId);
    val next = plan.position.counterparty.load();
    val prior = old.counterparty.load();
    if (plan.lpPayout > 0 || old.entryNotional != plan.position.entryNotional || prior.reserved != next.reserved) {
        val body = RvSettle {actionId: b.fresh_nonce(), bucketId: peers.riskBucketId,
            positionId: key, payout: plan.lpPayout, notional: plan.position.entryNotional,
            reserved: next.reserved, recipient: owner}.toCell();
        b.add_settlement(key, PxSettlement {marketId, queryId, gen: old.gen, body});
        createMessage({bounce: BounceMode.Only256BitsOfBody, value: px_rv_settle_value(ledger), dest: peers.riskVault, body})
            .send(SEND_MODE_PAY_FEES_SEPARATELY);
    }
    px_pay(ledger, owner, plan.payout, queryId, leg);
}
