tolk 1.5.0

// funding.tolk
// Funding rate computation and accrual logic for perpetual positions.

import "../shared/utils/error_codes.tolk";

const FUNDING_SCALE: int128 = 1000000000; // 1e9 fixed-point scale for funding indices

struct FundingParams {
    interval: int64;
    capBps: uint32;
    interestBps: uint32;
}

struct FundingAccumulator {
    index: int128;
    lastSync: int64;
    markPrice: coins;
    oraclePrice: coins;
    premiumRate: int128;
}

struct FundingObservation {
    markPrice: coins;
    oraclePrice: coins;
    timestamp: int64;
}

struct FundingDelta {
    premiumRate: int128;
    elapsed: int64;
    indexDelta: int128;
}

fun clamp_int256_to_int128(value: int256): int128 {
    val maxValue = ((1 as int256) << 127) - 1;
    val minValue = -((1 as int256) << 127);
    if (value > maxValue) {
        return maxValue as int128;
    }
    if (value < minValue) {
        return minValue as int128;
    }
    return value as int128;
}

fun funding_validate_params(params: FundingParams) {
    assert (params.interval > 0) throw ERR_PERPS_CONFIG;
}

fun funding_init(params: FundingParams, obs: FundingObservation): FundingAccumulator {
    funding_validate_params(params);
    return FundingAccumulator {
        index: 0,
        lastSync: obs.timestamp,
        markPrice: obs.markPrice,
        oraclePrice: obs.oraclePrice,
        premiumRate: funding_compute_premium(params, obs.markPrice, obs.oraclePrice),
    };
}

fun funding_should_tick(params: FundingParams, state: FundingAccumulator, nowTs: int64): bool {
    funding_validate_params(params);
    val elapsed = nowTs - state.lastSync;
    if (elapsed < 0) {
        return false;
    }
    return elapsed >= params.interval;
}

fun funding_compute_premium(params: FundingParams, markPrice: coins, oraclePrice: coins): int128 {
    if (oraclePrice == 0) {
        return 0;
    }
    val mark = markPrice as int256;
    val oracle = oraclePrice as int256;
    val diff = mark - oracle;
    var rawPremium = (diff * (FUNDING_SCALE as int256)) / oracle;
    var cap = (params.capBps as int256) * (FUNDING_SCALE as int256) / 10000;
    if (cap < 0) {
        cap = -cap;
    }
    if (cap > 0) {
        if (rawPremium > cap) {
            rawPremium = cap;
        }
        if (rawPremium < -cap) {
            rawPremium = -cap;
        }
    }
    val interest = (params.interestBps as int256) * (FUNDING_SCALE as int256) / 10000;
    val total = rawPremium + interest;
    return clamp_int256_to_int128(total);
}

fun funding_delta(params: FundingParams, state: FundingAccumulator, obs: FundingObservation): FundingDelta {
    funding_validate_params(params);
    var elapsed = obs.timestamp - state.lastSync;
    if (elapsed < 0) {
        elapsed = 0;
    }
    val premium = funding_compute_premium(params, obs.markPrice, obs.oraclePrice);
    val interval = params.interval as int128;
    val indexDelta = (premium * (elapsed as int128)) / interval;
    return FundingDelta {
        premiumRate: premium,
        elapsed,
        indexDelta,
    };
}

fun funding_apply(state: FundingAccumulator, delta: FundingDelta, obs: FundingObservation): FundingAccumulator {
    return FundingAccumulator {
        index: state.index + delta.indexDelta,
        lastSync: obs.timestamp,
        markPrice: obs.markPrice,
        oraclePrice: obs.oraclePrice,
        premiumRate: delta.premiumRate,
    };
}
