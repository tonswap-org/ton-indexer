tolk 1.5.0

import "../shared/jetton/jetton_quotes";

import "../dlmm/pool_state_init";
import "../dlmm/pool_storage";
import "../dlmm/constants";
import "../dlmm/math";
import "../dlmm/pool_codec";

fun onInternalMessage(in: InMessage) {}

get fun initial_data(factory: address, feeSink: address, treasury: address, t3Master: address, id: cell): cell {
    return pool_initial_data(factory, feeSink, treasury, t3Master, JETTON_V21_WALLET_GAS, 0, jetton_standard_budget(JETTON_V21_WALLET_GAS), PoolId.fromCell(id));
}
get fun roundtrip(kind: int, value: cell): cell {
    if (kind == 0) { return PoolId.fromCell(value).toCell(); }
    if (kind == 1) { return LiqAdd.fromCell(value).toCell(); }
    if (kind == 2) { return LiqRemove.fromCell(value).toCell(); }
    if (kind == 3) { return LiqOutcome.fromCell(value).toCell(); }
    if (kind == 4) { return PoolCreate.fromCell(value).toCell(); }
    if (kind == 5) { return PoolCreated.fromCell(value).toCell(); }
    if (kind == 6) { return PoolReady.fromCell(value).toCell(); }
    if (kind == 7) { return LiqAddRow.fromCell(value).toCell(); }
    if (kind == 8) { return LiqRemoveRow.fromCell(value).toCell(); }
    if (kind == 9) { return LiqResultRow.fromCell(value).toCell(); }
    if (kind == 11) { return PoolPositionBucket.fromCell(value).toCell(); }
    return PoolFactoryStorage.fromCell(value).toCell();
}
get fun constants(): (int, int, int, int, int, int, int, int, int, int, int, int, int, int, int) {
    return (MAX_SWAP_BINS, MAX_LIQ_ADD_BINS, MAX_LIQ_REMOVE_BINS, MAX_BINS, MAX_POSITIONS, MAX_CAMPAIGNS, POOL_OWED_CAP,
        SWAP_PREWALK_GAS_MAX, STEP_GAS_MAX, APPLY_TAIL_GAS_MAX, SWAP_GAS_MAX, ADD_GAS_MAX, REMOVE_GAS_MAX,
        POOL_PUBLIC_BIN_SPACING, POOL_PUBLIC_FEE_PIPS);
}

get fun price(binId: int, spacing: int, decimals: int): (int, bool) {
    return (dlmm_price_raw_q64(binId, spacing, decimals), dlmm_bin_valid(binId, spacing, decimals));
}

get fun parse(kind: int, value: cell, credited: coins): cell? {
    if (kind == 0) { val id = pool_id_try_parse(value); return id == null ? null : id.toCell(); }
    val opened = pool_open(value);
    if (opened == null) { return null; }
    if (kind == 1) { val add = pool_add_try_parse(opened, credited); return add == null ? null : add.toCell(); }
    if (kind == 2) { val remove = pool_remove_try_parse(opened); return remove == null ? null : remove.toCell(); }
    val farm = pool_farm_try_parse(opened); return farm == null ? null : farm.toCell();
}
