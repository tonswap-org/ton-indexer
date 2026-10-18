tolk 1.5.0

// testing/serialization_harness.tolk
// Utilities that expose serialization helpers to tests for regression checking of bit-level encodings.

import "../shared/utils/serialization.tolk";

struct Storage {}

const SAMPLE_ADDRESS: address = address("0:1111111111111111111111111111111111111111111111111111111111111111");
const ALT_ADDRESS: address = address("0:2222222222222222222222222222222222222222222222222222222222222222");

fun sample_metadata(): cell {
    return beginCell().storeUint(0xdead, 16).endCell();
}

fun onInternalMessage(in: InMessage) {}

fun onBouncedMessage(in: InMessageBounced) {}

get fun encode_address_present(): cell {
    var builder = beginCell();
    builder = store_maybe_address(builder, SAMPLE_ADDRESS as any_address);
    return builder.endCell();
}

get fun encode_address_absent(): cell {
    var builder = beginCell();
    builder = store_maybe_address(builder, createAddressNone());
    return builder.endCell();
}

get fun roundtrip_address_present(): int {
    var builder = beginCell();
    builder = store_maybe_address(builder, SAMPLE_ADDRESS as any_address);
    val cell = builder.endCell();
    var slice = cell.beginParse();
    val decoded = load_maybe_address(slice);
    if (decoded.1 == (SAMPLE_ADDRESS as any_address)) {
        return 1;
    }
    return 0;
}

get fun roundtrip_address_alt(): int {
    var builder = beginCell();
    builder = store_maybe_address(builder, ALT_ADDRESS as any_address);
    val cell = builder.endCell();
    var slice = cell.beginParse();
    val decoded = load_maybe_address(slice);
    if (decoded.1 == (ALT_ADDRESS as any_address)) {
        return 1;
    }
    return 0;
}

get fun roundtrip_address_absent(): int {
    var builder = beginCell();
    builder = store_maybe_address(builder, createAddressNone());
    val cell = builder.endCell();
    var slice = cell.beginParse();
    val decoded = load_maybe_address(slice);
    if (decoded.1.isNone()) {
        return 1;
    }
    return 0;
}

get fun encode_cell_present(): cell {
    var builder = beginCell();
    builder = store_maybe_cell(builder, sample_metadata());
    return builder.endCell();
}

get fun encode_cell_absent(): cell {
    var builder = beginCell();
    builder = store_maybe_cell(builder, empty_cell());
    return builder.endCell();
}

get fun roundtrip_cell_present(): int {
    var builder = beginCell();
    builder = store_maybe_cell(builder, sample_metadata());
    val cell = builder.endCell();
    var slice = cell.beginParse();
    val decoded = load_maybe_cell(slice);
    val payload = decoded.1;
    var metaSlice = payload.beginParse();
    return metaSlice.loadUint(16);
}

get fun roundtrip_cell_absent(): int {
    var builder = beginCell();
    builder = store_maybe_cell(builder, empty_cell());
    val cell = builder.endCell();
    var slice = cell.beginParse();
    val decoded = load_maybe_cell(slice);
    if (is_empty_cell(decoded.1)) {
        return 1;
    }
    return 0;
}

get fun check_empty_cell_zero(): int {
    if (is_empty_cell(empty_cell())) {
        return 1;
    }
    return 0;
}

get fun check_empty_cell_payload(): int {
    if (is_empty_cell(sample_metadata())) {
        return 1;
    }
    return 0;
}

get fun trigger_address_flag_underflow(): int {
    val cell = empty_cell();
    val slice = cell.beginParse();
    load_maybe_address(slice);
    return 0;
}

get fun trigger_address_missing_payload(): int {
    var builder = beginCell();
    builder.storeUint(1, 1);
    val cell = builder.endCell();
    val slice = cell.beginParse();
    load_maybe_address(slice);
    return 0;
}

get fun trigger_cell_flag_underflow(): int {
    val cell = empty_cell();
    val slice = cell.beginParse();
    load_maybe_cell(slice);
    return 0;
}

get fun trigger_cell_missing_ref(): int {
    var builder = beginCell();
    builder.storeUint(1, 1);
    val cell = builder.endCell();
    val slice = cell.beginParse();
    load_maybe_cell(slice);
    return 0;
}
