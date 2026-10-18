tolk 1.5.0

// testing/full_math_harness.tolk
// Harness exposing the FullMath helpers so we can validate large-number precision and rounding paths.

import "../shared/math/full_math.tolk";

struct Storage {}

fun onInternalMessage(in: InMessage) {}

fun onBouncedMessage(in: InMessageBounced) {}

get fun mul_div_preview(a: int, b: int, denominator: int): int {
    return mul_div(a, b, denominator);
}

get fun mul_div_round_up_preview(a: int, b: int, denominator: int): int {
    return mul_div_round_up(a, b, denominator);
}

get fun mul_div_round_preview(a: int, b: int, denominator: int): int {
    return mul_div_round(a, b, denominator);
}

get fun ceil_div_preview(value: int, divisor: int): int {
    return ceil_div(value, divisor);
}
