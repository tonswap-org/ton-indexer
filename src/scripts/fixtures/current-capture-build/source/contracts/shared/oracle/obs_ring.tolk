tolk 1.5.0

// Observation ring of a pool: what the observed value (the active bin) and the pool's health were in
// every retained second. A slot exists only for an 8-second bucket in which the state changed, keyed by
// the bucket's absolute index, so a write rate cannot shorten the retained history and a state held for
// one second weighs one second.

const OBS_BUCKET_SECONDS: int = 8;
// 2,049 buckets always span at least 2,048 * 8 = 16,384 seconds.
const OBS_CAPACITY: int = 2049;
const OBS_MIN_COVERAGE_BPS: int = 8000;
// A lane stores value + 2^31, so that eight values fill one unsigned word.
const OBS_LANE_OFFSET: int = 1 << 31;
const OBS_LANE_UNIT: int = 0x0000000100000001000000010000000100000001000000010000000100000001;
const OBS_LANES_ALL: int = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

struct ObsSlot {
    cumV: int64;      // sum of the value over the healthy seconds before the bucket start
    cumH: uint40;     // healthy seconds before the bucket start
    mask: uint8;      // bit i: second i of the bucket was healthy
    lanes: uint256;   // second i of the bucket at bits [32i, 32i + 32)
}

struct ObsRing {
    count: uint16;
    curValue: int32;
    curHealthy: bool;
    slots: map<uint32, ObsSlot>;
}

fun obs_ring_empty_cell(): cell {
    return ObsRing { count: 0, curValue: 0, curHealthy: false, slots: [] }.toCell();
}

fun obs_lane(lanes: int, i: int): int {
    return ((lanes >> (32 * i)) & 0xffffffff) - OBS_LANE_OFFSET;
}

// Cumulatives at second n of the slot's bucket, n in 0..8.
fun obs_slot_cum(slot: ObsSlot, n: int): (int, int) {
    var v: int = slot.cumV;
    var h: int = slot.cumH;
    var lanes: int = slot.lanes;
    var mask: int = slot.mask;
    repeat (n) {
        if ((mask & 1) != 0) {
            v += (lanes & 0xffffffff) - OBS_LANE_OFFSET;
            h += 1;
        }
        lanes >>= 32;
        mask >>= 1;
    }
    return (v, h);
}

// Records that the state is (value, healthy) from second nowTs on; false when that is already the
// state. It has no assert and no clock guard, because a pool must never fail on its ring: block time
// does not decrease for one account, and value is a bin id, which fits a lane.
fun ObsRing.write(mutate self, nowTs: int, value: int, healthy: bool): bool {
    if (self.count > 0 && self.curValue == value && self.curHealthy == healthy) {
        return false;
    }
    val bucket = nowTs / OBS_BUCKET_SECONDS;
    val offset = nowTs % OBS_BUCKET_SECONDS;
    var slot = ObsSlot { cumV: 0, cumH: 0, mask: 0, lanes: 0 };
    val last = self.slots.findLast();
    if (last.isFound && last.getKey() == bucket) {
        slot = last.loadValue();
    } else {
        if (last.isFound) {
            // The last state held to the end of its bucket and through every bucket without a slot.
            val prev = last.loadValue();
            var (v, h) = obs_slot_cum(prev, OBS_BUCKET_SECONDS);
            val tail = obs_lane(prev.lanes, 7);
            val tailHealthy = (prev.mask >> 7) != 0;
            if (tailHealthy) {
                val gap = (bucket - last.getKey() - 1) * OBS_BUCKET_SECONDS;
                v += tail * gap;
                h += gap;
            }
            slot = ObsSlot {
                cumV: v as int64,
                cumH: h as uint40,
                mask: (tailHealthy ? 255 : 0) as uint8,
                lanes: ((tail + OBS_LANE_OFFSET) * OBS_LANE_UNIT) as uint256,
            };
        }
        self.count += 1;
        if (self.count > OBS_CAPACITY) {
            self.slots.delete(self.slots.findFirst().getKey());
            self.count -= 1;
        }
    }
    // Only the seconds from now on change; an elapsed second is never rewritten.
    val keepLanes = (1 << (32 * offset)) - 1;
    val keepMask = (1 << offset) - 1;
    slot.lanes = ((slot.lanes & keepLanes) | (((value + OBS_LANE_OFFSET) * OBS_LANE_UNIT) & ~keepLanes & OBS_LANES_ALL)) as uint256;
    slot.mask = ((slot.mask & keepMask) | (healthy ? (255 & ~keepMask) : 0)) as uint8;
    self.slots.set(bucket as uint32, slot);
    self.curValue = value as int32;
    self.curHealthy = healthy;
    return true;
}

// (found, sum of the value, healthy seconds) over the healthy seconds before t. Not found means that t
// precedes the retained history. The answer is final only for t <= now, which every caller checks.
fun ObsRing.cumAt(self, t: int): (bool, int, int) {
    if (t < 0) {
        return (false, 0, 0);
    }
    val entry = self.slots.findKeyLessOrEqual((t / OBS_BUCKET_SECONDS) as uint32);
    if (!entry.isFound) {
        return (false, 0, 0);
    }
    val slot = entry.loadValue();
    val elapsed = t - entry.getKey() * OBS_BUCKET_SECONDS;
    var (v, h) = obs_slot_cum(slot, min(elapsed, OBS_BUCKET_SECONDS));
    if (elapsed > OBS_BUCKET_SECONDS && (slot.mask >> 7) != 0) {
        val rest = elapsed - OBS_BUCKET_SECONDS;
        v += obs_lane(slot.lanes, 7) * rest;
        h += rest;
    }
    return (true, v, h);
}

// (found, sum of the value, healthy seconds) over [t - window, t).
fun ObsRing.windowAt(self, t: int, window: int): (bool, int, int) {
    val (found1, v1, h1) = self.cumAt(t);
    val (found0, v0, h0) = self.cumAt(t - window);
    if (!found1 || !found0) {
        return (false, 0, 0);
    }
    return (true, v1 - v0, h1 - h0);
}

// (available, floor of the average value over the healthy seconds, coverageBps) for [t - window, t),
// window > 0. An average needs both ends retained and 80% of the window healthy.
fun ObsRing.twapAt(self, t: int, window: int): (bool, int, int) {
    val (found, sum, healthy) = self.windowAt(t, window);
    if (!found) {
        return (false, 0, 0);
    }
    val coverage = healthy * 10000 / window;
    if (healthy * 10000 < OBS_MIN_COVERAGE_BPS * window) {
        return (false, 0, coverage);
    }
    return (true, sum / healthy, coverage);
}
