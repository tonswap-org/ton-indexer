tolk 1.5.0
import "@gen/op/tep";
import "@gen/op/jetton"
import "@gen/op/oracle"
import "@gen/op/perps"
import "@gen/op/risk"
import "engine_types"
import "engine_state"
import "engine_math"
import "engine_commit"
import "native_budget"
import "engine_echo"
import "engine_messages"
import "engine_flow"
import "engine_recovery"
import "../shared/jetton/holder_recovery"
import "../t3/recovery_types"
import "../t3/receipt_tree"
import "@gen/op/t3"
import "../shared/governance/module_gate"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/jetton/jetton_sweep"
import "../shared/risk/counterparty"
import "../shared/risk/settle"
import "../shared/oracle/evidence"
import "../shared/utils/rich_bounce"
import "../treasury/fee_router_quote"
import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"

fun px_is_peer(s: PxStorage, a: address): bool {
    val p = s.peers.load(); if (a == s.gate.governance || a == p.feeSink || a == p.riskVault || a == p.treasury) { return true; }
    var e = s.book.load().venues.load().markets.findFirst();
    while (e.isFound) { if (a == e.loadValue().load().pool) { return true; } e = s.book.load().venues.load().markets.iterateNext(e); }
    return false;
}
fun px_min_value(ledger: JettonLedger, op: int): coins {
    if (op == OP_DISCOVER_WALLETS) { return ledger.minDiscover() + calculateForwardFee(BASECHAIN, 1000, 2); }
    if (op == OP_PX_INCREASE) { return px_open_value(ledger); }
    if (op == OP_PX_REMOVE_MARGIN || op == OP_PX_CLOSE || op == OP_PX_CLAIM_FUNDING || op == OP_PERPS_LIQUIDATE) { return px_exit_value(ledger); }
    if (op == OP_PERPS_REFRESH) { return calculateGasFee(BASECHAIN, 200000) + oracle_min_forward() + calculateForwardFee(BASECHAIN, 2000, 4); }
    if (op == OP_PX_RESYNC) { return calculateGasFee(BASECHAIN, 100000) + px_rv_target_value() + calculateForwardFee(BASECHAIN, 2000, 4); }
    if (op == OP_SETTLE_RETRY) { return calculateGasFee(BASECHAIN, 100000) + px_rv_settle_value(ledger) + calculateForwardFee(BASECHAIN, 2000, 4); }
    if (op == OP_PX_FLUSH || op == OP_HOLDER_FEE_SWEEP) {
        val forward = op == OP_HOLDER_FEE_SWEEP ? fee_router_min_forward() : ledger.refundFloor(0, px_refund(), 40000);
        return calculateGasFee(BASECHAIN, 100000) + ledger.legValue(0, forward, 48, 1, PX_BOUNCE_GAS) + calculateForwardFee(BASECHAIN, 1000, 2);
    }
    if (op == OP_CLAIM_OWED) { return max(ledger.jetton_min_claim(0, PX_BOUNCE_GAS), calculateGasFee(BASECHAIN, PX_HANDLER_GAS)); }
    if (op == OP_CLAIM_ARCHIVED) { return max(ledger.jetton_min_archive_claim(0, PX_BOUNCE_GAS), calculateGasFee(BASECHAIN, PX_HANDLER_GAS)); }
    if (op == OP_SWEEP_PROBE) { return ledger.jetton_min_sweep(0, PX_BOUNCE_GAS); }
    return calculateGasFee(BASECHAIN, PX_HANDLER_GAS) + calculateForwardFee(BASECHAIN, 2000, 4);
}
fun on_credit_perps(sender: address, value: coins, body: slice) {
    var s = PxStorage.load(); var ledger = s.ledger(); var sweeps = s.sweeps.load();
    val protection = s.jetton.load().recovery.get(0);
    val ingress = JettonSweeps.onNotification(mutate sweeps, ledger, sender, body, protection != null ? protection! as cell : null);
    assert (ingress.kind != 0 || protection == null) throw ERR_JETTON_RECOVERY;
    if (ingress.dirty) { s.sweeps = sweeps.toCell(); }
    if (ingress.kind != 1 || ingress.credit!.claimReceipt) {
        if (ingress.kind == 2) { if (jetton_sweep_pay(mutate ledger, ingress, s.peers.load().treasury, value, 0, null) != 0) { s.dispatch(ingress.pay); } s.setLedger(ledger); s.save(); }
        else { if (ingress.dirty) { s.save(); } if (ingress.kind == 1) { jetton_bounce_excess(ingress.credit!.from, ingress.credit!.queryId, value, 0); } }
        return;
    }
    val credit = ingress.credit!; s.handled(credit.amount); val command = credit.payloadOk ? px_command_decode(credit.payload) : null;
    var b = s.book.load(); var reason = PX_BAD_TERMS;
    if (command != null && (command.kind == 1 || command.kind == 2 || command.kind == 4)) {
        reason = px_request_status(s, b, ledger, credit.from, command!, credit.amount);
        val minimum = command.kind == 4 ? calculateGasFee(BASECHAIN, PX_HANDLER_GAS) : px_open_value(ledger);
        if (value < minimum) { reason = PX_FUNDING; }
    }
    if (reason != PX_OK) {
        val result = ledger.refundOrOwe(credit, credit.from, value, px_refund(), reason as uint8);
        assert (result != 0 || protection == null) throw ERR_JETTON_RECOVERY;
        if (result == 1 || result == 2) { s.dispatch(credit.amount); }
        s.setLedger(ledger); s.save(); return;
    }
    val cmd = command!; val key = px_position_key(credit.from, cmd.marketId);
    if (cmd.kind == 4) {
        val old = b.position(key); var plan = px_refuse(old, PX_OK); plan.position.margin += credit.amount;
        b.apply_plan(key, old, plan, cmd.marketId); s.book = b.toCell(); s.save();
        px_reserve(value, 0); px_event(3, 0, credit.from, cmd.marketId, cmd.queryId, plan, old); px_return(credit.from); return;
    }
    val kept = px_begin(mutate b, ledger, credit.from, cmd, credit.amount); val p = b.pendings.mustGet(key, 9032).load();
    s.book = b.toCell(); s.save(); px_reserve(value, kept);
    var echo = px_echo(PX_ECHO_PENDING, cmd.marketId, credit.from); echo.nonce = p.nonce;
    px_query(b.market(cmd.marketId).pool, cmd.queryId, echo, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun px_settled(sender: address, value: coins, body: slice) {
    var s = PxStorage.load(); val peers = s.peers.load(); if (sender != peers.riskVault) { return; }
    val msg = RvSettled.fromSlice(body); var b = s.book.load(); val found = b.settlements.get(msg.positionId);
    if (msg.bucketId != peers.riskBucketId || !found.isFound) { return; }
    val record = found.loadValue().load(); val expected = record.body.load(); if (msg.actionId != expected.actionId) { return; }
    b.drop_settlement(msg.positionId); s.book = b.toCell(); s.save(); px_reserve(value, 0);
    val old = b.position(msg.positionId); var event = px_refuse(old, 0); event.lpPayout = msg.paid;
    px_event(9, 0, expected.recipient, record.marketId, record.queryId, event, old);
    if (msg.paid < expected.payout) { event.unpaidLoss = expected.payout - msg.paid; px_event(10, 0, expected.recipient, record.marketId, record.queryId, event, old); }
    if (!msg.applied) { px_event(11, 0, expected.recipient, record.marketId, record.queryId, event, old); }
    px_return(expected.recipient);
}
fun on_bounce_perps(sender: address, value: coins, body: slice) {
    var s = PxStorage.load(); var ledger = s.ledger(); var sweeps = s.sweeps.load();
    val result = JettonSweeps.onBounce(mutate sweeps, ledger, sender, body);
    if (result.dirty) { s.sweeps = sweeps.toCell(); }
    val bounced = result.b;
    if (result.probe || bounced.kind == 1) {
        if (result.probe) { if (result.dirty) { s.save(); } jetton_bounce_excess(bounced.excessTo, bounced.queryId, value, 0); return; }
        val command: JettonSourceFailure = { queryId:bounced.queryId, amount:bounced.amount,
            destination:bounced.destination!, excessTo:bounced.excessTo!, claimReceipt:bounced.claimReceipt, payload:bounced.payload };
        px_source_failure(mutate s, mutate ledger, command, value, JETTON_OWED_CAP);
        s.restored(bounced.amount); s.setLedger(ledger); s.save(); return;
    }
    if (result.dirty) { s.save(); }
    if (!rich_bounce_is_canonical(body)) { return; }
    val rich = RichBounceBody.fromSlice(body); var (original, exotic) = rich.originalBody.beginParseSpecial();
    if (exotic || original.remainingBitsCount() < 32) { return; } val op = original.preloadUint(32); var b = s.book.load();
    if (op == OP_ORACLE_QUERY && original.remainingBitsCount() == 160 && original.remainingRefsCount() == 1) {
        val query = OracleQuery.fromSlice(original); val decoded = px_echo_decode(query.echo); if (decoded == null) { return; } val echo = decoded!;
        val found = b.venues.load().markets.get(echo.marketId); if (!found.isFound || found.loadValue().load().pool != sender) { return; }
        if (echo.kind != PX_ECHO_PENDING) { px_reserve(value, 0); px_return(echo.payer); return; }
        val key = px_position_key(echo.owner, echo.marketId); val pending = b.pendings.get(key); if (!pending.isFound) { return; }
        val p = pending.loadValue().load(); if (p.nonce != echo.nonce || p.queryId != query.queryId || p.requestedAt != echo.sentAt || p.reservation != null) { return; }
        px_finish_reject(s, b, ledger, key, p, value, false, PX_ORACLE); return;
    }
    if (op == OP_RV_TARGET && sender == s.peers.load().riskVault && original.remainingBitsCount() >= 376 && original.remainingRefsCount() == 0) {
        original.skipBits(32); val nonce = original.loadUint(64); val bucket = original.loadUint(16); val key = original.loadUint(256);
        val notional = original.tryLoadCoins(); val reserved = original.tryLoadCoins();
        if (notional == null || reserved == null || !original.isEmpty() || bucket != s.peers.load().riskBucketId) { return; }
        val found = b.pendings.get(key); if (!found.isFound) { return; } val p = found.loadValue().load();
        if (p.nonce != nonce || p.reservation == null) { return; } val r = p.reservation!.load();
        if (r.targetNotional != notional || r.targetReserved != reserved) { return; }
        px_finish_reject(s, b, ledger, key, p, value, false, PX_CAP); return;
    }
}
fun handle_perps(sender: address, value: coins, body: slice) {
    val op = body.preloadUint(32); var s = PxStorage.load(); var b = s.book.load(); var ledger = s.ledger(); val peers = s.peers.load();
    assert (value >= px_min_value(ledger, op)) throw 9030;
    if (gate_handle(mutate s.gate, sender, body)) { s.save(); px_reserve(value, 0); px_return(sender); return; }
    if (op == OP_DISCOVER_WALLETS) { val msg = DiscoverWallets.fromSlice(body); px_reserve(value, 0); ledger.discover(); px_return(sender); return; }
    if (op == OP_CLAIM_OWED) { val msg = ClaimOwed.fromSlice(body); val before = ledger.owedTotal(msg.slot); ledger.claim(msg.slot, msg.owner, msg.queryId, sender, value, false, PX_BOUNCE_GAS, 0); s.dispatch(before - ledger.owedTotal(msg.slot)); s.setLedger(ledger); s.save(); return; }
    if (op == OP_CLAIM_ARCHIVED) { val msg = ClaimArchived.fromSlice(body); ledger.claimArchived(msg, sender, value, false, PX_BOUNCE_GAS, 0); s.dispatch(msg.amount); s.setLedger(ledger); s.save(); return; }
    if (op == OP_SWEEP_ALLOW) { gate_require_governance(s.gate, sender); val msg = SweepAllow.fromSlice(body); var sweeps = s.sweeps.load(); sweeps.allow(ledger, msg.slot, msg.amount); s.sweeps = sweeps.toCell(); s.save(); px_reserve(value, 0); px_return(sender); return; }
    if (op == OP_SWEEP_PROBE) { val msg = SweepProbe.fromSlice(body); var sweeps = s.sweeps.load(); sweeps.probe(ledger, msg.slot, s.liabilities(), sender, value, PX_BOUNCE_GAS, s.jetton.load().recovery.reconciliation(msg.slot)); s.sweeps = sweeps.toCell(); s.save(); return; }
    if (op == OP_PX_CONFIG) { gate_require_governance(s.gate, sender); val msg = PxConfig.fromSlice(body); assert (msg.feeBps <= 1000) throw 9031; b.feeBps = msg.feeBps; s.book = b.toCell(); s.save(); px_reserve(value, 0); px_return(sender); return; }
    if (op == OP_PX_MARKET || op == OP_PX_MARKET_UPDATE) {
        gate_require_governance(s.gate, sender); var marketId: uint32 = 0; var pool = sender; var params = PxParams {depthUnit: 0, oiCap: 0, impactAlpha: 0, impactBeta: 0, maxLeverageBps: 0, maintenanceBps: 0, fundingCapBps: 0};
        if (op == OP_PX_MARKET) { val msg = PxMarketRegister.fromSlice(body); marketId = msg.marketId; pool = msg.pool; params = msg.params.load(); }
        else { val msg = PxMarketUpdate.fromSlice(body); marketId = msg.marketId; params = msg.params.load(); }
        val old = b.venues.load().markets.get(marketId);
        assert (marketId >= 1 && marketId <= 4 && px_params_valid(params) && (op == OP_PX_MARKET ? !old.isFound && ledger.canPay(pool) && !px_is_peer(s, pool) : old.isFound)) throw 9032;
        var cap = params.oiCap; var entries = b.venues.load().markets.findFirst(); while (entries.isFound) { if (entries.getKey() != marketId) { cap += entries.loadValue().load().params.load().oiCap; } entries = b.venues.load().markets.iterateNext(entries); } assert (cap <= 22500000000) throw 9033;
        val market = old.isFound ? old.loadValue().load() : PxMarket {pool, params: params.toCell(), totals: PxMarketTotals {longOi: 0, shortOi: 0, pending: 0}.toCell(), funding: PxFunding {index: 0, remainder: 0, rate: 0, accruedAt: 0, observedAt: 0, validUntil: 0}.toCell()};
        var updated = market; updated.params = params.toCell(); b.put_market(marketId, updated); s.book = b.toCell(); s.save(); px_reserve(value, 0); px_return(sender); return;
    }
    if (op == OP_PX_FLUSH || op == OP_HOLDER_FEE_SWEEP) {
        if (op == OP_PX_FLUSH) { val msg = PxFlush.fromSlice(body); assert (b.lossPending > 0 && ledger.coreReady()) throw 9034; val amount = b.lossPending; b.lossPending = 0;
            s.book = b.toCell(); s.dispatch(amount); s.save(); px_reserve(value, 0); ledger.sendTransfer(0, {queryId: msg.queryId, amount, destination: peers.riskVault, excessTo: sender, forwardGram: ledger.refundFloor(0, px_refund(), 40000), forwardPayload: RvDeposit {bucketId: peers.riskBucketId}.toCell()}, 0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL); return; }
        val msg = HolderFeeSweep.fromSlice(body); assert (b.feesAccrued >= 1000000000 && ledger.coreReady()) throw 9034; val amount = b.feesAccrued; b.feesAccrued = 0;
        s.book = b.toCell(); s.dispatch(amount); s.save(); px_reserve(value, 0); ledger.sendTransfer(0, {queryId: msg.queryId, amount, destination: peers.feeSink, excessTo: sender, forwardGram: fee_router_min_forward(), forwardPayload: beginCell().storeUint(OP_HOLDER_FEE_SWEEP, 32).endCell()}, 0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL); return;
    }
    if (op == OP_PERPS_EXPIRE_OPEN) { val msg = PerpsExpireOpen.fromSlice(body); val key = px_position_key(msg.owner, msg.marketId); val p = b.pendings.mustGet(key, 9035).load();
        assert (blockchain.now() >= p.requestedAt + 60 && (p.reservation == null || blockchain.now() > p.reservation!.load().servedAt + 60)) throw 9035;
        px_finish_reject(s, b, ledger, key, p, value, p.reservation != null, PX_STALE); return; }
    if (op == OP_SETTLE_RETRY) { val msg = SettleRetry.fromSlice(body); val exact = b.settlements.mustGet(msg.positionId, 9036).load().body;
        createMessage({bounce: BounceMode.Only256BitsOfBody, dest: peers.riskVault, value: 0, body: exact}).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL); return; }
    if (op == OP_PX_RESYNC) { val msg = PxResync.fromSlice(body); val key = px_position_key(msg.owner, msg.marketId); assert (!b.pendings.exists(key) && !b.settlements.exists(key)) throw 9037; val pos = b.position(key);
        val target = RvTarget {actionId: b.fresh_nonce(), bucketId: peers.riskBucketId, positionId: key, notional: pos.entryNotional, reserved: pos.counterparty.load().reserved}; s.book = b.toCell(); s.save();
        createMessage({bounce: BounceMode.RichBounce, dest: peers.riskVault, value: 0, body: target}).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL); return; }
    if (op == OP_PERPS_REFRESH || op == OP_PERPS_LIQUIDATE) {
        var marketId: uint32 = 0; var owner = sender; if (op == OP_PERPS_REFRESH) { val msg = PerpsRefresh.fromSlice(body); marketId = msg.marketId; } else { val msg = PerpsLiquidate.fromSlice(body); marketId = msg.marketId; owner = msg.owner; }
        val market = b.market(marketId); var echo = px_echo(op == OP_PERPS_REFRESH ? PX_ECHO_REFRESH : PX_ECHO_LIQUIDATE, marketId, owner); echo.payer = sender;
        if (op == OP_PERPS_LIQUIDATE) { val key = px_position_key(owner, marketId); val pos = b.position(key); assert (pos.size != 0 && !b.settlements.exists(key)) throw 9038; echo.gen = pos.gen; }
        var head = body; head.skipBits(32); px_query(market.pool, head.loadUint(64), echo, SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL); return;
    }
    val decoded = px_command_decode(body); assert (decoded != null) throw 9039; val cmd = decoded!;
    assert ((cmd.kind == 2 || cmd.kind == 3 || cmd.kind == 5 || cmd.kind == 6) && px_request_status(s, b, ledger, sender, cmd, 0) == PX_OK) throw 9039;
    if (cmd.kind <= 2) {
        val kept = px_begin(mutate b, ledger, sender, cmd, 0); val p = b.pendings.mustGet(px_position_key(sender, cmd.marketId), 9032).load();
        s.book = b.toCell(); s.save(); px_reserve(value, kept); var echo = px_echo(PX_ECHO_PENDING, cmd.marketId, sender); echo.nonce = p.nonce;
        px_query(b.market(cmd.marketId).pool, cmd.queryId, echo, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL); return;
    }
    var echo = px_echo(cmd.kind == 3 ? PX_ECHO_REMOVE : cmd.kind == 5 ? PX_ECHO_EXIT : PX_ECHO_FUNDING, cmd.marketId, sender); echo.gen = cmd.gen; echo.deadline = cmd.deadline; echo.size = cmd.kind == 3 ? cmd.amount as int128 : cmd.size; echo.limit = cmd.limit;
    px_query(b.market(cmd.marketId).pool, cmd.queryId, echo, SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } if (in.body.remainingBitsCount() < 32) { throw 9039; } val op = in.body.preloadUint(32);
    if (op == OP_T3_NOTIFICATION_CERTIFICATE || op == OP_T3_FAILURE_CERTIFICATE) { px_recovery_accept(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_JETTON_RECOVERY_CLAIM) { px_recovery_claim(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit_perps(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { var s = PxStorage.load(); var ledger = s.ledger(); val take = ledger.checkTake(in.senderAddress, in.body); if (take == null || px_is_peer(s, take.wallet)) { return; } ledger.commitTake(take); s.setLedger(ledger); s.save(); return; }
    if (oracle_is_result(in.body)) { px_oracle_result(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_RV_TARGET_ANSWER) { px_target_answer(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_RV_SETTLED) { px_settled(in.senderAddress, in.valueCoins, in.body); return; }
    handle_perps(in.senderAddress, in.valueCoins, in.body);
}
fun onBouncedMessage(in: InMessageBounced) { on_bounce_perps(in.senderAddress, in.valueCoins, in.bouncedBody); }
get fun get_state(): cell { return contract.getData(); }
get fun get_min_value(op: uint32): coins { return px_min_value(PxStorage.load().ledger(), op); }
get fun get_min_forward(op: uint32, slot: uint8): coins {
    val ledger = PxStorage.load().ledger(); return max(op == OP_PX_ADD_MARGIN ? calculateGasFee(BASECHAIN, PX_HANDLER_GAS) : px_open_value(ledger), ledger.refundFloor(slot, px_refund(), 100000));
}
get fun get_position(owner: address, marketId: uint32): PxPosition { return PxStorage.load().book.load().position(px_position_key(owner, marketId)); }
get fun get_pending_open(owner: address, marketId: uint32): cell? { val p = PxStorage.load().book.load().pendings.get(px_position_key(owner, marketId)); return p.isFound ? p.loadValue() : null; }
get fun get_pending_settle(key: uint256): cell? { val p = PxStorage.load().book.load().settlements.get(key); return p.isFound ? p.loadValue() : null; }
get fun get_jetton_slots(): map<uint8, JettonSlot> { return PxStorage.load().ledger().slots; }
get fun get_owed(slot: uint8, owner: address): coins { return PxStorage.load().ledger().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) { val ledger = PxStorage.load().ledger(); return (ledger.owedTotal(slot), ledger.owedCount(slot)); }
get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return PxStorage.load().ledger().owedArchive(slot); }
get fun get_min_claim(slot: uint8): coins { return max(PxStorage.load().ledger().jetton_min_claim(slot, PX_BOUNCE_GAS), px_min_value(PxStorage.load().ledger(), 0)); }
get fun get_min_archive_claim(slot: uint8): coins { return max(PxStorage.load().ledger().jetton_min_archive_claim(slot, PX_BOUNCE_GAS), px_min_value(PxStorage.load().ledger(), 0)); }
get fun get_jetton_liabilities(slot: uint8): coins { return slot == 0 ? PxStorage.load().liabilities() : 0; }
get fun get_unattributed_surplus(slot: uint8, balance: coins, protectedCredits: int?, acceptedTransfers: int?): (int, int, int) { val due = get_jetton_liabilities(slot) + PxStorage.load().jetton.load().recovery.excluded(slot, protectedCredits, acceptedTransfers); return (due, max(balance - due, 0), max(due - balance, 0)); }
get fun get_sweep(slot: uint8): SweepSlot { return PxStorage.load().sweeps.load().get(slot); }
get fun get_min_sweep(slot: uint8): coins { return PxStorage.load().ledger().jetton_min_sweep(slot, PX_BOUNCE_GAS); }
get fun get_gate(): (address, bool) { val g = PxStorage.load().gate; return (g.governance, g.withdrawalsOnly); }
get fun get_peers(): PxPeers { return PxStorage.load().peers.load(); }
get fun get_markets(): map<uint32, Cell<PxMarket>> { return PxStorage.load().book.load().venues.load().markets; }
get fun get_market(marketId: uint32): cell? {
    val m = PxStorage.load().book.load().venues.load().markets.get(marketId); return m.isFound ? m.loadValue() : null;
}
get fun get_risk_target(owner: address, marketId: uint32): (coins, coins, bool, bool) {
    val b = PxStorage.load().book.load(); val key = px_position_key(owner, marketId); val p = b.position(key);
    return (p.entryNotional, p.counterparty.load().reserved, b.pendings.exists(key), b.settlements.exists(key));
}
get fun get_ledger(): (coins, coins, coins, coins, coins, coins, coins) {
    val s = PxStorage.load(); val b = s.book.load(); return (b.marginLiability, b.pendingDeposits,
        b.feesAccrued, b.lossPending, b.collectedLossHeld, s.ledger().owedTotal(0), b.nativeKept);
}
get fun get_exposure_cap(): (coins, coins, coins, coins) {
    val b = PxStorage.load().book.load(); var cap: coins = 0; var used: coins = 0; var pending: coins = 0;
    var m = b.venues.load().markets.findFirst();
    while (m.isFound) { val market = m.loadValue().load(); val totals = market.totals.load();
        cap += market.params.load().oiCap; used += totals.longOi + totals.shortOi; pending += totals.pending;
        m = b.venues.load().markets.iterateNext(m);
    }
    return (cap, 22500000000, used, pending);
}
get fun get_capacity(owner: address, marketId: uint32): (int, int, int, int, int, bool) {
    val b = PxStorage.load().book.load(); val key = px_position_key(owner, marketId); val (p, s) = b.prefix_counts(key);
    return (b.positionCount, b.pendingCount, b.settleCount, p, s, b.has_admission_space(key));
}
get fun get_request_check(owner: address, body: cell, deposit: coins): int {
    var (slice, exotic) = body.beginParseSpecial(); if (exotic) { return PX_BAD_TERMS; }
    val cmd = px_command_decode(slice); if (cmd == null) { return PX_BAD_TERMS; }
    val s = PxStorage.load(); return px_request_status(s, s.book.load(), s.ledger(), owner, cmd!, deposit);
}
get fun get_rent_runway(): (coins, coins) {
    val s = PxStorage.load(); val b = s.book.load(); val (bits, cells) = s.ledger().owedStorageBounds();
    // Bounds include code, four markets, recovery frontier and the complete prefix dictionary.
    // Record counts include both phases and history retained after a full close.
    return (max(contract.getOriginalBalance() - b.nativeKept, 0), calculateStorageFee(BASECHAIN, 31536000,
        500000 + 3000 * b.pendingCount + 1600 * b.settleCount + 1500 * b.positionCount + bits,
        2000 + 5 * b.pendingCount + 4 * b.settleCount + 4 * b.positionCount + cells));
}

get fun get_recovery(slot: uint8): Cell<JettonRecovery>? { return PxStorage.load().jetton.load().recovery.get(slot); }
get fun get_min_recovery(certificate: cell): coins {
    var body = certificate.beginParse(); body.loadUint(32); val config = body.loadRef() as Cell<ProofConfig>; body.loadRef(); val code = body.loadRef();
    val evidence = jetton_recovery_authenticate(PxStorage.load().ledger(), 0, t3_proof_address(config, code), certificate.beginParse());
    return jetton_receipt_value(T3Receipt { key:evidence.key, payload:evidence.item.toCell() }.toCell());
}
get fun get_min_recovery_claim(receipt: Cell<T3Receipt>): coins {
    JettonRecoveryItem.fromCell(receipt.load().payload);
    return calculateGasFee(0, JETTON_RECEIPT_GAS) + jetton_recovery_rent();
}
