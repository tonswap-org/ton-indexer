tolk 1.5.0

// Pool side of the oracle: the one writer of the ring, the evidence builder, the stateless answer to a
// query and the bodies of the pool's oracle getters. A pool emits an oracle result nowhere else.

import "@stdlib/gas-payments.tolk";
import "../../dlmm/math.tolk";
import "obs_ring.tolk";
import "evidence.tolk";

// 1.2 times the worst-case write: a new bucket with an eviction on a full ring whose keys fork on 28
// bits, the most that unix time allows before the year 2106.
const RING_TOUCH_GAS_MAX: int = 55000;

// The pool calls this after every handler that can change the active bin, its reserves, the pause or
// readiness. It returns the same cell when the state is the recorded one, and it never throws.
fun ring_touch(ring: cell, nowTs: int, value: int, healthy: bool): cell {
    var r = ObsRing.fromCell(ring);
    if (!r.write(nowTs, value, healthy)) {
        return ring;
    }
    return r.toCell();
}

// T3 per whole X scaled 10^9 at a bin, rounded up; 0 when the pool has no price for the bin or the
// result is not representable. It shares the pool's power function, so the two cannot drift.
fun oracle_price_e9(binId: int, binSpacing: int): int {
    val xPerT3 = dlmm_price_norm_q64(binId, binSpacing);
    if (xPerT3 == 0) {
        return 0;
    }
    val price = mulDivCeil(1 << 64, 1000000000, xPerT3);
    return price >= ORACLE_PRICE_E9_MIN && price < ORACLE_PRICE_E9_LIMIT ? price : 0;
}

// Price of the floor average bin of [t - window, t), given the cumulatives at both ends; 0 unless the
// start is retained and 80% of the window was healthy.
fun oracle_window_price(v1: int, h1: int, start: (bool, int, int), window: int, binSpacing: int): int {
    val healthy = h1 - start.2;
    if (!start.0 || healthy * 10000 < OBS_MIN_COVERAGE_BPS * window) {
        return 0;
    }
    return oracle_price_e9((v1 - start.1) / healthy, binSpacing);
}

// The evidence of a pool at nowTs: current when `at` is 0, else for the windows ending at `at`. A
// pool that is not eligible, an empty ring and an `at` in the future give evidence without a price.
fun oracle_evidence_cell(ring: cell, eligible: bool, binSpacing: int, nowTs: int, at: int): cell {
    val historical = at != 0;
    val t = historical ? at : nowTs;
    var flags = historical ? ORACLE_FLAG_HISTORICAL : 0;
    var spot = 0;
    var short = 0;
    var medium = 0;
    var long = 0;
    if (eligible && t <= nowTs) {
        val r = ObsRing.fromCell(ring);
        // Spot exists only while the pool is healthy: an unhealthy pool cannot follow the market.
        if (!historical && r.curHealthy) {
            spot = oracle_price_e9(r.curValue, binSpacing);
        }
        val (found, v1, h1) = r.cumAt(t);
        if (found) {
            short = oracle_window_price(v1, h1, r.cumAt(t - ORACLE_WINDOW_SHORT), ORACLE_WINDOW_SHORT, binSpacing);
            medium = oracle_window_price(v1, h1, r.cumAt(t - ORACLE_WINDOW_MEDIUM), ORACLE_WINDOW_MEDIUM, binSpacing);
            long = oracle_window_price(v1, h1, r.cumAt(t - ORACLE_WINDOW_LONG), ORACLE_WINDOW_LONG, binSpacing);
        }
        if (spot != 0) { flags |= ORACLE_FLAG_HEALTHY_NOW; }
        if (short != 0) { flags |= ORACLE_FLAG_SHORT_OK; }
        if (medium != 0) { flags |= ORACLE_FLAG_MEDIUM_OK; }
        if (long != 0) { flags |= ORACLE_FLAG_LONG_OK; }
    }
    return Evidence {
        servedAt: nowTs as uint64,
        at: t as uint64,
        flags: flags as uint8,
        spot: spot as uint128,
        short: short as uint128,
        medium: medium as uint128,
        long: long as uint128,
    }.toCell();
}

// Answers a query to its sender and writes nothing. The pool calls it before any state-changing code
// and while paused, passing the three message fields. Every check precedes the load of the ring, so a
// refused query costs the same on any ring; a refusal throws, which bounces the query. The value
// check makes the reply affordable, so it leaves with the whole remaining value as the only action.
fun oracle_serve(sender: address, value: coins, body: slice, ring: cell, eligible: bool, binSpacing: int): void {
    assert (body.remainingBitsCount() == ORACLE_QUERY_BITS && body.remainingRefsCount() == 1) throw ERR_ORACLE_QUERY_LAYOUT;
    val query = OracleQuery.fromSlice(body);
    // The echo comes back in the reply, which is priced for one cell.
    assert (query.echo.depth() == 0) throw ERR_ORACLE_QUERY_ECHO;
    assert (value >= oracle_min_forward()) throw ERR_ORACLE_QUERY_VALUE;
    val reply = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: sender,
        body: OracleResult {
            queryId: query.queryId,
            evidence: oracle_evidence_cell(ring, eligible, binSpacing, blockchain.now(), query.at) as Cell<Evidence>,
            echo: query.echo,
        },
    });
    reply.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// Body of the pool getter twap_at: (available, avgBin, priceE9, coverageBps). Unavailable for a window
// that is not positive, for a t in the future and wherever the ring has no average.
fun oracle_twap_at(ring: cell, binSpacing: int, nowTs: int, t: int, window: int): (bool, int, int, int) {
    if (window <= 0 || t > nowTs) {
        return (false, 0, 0, 0);
    }
    val (available, avgBin, coverageBps) = ObsRing.fromCell(ring).twapAt(t, window);
    if (!available) {
        return (false, 0, 0, coverageBps);
    }
    return (true, avgBin, oracle_price_e9(avgBin, binSpacing), coverageBps);
}

// Body of the pool getter observation_bounds: (count, oldestStart, newestStart, curBin, curHealthy).
fun oracle_observation_bounds(ring: cell): (int, int, int, int, bool) {
    val r = ObsRing.fromCell(ring);
    if (r.count == 0) {
        return (0, 0, 0, 0, false);
    }
    return (r.count, r.slots.findFirst().getKey() * OBS_BUCKET_SECONDS, r.slots.findLast().getKey() * OBS_BUCKET_SECONDS, r.curValue, r.curHealthy);
}
