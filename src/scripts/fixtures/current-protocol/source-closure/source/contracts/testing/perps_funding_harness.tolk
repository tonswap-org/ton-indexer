tolk 1.5.0

// testing/perps_funding_harness.tolk
// Test harness surfacing funding rate math (ramps, keeper incentives) from the perps engine.

import "../perps/funding.tolk";

struct Storage {}

fun onInternalMessage(in: InMessage) {}

fun onBouncedMessage(in: InMessageBounced) {}

get fun funding_premium_preview(
    interval: int64,
    cap_bps: uint32,
    interest_bps: uint32,
    mark: coins,
    oracle: coins,
): int128 {
    val params = FundingParams {
        interval,
        capBps: cap_bps,
        interestBps: interest_bps,
    };
    return funding_compute_premium(params, mark, oracle);
}

get fun funding_delta_preview(
    interval: int64,
    cap_bps: uint32,
    interest_bps: uint32,
    last_index: int128,
    last_sync: int64,
    last_mark: coins,
    last_oracle: coins,
    next_mark: coins,
    next_oracle: coins,
    next_timestamp: int64,
): cell {
    val params = FundingParams {
        interval,
        capBps: cap_bps,
        interestBps: interest_bps,
    };
    val state = FundingAccumulator {
        index: last_index,
        lastSync: last_sync,
        markPrice: last_mark,
        oraclePrice: last_oracle,
        premiumRate: 0,
    };
    val obs = FundingObservation {
        markPrice: next_mark,
        oraclePrice: next_oracle,
        timestamp: next_timestamp,
    };
    val delta = funding_delta(params, state, obs);
    var builder = beginCell();
    builder.storeInt(delta.premiumRate, 128);
    builder.storeInt(delta.elapsed, 64);
    builder.storeInt(delta.indexDelta, 128);
    return builder.endCell();
}
