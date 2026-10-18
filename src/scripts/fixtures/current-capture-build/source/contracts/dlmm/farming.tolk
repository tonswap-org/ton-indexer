tolk 1.5.0

// Campaign accounting is bounded by the existing position and campaign dictionaries.
import "./pool_storage";
import "../shared/math/full_math";

const POOL_FARM_SCALE = 1 << 128;
const POOL_FARM_MAX_WEIGHT = 1 << 120;

fun pool_farm_update(campaign: PoolCampaign, terms: PoolCampaignTerms, nowTs: int): PoolCampaign {
    var c = campaign;
    val t = min(nowTs, c.end);
    if (t <= c.lastTs) { return c; }
    val emitted = mulDivFloor(terms.total, t - terms.start, terms.duration);
    val prior = mulDivFloor(terms.total, c.lastTs - terms.start, terms.duration);
    if (c.weight > 0) { c.acc += mulDivFloor(emitted - prior, POOL_FARM_SCALE, c.weight); }
    c.lastTs = t;
    return c;
}
fun pool_farm_weight(position: PoolPosition, bin: PoolBin): int {
    return bin.pq == 0 ? 0 : position.shares / bin.pq;
}
fun pool_farm_accrued(position: PoolPosition, bin: PoolBin, campaign: PoolCampaign): int {
    val carry = position.rewardCarry == null ? 0 as uint128 : position.rewardCarry!.load().fraction;
    // A live position's unchanged weight is at most the campaign weight in every interval,
    // so accrued value is bounded by total reward * Q128, below 2^248.
    return pool_farm_weight(position, bin) * (campaign.acc - position.accSnap) + carry;
}
fun pool_farm_pending(position: PoolPosition, bin: PoolBin, campaign: PoolCampaign): coins {
    return pool_farm_accrued(position, bin, campaign) >> 128;
}

fun pool_farm_claim(mutate position: PoolPosition, bin: PoolBin, campaign: PoolCampaign): coins {
    val accrued = pool_farm_accrued(position, bin, campaign);
    val payout: coins = accrued >> 128;
    val fraction = accrued & (POOL_FARM_SCALE - 1);
    position.accSnap = campaign.acc;
    position.rewardCarry = fraction == 0 ? null : PoolFarmFraction { fraction }.toCell();
    return payout;
}
