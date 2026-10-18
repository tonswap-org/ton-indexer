tolk 1.5.0

// Shared RiskVault wire layouts. Peer authentication belongs to the receiving contract.
struct (0x52564344) RvDeposit { bucketId: uint16 }

struct (0x52565447) RvTarget {
    actionId: uint64
    bucketId: uint16
    positionId: uint256
    notional: coins
    reserved: coins
}

struct (0x52565441) RvTargetAnswer {
    actionId: uint64
    bucketId: uint16
    positionId: uint256
    status: uint8
    reason: uint16
    notional: coins
    reserved: coins
}

struct (0x52565354) RvSettle {
    actionId: uint64
    bucketId: uint16
    positionId: uint256
    payout: coins
    notional: coins
    reserved: coins
    recipient: address
}

struct (0x52565348) RvSettled {
    actionId: uint64
    bucketId: uint16
    positionId: uint256
    paid: coins
    applied: bool
}

struct (0x46535750) HolderFeeSweep { queryId: uint64 }
struct (0x52565253) SettleRetry { queryId: uint64; positionId: uint256 }

const RV_TARGET_APPLIED = 1
const RV_TARGET_REJECTED = 2
const RV_REASON_STALE = 1
const RV_REASON_PAUSED = 3
const RV_REASON_INSUFFICIENT = 4
const RV_REASON_UNDER_RESERVED = 5
const RV_REASON_CAPACITY = 6
const RV_REASON_OVER_BUCKET_CAP = 7

// Used after an authenticated notification; malformed payloads must not throw.
fun rv_deposit_bucket(body: slice): int {
    if (body.remainingBitsCount() != 48 || body.remainingRefsCount() != 0) { return -1; }
    if (body.loadUint(32) != 0x52564344) { return -1; }
    return body.loadUint(16);
}
