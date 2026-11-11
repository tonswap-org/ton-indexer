tolk 1.5.0

// serialization.tolk
// Shared cell encoding and decoding helpers for TONSwap modules.

import "./error_codes.tolk";
import "@stdlib/exotic-cells.tolk";

fun empty_cell(): cell {
    return beginCell().endCell();
}

fun is_empty_cell(value: cell): bool {
    val slice = value.beginParse();
    if (!slice.isEmpty()) {
        return false;
    }
    return slice.remainingRefsCount() == 0;
}

// Immutable executable dependencies must carry their ordinary code cell.
// CTOS alone resolves library references and cannot enforce this boundary.
fun is_nonempty_ordinary_cell(value: cell): bool {
    val (contents, exotic) = value.beginParseSpecial();
    return !exotic &&
        (contents.remainingBitsCount() > 0 || contents.remainingRefsCount() > 0);
}

fun store_maybe_address(builder: builder, value: any_address): builder {
    if (value.isNone()) {
        return builder.storeUint(0, 1);
    }
    builder = builder.storeUint(1, 1);
    return builder.storeAddress(value.castToInternal());
}

fun load_maybe_address(cursor: slice): (slice, any_address) {
    if (cursor.remainingBitsCount() < 1) {
        throw ERR_SERIALIZATION_FLAG;
    }
    val has = cursor.loadUint(1);
    if (has == 0) {
        return (cursor, createAddressNone());
    }
    if (cursor.remainingBitsCount() == 0 && cursor.remainingRefsCount() == 0) {
        throw ERR_SERIALIZATION_DATA;
    }
    val addr = cursor.loadAddress();
    return (cursor, addr as any_address);
}

fun store_maybe_cell(builder: builder, value: cell): builder {
    if (is_empty_cell(value)) {
        return builder.storeUint(0, 1);
    }
    builder = builder.storeUint(1, 1);
    return builder.storeRef(value);
}

fun load_maybe_cell(cursor: slice): (slice, cell) {
    if (cursor.remainingBitsCount() < 1) {
        throw ERR_SERIALIZATION_FLAG;
    }
    val has = cursor.loadUint(1);
    if (has == 0) {
        return (cursor, empty_cell());
    }
    if (cursor.remainingRefsCount() == 0) {
        throw ERR_SERIALIZATION_DATA;
    }
    val value = cursor.loadRef();
    return (cursor, value);
}
