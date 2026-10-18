tolk 1.5.0

// What a pool reports about itself and how a consumer reads it. Evidence carries observations only:
// no threshold, coverage number or attestation travels, and the one authentication is that the
// message came from the pool the consumer is bound to.
//
// Prices are whole T3 per whole X scaled 10^9, whatever the jetton's decimals. A consumer quantity
// multiplied by a price is in 10^-9 units of whole X.

import "@stdlib/gas-payments.tolk";
import "@stdlib/exotic-cells.tolk";
import "@gen/op/restricted_oracle_result";

const ORACLE_FLAG_HEALTHY_NOW: int = 1;   // current evidence only; set exactly when spot != 0
const ORACLE_FLAG_SHORT_OK: int = 2;
const ORACLE_FLAG_MEDIUM_OK: int = 4;
const ORACLE_FLAG_LONG_OK: int = 8;
const ORACLE_FLAG_HISTORICAL: int = 16;   // the windows end at `at`, not at the serving time
const ORACLE_FLAGS_ALL: int = 31;

const ORACLE_WINDOW_SHORT: int = 300;
const ORACLE_WINDOW_MEDIUM: int = 1800;
const ORACLE_WINDOW_LONG: int = 7200;

// A price below 10^6 moves by more than 1 ppm per unit, and one at 2^120 or above does not fit the
// amounts a consumer multiplies it with. Such a price is not reported and its flag stays clear.
const ORACLE_PRICE_E9_MIN: int = 1000000;
const ORACLE_PRICE_E9_LIMIT: int = 1 << 120;

// A pool is healthy only while its active bin holds this much value, in T3 units, in each token.
const ORACLE_MIN_SIDE_T3: int = 8000000000000;

// Part of the pool's wire contract: immutable pool code and every consumer price a query with it,
// so a consumer built later must use a value at least as large as the deployed pools'.
// 1.2 times the worst-case query on a full ring, with room for a real pool's dispatch.
const ORACLE_QUERY_GAS_MAX: int = 100000;

// Body sizes, tag included: a query also has one reference and a result two.
const ORACLE_QUERY_BITS: int = 160;
const ORACLE_RESULT_BITS: int = 96;
const ORACLE_EVIDENCE_BITS: int = 648;
const ORACLE_ECHO_MAX_BITS: int = 1023;

const ERR_ORACLE_QUERY_LAYOUT: int = 700;
const ERR_ORACLE_QUERY_ECHO: int = 701;
const ERR_ORACLE_QUERY_VALUE: int = 702;

struct Evidence {
    servedAt: uint64;
    at: uint64;      // equals servedAt in current evidence
    flags: uint8;
    spot: uint128;
    short: uint128;
    medium: uint128;
    long: uint128;
}

// `at` 0 asks for current evidence, any other value for the windows ending at that second. The echo is
// the consumer's own continuation: one cell without references, which the pool returns untouched.
struct (0x4f515259) OracleQuery {
    queryId: uint64;
    at: uint64;
    echo: cell;
}

struct (0x4f524553) OracleResult {
    queryId: uint64;
    evidence: Cell<Evidence>;
    echo: cell;
}

// What a query must carry: the worst-case compute of the pool plus the reply with a full echo. The
// pool's value check, its getter and every consumer's minimum call this one function.
fun oracle_min_forward(): coins {
    return calculateGasFee(BASECHAIN, ORACLE_QUERY_GAS_MAX)
        + calculateForwardFee(BASECHAIN, ORACLE_RESULT_BITS + ORACLE_EVIDENCE_BITS + ORACLE_ECHO_MAX_BITS, 3);
}

fun oracle_price_reported(price: int, flagSet: bool): bool {
    return flagSet ? price >= ORACLE_PRICE_E9_MIN && price < ORACLE_PRICE_E9_LIMIT : price == 0;
}

// Reads an evidence cell without ever throwing: (false, zeroes) unless the cell is ordinary, holds
// exactly the layout and is something a pool can have built. A consumer acts on (true, e) only.
fun evidence_decode(c: cell): (bool, Evidence) {
    val none = Evidence { servedAt: 0, at: 0, flags: 0, spot: 0, short: 0, medium: 0, long: 0 };
    val (s, exotic) = c.beginParseSpecial();
    if (exotic || s.remainingBitsCount() != ORACLE_EVIDENCE_BITS || s.remainingRefsCount() != 0) {
        return (false, none);
    }
    val read = Evidence.fromSlice(s);
    val f = read.flags;
    val historical = (f & ORACLE_FLAG_HISTORICAL) != 0;
    val healthyNow = (f & ORACLE_FLAG_HEALTHY_NOW) != 0;
    if ((f & ~ORACLE_FLAGS_ALL) != 0
        || !oracle_price_reported(read.spot, healthyNow)
        || !oracle_price_reported(read.short, (f & ORACLE_FLAG_SHORT_OK) != 0)
        || !oracle_price_reported(read.medium, (f & ORACLE_FLAG_MEDIUM_OK) != 0)
        || !oracle_price_reported(read.long, (f & ORACLE_FLAG_LONG_OK) != 0)
        || (historical ? healthyNow : read.at != read.servedAt)) {
        return (false, none);
    }
    return (true, read);
}

// Dispatch malformed replies to the non-throwing consumer decoder too.
fun oracle_is_result(body: slice): bool {
    return body.remainingBitsCount() >= 32 && body.preloadUint(32) == OP_ORACLE_RESULT;
}
