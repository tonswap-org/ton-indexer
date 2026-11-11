tolk 1.5.0
import "@stdlib/gas-payments";
import "../shared/oracle/verdict";

const OPTION_KIND_SHOUT = 1;
const OPTION_KIND_OUTPERF = 2;
const OPTION_MIN_NOTIONAL = 500000000;
const OPTION_MAX_NOTIONAL = 15000000000;
const OPTION_MIN_TENOR = 10800;
const OPTION_MAX_TENOR = 2592000;
const OPTION_MAX_TEMPLATES = 1024;
const OPTION_MAX_SERIES = 8192;
// Live exposure alone does not bound retained early-exercise outcomes.
const OPTION_MAX_CHILD_POSITIONS = 256;
const OPTION_MANAGER_GAS = 160000;
const OPTION_CREATE_CHAIN_GAS = OPTION_MANAGER_GAS + 120000 + 30000;
const OPTION_CHILD_INIT_BITS = 100000;
const OPTION_CHILD_INIT_CELLS = 256;
const OPTION_CHILD_MAX_BITS = 1000000;
const OPTION_CHILD_MAX_CELLS = 2048;

fun option_child_rent(tenor: int): coins {
    return 2 * calculateStorageFee(BASECHAIN,tenor + OPTION_BUY_CUTOFF + 7776000,
        OPTION_CHILD_MAX_BITS,OPTION_CHILD_MAX_CELLS);
}
fun option_series_rent(): coins { return 2*calculateStorageFee(BASECHAIN,31536000,5000,12); }
fun option_create_value(): coins {
    return calculateGasFee(BASECHAIN,OPTION_CREATE_CHAIN_GAS)
        + calculateForwardFee(BASECHAIN,OPTION_CHILD_INIT_BITS + 4000,OPTION_CHILD_INIT_CELLS + 8)
        + 2*calculateForwardFee(BASECHAIN,1900,3)
        + option_child_rent(OPTION_MAX_TENOR) + option_series_rent();
}
fun option_basechain(a: address): bool { return a.getWorkchain() == 0; }
