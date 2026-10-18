tolk 1.5.0
import "@stdlib/exotic-cells";

// A bounce of BounceMode.RichBounce: RichBounceBody, prefix 0xfffffffe, with two
// references. Its root has 73 bits when no compute phase ran and 137 when the
// Maybe bit is followed by the inline gasUsed and vmSteps pair. A handler checks
// the shape before it decodes, because a bounced message cannot bounce again:
// a decoder that traps on a crafted body loses the bounce. An ordinary bounce
// (0xffffffff and at most 256 bits of the body) never passes.
fun rich_bounce_is_canonical(bouncedBody: slice): bool {
    val bits = bouncedBody.remainingBitsCount();
    if ((bits != 73 && bits != 137) || bouncedBody.remainingRefsCount() != 2
        || bouncedBody.preloadUint(32) != 0xfffffffe) {
        return false;
    }
    // After the prefix come bouncedByPhase:uint8 and exitCode:int32.
    val hasComputePhase = bouncedBody.getMiddleBits(72, 1).preloadUint(1) == 1;
    return hasComputePhase == (bits == 137);
}

// The root geometry is sufficient to locate the original send LT without traversing
// an optional extra-currency dictionary. Zero means unavailable or malformed.
fun rich_bounce_original_lt(info: cell): uint64 {
    var (s,exotic) = info.beginParseSpecial();
    if (exotic || s.remainingBitsCount() < 4) { return 0; }
    val amountBits = s.loadUint(4) * 8;
    if (s.remainingBitsCount() != amountBits + 97) { return 0; }
    s.skipBits(amountBits);
    val hasExtra = s.loadBool();
    if (s.remainingRefsCount() != (hasExtra ? 1 : 0)) { return 0; }
    return s.loadUint(64) as uint64;
}
