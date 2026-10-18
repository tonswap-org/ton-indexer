tolk 1.5.0

// A static budget includes committed and pending exposure. It never reads market depth.
struct ExposureCap { used: coins; operatingCap: coins }

const FIRST_RELEASE_PERPS_GLOBAL_OI_CAP = 22500000000
const OPTIONS_AGGREGATE_NOTIONAL_CEILING = 15000000000
const COVER_NOTIONAL_CEILING = 30000000000
const MIN_OPTION_NOTIONAL = 500000000
const MIN_PERPS_ENTRY_NOTIONAL = 750000000

fun cap_can_add(c: ExposureCap, ceiling: coins, delta: coins): bool {
    return delta >= 0 && c.used + delta <= min(c.operatingCap, ceiling);
}

// Callers admit an increase with cap_can_add before committing it.
fun cap_add(c: ExposureCap, delta: coins): ExposureCap {
    return { used: c.used + delta, operatingCap: c.operatingCap };
}

fun cap_sub(c: ExposureCap, delta: coins): ExposureCap {
    return { used: max(c.used - delta, 0), operatingCap: c.operatingCap };
}

fun cap_set(c: ExposureCap, ceiling: coins, value: coins): (ExposureCap, bool) {
    if (value < 0 || value > ceiling) { return (c, false); }
    return ({ used: c.used, operatingCap: value }, true);
}
