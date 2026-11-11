tolk 1.5.0

// full_math.tolk
// High-precision mul/div helpers shared by DLMM liquidity and risk accounting.

import "../utils/error_codes.tolk";

@pure
fun mulDivFloor(x: int, y: int, z: int): int
    builtin

@pure
fun mulDivCeil(x: int, y: int, z: int): int
    builtin

@pure
fun mulDivRound(x: int, y: int, z: int): int
    builtin

fun mul_div(a: int, b: int, denominator: int): int {
    assert (denominator != 0) throw ERR_DIV_ZERO;
    if (a == 0 || b == 0) {
        return 0;
    }
    return mulDivFloor(a, b, denominator);
}

fun mul_div_round_up(a: int, b: int, denominator: int): int {
    assert (denominator != 0) throw ERR_DIV_ZERO;
    if (a == 0 || b == 0) {
        return 0;
    }
    return mulDivCeil(a, b, denominator);
}

fun mul_div_round(a: int, b: int, denominator: int): int {
    assert (denominator != 0) throw ERR_DIV_ZERO;
    if (a == 0 || b == 0) {
        return 0;
    }
    return mulDivRound(a, b, denominator);
}

fun ceil_div(value: int, divisor: int): int {
    assert (divisor != 0) throw ERR_DIV_ZERO;
    if (value == 0) {
        return 0;
    }
    return mulDivCeil(value, 1, divisor);
}
