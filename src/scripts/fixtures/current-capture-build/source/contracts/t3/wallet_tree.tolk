tolk 1.5.0

import "@stdlib/exotic-cells";
import "wallet_types";

fun emptyHash(): int { return beginCell().storeUint(0,8).endCell().hash(); }
fun pair(a: int,b: int,kind: int): int { return beginCell().storeUint(kind,8).storeUint(a,256).storeUint(b,256).endCell().hash(); }
fun leaf(c: cell,kind: int): int { return beginCell().storeUint(kind,8).storeRef(c).endCell().hash(); }
fun step(proof: cell,last: bool): (int,cell?) {
    var (s,exotic) = proof.beginParseSpecial(); assert (!exotic && s.remainingBitsCount() == 257) throw 841;
    val sibling = s.loadUint(256); val tail = s.loadMaybeRef(); s.assertEnd(); assert ((tail == null) == last) throw 841;
    return (sibling,tail);
}
fun T3WalletState.replace(mutate self,key: int,oldHash: int,newHash: int,proof: cell) {
    var difference = key ^ self.nextId; var frontierLevel = -1;
    while (difference != 0) { frontierLevel += 1; difference >>= 1; }
    var old = oldHash; var next = newHash; var cursor = key; var node = proof; var level = 0;
    repeat (64) {
        // At full count, frontierLevel is 64 and there is no future append partition.
        if (level == frontierLevel) { self.frontier.set(level as uint8,next as uint256); }
        val (sibling,tail) = step(node,level == 63);
        old = (cursor & 1) == 0 ? pair(old,sibling,4) : pair(sibling,old,4);
        next = (cursor & 1) == 0 ? pair(next,sibling,4) : pair(sibling,next,4);
        cursor >>= 1; level += 1; if (tail != null) { node = tail!; }
    }
    assert (old == self.root) throw 842; self.root = next as uint256;
}
fun T3WalletState.append(mutate self,record: cell) {
    assert (self.nextId < 18446744073709551616) throw 849;
    var hash = leaf(record,3); var zero = emptyHash(); var cursor = self.nextId; var level = 0; var stored = false;
    while (cursor != 0) {
        if ((cursor & 1) == 0) {
            if (!stored) { self.frontier.set(level as uint8,hash as uint256); stored = true; }
            hash = pair(hash,zero,4);
        } else { hash = pair(self.frontier.mustGet(level as uint8),hash,4); }
        zero = pair(zero,zero,4); cursor >>= 1; level += 1;
    }
    // Above the highest set bit, no frontier lookup or cursor branch remains.
    if (level < 64) {
        if (!stored) { self.frontier.set(level as uint8,hash as uint256); }
        repeat (64 - level) { hash = pair(hash,zero,4); zero = pair(zero,zero,4); }
    }
    self.root = hash as uint256; self.nextId += 1;
}
fun T3WalletJournal.verify(self,index: int,evidence: cell,proof: cell) {
    assert (index < self.count) throw 843;
    var hash = leaf(evidence,1); var cursor = index; var node = proof; var level = 0;
    repeat (64) {
        val (sibling,tail) = step(node,level == 63);
        hash = (cursor & 1) == 0 ? pair(hash,sibling,2) : pair(sibling,hash,2);
        cursor >>= 1; level += 1; if (tail != null) { node = tail!; }
    }
    assert (hash == self.root) throw 843;
}
fun T3WalletJournal.append(mutate self,evidence: cell) {
    var hash = leaf(evidence,1); var zero = emptyHash(); var cursor = self.count; var level = 0; var stored = false;
    while (cursor != 0) {
        if ((cursor & 1) == 0) {
            if (!stored) { self.frontier.set(level as uint8,hash as uint256); stored = true; }
            hash = pair(hash,zero,2);
        } else { hash = pair(self.frontier.mustGet(level as uint8),hash,2); }
        zero = pair(zero,zero,2); cursor >>= 1; level += 1;
    }
    // Above the highest set bit, no frontier lookup or cursor branch remains.
    if (level < 64) {
        if (!stored) { self.frontier.set(level as uint8,hash as uint256); }
        repeat (64 - level) { hash = pair(hash,zero,2); zero = pair(zero,zero,2); }
    }
    self.root = hash as uint256; self.count += 1;
}
