tolk 1.5.0

import "@stdlib/gas-payments"

const FEE_ROUTER_CREDIT_GAS = 40000
fun fee_router_min_forward(): coins { return calculateGasFee(BASECHAIN, FEE_ROUTER_CREDIT_GAS); }
