tolk 1.5.0
import "@gen/op/perps"
import "../shared/jetton/tep74_codec"
import "engine_types"

struct (0x50584f50) PxOpen { queryId: uint64; marketId: uint32; size: int128; limit: coins; leverage: uint32; deadline: uint32 }
struct (0x50584d44) PxIncrease { queryId: uint64; marketId: uint32; gen: uint64; deadline: uint32; size: int128; limit: coins }
struct (0x5058414d) PxAddMargin { queryId: uint64; marketId: uint32; gen: uint64; deadline: uint32 }
struct (0x5058524d) PxRemoveMargin { queryId: uint64; marketId: uint32; gen: uint64; deadline: uint32; amount: coins }
struct (0x5058434c) PxClose { queryId: uint64; marketId: uint32; gen: uint64; deadline: uint32; size: int128; limit: coins }
struct (0x50584643) PxClaimFunding { queryId: uint64; marketId: uint32; gen: uint64; deadline: uint32 }
struct (0x50524653) PerpsRefresh { queryId: uint64; marketId: uint32 }
struct (0x504c4951) PerpsLiquidate { queryId: uint64; owner: address; marketId: uint32 }
struct (0x5045584f) PerpsExpireOpen { queryId: uint64; owner: address; marketId: uint32 }
struct (0x50585253) PxResync { queryId: uint64; owner: address; marketId: uint32 }
struct (0x50584c46) PxFlush { queryId: uint64 }
struct (0x50584346) PxConfig { queryId: uint64; feeBps: uint16 }
struct (0x50584d4b) PxMarketRegister { queryId: uint64; marketId: uint32; pool: address; params: Cell<PxParams> }
struct (0x5058554d) PxMarketUpdate { queryId: uint64; marketId: uint32; params: Cell<PxParams> }

struct PxCommand { kind: uint8; queryId: uint64; marketId: uint32; gen: uint64; deadline: uint32; size: int128; limit: coins; leverage: uint32; amount: coins }
// Used after a physical jetton credit: every malformed shape returns a status.
fun px_command_decode(body: slice): PxCommand? {
    if (body.remainingRefsCount() != 0 || body.remainingBitsCount() < 128) { return null; }
    var s = body; val op = s.loadUint(32);
    val kind = op == OP_PX_OPEN ? 1 : op == OP_PX_INCREASE ? 2 : op == OP_PX_REMOVE_MARGIN ? 3
        : op == OP_PX_ADD_MARGIN ? 4 : op == OP_PX_CLOSE ? 5 : op == OP_PX_CLAIM_FUNDING ? 6 : 0;
    if (kind == 0) { return null; }
    var c = PxCommand {kind, queryId: s.loadUint(64), marketId: s.loadUint(32), gen: 0, deadline: 0, size: 0, limit: 0, leverage: 0, amount: 0};
    if (kind != 1) {
        if (s.remainingBitsCount() < 96) { return null; }
        c.gen = s.loadUint(64); c.deadline = s.loadUint(32);
    }
    if (kind == 1 || kind == 2 || kind == 5) {
        if (s.remainingBitsCount() < 132) { return null; }
        c.size = s.loadInt(128); val limit = s.tryLoadCoins(); if (limit == null) { return null; } c.limit = limit!;
    }
    if (kind == 1) {
        if (s.remainingBitsCount() != 64) { return null; }
        c.leverage = s.loadUint(32); c.deadline = s.loadUint(32);
    }
    if (kind == 3) { val amount = s.tryLoadCoins(); if (amount == null) { return null; } c.amount = amount!; }
    return s.isEmpty() ? c : null;
}
