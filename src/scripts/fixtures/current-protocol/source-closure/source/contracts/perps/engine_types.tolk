tolk 1.5.0

import "../shared/risk/counterparty"
import "../shared/risk/exposure_cap"

const PX_OK = 0;
const PX_BAD_TERMS = 1;
const PX_MARGIN = 2;
const PX_LIMIT = 3;
const PX_CAP = 4;
const PX_LIQUIDATABLE = 5;
const PX_BUSY = 6;
const PX_STALE = 7;
const PX_ORACLE = 8;
const PX_FUNDING = 9;
const PX_CAPACITY = 10;
const PX_COINS_LIMIT = 1 << 120;
const PX_SIZE_LIMIT = 1 << 127;
const PX_PRICE_SCALE = 1000000000;
const PX_BPS = 10000;
const PX_IMPACT_CAP = 350;
const PX_FUNDING_INTERVAL = 3600;

struct PxParams {
    depthUnit: coins;
    oiCap: coins;
    impactAlpha: int128;
    impactBeta: int128;
    maxLeverageBps: uint32;
    maintenanceBps: uint32;
    fundingCapBps: uint32;
}
struct PxFunding {
    index: int128;
    remainder: int64;
    rate: int64;
    accruedAt: uint64;
    observedAt: uint64;
    validUntil: uint64;
}
struct PxPosition {
    gen: uint64;
    size: int128;
    margin: coins;
    entryNotional: coins;
    lastFundingIndex: int128;
    counterparty: Cell<CounterpartyPosition>;
}
struct PxPlan {
    status: int;
    position: PxPosition;
    fee: coins;
    payout: coins;
    lpPayout: coins;
    loss: coins;
    fundingCollected: coins;
    notionalDelta: int;
    fillPrice: coins;
    unpaidLoss: coins;
}
fun px_empty_position(): PxPosition {
    return { gen: 0, size: 0, margin: 0, entryNotional: 0, lastFundingIndex: 0,
        counterparty: CounterpartyPosition { reserved: 0, pendingFunding: 0, collectedLoss: 0, remainingEntitlement: 0 }.toCell() };
}
fun px_refuse(p: PxPosition, status: int): PxPlan {
    return { status, position: p, fee: 0, payout: 0, lpPayout: 0, loss: 0,
        fundingCollected: 0, notionalDelta: 0, fillPrice: 0, unpaidLoss: 0 };
}
