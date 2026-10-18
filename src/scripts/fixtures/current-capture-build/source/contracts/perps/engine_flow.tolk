tolk 1.5.0
import "engine_types"
import "engine_state"
import "engine_math"
import "engine_commit"
import "native_budget"
import "engine_echo"
import "engine_messages"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/risk/counterparty"
import "../shared/risk/settle"
import "../shared/oracle/evidence"
import "../shared/oracle/verdict"
import "@stdlib/gas-payments"

fun px_kept(ledger: JettonLedger): coins { return px_leg(ledger) + calculateGasFee(BASECHAIN, PX_HANDLER_GAS) + px_rv_target_value(); }
fun px_commit_value(ledger: JettonLedger): coins {
    return calculateGasFee(BASECHAIN, PX_HANDLER_GAS) + px_leg(ledger) + px_rv_settle_value(ledger)
        + calculateForwardFee(BASECHAIN, 5000, 8);
}
fun px_open_value(ledger: JettonLedger): coins {
    return calculateGasFee(BASECHAIN, PX_HANDLER_GAS * 2) + px_kept(ledger) + oracle_min_forward()
        + px_rv_target_value() + 4 * calculateForwardFee(BASECHAIN, 2000, 4);
}
fun px_exit_value(ledger: JettonLedger): coins {
    return calculateGasFee(BASECHAIN, 100000) + oracle_min_forward() + px_commit_value(ledger)
        + calculateForwardFee(BASECHAIN, 2000, 4);
}
fun px_refund(): JettonRefund {
    return {forwardGram: 0, payload: null, payloadBits: 0, payloadCells: 0, plain: true, keep: 0, spent: 0,
        bounceGas: PX_BOUNCE_GAS, tailGas: JETTON_REFUND_TAIL_GAS, owedCap: JETTON_OWED_CAP};
}
fun px_echo(kind: int, marketId: uint32, owner: address): PxEcho {
    return {kind, marketId, sentAt: blockchain.now(), owner, payer: owner, nonce: 0, gen: 0, deadline: 0, size: 0, limit: 0};
}
fun px_query(pool: address, queryId: uint64, e: PxEcho, mode: int) {
    createMessage({bounce: BounceMode.RichBounce, value: 0, dest: pool,
        body: OracleQuery {queryId, at: 0, echo: px_echo_cell(e)}}).send(mode);
}
fun px_request_status(s: PxStorage, b: PxBook, ledger: JettonLedger, owner: address, cmd: PxCommand, deposit: coins): int {
    val found = b.venues.load().markets.get(cmd.marketId);
    if (!found.isFound || !ledger.canPay(owner) || !ledger.coreReady() || blockchain.now() > cmd.deadline) { return PX_BAD_TERMS; }
    val key = px_position_key(owner, cmd.marketId); val pos = b.position(key);
    if (cmd.kind == 1 ? pos.size != 0 : pos.size == 0 || pos.gen != cmd.gen) { return PX_STALE; }
    if (cmd.kind == 4) { return deposit > 0 ? PX_OK : PX_BAD_TERMS; }
    if (b.pendings.exists(key) || b.settlements.exists(key)) { return PX_BUSY; }
    if (cmd.kind == 1 || cmd.kind == 2) {
        if (s.gate.withdrawalsOnly) { return PX_BUSY; }
        if (cmd.size == 0 || cmd.size == -(1 << 127) || cmd.limit == 0 || (cmd.kind == 1 && deposit == 0)
            || (cmd.kind == 2 && (cmd.size > 0) != (pos.size > 0))) { return PX_BAD_TERMS; }
        if (cmd.kind == 1 && (cmd.leverage < 1 || cmd.leverage > found.loadValue().load().params.load().maxLeverageBps)) { return PX_BAD_TERMS; }
    }
    if (cmd.kind == 3 && (cmd.amount == 0 || cmd.amount > pos.margin || deposit != 0)) { return PX_BAD_TERMS; }
    if (cmd.kind <= 2 && !b.has_admission_space(key)) { return PX_CAPACITY; }
    if (cmd.kind == 5 && (cmd.limit == 0 || (cmd.size != 0 && ((cmd.size > 0) != (pos.size > 0) || abs(cmd.size) > abs(pos.size))))) { return PX_BAD_TERMS; }
    return b.nextNonce < (1 << 64) - 2 ? PX_OK : PX_CAPACITY;
}
fun px_begin(mutate b: PxBook, ledger: JettonLedger, owner: address, cmd: PxCommand, deposit: coins): coins {
    val key = px_position_key(owner, cmd.marketId); val market = b.market(cmd.marketId); val nonce = b.fresh_nonce();
    val kept = px_kept(ledger);
    val terms = PxTerms {gen: cmd.kind == 1 ? nonce : cmd.gen, deadline: cmd.deadline, size: cmd.size, limit: cmd.limit,
        leverage: cmd.kind == 1 ? cmd.leverage : market.params.load().maxLeverageBps};
    b.add_pending(key, {owner, marketId: cmd.marketId, queryId: cmd.queryId, nonce, requestedAt: blockchain.now(), kind: cmd.kind,
        deposit, kept, terms: terms.toCell(), reservation: null});
    return kept;
}
fun px_pending_plan(b: PxBook, p: PxPending, price: coins): PxPlan {
    val market = b.market(p.marketId); val terms = p.terms.load(); val old = b.position(px_position_key(p.owner, p.marketId));
    if (blockchain.now() > terms.deadline || (p.kind == 1 ? old.size != 0 : old.size == 0 || old.gen != terms.gen)) { return px_refuse(old, PX_STALE); }
    return px_plan_open(market.params.load(), old, market.funding.load().index, terms.size, p.deposit, price, terms.limit, terms.leverage, b.feeBps, terms.gen);
}
fun px_reject(mutate b: PxBook, ledger: JettonLedger, peers: PxPeers, key: uint256, p: PxPending,
    value: coins, release: bool, reason: int, preempt: bool, old: PxPosition): bool {
    val leg = p.deposit == 0 ? 0 as coins : px_leg(ledger);
    val gas = calculateGasFee(BASECHAIN, PX_HANDLER_GAS);
    val need = gas + leg + (release ? px_rv_target_value() : 0 as coins) + calculateForwardFee(BASECHAIN, 2500, 4);
    if (value + p.kept < need || (release && b.nextNonce == (1 << 64) - 1)) { return false; }
    b.drop_pending(key, p);
    if (release) {
        createMessage({bounce: BounceMode.RichBounce, value: px_rv_target_value(), dest: peers.riskVault,
            body: RvTarget {actionId: b.fresh_nonce(), bucketId: peers.riskBucketId, positionId: key,
                notional: old.entryNotional, reserved: old.counterparty.load().reserved}}).send(SEND_MODE_PAY_FEES_SEPARATELY);
    }
    px_pay(ledger, p.owner, p.deposit, p.queryId, leg);
    px_event(8, reason, p.owner, p.marketId, p.queryId, px_refuse(old, reason), old);
    if (preempt) {
        val unused = max(p.kept - gas - leg - calculateForwardFee(BASECHAIN, 2500, 4), 0);
        if (unused > 0) { createMessage({bounce: BounceMode.NoBounce, value: unused, dest: p.owner, body: createEmptyCell()}).send(SEND_MODE_PAY_FEES_SEPARATELY); }
    }
    return true;
}
fun px_finish_reject(s0: PxStorage, b0: PxBook, ledger: JettonLedger, key: uint256, p: PxPending, value: coins, release: bool, reason: int) {
    var s = s0; var b = b0;
    if (px_reject(mutate b, ledger, s.peers.load(), key, p, value, release, reason, false, b.position(key))) {
        s.book = b.toCell(); s.dispatch(p.deposit); s.save(); px_reserve(value, -p.kept); px_return(p.owner);
    } else { s.book = b.toCell(); s.save(); px_reserve(value, 0); px_return(p.owner); }
}
fun px_oracle_result(sender: address, value: coins, body: slice) {
    if (body.remainingBitsCount() != 96 || body.remainingRefsCount() != 2) { return; }
    val reply = OracleResult.fromSlice(body); val decoded = px_echo_decode(reply.echo);
    if (decoded == null) { return; } val echo = decoded!;
    var s = PxStorage.load(); var b = s.book.load(); val entry = b.venues.load().markets.get(echo.marketId);
    if (!entry.isFound || entry.loadValue().load().pool != sender) { return; }
    var market = entry.loadValue().load(); val ledger = s.ledger(); val peers = s.peers.load();
    val (valid, evidence) = evidence_decode(reply.evidence);
    if (valid) { market.funding = px_observe(market.funding.load(), market.params.load(), evidence, blockchain.now()).toCell(); b.put_market(echo.marketId, market); }
    val key = px_position_key(echo.owner, echo.marketId);
    if (echo.kind == PX_ECHO_PENDING) {
        val found = b.pendings.get(key);
        if (!found.isFound) { s.book = b.toCell(); s.save(); px_reserve(value, 0); px_return(echo.owner); return; }
        val p = found.loadValue().load();
        if (p.nonce != echo.nonce || p.requestedAt != echo.sentAt || p.queryId != reply.queryId || p.reservation != null) {
            s.book = b.toCell(); s.save(); px_reserve(value, 0); px_return(echo.owner); return;
        }
        var reason = PX_OK;
        if (!valid || !oracle_request_live(echo.sentAt, blockchain.now()) || !verdict_admission(evidence, blockchain.now())) { reason = PX_ORACLE; }
        if (b.settlements.exists(key) || s.gate.withdrawalsOnly) { reason = PX_BUSY; }
        val price = verdict_fill(evidence, p.terms.load().size > 0) as coins;
        val plan = reason == PX_OK ? px_pending_plan(b, p, price) : px_refuse(b.position(key), reason);
        if (plan.status != PX_OK) { reason = plan.status; }
        val totals = market.totals.load();
        if (totals.longOi + totals.shortOi + totals.pending + plan.notionalDelta > market.params.load().oiCap || !b.has_commit_space(key)) { reason = PX_CAPACITY; }
        if (value < calculateGasFee(BASECHAIN, PX_HANDLER_GAS) + px_rv_target_value()
            + calculateForwardFee(BASECHAIN, 2500, 4)) { reason = PX_FUNDING; }
        if (reason != PX_OK) { px_finish_reject(s, b, ledger, key, p, value, false, reason); return; }
        var pending = p; val old = b.position(key);
        pending.reservation = PxReservation {servedAt: evidence.servedAt, oraclePrice: price, notional: plan.notionalDelta as coins,
            basisNotional: old.entryNotional, basisReserved: old.counterparty.load().reserved,
            targetNotional: plan.position.entryNotional, targetReserved: plan.position.counterparty.load().reserved}.toCell();
        b.pendings.set(key, pending.toCell()); var updated = market.totals.load(); updated.pending += plan.notionalDelta;
        market.totals = updated.toCell(); b.put_market(p.marketId, market); s.book = b.toCell(); s.save();
        createMessage({bounce: BounceMode.RichBounce, value: 0, dest: peers.riskVault,
            body: RvTarget {actionId: p.nonce, bucketId: peers.riskBucketId, positionId: key,
                notional: plan.position.entryNotional, reserved: plan.position.counterparty.load().reserved}}).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    if (echo.kind == PX_ECHO_REFRESH) { s.book = b.toCell(); s.save(); px_reserve(value, 0); px_return(echo.payer); return; }
    val old = b.position(key); var reason = PX_OK;
    if (!valid || !oracle_request_live(echo.sentAt, blockchain.now()) || !(echo.kind == PX_ECHO_REMOVE ? verdict_admission(evidence, blockchain.now()) : verdict_exit(evidence, blockchain.now()))) { reason = PX_ORACLE; }
    if (old.size == 0 || old.gen != echo.gen || (echo.kind != PX_ECHO_LIQUIDATE && blockchain.now() > echo.deadline)) { reason = PX_STALE; }
    if (b.settlements.exists(key) || (echo.kind != PX_ECHO_LIQUIDATE && b.pendings.exists(key))) { reason = PX_BUSY; }
    val kind = echo.kind == PX_ECHO_LIQUIDATE ? 2 : echo.kind == PX_ECHO_FUNDING ? 3 : 1;
    val plan = reason == PX_OK ? (echo.kind == PX_ECHO_REMOVE
        ? px_plan_remove(market.params.load(), old, market.funding.load().index, echo.size as coins, verdict_fill(evidence, old.size > 0) as coins)
        : px_plan_close(market.params.load(), old, market.funding.load().index, echo.size,
        verdict_fill(evidence, old.size < 0) as coins, evidence.short as coins, echo.limit, kind, b.feeBps)) : px_refuse(old, reason);
    if (plan.status != PX_OK) { reason = plan.status; }
    val pending = b.pendings.get(key); var release: coins = 0; var dispatched = plan.payout;
    var extra: coins = 0;
    if (echo.kind == PX_ECHO_LIQUIDATE && pending.isFound) {
        val p = pending.loadValue().load();
        extra = max(calculateGasFee(BASECHAIN, PX_HANDLER_GAS) + (p.deposit > 0 ? px_leg(ledger) : 0 as coins)
            + calculateForwardFee(BASECHAIN, 2500, 4) - p.kept, 0);
    }
    if (value < px_commit_value(ledger) + extra || b.nextNonce == (1 << 64) - 1) { reason = PX_FUNDING; }
    if (reason != PX_OK) {
        s.book = b.toCell(); s.save(); px_reserve(value, 0); px_event(8, reason, echo.owner, echo.marketId, reply.queryId, px_refuse(old, reason), old); px_return(echo.payer); return;
    }
    if (echo.kind == PX_ECHO_LIQUIDATE && pending.isFound) {
        val p = pending.loadValue().load();
        if (!px_reject(mutate b, ledger, peers, key, p, value, false, PX_LIQUIDATABLE, true, old)) { return; }
        release = p.kept; dispatched += p.deposit;
    }
    px_close_commit(mutate b, peers, ledger, key, echo.owner, echo.marketId, reply.queryId, old, plan, px_leg(ledger));
    s.book = b.toCell(); s.dispatch(dispatched); s.save(); px_reserve(value, -release);
    px_event(echo.kind == PX_ECHO_REMOVE ? 4 : kind == 2 ? 6 : kind == 3 ? 7 : 5, 0, echo.owner, echo.marketId, reply.queryId, plan, old); px_return(echo.payer);
}
fun px_target_answer(sender: address, value: coins, body: slice) {
    var s = PxStorage.load(); val peers = s.peers.load(); if (sender != peers.riskVault) { return; }
    val msg = RvTargetAnswer.fromSlice(body); var b = s.book.load(); val found = b.pendings.get(msg.positionId);
    if (msg.bucketId != peers.riskBucketId || !found.isFound) { return; }
    val p = found.loadValue().load(); if (p.nonce != msg.actionId || p.reservation == null) { return; }
    val r = p.reservation!.load(); val old = b.position(msg.positionId); val ledger = s.ledger();
    var reason = PX_OK;
    if (msg.status != RV_TARGET_APPLIED || msg.notional != r.targetNotional || msg.reserved != r.targetReserved) { reason = PX_CAP; }
    if (s.gate.withdrawalsOnly || b.settlements.exists(msg.positionId)) { reason = PX_BUSY; }
    if (blockchain.now() - r.servedAt > 60 || old.entryNotional != r.basisNotional || old.counterparty.load().reserved != r.basisReserved) { reason = PX_STALE; }
    if (!b.has_commit_space(msg.positionId) || (old.size == 0 && b.positionCount >= PX_POSITION_CAP)) { reason = PX_CAPACITY; }
    val plan = reason == PX_OK ? px_pending_plan(b, p, r.oraclePrice) : px_refuse(old, reason);
    if (plan.status != PX_OK) { reason = plan.status; }
    val market = b.market(p.marketId); val totals = market.totals.load();
    if (totals.longOi + totals.shortOi + totals.pending > market.params.load().oiCap || plan.position.entryNotional != r.targetNotional || plan.position.counterparty.load().reserved != r.targetReserved) { reason = PX_CAP; }
    if (value < calculateGasFee(BASECHAIN, PX_HANDLER_GAS) + calculateForwardFee(BASECHAIN, 2500, 4)) { reason = PX_FUNDING; }
    if (reason != PX_OK) { px_finish_reject(s, b, ledger, msg.positionId, p, value, msg.status == RV_TARGET_APPLIED, reason); return; }
    b.drop_pending(msg.positionId, p); b.apply_plan(msg.positionId, old, plan, p.marketId);
    s.book = b.toCell(); s.save(); px_reserve(value, -p.kept); px_event(p.kind == 1 ? 1 : 2, 0, p.owner, p.marketId, p.queryId, plan, old); px_return(p.owner);
}
