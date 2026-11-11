tolk 1.5.0

import "@stdlib/exotic-cells";

// Physical receiving transaction LT is the key. The caller authenticates the receipt.
struct T3Receipt { key: uint64; payload: cell }
struct T3ReceiptTree { root: uint256; initialized: bool; lastKey: uint64; lastLeaf: uint256; frontier: cell? }
fun t3_receipt_empty_hash(): int { return beginCell().storeUint(0,8).hash(); }
fun t3_receipt_pair(a: int,b: int): int { return beginCell().storeUint(4,8).storeUint(a,256).storeUint(b,256).hash(); }
fun t3_receipt_leaf(record: cell): int { return beginCell().storeUint(3,8).storeRef(record).hash(); }
fun t3_receipt_bit_size(value: int): int asm "UBITSIZE";
fun t3_receipt_highest_bit(value: int): int { return t3_receipt_bit_size(value) - 1; }
fun t3_receipt_path(hashes: array<int>): cell {
    var head: cell? = null; var end = 64;
    while (end > 0) {
        val first = end >= 3 ? end - 3 : 0; var index = first; var b = beginCell();
        while (index < end) { b.storeUint(hashes.get(index),256); index += 1; }
        if (head != null) { b.storeRef(head!); }
        head = b.endCell(); end = first;
    }
    return head!;
}
fun T3ReceiptTree.append(mutate self,receipt: Cell<T3Receipt>) {
    val key = receipt.load().key;
    assert (!self.initialized || key > self.lastKey) throw 882;
    val split = self.initialized ? t3_receipt_highest_bit(key ^ self.lastKey) : 64;
    var old = self.lastLeaf as int; var next = t3_receipt_leaf(receipt); var zero = t3_receipt_empty_hash(); var level = 0;
    var previousPath = self.frontier == null ? createEmptySlice() : self.frontier!.beginParse(); var hashes: array<int> = [];
    repeat (64) {
        var previous = zero;
        if (self.initialized) {
            if (previousPath.remainingBitsCount() == 0) { previousPath = previousPath.loadRef().beginParse(); }
            previous = previousPath.loadUint(256);
        }
        var sibling = previous;
        if (level < split) {
            // Save the old rightmost subtree before replacing its lower t3_receipt_path with empty siblings.
            if (self.initialized) {
                old = ((self.lastKey >> level) & 1) == 0 ? t3_receipt_pair(old,previous) : t3_receipt_pair(previous,old);
            }
            sibling = zero;
        } else if (level == split) { sibling = old; }
        hashes.push(sibling);
        next = ((key >> level) & 1) == 0 ? t3_receipt_pair(next,sibling) : t3_receipt_pair(sibling,next);
        if (level < split) { zero = t3_receipt_pair(zero,zero); } level += 1;
    }
    self.root = next as uint256; self.lastKey = key; self.lastLeaf = t3_receipt_leaf(receipt) as uint256;
    self.frontier = t3_receipt_path(hashes); self.initialized = true;
}
// Only the divergent subtree changes in the retained rightmost path.
fun t3_receipt_patch(path: cell,index: int,value: int): cell {
    var prefixes: array<cell> = []; var node = path; var remaining = index;
    var s = node.beginParse();
    while (remaining >= s.remainingBitsCount() / 256) {
        remaining -= s.remainingBitsCount() / 256; prefixes.push(node);
        node = s.loadRef(); s = node.beginParse();
    }
    val before = s.loadBits(remaining * 256); s.skipBits(256);
    var result = beginCell().storeSlice(before).storeUint(value,256).storeSlice(s).endCell();
    while (prefixes.size() > 0) {
        var prefix = prefixes.pop().beginParse();
        result = beginCell().storeSlice(prefix.loadBits(prefix.remainingBitsCount())).storeRef(result).endCell();
    }
    return result;
}
fun T3ReceiptTree.replace(mutate self,prior: Cell<T3Receipt>?,receipt: Cell<T3Receipt>,proof: cell) {
    val key = receipt.load().key;
    assert (self.initialized && key <= self.lastKey && (prior == null || prior!.load().key == key)) throw 883;
    val split = t3_receipt_highest_bit(key ^ self.lastKey);
    var old = prior == null ? t3_receipt_empty_hash() : t3_receipt_leaf(prior!); var next = t3_receipt_leaf(receipt); var step = proof; var level = 0;
    var changed = 0;
    if (key == self.lastKey) { self.lastLeaf = next as uint256; }
    repeat (64) {
        if (level == split) { changed = next; }
        var (s,exotic) = step.beginParseSpecial(); assert (!exotic && s.remainingBitsCount() == 257) throw 884;
        val sibling = s.loadUint(256); val tail = s.loadMaybeRef(); s.assertEnd();
        assert ((tail == null) == (level == 63)) throw 884;
        old = ((key >> level) & 1) == 0 ? t3_receipt_pair(old,sibling) : t3_receipt_pair(sibling,old);
        next = ((key >> level) & 1) == 0 ? t3_receipt_pair(next,sibling) : t3_receipt_pair(sibling,next);
        level += 1; if (tail != null) { step = tail!; }
    }
    assert (old == self.root) throw 885; self.root = next as uint256;
    if (split >= 0) { self.frontier = t3_receipt_patch(self.frontier!,split,changed); }
}
fun t3_receipt_tree(): T3ReceiptTree {
    return { root: 80355962451499150200844324337340404487209003436766272097586724178421748362113,
        initialized: false, lastKey: 0, lastLeaf: t3_receipt_empty_hash(), frontier: null };
}
