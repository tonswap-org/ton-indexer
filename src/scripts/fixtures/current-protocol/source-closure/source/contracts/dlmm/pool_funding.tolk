tolk 1.5.0

import "@stdlib/gas-payments";
import "./constants";
import "./pool_state_init";
import "../shared/jetton/jetton_quotes";
import "../shared/dex/swap_payload";

const POOL_RENT_SECONDS = 63072000;

fun pool_rent_target(binCount: int, positionCount: int, campaignCount: int): coins {
    val cells = 9000 + 2 * binCount + 3 * positionCount + 4 * campaignCount;
    return calculateStorageFee(BASECHAIN, POOL_RENT_SECONDS, 500 * cells, cells);
}
fun pool_tip(binCount: int, positionCount: int, campaignCount: int, before: coins): coins {
    val target = pool_rent_target(binCount, positionCount, campaignCount);
    return before < target ? target / 1024 : 0;
}
fun pool_init_balance(): coins { return pool_rent_target(0, 0, 0) / 4; }
fun pool_liq_log_fee(): coins { return calculateForwardFee(BASECHAIN, 1039, 2); }
fun pool_liq_aux_value(count: int): coins {
    return swap_notify_value() + calculateForwardFee(BASECHAIN, 247 + count * 289, 1 + count);
}
fun pool_register_value(): coins {
    return calculateGasFee(BASECHAIN, FACTORY_READY_GAS) + swap_log_fee()
        + calculateForwardFee(BASECHAIN, 700, 2);
}
fun pool_init_value(walletGramX: coins): coins {
    return pool_init_balance() + calculateGasFee(BASECHAIN, POOL_INIT_GAS)
        + jetton_discover_value(0) + jetton_discover_value(walletGramX) + pool_register_value();
}
fun pool_factory_target(codeBits: int, codeCells: int): coins {
    return calculateStorageFee(BASECHAIN, POOL_RENT_SECONDS, codeBits + 50000, codeCells + 100);
}
fun pool_factory_keep(codeBits: int, codeCells: int, before: coins): coins {
    val target = pool_factory_target(codeBits, codeCells);
    return before < target ? target / 32 : 0;
}
fun pool_factory_create_value(s: PoolFactoryStorage, walletGramX: coins, before: coins): coins {
    return calculateGasFee(BASECHAIN, FACTORY_CREATE_GAS)
        + calculateForwardFee(BASECHAIN, s.poolCodeBits + 4000, s.poolCodeCells + 12)
        + pool_init_value(walletGramX) + pool_factory_keep(s.poolCodeBits, s.poolCodeCells, before);
}
fun pool_factory_relay_value(): coins {
    return calculateGasFee(BASECHAIN, FACTORY_RELAY_GAS) + calculateForwardFee(BASECHAIN, 600, 1)
        + calculateGasFee(BASECHAIN, POOL_ADMIN_GAS_MAX) + swap_log_fee();
}
