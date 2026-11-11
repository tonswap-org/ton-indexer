tolk 1.5.0

import "@stdlib/exotic-cells";
import "@gen/op/jetton";
import "@gen/op/restricted_owed_claim_receipt";

struct (0x4a535053) JettonSnapshotRequest {}
struct (0x4a535043) JettonSnapshotCredit { protectedCredits: uint256; acceptedTransfers: uint256 }
struct JettonReconciliation { handled: uint256; restored: uint256 }

fun jetton_exact_tag(c: cell, tag: int): bool {
    val (s,exotic) = c.beginParseSpecial();
    return !exotic && s.remainingBitsCount() == 32 && s.remainingRefsCount() == 0 && s.preloadUint(32) == tag;
}
fun jetton_is_claim_receipt(payload: cell): bool { return jetton_exact_tag(payload,OP_OWED_CLAIM_RECEIPT); }
fun jetton_protected_payload(either: cell): bool {
    var (s,exotic) = either.beginParseSpecial();
    if (exotic || s.remainingBitsCount() == 0) { return true; }
    if (s.loadBool()) {
        if (s.remainingBitsCount() != 0 || s.remainingRefsCount() != 1) { return true; }
        return !jetton_exact_tag(s.loadRef(),OP_OWED_CLAIM_RECEIPT);
    }
    return !(s.remainingBitsCount() == 32 && s.remainingRefsCount() == 0 && s.preloadUint(32) == OP_OWED_CLAIM_RECEIPT);
}
