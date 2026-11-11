tolk 1.5.0
import "engine_state"
import "engine_commit"
import "../shared/jetton/holder_recovery"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/utils/error_codes"
import "../shared/jetton/protected_credit"
import "../shared/risk/settle"
import "../t3/recovery_types"
import "../t3/receipt_tree"
import "@gen/op/t3"
import "@gen/op/risk"
import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"

fun px_loss_marker(payload: cell?, bucket: uint16): bool {
    if (payload == null) { return false; }
    val (body, exotic) = payload!.beginParseSpecial();
    return !exotic && rv_deposit_bucket(body) == bucket;
}
// Marked protocol transfers restore their exact domain; other sends owe the payee.
fun px_source_failure(mutate s: PxStorage, mutate ledger: JettonLedger,
    command: JettonSourceFailure, value: coins, cap: int) {
    val peers = s.peers.load();
    val fees = !command.claimReceipt && command.destination == peers.feeSink
        && command.payload != null && jetton_exact_tag(command.payload!, OP_HOLDER_FEE_SWEEP);
    val losses = !command.claimReceipt && command.destination == peers.riskVault
        && px_loss_marker(command.payload, peers.riskBucketId);
    if (fees || losses) {
        var book = s.book.load();
        if (fees) { book.feesAccrued += command.amount; } else { book.lossPending += command.amount; }
        s.book = book.toCell(); jetton_bounce_excess(command.excessTo, command.queryId, value, 0);
    } else {
        val (result, keep) = ledger.owedCredit(0, command.destination, command.amount, cap);
        assert (result != 0) throw ERR_JETTON_RECOVERY;
        jetton_log_owed(0, command.destination, command.amount, 3);
        jetton_bounce_excess(command.excessTo, command.queryId, value, keep);
    }
}
fun px_recovery_accept(sender: address, value: coins, body: slice) {
    assert (value >= calculateGasFee(0, JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;
    setGasLimit(250000);
    var s = PxStorage.load(); var managed = s.jetton.load();
    val evidence = jetton_recovery_authenticate(managed.ledger, 0, sender, body);
    val candidate = T3Receipt { key:evidence.key, payload:evidence.item.toCell() }.toCell();
    assert (value >= jetton_receipt_value(candidate)) throw ERR_JETTON_VALUE;
    val receipt = managed.recovery.record(evidence); s.jetton = managed.toCell(); s.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + jetton_receipt_rent(), RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({ dest:createAddressNone(), body:JettonRecovered { receipt } }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    px_return(sender);
}
fun px_recovery_claim(sender: address, value: coins, body: slice) {
    val message = JettonRecoveryClaim.fromSlice(body);
    assert (value >= calculateGasFee(0, JETTON_RECEIPT_GAS) + jetton_recovery_rent()) throw ERR_JETTON_VALUE;
    setGasLimit(250000);
    var s = PxStorage.load(); var managed = s.jetton.load();
    val item = managed.recovery.claim(message.receipt, message.proof);
    var ledger = managed.ledger; s.jetton = managed.toCell();
    if (item.incoming) {
        // No trade or margin addition committed; never execute it at later terms.
        val credit = jetton_parse_notification(item.slot, item.body.beginParse());
        assert (credit != null && !credit!.claimReceipt && credit!.amount == item.amount) throw ERR_JETTON_RECOVERY;
        val (result, keep) = ledger.owedCredit(item.slot, credit!.from, item.amount, 1);
        assert (result != 0) throw ERR_JETTON_RECOVERY;
        jetton_log_owed(item.slot, credit!.from, item.amount, 3);
        jetton_bounce_excess(sender, credit!.queryId, value, keep);
    } else {
        val command = jetton_source_failure(item.body);
        assert (command.amount == item.amount) throw ERR_JETTON_RECOVERY;
        px_source_failure(mutate s, mutate ledger, command, value, 1);
    }
    s.setLedger(ledger); s.save();
}
