tolk 1.5.0

import "./pool_storage";

// A bounded collision bucket caps the number of owner-prefix forks paid by any write. The first
// owner and first position are inline; farm fractions add at most one cell per position.
const POOL_POSITION_BUCKET_OWNERS = 4;
fun pool_owner_key(owner: address): uint128 {
    return (beginCell().storeAddress(contract.getAddress()).storeAddress(owner).endCell().hash() >> 128) as uint128;
}
fun pool_owner_empty(): PoolOwnerPositions {
    return { firstBin: 0, first: { shares: 0, farmId: 0, accSnap: 0, rewardCarry: null }, more: [] };
}
fun pool_positions_load(index: map<uint128, PoolPositionBucket>, owner: address): (bool, PoolOwnerPositions) {
    val found = index.get(pool_owner_key(owner));
    if (!found.isFound) { return (true, pool_owner_empty()); }
    val bucket = found.loadValue();
    if (bucket.owner == owner) { return (true, bucket.positions); }
    val other = bucket.others.get(owner);
    if (other.isFound) { return (true, other.loadValue()); }
    return (bucket.otherCount < POOL_POSITION_BUCKET_OWNERS - 1, pool_owner_empty());
}
fun pool_positions_owner(index: map<uint128, PoolPositionBucket>, owner: address): PoolOwnerPositions {
    val (_, positions) = pool_positions_load(index, owner);
    return positions;
}
fun pool_positions_store(mutate index: map<uint128, PoolPositionBucket>, owner: address, positions: PoolOwnerPositions): bool {
    val key = pool_owner_key(owner); val found = index.get(key);
    if (!found.isFound) {
        if (positions.first.shares > 0) { index.set(key, { owner, positions, otherCount: 0, others: [] }); }
        return true;
    }
    var bucket = found.loadValue();
    if (bucket.owner == owner) {
        if (positions.first.shares > 0) { bucket.positions = positions; }
        else {
            val promote = bucket.others.findFirst();
            if (!promote.isFound) { index.delete(key); return true; }
            bucket.owner = promote.getKey(); bucket.positions = promote.loadValue();
            bucket.others.delete(bucket.owner); bucket.otherCount -= 1;
        }
    } else if (positions.first.shares == 0) {
        if (!bucket.others.exists(owner)) { return true; }
        bucket.others.delete(owner); bucket.otherCount -= 1;
    } else {
        if (!bucket.others.exists(owner)) {
            if (bucket.otherCount >= POOL_POSITION_BUCKET_OWNERS - 1) { return false; }
            bucket.otherCount += 1;
        }
        bucket.others.set(owner, positions);
    }
    index.set(key, bucket); return true;
}
fun PoolOwnerPositions.position(self, binId: int32): PoolPosition? {
    if (self.first.shares == 0) { return null; }
    if (binId == self.firstBin) { return self.first; }
    val found = self.more.get(binId);
    return found.isFound ? found.loadValue() : null;
}
fun PoolOwnerPositions.put(mutate self, binId: int32, position: PoolPosition) {
    if (self.first.shares == 0 || self.firstBin == binId) { self.firstBin = binId; self.first = position; }
    else { self.more.set(binId, position); }
}
fun PoolOwnerPositions.remove(mutate self, binId: int32) {
    if (self.first.shares == 0) { return; }
    if (self.firstBin != binId) { self.more.delete(binId); return; }
    val next = self.more.findFirst();
    if (!next.isFound) { self = pool_owner_empty(); return; }
    self.firstBin = next.getKey(); self.first = next.loadValue(); self.more.delete(self.firstBin);
}
