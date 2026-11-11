tolk 1.5.0

import "recovery_types";
import "deposit_intent";
import "receipt_tree";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/jetton_slots";

struct T3CreditEvidence { transactionHash: uint256; messageHash: uint256 }
struct T3ReserveCredit {
    certified: bool;
    owner: address;
    queryId: uint64;
    amount: coins;
    intent: cell;
    evidence: Cell<T3CreditEvidence>?;
}

// Authentication and permissive malformed-payload decoding belong to the ledger.
// The caller passes only a non-null result of ledger.onNotification.
// createdLt = receiving transaction LT + 1 is qualified for the pinned reserve code.
fun t3_credit_notification(msg: JettonCredit, createdLt: uint64): T3Receipt {
    assert (createdLt > 1 && msg.amount > 0 && msg.payloadOk) throw 973;
    val credit: T3ReserveCredit = { certified: false, owner: msg.from, queryId: msg.queryId,
        amount: msg.amount, intent: t3_deposit_intent(beginCell().storeSlice(msg.payload).endCell()), evidence: null };
    return { key: (createdLt - 1) as uint64, payload: credit.toCell() };
}

// A credit certificate names an actual successful transfer into the immutable
// master-discovered hub wallet. The verifier checks both balance transitions.
// Its source wallet address is evidence, not an independently trusted authority.
fun t3_credit_certificate(sender: address, config: Cell<ProofConfig>, proofCode: cell, pinnedProofHash: uint256,
        hub: address, master: address, wallet: address, reserveCodeHash: uint256,
        messageHash: uint256): T3Receipt {
    assert (sender == t3_checked_proof_address(config,proofCode,pinnedProofHash)) throw 979;
    val cfg = config.load(); val c = cfg.credit.load(); var ids = c.identities.beginParse();
    val owner = ids.loadAddress();
    assert (ids.loadAddress() == hub && ids.loadAddress() == master) throw 971; ids.assertEnd();
    assert (owner.getWorkchain() == 0) throw 971;
    var wallets = c.wallets.beginParse(); wallets.loadAddress();
    assert (wallets.loadAddress() == wallet) throw 972;
    val queryId = wallets.loadUint(64); val amount = wallets.loadCoins(); wallets.assertEnd();
    assert (amount > 0) throw 973;
    assert (c.codeHash == reserveCodeHash) throw 974;
    val target = cfg.targets.load().target.load(); assert (target.lt > 0) throw 975;
    val evidence: T3CreditEvidence = { transactionHash: target.hash, messageHash };
    val credit: T3ReserveCredit = { certified: true, owner, queryId: queryId as uint64,
        amount, intent: c.intent, evidence: evidence.toCell() };
    return { key: target.lt, payload: credit.toCell() };
}
