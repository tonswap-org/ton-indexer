tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"
import "../utils/error_codes"
import "jetton_quotes"
import "tep74_codec"
import "../utils/rich_bounce"
import "jetton_slots"
import "protected_credit"
import "@gen/op/jetton"

const ERR_JETTON_SWEEP = 1224

const JETTON_PROBE_GAS = 80000
const JETTON_PROOF_GAS = 80000
const JETTON_SWEEP_PAYLOAD_BITS = 1023
const JETTON_SWEEP_PAYLOAD_CELLS = 1

struct (0x4a535741) SweepAllow { queryId: uint64; slot: uint8; amount: coins }
struct (0x4a535750) SweepProbe { queryId: uint64; slot: uint8 }
struct SweepSlot {
    seq: uint64
    allowance: coins
    pending: bool
    pAmount: coins
    pBase: coins
    pAllow: coins
    pCredits: coins
    protection: Cell<JettonReconciliation>?
}
struct JettonSweeps { busy: uint256; slots: map<uint8, SweepSlot> }
struct SweepInbound { kind: uint8; dirty: bool; credit: JettonCredit?; slot: uint8; pay: coins; nonce: uint64 }
struct SweepBounce { probe: bool; dirty: bool; b: JettonBounce }

fun JettonSweeps.get(self, slot: uint8): SweepSlot {
    val entry = self.slots.get(slot);
    return entry.isFound ? entry.loadValue() : SweepSlot {
        seq: 0, allowance: 0, pending: false, pAmount: 0, pBase: 0, pAllow: 0, pCredits: 0, protection: null
    };
}

fun SweepSlot.clearProbe(mutate self) {
    self.pending = false;
    self.pAmount = 0;
    self.pBase = 0;
    self.pAllow = 0;
    self.pCredits = 0;
    self.protection = null;
}

fun JettonSweeps.allow(mutate self, ledger: JettonLedger, slot: uint8, amount: coins) {
    assert (ledger.slots.exists(slot)) throw ERR_JETTON_SLOT;
    var s = self.get(slot);
    s.allowance = amount;
    s.clearProbe();
    self.slots.set(slot, s);
    self.busy &= ~(1 << slot);
}

fun JettonLedger.jetton_min_sweep(self, slot: uint8, bounceGas: int): coins {
    return calculateGasFee(BASECHAIN, JETTON_PROBE_GAS + JETTON_PROOF_GAS)
        + self.legValue(slot, 0, 0, 0, bounceGas)
        + self.legValue(slot, jetton_notify_value(), JETTON_SWEEP_PAYLOAD_BITS, JETTON_SWEEP_PAYLOAD_CELLS, bounceGas);
}

fun JettonSweeps.probe(mutate self, ledger: JettonLedger, slot: uint8, liabilities: coins,
                       sender: address, inValue: coins, bounceGas: int, reconciliation: Cell<JettonReconciliation>? = null) {
    val wallet = ledger.slots.mustGet(slot, ERR_JETTON_SLOT).wallet;
    var s = self.get(slot);
    assert (wallet != null && ledger.coreReady()) throw ERR_JETTON_SLOT;
    assert (!s.pending && s.allowance > 0 && s.seq < (1 << 64) - 1
        && liabilities <= JETTON_MAX_COINS - s.allowance) throw ERR_JETTON_SWEEP;
    assert (inValue >= ledger.jetton_min_sweep(slot, bounceGas)) throw ERR_JETTON_VALUE;
    val protected = ledger.slots.mustGet(slot,ERR_JETTON_SLOT).budget.load().creditProtection;
    // Unadapted holders fail closed for protected wallets.
    assert (!protected || reconciliation != null) throw ERR_JETTON_SWEEP;
    s.seq += 1;
    s.pending = true;
    s.pBase = liabilities;
    s.pAllow = s.allowance;
    s.pAmount = liabilities + s.allowance;
    s.pCredits = 0;
    s.protection = protected ? reconciliation : null;
    s.allowance = 0;
    self.slots.set(slot, s);
    self.busy |= 1 << slot;
    // The standard wallet is the only counterparty that can authenticate this self-proof.
    val forward = inValue - ledger.legValue(slot, 0, 0, 0, bounceGas) - calculateGasFee(BASECHAIN, JETTON_PROBE_GAS);
    val payload: cell? = protected ? JettonSnapshotRequest {}.toCell() : null;
    val body = beginCell().storeUint(OP_TEP74_TRANSFER,32).storeUint(s.seq,64).storeCoins(s.pAmount)
        .storeAddress(contract.getAddress()).storeAddress(sender).storeMaybeRef(payload).storeCoins(forward).storeBool(false).endCell();
    createMessage({ bounce: BounceMode.RichBounce,dest: wallet!,value: 0,body })
        .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun JettonSweeps.onNotification(mutate self, ledger: JettonLedger, sender: address, body: slice, dispatchState: cell? = null): SweepInbound {
    val (idx, all) = ledger.lookup(sender);
    if (idx < 0 || !all) { return { kind: 0, dirty: false, credit: null, slot: 0, pay: 0, nonce: 0 }; }
    val slot = idx as uint8;
    val c = jetton_parse_notification(slot, body);
    if (c == null || c.amount == 0) { return { kind: 0, dirty: false, credit: null, slot, pay: 0, nonce: 0 }; }
    var s = self.get(slot);
    if (c.from == contract.getAddress()) {
        if (!s.pending || c.queryId != s.seq || c.amount != s.pAmount) {
            return { kind: 0, dirty: false, credit: null, slot, pay: 0, nonce: 0 };
        }
        var excluded = 0;
        if (s.protection != null) {
            assert (c.payloadOk && c.payload.remainingBitsCount() == 544 && c.payload.remainingRefsCount() == 0) throw ERR_JETTON_SWEEP;
            val snapshot = JettonSnapshotCredit.fromSlice(c.payload);
            val base = s.protection!.load();
            assert (dispatchState != null && snapshot.protectedCredits >= base.handled) throw ERR_JETTON_SWEEP;
            // The trusted holder state starts with its cumulative dispatch counter.
            // New sends may reach the wallet before its snapshot. Later restorations
            // stay excluded until this window ends; only the frozen baseline is safe.
            excluded = snapshot.protectedCredits - base.handled + max(dispatchState!.beginParse().loadUint(256) - base.restored - snapshot.acceptedTransfers,0);
        }
        val pay: coins = max(s.pAllow - s.pCredits - excluded,0);
        val nonce = s.seq;
        s.clearProbe();
        self.slots.set(slot, s);
        self.busy &= ~(1 << slot);
        return { kind: 2, dirty: true, credit: null, slot, pay, nonce };
    }
    if (s.pending) {
        s.pCredits = min(s.pAllow, s.pCredits + c.amount);
        self.slots.set(slot, s);
    }
    return { kind: 1, dirty: s.pending, credit: c, slot, pay: 0, nonce: 0 };
}

// The ordinary ledger deliberately rejects self destinations; only this exact raw probe is exempt.
fun jetton_sweep_probe_bounce(ledger: JettonLedger, sender: address, bouncedBody: slice): JettonBounce {
    val (slot, _) = ledger.lookup(sender);
    if (slot < 0 || !rich_bounce_is_canonical(bouncedBody)) { return jetton_bounce_none(); }
    val rich = RichBounceBody.fromSlice(bouncedBody);
    var (body, exotic) = rich.originalBody.beginParseSpecial();
    if (exotic || body.remainingBitsCount() < 96 || body.loadUint(32) != OP_TEP74_TRANSFER) { return jetton_bounce_none(); }
    val queryId = body.loadUint(64) as uint64;
    val amount = body.tryLoadCoins();
    val destination = body.tryLoadStdAddress();
    val excessTo = body.tryLoadStdAddress();
    if (amount == null || destination == null || destination! != contract.getAddress() || excessTo == null
        || body.remainingBitsCount() < 1) { return jetton_bounce_none(); }
    if (body.loadBool()) {
        if (body.remainingRefsCount() != 1 || !ledger.slots.mustGet(slot as uint8,ERR_JETTON_SLOT).budget.load().creditProtection
            || !jetton_exact_tag(body.loadRef(),OP_JETTON_SNAPSHOT_REQUEST)) { return jetton_bounce_none(); }
    }
    val forward = body.tryLoadCoins();
    if (forward == null || body.remainingBitsCount() != 1 || body.remainingRefsCount() != 0 || body.loadBool()) {
        return jetton_bounce_none();
    }
    return { kind: 1, slot: slot as uint8, queryId, amount: amount!, destination, excessTo,
        claimReceipt: false, payloadTag: 0, payload: null, exitCode: rich.exitCode, bouncedByPhase: rich.bouncedByPhase, originalLt: rich_bounce_original_lt(rich.originalInfo) };
}

fun JettonSweeps.onBounce(mutate self, ledger: JettonLedger, sender: address, bouncedBody: slice): SweepBounce {
    var b = ledger.onBounce(sender, bouncedBody);
    if (b.kind == 0) { b = jetton_sweep_probe_bounce(ledger, sender, bouncedBody); }
    if (b.kind == 0) { return { probe: false, dirty: false, b }; }
    var s = self.get(b.slot);
    if (b.kind == 1 && b.destination != null && b.destination! == contract.getAddress()) {
        // A cancelled or superseded probe may still bounce; it never creates a user liability.
        if (!s.pending || b.queryId != s.seq || b.amount != s.pAmount) {
            return { probe: true, dirty: false, b };
        }
        s.allowance = s.pAllow;
        s.clearProbe();
        self.slots.set(b.slot, s);
        self.busy &= ~(1 << b.slot);
        return { probe: true, dirty: true, b };
    }
    if (s.pending) {
        s.pCredits = min(s.pAllow, s.pCredits + b.amount);
        self.slots.set(b.slot, s);
    }
    return { probe: false, dirty: s.pending, b };
}

// 0 no payable proof, 1 sent. Every authenticated refusal can enter durable owed recovery.
fun jetton_sweep_pay(mutate ledger: JettonLedger, r: SweepInbound, treasury: address, inValue: coins,
                     payoutQueryId: uint64, payoutPayload: cell?): int {
    if (r.kind != 2 || r.pay == 0 || !ledger.canPay(treasury)) { return 0; }
    val slot = ledger.slots.get(r.slot);
    if (!slot.isFound || slot.loadValue().wallet == null) { return 0; }
    // Holder-built receipts are ordinary, ref-free cells; quotes cover their full possible width.
    if (payoutPayload != null) {
        val (body, exotic) = payoutPayload.beginParseSpecial();
        if (exotic || body.remainingRefsCount() != 0) { return 0; }
    }
    reserveGramsOnBalance(max(contract.getOriginalBalance() - inValue, 0), RESERVE_MODE_AT_MOST);
    ledger.sendTransfer(r.slot, { queryId: payoutQueryId, amount: r.pay, destination: treasury,
        excessTo: treasury, forwardGram: jetton_notify_value(), forwardPayload: payoutPayload ?? jetton_claim_receipt() },
        0, SEND_MODE_CARRY_ALL_BALANCE);
    return 1;
}
