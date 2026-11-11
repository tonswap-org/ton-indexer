tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/exotic-cells";
import "@stdlib/gas-payments";
import "jetton_slots";
import "tep74_codec";
import "protected_credit";
import "../../t3/receipt_tree";
import "../../t3/recovery_types";
import "../../t3/wallet_types";
import "../../t3/wallet_budget";
import "@gen/op/t3";

const ERR_JETTON_RECOVERY = 1226;
const JETTON_RECEIPT_GAS = 300000;
struct JettonRecovery { dispatched: uint256; handled: uint256; pending: coins; tree: Cell<T3ReceiptTree>?; restored: uint256 }
struct JettonRecoveries { slots: map<uint8,Cell<JettonRecovery>> }
struct JettonManagedLedger { ledger: JettonLedger; recovery: JettonRecoveries }
struct JettonRecoveryItem { incoming: bool; slot: uint8; amount: coins; claimed: bool; body: cell }
struct JettonRecoveryEvidence { key: uint64; item: JettonRecoveryItem; absence: cell }
struct JettonSourceFailure { queryId: uint64; amount: coins; destination: address; excessTo: address; claimReceipt: bool; payload: cell? }
struct (0x4a524543) JettonRecovered { receipt: Cell<T3Receipt> }
struct (0x4a52434d) JettonRecoveryClaim { receipt: Cell<T3Receipt>; proof: cell }

fun jetton_empty_recovery(): Cell<JettonRecovery> {
    return JettonRecovery { dispatched:0,handled:0,pending:0,tree:null,restored:0 }.toCell();
}
fun JettonRecoveries.get(self,slot: uint8): Cell<JettonRecovery>? {
    val found = self.slots.get(slot); return found.isFound ? found.loadValue() : null;
}
fun JettonRecoveries.dispatch(mutate self,slot: uint8,amount: coins) {
    val found = self.get(slot);
    if (found != null && amount > 0) {
        var tail = (found! as cell).beginParse(); val current = tail.loadUint(256);
        self.slots.set(slot,beginCell().storeUint(current+amount,256).storeSlice(tail).endCell() as Cell<JettonRecovery>);
    }
}
fun JettonRecoveries.handled(mutate self,slot: uint8,amount: coins) {
    val found = self.get(slot);
    if (found != null) { var r = found!.load(); r.handled += amount; self.slots.set(slot,r.toCell()); }
}
fun JettonRecoveries.restored(mutate self,slot: uint8,amount: coins) {
    val found = self.get(slot);
    if (found != null) { var r = found!.load(); r.restored += amount; self.slots.set(slot,r.toCell()); }
}
fun JettonRecoveries.reconciliation(self,slot: uint8): Cell<JettonReconciliation>? {
    val found = self.get(slot); if (found == null) { return null; }
    val r = found!.load(); return JettonReconciliation { handled:r.handled,restored:r.restored }.toCell();
}
fun JettonRecoveries.pending(self,slot: uint8): coins {
    val found = self.get(slot); return found != null ? found!.load().pending : 0;
}
fun JettonRecoveries.excluded(self,slot: uint8,credits: int?,accepted: int?): int {
    val found = self.get(slot); if (found == null) { return 0; }
    val r = found!.load(); assert (credits != null && accepted != null && credits! >= r.handled && accepted! >= 0) throw ERR_JETTON_RECOVERY;
    return credits! - r.handled + max(r.dispatched - r.restored - accepted!,0);
}
fun jetton_source_failure(body: cell): JettonSourceFailure {
    var b = body.beginParse(); assert (b.loadUint(32) == OP_TEP74_TRANSFER) throw ERR_JETTON_RECOVERY;
    val queryId = b.loadUint(64) as uint64; val amount = b.loadCoins();
    val destination = b.loadAddress(); val excessTo = b.loadAddress();
    assert (amount > 0 && !b.loadBool()) throw ERR_JETTON_RECOVERY; b.loadCoins();
    var payload: cell? = null; if (b.loadBool()) { payload = b.loadRef(); } b.assertEnd();
    return { queryId,amount,destination,excessTo,claimReceipt:payload != null && jetton_is_claim_receipt(payload!),payload };
}
// The holder selects a configured slot; a caller cannot introduce a wallet or token.
fun jetton_recovery_authenticate(ledger: JettonLedger,slot: uint8,sender: address,body: slice): JettonRecoveryEvidence {
    var b = body; val op = b.loadUint(32); val incoming = op == OP_T3_NOTIFICATION_CERTIFICATE;
    assert (incoming || op == OP_T3_FAILURE_CERTIFICATE) throw ERR_JETTON_RECOVERY;
    val config = b.loadRef() as Cell<ProofConfig>; var payload = b.loadRef().beginParse(); val proofCode = b.loadRef();
    if (incoming) { b.loadUint(256); } b.assertEnd();
    val request = payload.loadRef(); val walletCode = payload.loadRef(); val absence = payload.loadRef(); payload.assertEnd();
    val cfg = config.load(); val credit = cfg.credit.load(); val targets = cfg.targets.load();
    val token = ledger.slots.mustGet(slot,ERR_JETTON_RECOVERY);
    assert (token.wallet != null && token.budget.load().creditProtection) throw ERR_JETTON_RECOVERY;
    var ids = credit.identities.beginParse(); val holder = contract.getAddress();
    assert (ids.loadAddress() == holder && ids.loadAddress() == holder && ids.loadAddress() == token.master) throw ERR_JETTON_RECOVERY; ids.assertEnd();
    assert (credit.codeHash == walletCode.hash() && t3_wallet_init(holder,token.master,proofCode.hash() as uint256,walletCode).calculateAddress() == token.wallet!
        && sender == t3_proof_address(config,proofCode)) throw ERR_JETTON_RECOVERY;
    var w = credit.wallets.beginParse(); assert (w.loadAddress() == token.wallet!) throw ERR_JETTON_RECOVERY;
    val target = w.loadAddress(); val queryId = w.loadUint(64); val amount = w.loadCoins(); w.assertEnd();
    assert (amount > 0 && targets.source.load().lt > 0 && targets.target.load().lt > 0) throw ERR_JETTON_RECOVERY;
    var original = request;
    if (incoming) {
        val a = (request as Cell<WalletAttempt>).load(); val terms = a.terms.load(); val details = terms.details.load();
        assert (target == holder && !terms.burn && terms.recipient == holder && terms.amount == amount && details.queryId == queryId
            && details.forwardValue > 0 && t3_wallet_attempt_body(request as Cell<WalletAttempt>).hashOfLevel(0) == credit.requestHash) throw ERR_JETTON_RECOVERY;
        original = t3_wallet_notification(terms);
    } else {
        val command = jetton_source_failure(request);
        assert (command.amount == amount && command.queryId == queryId && ledger.canPay(command.destination)
            && request.hashOfLevel(0) == credit.requestHash) throw ERR_JETTON_RECOVERY;
        if (target == token.wallet!) { assert (targets.source.hash() == targets.target.hash()) throw ERR_JETTON_RECOVERY; }
        else { assert (target == holder && targets.target.load().lt > targets.source.load().lt) throw ERR_JETTON_RECOVERY; }
    }
    return { key:targets.source.load().lt,item:{incoming,slot,amount,claimed:false,body:original},absence };
}
fun JettonRecoveries.record(mutate self,e: JettonRecoveryEvidence): Cell<T3Receipt> {
    var r = self.slots.mustGet(e.item.slot,ERR_JETTON_RECOVERY).load();
    val receipt: T3Receipt = { key:e.key,payload:e.item.toCell() };
    var tree = r.tree == null ? t3_receipt_tree() : r.tree!.load();
    if (!tree.initialized || e.key > tree.lastKey) { tree.append(receipt.toCell()); }
    else { tree.replace(null,receipt.toCell(),e.absence); }
    r.tree = tree.toCell(); r.pending += e.item.amount;
    if (e.item.incoming) { r.handled += e.item.amount; } else { r.restored += e.item.amount; }
    self.slots.set(e.item.slot,r.toCell()); return receipt.toCell();
}
// Caller must atomically apply its business reducer or abort, retaining the pending item.
fun JettonRecoveries.claim(mutate self,receipt: Cell<T3Receipt>,proof: cell): JettonRecoveryItem {
    var rec = receipt.load(); var item = JettonRecoveryItem.fromCell(rec.payload);
    assert (!item.claimed && item.amount > 0) throw ERR_JETTON_RECOVERY;
    var r = self.slots.mustGet(item.slot,ERR_JETTON_RECOVERY).load(); assert (r.tree != null) throw ERR_JETTON_RECOVERY;
    var tree = r.tree!.load(); item.claimed = true; rec.payload = item.toCell(); tree.replace(receipt,rec.toCell(),proof);
    r.pending -= item.amount; r.tree = tree.toCell(); self.slots.set(item.slot,r.toCell()); return item;
}
fun jetton_receipt_rent(): coins { return calculateStorageFee(0,157680000,19000,25); }
fun jetton_receipt_value(receipt: Cell<T3Receipt>): coins {
    val body = JettonRecovered { receipt }.toCell(); val (cells,bits,_) = body.calculateSizeStrict(512);
    return calculateGasFee(0,JETTON_RECEIPT_GAS) + jetton_receipt_rent() + calculateForwardFee(0,bits+256,cells+2) + 1;
}
