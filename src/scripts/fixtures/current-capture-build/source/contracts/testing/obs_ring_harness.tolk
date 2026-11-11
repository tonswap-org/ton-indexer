tolk 1.5.0

// The pool side of the oracle as pure getters. The ring is a value here: a getter takes a ring cell
// and returns what the library makes of it, so that long histories are replayed and compared without
// a transaction per write.

import "@stdlib/gas-payments.tolk";
import "../dlmm/math.tolk";
import "../shared/oracle/evidence.tolk";
import "../shared/oracle/obs_ring.tolk";
import "../shared/oracle/responder.tolk";

fun onInternalMessage(in: InMessage) {}

get fun empty_ring(): cell {
    return obs_ring_empty_cell();
}

// (the ring after the write, gas of the ring_touch call alone)
get fun touch(ring: cell, nowTs: int, value: int, healthy: bool): (cell, int) {
    val before = getGasConsumedAtTheMoment();
    val next = ring_touch(ring, nowTs, value, healthy);
    return (next, getGasConsumedAtTheMoment() - before);
}

// Replays a chain of cells, each `count:uint8` then count times `ts:uint64 value:int32 healthy:bool`,
// with the next cell as its only reference.
get fun touch_many(ring: cell, writes: cell): cell {
    var next = ring;
    var s = writes.beginParse();
    while (true) {
        repeat (s.loadUint(8)) {
            next = ring_touch(next, s.loadUint(64), s.loadInt(32), s.loadBool());
        }
        if (s.remainingRefsCount() == 0) {
            return next;
        }
        s = s.loadRef().beginParse();
    }
}

get fun header(ring: cell): (int, int, bool) {
    val r = ObsRing.fromCell(ring);
    return (r.count, r.curValue, r.curHealthy);
}

get fun cum_at(ring: cell, t: int): (bool, int, int) {
    return ObsRing.fromCell(ring).cumAt(t);
}

get fun window_at(ring: cell, t: int, window: int): (bool, int, int) {
    return ObsRing.fromCell(ring).windowAt(t, window);
}

get fun twap_at(ring: cell, t: int, window: int): (bool, int, int) {
    return ObsRing.fromCell(ring).twapAt(t, window);
}

// The constants a pool budgets with, for the TypeScript mirror to be held to.
get fun limits(): (int, int, int) {
    return (RING_TOUCH_GAS_MAX, ORACLE_QUERY_GAS_MAX, ORACLE_MIN_SIDE_T3);
}

get fun price_norm_q64(binId: int, binSpacing: int): int {
    return dlmm_price_norm_q64(binId, binSpacing);
}

get fun price_e9(binId: int, binSpacing: int): int {
    return oracle_price_e9(binId, binSpacing);
}
