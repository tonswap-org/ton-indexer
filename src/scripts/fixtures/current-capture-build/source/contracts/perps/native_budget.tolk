tolk 1.5.0

import "../shared/jetton/jetton_slots"
import "@stdlib/gas-payments"

const PX_HANDLER_GAS = 250000;
const PX_BOUNCE_GAS = 250000;

fun px_leg(ledger: JettonLedger): coins { return ledger.legValue(0, 0, 0, 0, PX_BOUNCE_GAS); }
fun px_rv_target_value(): coins {
    return calculateGasFee(BASECHAIN, 60000) + calculateGasFee(BASECHAIN, PX_HANDLER_GAS)
        + calculateStorageFee(BASECHAIN, 157680000, 1000, 2)
        + calculateForwardFee(BASECHAIN, 900, 1) + calculateForwardFee(BASECHAIN, 1300, 2);
}
fun px_rv_settle_value(ledger: JettonLedger): coins {
    return calculateGasFee(BASECHAIN, 80000) + calculateGasFee(BASECHAIN, 100000)
        + ledger.legValue(0, 0, 32, 1, 250000) + calculateForwardFee(BASECHAIN, 900, 1)
        + 2 * calculateForwardFee(BASECHAIN, 1300, 2);
}
