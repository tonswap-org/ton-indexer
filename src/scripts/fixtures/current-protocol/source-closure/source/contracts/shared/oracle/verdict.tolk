tolk 1.5.0

// The rules a consumer applies to decoded evidence. Pure and non-throwing; an uncovered window
// supplies no usable price.

import "evidence.tolk";

const ORACLE_MAX_AGE: int = 30;
const ORACLE_REQUEST_TTL: int = 60;
const ORACLE_ALIGN_BPS: int = 150;

// No buy inside the longest settlement window: from then on part of the settlement average is
// already recorded and readable.
const OPTION_BUY_CUTOFF: int = ORACLE_WINDOW_LONG;

// Neither age has a lower bound: evidence is authentic by its sender and its echo proves that it was
// produced after the request, so a clock surprise between shards must not close a market.
fun oracle_fresh(e: Evidence, nowTs: int): bool {
    return (e.flags & ORACLE_FLAG_HISTORICAL) == 0 && nowTs - e.servedAt <= ORACLE_MAX_AGE;
}

fun oracle_request_live(sentAt: int, nowTs: int): bool {
    return nowTs - sentAt <= ORACLE_REQUEST_TTL;
}

// The one predicate behind every action that settles value now: a healthy pool and three covered windows.
fun oracle_priced(e: Evidence, nowTs: int): bool {
    val need = ORACLE_FLAG_HEALTHY_NOW | ORACLE_FLAG_SHORT_OK | ORACLE_FLAG_MEDIUM_OK | ORACLE_FLAG_LONG_OK;
    return oracle_fresh(e, nowTs) && (e.flags & need) == need;
}

fun verdict_median(e: Evidence): int {
    return max(min(e.short, e.medium), min(max(e.short, e.medium), e.long));
}

fun oracle_aligned(price: int, median: int): bool {
    return 10000 * abs(price - median) <= ORACLE_ALIGN_BPS * median;
}

// Rule A, risk-increasing actions: priced, and spot and every window within 150 bps of the median.
fun verdict_admission(e: Evidence, nowTs: int): bool {
    if (!oracle_priced(e, nowTs)) {
        return false;
    }
    val m = verdict_median(e);
    return oracle_aligned(e.spot, m) && oracle_aligned(e.short, m) && oracle_aligned(e.medium, m) && oracle_aligned(e.long, m);
}

// Rule X, voluntary exits. Alignment is not required: an exit fills at the worst of the four sources.
fun verdict_exit(e: Evidence, nowTs: int): bool {
    return oracle_priced(e, nowTs);
}

// The trader-adverse extreme of spot and the three windows.
fun verdict_fill(e: Evidence, isBuy: bool): int {
    if (isBuy) {
        return max(max(e.spot, e.short), max(e.medium, e.long));
    }
    return min(min(e.spot, e.short), min(e.medium, e.long));
}

// Rule F, forced closes: on exactly the evidence on which an exit is priced, at the short average.
fun verdict_forced(e: Evidence, nowTs: int): (bool, int) {
    return (oracle_priced(e, nowTs), e.short);
}

// Rule M, the protocol's own market buy: (allowed, reference price).
fun verdict_market_buy(e: Evidence, nowTs: int): (bool, int) {
    val need = ORACLE_FLAG_HEALTHY_NOW | ORACLE_FLAG_SHORT_OK | ORACLE_FLAG_MEDIUM_OK;
    if (!oracle_fresh(e, nowTs) || (e.flags & need) != need) {
        return (false, 0);
    }
    return (true, min(e.short, e.medium));
}

// Rule E, one side of an option at expiry: (accepted, mediumE9, longE9). Not accepted means that the
// reply is not this side's answer and is ignored. An accepted answer carries a price of 0 for a window
// that cannot be used. Short-window coverage does not gate the medium or long historical price.
fun verdict_expiry(e: Evidence, expiry: int): (bool, int, int) {
    if ((e.flags & ORACLE_FLAG_HISTORICAL) == 0 || e.at != expiry || e.servedAt < expiry) {
        return (false, 0, 0);
    }
    return (true, e.medium, e.long);
}

// One window for the whole series, so that both sides average over the same period: 1800 if every
// side has a medium price, else 7200 if every side has a long price, else 0 (void). A one-sided
// series passes its answer twice.
fun verdict_expiry_window(m0: int, l0: int, m1: int, l1: int): int {
    if (m0 != 0 && m1 != 0) {
        return ORACLE_WINDOW_MEDIUM;
    }
    if (l0 != 0 && l1 != 0) {
        return ORACLE_WINDOW_LONG;
    }
    return 0;
}
