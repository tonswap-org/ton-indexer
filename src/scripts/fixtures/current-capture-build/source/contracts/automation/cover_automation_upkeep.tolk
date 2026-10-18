tolk 1.5.0

import "@stdlib/gas-payments"
import "../shared/utils/error_codes"

struct CoverUpkeepStorage { manager: address }
fun onInternalMessage(in: InMessage) { assert (in.body.isEmpty()) throw ERR_JETTON_CONFIG; }
get fun get_manager(): address { return CoverUpkeepStorage.fromCell(contract.getData()).manager; }
get fun get_rent_runway(): (coins, coins) {
    return (contract.getOriginalBalance(), calculateStorageFee(BASECHAIN, 31536000, 10000, 32));
}
