tolk 1.5.0

import "governance_types"

struct GovernanceParams {
    minVote: int; maxVote: int; review: int; delay: int; grace: int
    share: int; floor: int; approval: int
}
fun governance_params(class: int): GovernanceParams {
    val bucket = governance_bucket();
    if (class == 2) { return { minVote: bucket, maxVote: bucket, review: 0, delay: 0, grace: bucket,
        share: 1500, floor: 200, approval: 6667 }; }
    if (class == 1) { return { minVote: 3 * bucket, maxVote: 14 * bucket, review: bucket,
        delay: 7 * bucket, grace: 7 * bucket, share: 3000, floor: 500, approval: 6667 }; }
    return { minVote: 3 * bucket, maxVote: 7 * bucket, review: bucket, delay: 2 * bucket,
        grace: 7 * bucket, share: 1500, floor: 200, approval: 6000 };
}
fun GovernanceProposal.closeAt(self): int {
    val p = governance_params(self.class);
    return self.decidedAt == 0 ? self.start + p.maxVote : max(self.decidedAt + p.review, self.start + p.minVote);
}
fun GovernanceProposal.lockUntil(self): uint32 {
    val p = governance_params(self.class);
    return (self.start + p.maxVote + p.review + p.delay + p.grace) as uint32;
}
fun GovernanceProposal.passes(self): bool {
    val t = self.tally.load();
    return t.partQ >= t.quorum && t.yes > 0 && t.yes * 10000 >= governance_params(self.class).approval * (t.yes + t.no);
}
fun governance_quorum(class: int, weight: coins, supply: coins): coins {
    val p = governance_params(class);
    return max((weight * p.share + 9999) / 10000, max(1, (supply * p.floor + 9999) / 10000));
}
fun GovernanceProps.group(self, class: int): (int, int) {
    val offset = class == 2 ? 8 : 0;
    var free = -1; var open = 0; var i = 0;
    repeat (8) {
        val slot = offset + i; val id = self.slots.at(slot);
        if (id == 0) { if (free < 0) { free = slot; } }
        else {
            val found = self.proposals.get(id);
            if (found.isFound && blockchain.now() < found.loadValue().closeAt()) { open += 1; }
        }
        i += 1;
    }
    return (free, open);
}
fun GovernanceLock.clearVotes(mutate self, props: GovernanceProps) {
    var i = 0;
    repeat (16) {
        val id = props.slots.at(i);
        if (id == 0 || id >= self.voteStamp) { self.voteMask &= ~(1 << i); }
        i += 1;
    }
}
