tolk 1.5.0

import "@stdlib/exotic-cells"
import "../utils/error_codes"

// A mutable sparse tree: consumed leaves remain consumed across future appends.
// A full uint64 index space fails closed; it never wraps or recycles a claim ID.
const OWED_ARCHIVE_LIMIT = 18446744073709551616
const OWED_ARCHIVE_MAX_COINS = (1 << 120) - 1

struct OwedArchive {
    count: uint65
    root: uint256
    total: coins
    frontier: map<uint8, uint256>
}
fun owed_archive_empty_hash(): int { return beginCell().storeUint(0, 8).endCell().hash(); }
fun owed_archive_pair(left: int, right: int): int {
    return beginCell().storeUint(3, 8).storeUint(left, 256).storeUint(right, 256).endCell().hash();
}
fun owed_archive_empty_root(): uint256 {
    var hash = owed_archive_empty_hash(); repeat (64) { hash = owed_archive_pair(hash, hash); }
    return hash as uint256;
}
fun owed_archive_leaf(slot: uint8, id: uint64, owner: address, amount: coins): int {
    return beginCell().storeUint(1, 8).storeAddress(contract.getAddress()).storeUint(slot, 8)
        .storeUint(id, 64).storeAddress(owner).storeUint(amount, 120).endCell().hash();
}
fun owed_archive_consumed(slot: uint8, id: uint64): int {
    return beginCell().storeUint(2, 8).storeAddress(contract.getAddress()).storeUint(slot, 8).storeUint(id, 64).endCell().hash();
}
fun OwedArchive.append(mutate self, slot: uint8, owner: address, amount: coins): uint64 {
    assert (self.count < OWED_ARCHIVE_LIMIT && amount > 0 && self.total <= OWED_ARCHIVE_MAX_COINS - amount) throw ERR_OWED_ARCHIVE_PROOF;
    val id = self.count as uint64;
    var node = owed_archive_leaf(slot, id, owner, amount); var zero = owed_archive_empty_hash();
    var index = self.count; var level = 0; var stored = false;
    repeat (64) {
        if ((index & 1) == 0) {
            if (!stored) { self.frontier.set(level as uint8, node as uint256); stored = true; }
            node = owed_archive_pair(node, zero);
        } else { node = owed_archive_pair(self.frontier.mustGet(level as uint8), node); }
        zero = owed_archive_pair(zero, zero); index >>= 1; level += 1;
    }
    self.root = node as uint256; self.count += 1; self.total += amount; return id;
}
fun owed_archive_proof_step(proof: cell, last: bool): (int, cell?) {
    var (s, exotic) = proof.beginParseSpecial();
    assert (!exotic && s.remainingBitsCount() == 257) throw ERR_OWED_ARCHIVE_PROOF;
    val sibling = s.loadUint(256); val tail = s.loadMaybeRef(); s.assertEnd();
    assert ((tail == null) == last) throw ERR_OWED_ARCHIVE_PROOF;
    return (sibling, tail);
}
fun OwedArchive.consume(mutate self, slot: uint8, id: uint64, owner: address, amount: coins, proof: cell) {
    assert (id < self.count && amount > 0 && amount <= self.total) throw ERR_OWED_ARCHIVE_PROOF;
    var old = owed_archive_leaf(slot, id, owner, amount); var next = owed_archive_consumed(slot, id);
    var difference = id ^ self.count; var frontierLevel = -1;
    while (difference != 0) { frontierLevel += 1; difference >>= 1; }
    var cursor = id; var step = proof; var level = 0;
    repeat (64) {
        // The occupied append-prefix subtree containing id. A full tree selects level64,
        // which has no frontier entry and can no longer append.
        if (level == frontierLevel) { self.frontier.set(level as uint8, next as uint256); }
        val (sibling, tail) = owed_archive_proof_step(step, level == 63);
        old = (cursor & 1) == 0 ? owed_archive_pair(old, sibling) : owed_archive_pair(sibling, old);
        next = (cursor & 1) == 0 ? owed_archive_pair(next, sibling) : owed_archive_pair(sibling, next);
        if (tail != null) { step = tail!; }
        cursor >>= 1; level += 1;
    }
    assert (old == self.root) throw ERR_OWED_ARCHIVE_PROOF;
    self.root = next as uint256; self.total -= amount;
}
