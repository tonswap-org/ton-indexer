tolk 1.5.0

import "governance_types"

fun governance_day_add(mutate days: map<uint32, coins>, day: uint32, delta: int) {
    val found = days.get(day);
    val amount = (found.isFound ? found.loadValue() : 0 as coins) + delta;
    if (amount == 0) { days.delete(day); }
    else { days.set(day, amount as coins); }
}

// Cursors describe processed keys, not wall time: removals remain exact during a partial roll.
fun GovernanceStake.removeWeight(mutate self, lock: GovernanceLock, bucketSeconds: int) {
    if (lock.bucket <= self.matureThrough) { self.mature -= lock.amount; }
    else { governance_day_add(mutate self.buckets, lock.bucket, -lock.amount); }
    val expiry = (lock.commitUntil / bucketSeconds) as uint32;
    if (expiry <= self.expiredThrough) { self.expired -= lock.amount; }
    else { governance_day_add(mutate self.expiring, expiry, -lock.amount); }
}
fun GovernanceStake.addWeight(mutate self, lock: GovernanceLock, bucketSeconds: int) {
    if (lock.bucket <= self.matureThrough) { self.mature += lock.amount; }
    else { governance_day_add(mutate self.buckets, lock.bucket, lock.amount); }
    val expiry = (lock.commitUntil / bucketSeconds) as uint32;
    if (expiry <= self.expiredThrough) { self.expired += lock.amount; }
    else { governance_day_add(mutate self.expiring, expiry, lock.amount); }
}

fun GovernanceStake.rollComplete(self, today: int): bool {
    val young = self.buckets.findFirst();
    val end = self.expiring.findFirst();
    return (!young.isFound || young.getKey() > today - 30) && (!end.isFound || end.getKey() > today);
}

// Alternate due maps so lock traffic cannot grow the expiry map while maturation consumes the budget.
fun GovernanceStake.roll(mutate self, today: int, limit: int): int {
    var rolled = 0;
    var preferYoung = true;
    repeat (limit) {
        val young = self.buckets.findFirst();
        val end = self.expiring.findFirst();
        val youngDue = young.isFound && young.getKey() <= today - 30;
        val endDue = end.isFound && end.getKey() <= today;
        if (!youngDue && !endDue) { break; }
        if (youngDue && (!endDue || preferYoung)) {
            self.mature += young.loadValue();
            self.matureThrough = young.getKey();
            self.buckets.delete(young.getKey());
        } else {
            self.expired += end.loadValue();
            self.expiredThrough = end.getKey();
            self.expiring.delete(end.getKey());
        }
        preferYoung = !preferYoung;
        rolled += 1;
    }
    val young = self.buckets.findFirst();
    val end = self.expiring.findFirst();
    if (!young.isFound || young.getKey() > today - 30) {
        self.matureThrough = max(self.matureThrough, today - 30) as uint32;
    }
    if (!end.isFound || end.getKey() > today) { self.expiredThrough = max(self.expiredThrough, today) as uint32; }
    return rolled;
}

// Exact even when the roll is incomplete; callers use only present/future buckets.
fun GovernanceStake.weightAt(self, day: int): coins {
    var scaled = 30 * (self.mature - self.expired);
    var item = self.buckets.findFirst();
    while (item.isFound) {
        val age = day - item.getKey();
        if (age >= 7) { scaled += item.loadValue() * min(age, 30); }
        item = self.buckets.iterateNext(item);
    }
    var end = self.expiring.findFirst();
    while (end.isFound && end.getKey() <= day) {
        scaled -= 30 * end.loadValue();
        end = self.expiring.iterateNext(end);
    }
    return scaled / 30;
}

// Transaction paths call this only after rollComplete, so at most 23 young keys contribute.
fun GovernanceStake.snapshot(self, day: int): coins {
    var scaled = 30 * (self.mature - self.expired);
    var item = self.buckets.findFirst();
    while (item.isFound && item.getKey() <= day - 7) {
        scaled += item.loadValue() * (day - item.getKey());
        item = self.buckets.iterateNext(item);
    }
    return scaled / 30;
}

fun GovernanceLock.weight(self, start: uint32, bucketSeconds: int): (coins, uint122) {
    val day = start / bucketSeconds;
    val age = day - self.bucket;
    val commitment = self.commitChangedAt >= start ? self.prevCommit : self.commitUntil;
    if (age < 7 || commitment / bucketSeconds <= day) { return (0, 0); }
    val q = self.amount * min(age, 30) / 30;
    val remaining = commitment - start;
    val multiplier = remaining >= 90 * bucketSeconds ? 4 : remaining >= 30 * bucketSeconds ? 2 : 1;
    return (q, q * multiplier);
}
