tolk 1.5.0

import "../shared/jetton/tep74_codec"
import "@stdlib/exotic-cells"

const PX_ECHO_PENDING = 1;
const PX_ECHO_EXIT = 2;
const PX_ECHO_LIQUIDATE = 3;
const PX_ECHO_REFRESH = 4;
const PX_ECHO_FUNDING = 5;
const PX_ECHO_REMOVE = 6;

// Kind-specific encoding avoids two addresses on an owner's own exit.
// The largest shape is EXIT: 719 bits at maximum Coins, with no references.
struct PxEcho {
    kind: uint8;
    marketId: uint32;
    sentAt: uint64;
    owner: address;
    payer: address;
    nonce: uint64;
    gen: uint64;
    deadline: uint32;
    size: int128;
    limit: coins;
}
fun px_echo_cell(e: PxEcho): cell {
    var b = beginCell().storeUint(e.kind, 8).storeUint(e.marketId, 32).storeUint(e.sentAt, 64);
    if (e.kind == PX_ECHO_REFRESH) { return b.storeAddress(e.payer).endCell(); }
    b.storeAddress(e.owner);
    if (e.kind == PX_ECHO_PENDING) { return b.storeUint(e.nonce, 64).endCell(); }
    if (e.kind == PX_ECHO_LIQUIDATE) { return b.storeAddress(e.payer).storeUint(e.gen, 64).endCell(); }
    b.storeUint(e.gen, 64).storeUint(e.deadline, 32);
    if (e.kind == PX_ECHO_EXIT) { b.storeInt(e.size, 128).storeCoins(e.limit); }
    if (e.kind == PX_ECHO_REMOVE) { b.storeCoins(e.size as coins); }
    return b.endCell();
}
fun px_echo_decode(c: cell): PxEcho? {
    var (s, exotic) = c.beginParseSpecial();
    if (exotic || s.remainingRefsCount() != 0 || s.remainingBitsCount() < 371) { return null; }
    val kind = s.loadUint(8);
    if (kind < PX_ECHO_PENDING || kind > PX_ECHO_REMOVE) { return null; }
    val marketId = s.loadUint(32);
    val sentAt = s.loadUint(64);
    val owner = s.tryLoadStdAddress();
    if (owner == null) { return null; }
    var e = PxEcho { kind, marketId, sentAt, owner: owner!, payer: owner!, nonce: 0, gen: 0, deadline: 0, size: 0, limit: 0 };
    if (kind == PX_ECHO_PENDING) {
        if (s.remainingBitsCount() != 64) { return null; }
        e.nonce = s.loadUint(64);
    } else if (kind == PX_ECHO_LIQUIDATE) {
        val payer = s.tryLoadStdAddress();
        if (payer == null || s.remainingBitsCount() != 64) { return null; }
        e.payer = payer!; e.gen = s.loadUint(64);
    } else if (kind == PX_ECHO_EXIT || kind == PX_ECHO_FUNDING || kind == PX_ECHO_REMOVE) {
        if (s.remainingBitsCount() < 96) { return null; }
        e.gen = s.loadUint(64); e.deadline = s.loadUint(32);
        if (kind == PX_ECHO_EXIT) {
            if (s.remainingBitsCount() < 132) { return null; }
            e.size = s.loadInt(128);
            val limit = s.tryLoadCoins();
            if (limit == null) { return null; }
            e.limit = limit!;
        }
        if (kind == PX_ECHO_REMOVE) { val amount = s.tryLoadCoins(); if (amount == null) { return null; } e.size = amount! as int128; }
    }
    if (!s.isEmpty()) { return null; }
    return e;
}
