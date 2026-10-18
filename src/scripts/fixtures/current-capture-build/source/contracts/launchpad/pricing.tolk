tolk 1.5.0

// First-release price unit: raw T3 per raw sale token, with 18 decimal places.
const LAUNCHPAD_PRICE_SCALE: int = 1000000000000000000;
const LAUNCHPAD_MAX_PRICE: int = 1329227995784915872903807060280344575;

fun launchpad_tokens_for_payment(payment: coins, price: coins): coins {
    return (payment * LAUNCHPAD_PRICE_SCALE) / price;
}

// Round funding up so even a fractional T3 atomic unit is paid for.
fun launchpad_payment_for_tokens(quantity: coins, price: coins): coins {
    return (quantity * price + LAUNCHPAD_PRICE_SCALE - 1) / LAUNCHPAD_PRICE_SCALE;
}
