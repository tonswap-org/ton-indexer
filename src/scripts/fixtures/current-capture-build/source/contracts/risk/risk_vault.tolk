tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/governance/module_gate"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/holder_recovery"
import "../shared/jetton/protected_credit"
import "../shared/risk/settle"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "../t3/receipt_tree"
import "../t3/recovery_types"
import "@gen/op/t3"
import "@gen/op/risk"
import "@gen/op/jetton"

const MAX_LIABILITY_RECORDS = 16384
const LIABILITY_TOMBSTONE_SECS = 86400
const RV_BOUNCE_GAS = 250000
const RV_DEPOSIT_GAS = 40000
const RV_TARGET_GAS = 60000
const RV_SETTLE_GAS = 80000
const RV_ADMIN_GAS = 40000
// Perps retires a bounded deep settlement entry and may emit three outcome logs.
// Its measured maximum is 72,332 gas; the callback carries more than 20% margin.
const RV_REPLY_GAS = 100000

struct BucketTotals { locked: coins; isolatedReserved: coins; outstandingNotional: coins }
struct Bucket {
    controller: address
    payoutHook: address
    reserveFloor: coins
    totals: Cell<BucketTotals>
}
struct Liability {
    notional: coins
    reserved: coins
    lastActionId: uint64
    lastOutcome: uint8
    lastReason: uint16
    lastPaid: coins
    lastApplied: bool
    lastAt: uint32
    deposit: coins
}
struct RiskVaultStorage {
    gate: ModuleGate
    treasury: address
    jetton: Cell<JettonManagedLedger>
    sweeps: Cell<JettonSweeps>
    buckets: map<uint16, Bucket>
    liabilities: map<uint256, Liability>
    liabilityCount: uint16
}
struct (0x5256424b) RvBucket {
    queryId: uint64
    bucketId: uint16
    controller: address
    payoutHook: address
    reserveFloor: coins
}
struct (0x52565754) RvWithdraw { queryId: uint64; bucketId: uint16; amount: coins }
struct (0x52564743) RvCollect { queryId: uint64; bucketId: uint16; positionId: uint256 }
struct (0x52564556) RvEvent { kind: uint8; bucketId: uint16; positionId: uint256; actionId: uint64; amount: coins }

fun RiskVaultStorage.load(): RiskVaultStorage { return RiskVaultStorage.fromCell(contract.getData()); }
fun RiskVaultStorage.save(self) { contract.setData(self.toCell()); }
fun RiskVaultStorage.ledger(self): JettonLedger { return self.jetton.load().ledger; }
fun RiskVaultStorage.setLedger(mutate self,ledger: JettonLedger) {
    var managed = self.jetton.load(); managed.ledger = ledger; self.jetton = managed.toCell();
}
fun RiskVaultStorage.dispatch(mutate self,slot: uint8,amount: coins) {
    var managed = self.jetton.load(); managed.recovery.dispatch(slot,amount); self.jetton = managed.toCell();
}
fun RiskVaultStorage.handled(mutate self,slot: uint8,amount: coins) {
    var managed = self.jetton.load(); managed.recovery.handled(slot,amount); self.jetton = managed.toCell();
}
fun RiskVaultStorage.restored(mutate self,slot: uint8,amount: coins) {
    var managed = self.jetton.load(); managed.recovery.restored(slot,amount); self.jetton = managed.toCell();
}
fun liability_key(bucketId: uint16, positionId: uint256): uint256 {
    return beginCell().storeUint(bucketId, 16).storeUint(positionId, 256).endCell().hash();
}
fun empty_liability(): Liability {
    return { notional: 0, reserved: 0, lastActionId: 0, lastOutcome: 0, lastReason: 0,
        lastPaid: 0, lastApplied: false, lastAt: 0, deposit: 0 };
}
fun reserve_bps(bucketId: int): int { return bucketId == 1 ? 1500 : 10000; }
fun reserve_ceiling(bucketId: int): coins { return bucketId == 1 ? 45000000000 : bucketId == 3 ? 30000000000 : 0; }
fun liability_deposit(): coins { return calculateStorageFee(BASECHAIN, 157680000, 1000, 2); }
fun rv_reply_value(): coins { return calculateGasFee(BASECHAIN, RV_REPLY_GAS) + calculateForwardFee(BASECHAIN, 900, 1); }
fun rv_refund(): JettonRefund {
    return { forwardGram: 0, payload: null, payloadBits: 0, payloadCells: 0, plain: true,
        keep: 0, spent: 0, bounceGas: RV_BOUNCE_GAS, tailGas: JETTON_REFUND_TAIL_GAS, owedCap: JETTON_OWED_CAP };
}
fun rv_min_value(ledger: JettonLedger, op: int): coins {
    val fwd = calculateForwardFee(BASECHAIN, 1300, 2);
    if (op == OP_DISCOVER_WALLETS) { return ledger.minDiscover() + fwd; }
    if (op == OP_RV_TARGET) { return calculateGasFee(BASECHAIN, RV_TARGET_GAS) + rv_reply_value() + liability_deposit() + fwd; }
    if (op == OP_RV_SETTLE) { return calculateGasFee(BASECHAIN, RV_SETTLE_GAS) + rv_reply_value() + ledger.legValue(0, 0, 32, 1, RV_BOUNCE_GAS) + 2 * fwd; }
    if (op == OP_SWEEP_PROBE) { return ledger.jetton_min_sweep(0, RV_BOUNCE_GAS); }
    if (op == OP_RV_WITHDRAW) { return calculateGasFee(BASECHAIN, RV_ADMIN_GAS) + ledger.legValue(0, jetton_notify_value(), 32, 1, RV_BOUNCE_GAS) + fwd; }
    return calculateGasFee(BASECHAIN, RV_ADMIN_GAS) + fwd;
}
fun rv_reserve(value: coins, delta: int) {
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value + delta, 0), RESERVE_MODE_AT_MOST);
}
fun rv_return(sender: address) {
    createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0, body: beginCell().endCell() })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun rv_log(kind: uint8, bucketId: uint16, positionId: uint256, actionId: uint64, amount: coins) {
    createExternalLogMessage({ dest: createAddressNone(), body: RvEvent { kind, bucketId, positionId, actionId, amount } })
        .send(SEND_MODE_IGNORE_ERRORS);
}
fun RiskVaultStorage.sum_locked(self): coins {
    var amount: coins = 0;
    var e = self.buckets.findFirst();
    while (e.isFound) { amount += e.loadValue().totals.load().locked; e = self.buckets.iterateNext(e); }
    return amount;
}
fun RiskVaultStorage.peer(self, a: address): bool {
    if (a == self.gate.governance || a == self.treasury) { return true; }
    var e = self.buckets.findFirst();
    while (e.isFound) {
        val b = e.loadValue();
        if (a == b.controller || a == b.payoutHook) { return true; }
        e = self.buckets.iterateNext(e);
    }
    return false;
}

fun rv_apply_credit(mutate st: RiskVaultStorage,mutate ledger: JettonLedger,c: JettonCredit,value: coins) {
    var id = c.payloadOk ? rv_deposit_bucket(c.payload) : -1;
    var b = id >= 0 ? st.buckets.get(id as uint16) : st.buckets.get(0);
    if (!b.isFound) {
        var e = st.buckets.findFirst();
        while (e.isFound) {
            val bucket = e.loadValue();
            if (c.from == bucket.controller || c.from == bucket.payoutHook) { id = e.getKey(); b = st.buckets.get(id as uint16); break; }
            e = st.buckets.iterateNext(e);
        }
    }
    if (b.isFound) {
        var bucket = b.loadValue();
        var totals = bucket.totals.load();
        if (totals.locked <= JETTON_MAX_COINS - c.amount) {
            totals.locked += c.amount;
            bucket.totals = totals.toCell();
            st.buckets.set(id as uint16, bucket);
            rv_log(1, id as uint16, 0, c.queryId, c.amount);
            jetton_bounce_excess(c.from, c.queryId, value, 0);
            return;
        }
    }
    val result = ledger.refundOrOwe(c, c.from, value, rv_refund(), 1);
    assert (result != 0 || st.jetton.load().recovery.get(c.slot) == null) throw ERR_JETTON_RECOVERY;
    if (result == 1 || result == 2) { st.dispatch(c.slot,c.amount); }
}

fun on_credit_risk(sender: address, value: coins, body: slice) {
    var st = RiskVaultStorage.load(); var ledger = st.ledger(); var sweeps = st.sweeps.load();
    val state = st.jetton.load().recovery.get(0);
    val r = JettonSweeps.onNotification(mutate sweeps,ledger,sender,body,state != null ? state! as cell : null);
    if (r.dirty) { st.sweeps = sweeps.toCell(); }
    assert (r.kind != 0 || state == null) throw ERR_JETTON_RECOVERY;
    if (r.kind == 2) {
        if (jetton_sweep_pay(mutate ledger,r,st.treasury,value,0,null) != 0) { st.dispatch(r.slot,r.pay); }
    } else if (r.kind == 1) {
        val c = r.credit!;
        if (c.claimReceipt) { jetton_bounce_excess(c.from,c.queryId,value,0); }
        else { st.handled(c.slot,c.amount); rv_apply_credit(mutate st,mutate ledger,c,value); }
    }
    st.setLedger(ledger); st.save();
}

fun rv_apply_source_failure(mutate st: RiskVaultStorage,mutate ledger: JettonLedger,slot: uint8,command: JettonSourceFailure,value: coins,owedCap: int = JETTON_OWED_CAP): int {
    if (!command.claimReceipt && command.destination == st.treasury && command.queryId >= 1 && command.queryId <= 3
        && command.payload != null && jetton_exact_tag(command.payload!,OP_RV_WITHDRAW)) {
        val r = st.buckets.get(command.queryId as uint16);
        if (r.isFound) {
            var bucket = r.loadValue();
            var totals = bucket.totals.load();
            if (totals.locked <= JETTON_MAX_COINS - command.amount) {
                totals.locked += command.amount;
                bucket.totals = totals.toCell();
                st.buckets.set(command.queryId as uint16, bucket);
                jetton_bounce_excess(command.excessTo, command.queryId, value, 0);
                return 1;
            }
        }
    }
    val (result,keep) = ledger.owedCredit(slot,command.destination,command.amount,owedCap);
    assert (result != 0 || st.jetton.load().recovery.get(slot) == null) throw ERR_JETTON_RECOVERY;
    jetton_log_owed(slot,command.destination,command.amount,result == 0 ? 255 : 3);
    jetton_bounce_excess(command.excessTo,command.queryId,value,keep); return result;
}

fun on_bounce_risk(sender: address,value: coins,body: slice) {
    var st = RiskVaultStorage.load(); var ledger = st.ledger(); var sweeps = st.sweeps.load();
    val r = JettonSweeps.onBounce(mutate sweeps,ledger,sender,body);
    if (r.dirty) { st.sweeps = sweeps.toCell(); }
    val b = r.b;
    if (r.probe || b.kind != 1) {
        if (r.dirty) { st.save(); }
        if (r.probe) { jetton_bounce_excess(b.excessTo,b.queryId,value,0); } return;
    }
    val command: JettonSourceFailure = { queryId:b.queryId,amount:b.amount,destination:b.destination!,excessTo:b.excessTo!,claimReceipt:b.claimReceipt,payload:b.payload };
    if (rv_apply_source_failure(mutate st,mutate ledger,b.slot,command,value) != 0) { st.restored(b.slot,b.amount); }
    st.setLedger(ledger); st.save();
}

fun onBouncedMessage(in: InMessageBounced) { on_bounce_risk(in.senderAddress, in.valueCoins, in.bouncedBody); }

fun handle_risk_target(mutate st: RiskVaultStorage, sender: address, value: coins, msg: RvTarget) {
    var bucket = st.buckets.mustGet(msg.bucketId, ERR_RISK_BUCKET);
    assert (sender == bucket.controller) throw ERR_RISK_VAULT;
    val key = liability_key(msg.bucketId, msg.positionId);
    val found = st.liabilities.get(key);
    var record = found.isFound ? found.loadValue() : empty_liability();
    var totals = bucket.totals.load();
    var reason: uint16 = 0;
    var deposit: coins = 0;
    if (!found.isFound && msg.notional == 0 && msg.reserved == 0) {
        // Unknown zero targets cannot allocate tombstones.
    } else if (found.isFound && msg.actionId <= record.lastActionId) {
        reason = RV_REASON_STALE;
    } else {
        val increasing = msg.notional > record.notional || msg.reserved > record.reserved;
        val nextReserved = totals.isolatedReserved - record.reserved + msg.reserved;
        if (increasing) {
            if (st.gate.withdrawalsOnly) { reason = RV_REASON_PAUSED; }
            else if (msg.reserved < (msg.notional * reserve_bps(msg.bucketId) + 9999) / 10000) { reason = RV_REASON_UNDER_RESERVED; }
            else if (nextReserved > reserve_ceiling(msg.bucketId)) { reason = RV_REASON_OVER_BUCKET_CAP; }
            else if (nextReserved + bucket.reserveFloor > totals.locked) { reason = RV_REASON_INSUFFICIENT; }
            else if (!found.isFound && st.liabilityCount >= MAX_LIABILITY_RECORDS) { reason = RV_REASON_CAPACITY; }
        }
        if (reason == 0) {
            totals.isolatedReserved = nextReserved;
            totals.outstandingNotional += msg.notional - record.notional;
            if (record.notional != msg.notional || record.reserved != msg.reserved) { record.lastAt = blockchain.now(); }
            record.notional = msg.notional;
            record.reserved = msg.reserved;
            if (!found.isFound) { deposit = liability_deposit(); record.deposit = deposit; st.liabilityCount += 1; }
            bucket.totals = totals.toCell();
            st.buckets.set(msg.bucketId, bucket);
        }
        if (reason == 0 || found.isFound) {
            record.lastActionId = msg.actionId;
            record.lastOutcome = reason == 0 ? 1 : 2;
            record.lastReason = reason;
            record.lastPaid = 0;
            record.lastApplied = reason == 0;
            st.liabilities.set(key, record);
        }
    }
    st.save();
    rv_reserve(value, deposit);
    createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0,
        body: RvTargetAnswer { actionId: msg.actionId, bucketId: msg.bucketId, positionId: msg.positionId,
            status: reason == 0 ? RV_TARGET_APPLIED : RV_TARGET_REJECTED, reason, notional: record.notional, reserved: record.reserved } })
        .send(SEND_MODE_CARRY_ALL_BALANCE);
}

fun handle_risk_settle(mutate st: RiskVaultStorage, sender: address, value: coins, msg: RvSettle) {
    var bucket = st.buckets.mustGet(msg.bucketId, ERR_RISK_BUCKET);
    assert (sender == bucket.controller || sender == bucket.payoutHook) throw ERR_RISK_VAULT;
    assert (msg.recipient.getWorkchain() == BASECHAIN) throw ERR_JETTON_DEST;
    var ledger = st.ledger();
    val key = liability_key(msg.bucketId, msg.positionId);
    val found = st.liabilities.get(key);
    var record = found.isFound ? found.loadValue() : empty_liability();
    var paid: coins = 0;
    var applied = false;
    var transfer: coins = 0;
    if (found.isFound && msg.actionId <= record.lastActionId) {
        if (msg.actionId == record.lastActionId && record.lastOutcome == 3) { paid = record.lastPaid; applied = record.lastApplied; }
    } else {
        applied = msg.notional <= record.notional && msg.reserved <= record.reserved;
        var totals = bucket.totals.load();
        val released: coins = applied ? record.reserved - msg.reserved : 0;
        if (ledger.coreReady() && ledger.canPay(msg.recipient)) { paid = min(msg.payout, min(released, totals.locked)); }
        if (applied) {
            totals.isolatedReserved -= released;
            totals.outstandingNotional += msg.notional - record.notional;
            if (record.notional != msg.notional || record.reserved != msg.reserved) { record.lastAt = blockchain.now(); }
            record.notional = msg.notional;
            record.reserved = msg.reserved;
        }
        totals.locked -= paid;
        transfer = paid; st.dispatch(0,paid);
        bucket.totals = totals.toCell();
        st.buckets.set(msg.bucketId, bucket);
        if (found.isFound) {
            record.lastActionId = msg.actionId;
            record.lastOutcome = 3;
            record.lastReason = 0;
            record.lastPaid = paid;
            record.lastApplied = applied;
            st.liabilities.set(key, record);
        }
        st.setLedger(ledger); st.save();
    }
    rv_reserve(value, 0);
    val answer = RvSettled { actionId: msg.actionId, bucketId: msg.bucketId, positionId: msg.positionId, paid, applied };
    if (transfer > 0) {
        createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: rv_reply_value(), body: answer })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        ledger.sendTransfer(0, { queryId: 0, amount: transfer, destination: msg.recipient, excessTo: msg.recipient, forwardGram: 0, forwardPayload: jetton_claim_receipt() },
            0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    } else {
        createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0, body: answer })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
}

fun handle_risk_plain(sender: address, value: coins, body: slice) {
    val op = body.preloadUint(32);
    var st = RiskVaultStorage.load();
    var ledger = st.ledger();
    assert (value >= rv_min_value(ledger, op)) throw ERR_JETTON_VALUE;
    if (gate_handle(mutate st.gate, sender, body)) { st.save(); rv_reserve(value, 0); rv_return(sender); return; }
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(body);
        rv_reserve(value, 0);
        ledger.discover();
        rv_return(sender);
        return;
    }
    if (op == OP_SWEEP_ALLOW) {
        gate_require_governance(st.gate, sender);
        val msg = SweepAllow.fromSlice(body);
        var sweeps = st.sweeps.load();
        sweeps.allow(ledger, msg.slot, msg.amount);
        st.sweeps = sweeps.toCell(); st.save(); rv_reserve(value, 0); rv_return(sender); return;
    }
    if (op == OP_SWEEP_PROBE) {
        val msg = SweepProbe.fromSlice(body);
        var sweeps = st.sweeps.load();
        sweeps.probe(ledger,msg.slot,st.sum_locked()+ledger.owedTotal(msg.slot)+st.jetton.load().recovery.pending(msg.slot),sender,value,RV_BOUNCE_GAS,st.jetton.load().recovery.reconciliation(msg.slot));
        st.sweeps = sweeps.toCell(); st.save(); return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(body);
        ledger.claimArchived(msg, sender, value, false, RV_BOUNCE_GAS, 0); st.dispatch(msg.slot,msg.amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_CLAIM_OWED) {
        val msg = ClaimOwed.fromSlice(body);
        val amount = ledger.owedOf(msg.slot,msg.owner);
        ledger.claim(msg.slot, msg.owner, msg.queryId, sender, value, false, RV_BOUNCE_GAS, 0); st.dispatch(msg.slot,amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_RV_TARGET) { handle_risk_target(mutate st, sender, value, RvTarget.fromSlice(body)); return; }
    if (op == OP_RV_SETTLE) { handle_risk_settle(mutate st, sender, value, RvSettle.fromSlice(body)); return; }
    if (op == OP_RV_BUCKET) {
        gate_require_governance(st.gate, sender);
        val msg = RvBucket.fromSlice(body);
        assert (msg.bucketId >= 1 && msg.bucketId <= 3 && !st.buckets.exists(msg.bucketId)) throw ERR_RISK_BUCKET;
        assert (ledger.canPay(msg.controller) && ledger.canPay(msg.payoutHook)
            && msg.controller != st.treasury && msg.payoutHook != st.treasury) throw ERR_JETTON_DEST;
        st.buckets.set(msg.bucketId, { controller: msg.controller, payoutHook: msg.payoutHook, reserveFloor: msg.reserveFloor,
            totals: BucketTotals { locked: 0, isolatedReserved: 0, outstandingNotional: 0 }.toCell() });
        st.save(); rv_reserve(value, 0); rv_return(sender); return;
    }
    if (op == OP_RV_WITHDRAW) {
        gate_require_governance(st.gate, sender);
        val msg = RvWithdraw.fromSlice(body);
        var bucket = st.buckets.mustGet(msg.bucketId, ERR_RISK_BUCKET);
        var totals = bucket.totals.load();
        val floor: coins = st.gate.withdrawalsOnly && totals.isolatedReserved == 0 ? 0 : bucket.reserveFloor;
        assert (msg.amount > 0 && msg.amount <= totals.locked - totals.isolatedReserved - floor && ledger.coreReady()) throw ERR_RISK_LIQUIDITY;
        totals.locked -= msg.amount; bucket.totals = totals.toCell(); st.buckets.set(msg.bucketId, bucket); st.dispatch(0,msg.amount); st.save();
        rv_reserve(value, 0);
        ledger.sendTransfer(0, { queryId: msg.bucketId as uint64, amount: msg.amount, destination: st.treasury, excessTo: sender,
            forwardGram: jetton_notify_value(), forwardPayload: beginCell().storeUint(OP_RV_WITHDRAW,32).endCell() }, 0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    if (op == OP_RV_COLLECT) {
        val msg = RvCollect.fromSlice(body);
        val key = liability_key(msg.bucketId, msg.positionId);
        val record = st.liabilities.mustGet(key, ERR_RISK_BUCKET);
        assert (record.notional == 0 && record.reserved == 0 && blockchain.now() >= record.lastAt + LIABILITY_TOMBSTONE_SECS) throw ERR_RISK_LIMITS;
        st.liabilities.delete(key); st.liabilityCount -= 1; st.save();
        rv_reserve(value, -record.deposit);
        createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0, body: beginCell().endCell() })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    throw ERR_RISK_VAULT;
}

fun rv_recovery_accept(sender: address,value: coins,body: slice) {
    assert (value >= calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE; setGasLimit(250000);
    var st = RiskVaultStorage.load(); var managed = st.jetton.load();
    val evidence = jetton_recovery_authenticate(managed.ledger,0,sender,body);
    val candidate = T3Receipt { key:evidence.key,payload:evidence.item.toCell() }.toCell();
    assert (value >= jetton_receipt_value(candidate)) throw ERR_JETTON_VALUE;
    val receipt = managed.recovery.record(evidence); st.jetton = managed.toCell(); st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered {receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    rv_return(sender);
}
fun rv_recovery_claim(sender: address,value: coins,body: slice) {
    val msg = JettonRecoveryClaim.fromSlice(body);
    assert (value >= get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE; setGasLimit(250000);
    var st = RiskVaultStorage.load(); var managed = st.jetton.load();
    val item = managed.recovery.claim(msg.receipt,msg.proof); var ledger = managed.ledger; st.jetton = managed.toCell();
    if (item.incoming) {
        val credit = jetton_parse_notification(item.slot,item.body.beginParse());
        assert (credit != null && !credit!.claimReceipt && credit!.amount == item.amount) throw ERR_JETTON_RECOVERY;
        rv_apply_credit(mutate st,mutate ledger,credit!,value);
    } else {
        val command = jetton_source_failure(item.body); assert (command.amount == item.amount) throw ERR_JETTON_RECOVERY;
        // Membership plus a deep address trie can exceed one transaction. A nonempty
        // direct book therefore archives this certified restoration without traversing it.
        assert (rv_apply_source_failure(mutate st,mutate ledger,item.slot,command,value,1) != 0) throw ERR_JETTON_RECOVERY;
    }
    st.setLedger(ledger); st.save();
}
fun onInternalMessage(in: InMessage) {
    val body = in.body;
    if (body.isEmpty()) { return; }
    if (body.remainingBitsCount() < 32) { handle_risk_plain(in.senderAddress, in.valueCoins, body); return; }
    val op = body.preloadUint(32);
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit_risk(in.senderAddress, in.valueCoins, body); return; }
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_T3_NOTIFICATION_CERTIFICATE || op == OP_T3_FAILURE_CERTIFICATE) { rv_recovery_accept(in.senderAddress,in.valueCoins,body); return; }
    if (op == OP_JETTON_RECOVERY_CLAIM) { rv_recovery_claim(in.senderAddress,in.valueCoins,body); return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) {
        var st = RiskVaultStorage.load();
        var ledger = st.ledger();
        val take = ledger.checkTake(in.senderAddress, body);
        if (take == null || st.peer(take.wallet)) { return; }
        ledger.commitTake(take); st.setLedger(ledger); st.save(); return;
    }
    handle_risk_plain(in.senderAddress, in.valueCoins, body);
}

get fun get_jetton_slots(): map<uint8, JettonSlot> { return RiskVaultStorage.load().ledger().slots; }
get fun get_owed(slot: uint8, owner: address): coins { return RiskVaultStorage.load().ledger().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = RiskVaultStorage.load().ledger(); return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_jetton_liabilities(slot: uint8): coins {
    val st = RiskVaultStorage.load(); return (slot == 0 ? st.sum_locked() : 0 as coins) + st.ledger().owedTotal(slot) + st.jetton.load().recovery.pending(slot);
}
get fun get_unattributed_surplus(slot: uint8, observedBalance: coins, protectedCredits: int?, acceptedTransfers: int?): (int, int, int) {
    val liability = get_jetton_liabilities(slot) + RiskVaultStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers); return (liability, max(observedBalance - liability, 0), max(liability - observedBalance, 0));
}
get fun get_sweep(slot: uint8): SweepSlot { return RiskVaultStorage.load().sweeps.load().get(slot); }
get fun get_min_sweep(slot: uint8): coins { return RiskVaultStorage.load().ledger().jetton_min_sweep(slot, RV_BOUNCE_GAS); }
get fun get_min_claim(slot: uint8): coins { return max(RiskVaultStorage.load().ledger().jetton_min_claim(slot, RV_BOUNCE_GAS), calculateGasFee(BASECHAIN, RV_ADMIN_GAS) + calculateForwardFee(BASECHAIN, 1300, 2)); }
get fun get_min_discover(): coins { return rv_min_value(RiskVaultStorage.load().ledger(), OP_DISCOVER_WALLETS); }
get fun get_min_value(op: uint32): coins { return rv_min_value(RiskVaultStorage.load().ledger(), op); }
get fun get_min_forward(op: uint32, slot: uint8): coins {
    val ledger = RiskVaultStorage.load().ledger();
    return max(calculateGasFee(BASECHAIN, RV_DEPOSIT_GAS), ledger.refundFloor(slot, rv_refund(), RV_DEPOSIT_GAS));
}
get fun get_buckets(): map<uint16, Bucket> { return RiskVaultStorage.load().buckets; }
get fun bucket_state(id: uint16): (address, address, coins, coins, coins, coins, int) {
    val b = RiskVaultStorage.load().buckets.mustGet(id, ERR_RISK_BUCKET); val t = b.totals.load();
    return (b.controller, b.payoutHook, b.reserveFloor, t.locked, t.isolatedReserved, t.outstandingNotional, reserve_bps(id));
}
get fun liability_state(bucketId: uint16, positionId: uint256): (coins, coins, uint64, uint8, coins, bool, uint32) {
    val r = RiskVaultStorage.load().liabilities.get(liability_key(bucketId, positionId));
    val l = r.isFound ? r.loadValue() : empty_liability();
    return (l.notional, l.reserved, l.lastActionId, l.lastOutcome, l.lastPaid, l.lastApplied, l.lastAt);
}
get fun get_ledger(): (coins, coins, int) { val st = RiskVaultStorage.load(); return (st.sum_locked(), st.ledger().owedTotal(0), st.liabilityCount); }
get fun get_rent_runway(): (coins, coins) {
    val st = RiskVaultStorage.load();
    val (bits, cells) = st.ledger().owedStorageBounds();
    // Code plus fixed state, and upper bounds for every dictionary leaf and branch.
    return (contract.getOriginalBalance(), calculateStorageFee(BASECHAIN, 31536000,
        200000 + 1000 * st.liabilityCount + bits, 512 + 2 * st.liabilityCount + cells));
}
get fun get_liability_deposit(): coins { return liability_deposit(); }
get fun get_gate(): (address, bool) { val g = RiskVaultStorage.load().gate; return (g.governance, g.withdrawalsOnly); }

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return RiskVaultStorage.load().ledger().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return RiskVaultStorage.load().ledger().jetton_min_archive_claim(slot, RV_BOUNCE_GAS); }

get fun get_recovery(slot: uint8): Cell<JettonRecovery>? { return RiskVaultStorage.load().jetton.load().recovery.get(slot); }
get fun get_min_recovery(certificate: cell): coins {
    var b = certificate.beginParse(); b.loadUint(32); val config = b.loadRef() as Cell<ProofConfig>; b.loadRef(); val code = b.loadRef();
    val evidence = jetton_recovery_authenticate(RiskVaultStorage.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt { key:evidence.key,payload:evidence.item.toCell() }.toCell());
}
get fun get_min_recovery_claim(receipt: Cell<T3Receipt>): coins {
    val item = JettonRecoveryItem.fromCell(receipt.load().payload); val ledger = RiskVaultStorage.load().ledger();
    return calculateGasFee(0,JETTON_RECEIPT_GAS) + (item.incoming ? ledger.refundFloor(item.slot,rv_refund(),RV_DEPOSIT_GAS) : jetton_recovery_rent());
}
