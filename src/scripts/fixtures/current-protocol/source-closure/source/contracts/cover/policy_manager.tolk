tolk 1.5.0

import "@stdlib/gas-payments"
import "../shared/utils/error_codes"

struct CoverManagerStorage { vault: address }
fun onInternalMessage(in: InMessage) { assert (in.body.isEmpty()) throw ERR_JETTON_CONFIG; }
get fun get_cover_vault(): address { return CoverManagerStorage.fromCell(contract.getData()).vault; }
get fun get_exposure_cap(key: uint32): (coins, coins, coins, coins) { return (0, 0, 0, 30000000000); }
get fun get_rent_runway(): (coins, coins) {
    return (contract.getOriginalBalance(), calculateStorageFee(BASECHAIN, 31536000, 10000, 32));
}
