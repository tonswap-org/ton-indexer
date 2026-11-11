tolk 1.5.0

import "../shared/math/full_math.tolk";

// Price of a bin in X per T3 with both tokens at 9 decimals: (1 + binSpacing / 1e6) ^ binId as Q64,
// increasing in binId and never above the exact value. Returns 0 for a spacing outside 1..10,000, an
// id beyond +-200,000 and a result outside [2^32, 2^128), where the price or its inverse would keep
// fewer than 32 significant bits. Never throws: the power saturates below 2^128, so no product leaves
// 257 bits.
fun dlmm_price_norm_q64(binId: int, binSpacing: int): int {
    if ((binSpacing < 1) | (binSpacing > 10000) | (binId < -200000) | (binId > 200000)) {
        return 0;
    }
    val cap = (1 << 128) - 1;
    var acc = (1 << 64) + (binSpacing << 64) / 1000000;
    var power = 1 << 64;
    var n = abs(binId);
    while (n > 0) {
        if ((n & 1) != 0) {
            power = min((power * acc) >> 64, cap);
        }
        n = n >> 1;
        acc = min((acc * acc) >> 64, cap);
    }
    if (power == cap) {
        return 0;
    }
    if (binId >= 0) {
        return power;
    }
    // Every step rounds down, so the power can be short of the exact one by 2^-45 of itself at most
    // (one unit in 2^64, doubled by each of 18 squarings). Dividing by a bound from above keeps the
    // inverse from exceeding the exact price.
    val price = (1 << 128) / (power + (power >> 44) + 1);
    return price < (1 << 32) ? 0 : price;
}

// Raw X units per raw T3 unit. Wider intermediate precision permits all decimal scales.
// The bounded power and 513-bit mulDiv intermediate make every invalid input return zero.
fun dlmm_price_raw_q64(binId: int, binSpacing: int, xDecimals: int): int {
    if (binSpacing < 1 || binSpacing > 10000 || binId < -200000 || binId > 200000 || xDecimals < 0 || xDecimals > 18) { return 0; }
    val q128 = 1 << 128;
    val limit = 1 << 224;
    var factor = q128 + mulDivFloor(q128, binSpacing, 1000000);
    var power = q128;
    var n = abs(binId);
    while (n > 0) {
        if ((n & 1) != 0) {
            if (factor >= limit || power > mulDivFloor(limit - 1, q128, factor)) { return 0; }
            power = mulDivFloor(power, factor, q128);
        }
        n >>= 1;
        if (n > 0) {
            factor = factor >= limit || factor > mulDivFloor(limit - 1, q128, factor)
                ? limit : mulDivFloor(factor, factor, q128);
        }
    }
    if (binId < 0) { power = mulDivFloor(q128, q128, power); }
    var scale = 1;
    repeat (xDecimals) { scale *= 10; }
    val raw = mulDivFloor(power, scale, 1000000000 * (1 << 64));
    return raw >= (1 << 32) && raw < (1 << 128) ? raw : 0;
}

fun dlmm_bin_valid(binId: int, binSpacing: int, xDecimals: int): bool {
    return dlmm_price_raw_q64(binId, binSpacing, xDecimals) != 0;
}
