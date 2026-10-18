tolk 1.5.0
import "@gen/op/tep";
import "@stdlib/exotic-cells";
import "../shared/jetton/tep74_codec";
import "../generated/op/t3";

// Unknown payload graphs never become part of a durable refund witness.
fun t3_deposit_intent(payload: cell): cell {
    var (s, exotic) = payload.beginParseSpecial();
    if (exotic || s.remainingBitsCount() < 32 || s.remainingRefsCount() != 0) { return createEmptyCell(); }
    val op = s.loadUint(32);
    if (op == OP_T3_SWAP) {
        if (s.remainingBitsCount() < 3 || s.loadUint(2) > 2) { return createEmptyCell(); }
        s.loadBool();
    } else if (op != OP_T3_MINT && op != OP_T3_PAIR) { return createEmptyCell(); }
    if (s.tryLoadCoins() == null) { return createEmptyCell(); }
    val recipient = s.tryLoadStdAddress();
    if (recipient == null || recipient.getWorkchain() != 0 || !s.isEmpty()) { return createEmptyCell(); }
    return payload;
}

// A pruned root could hide a valid instruction; authenticated exotic roots are opaque.
fun t3_request_intent(request: cell): cell {
    var (s, exotic) = request.beginParseSpecial(); assert (!exotic) throw 860;
    assert (s.loadUint(32) == OP_TEP74_TRANSFER) throw 909;
    s.loadUint(64); s.loadCoins(); s.loadAddress(); s.loadAddressAny(); s.loadMaybeRef(); s.loadCoins();
    val byRef = s.loadBool();
    val payload = byRef ? s.loadRef() : beginCell().storeSlice(s).endCell();
    if (byRef) { s.assertEnd(); }
    val (root, exoticRoot) = payload.beginParseSpecial();
    if (exoticRoot) { assert (root.preloadUint(8) != 1) throw 860; }
    return t3_deposit_intent(payload);
}
