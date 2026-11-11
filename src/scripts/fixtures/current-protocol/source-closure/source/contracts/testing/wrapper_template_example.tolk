tolk 1.5.0

import "@gen/op/testing"

// Sample contract used by WrapperTemplate. Stores a 32-bit value in data and exposes a getter.

contract WrapperTemplateExample {
    author: "TONSwap"
    version: "1.0.0"
    description: "Reference contract for ABI-driven TONSwap wrappers"

    storage: Storage
    incomingMessages: SetExample
}

/// Persistent 32-bit example state.
struct Storage {
    /// Current example value.
    example: int32;
}

/// Updates the stored example value.
struct (0x53455458) SetExample {
    /// New signed 32-bit value.
    example: int32;
}

fun default_storage(): Storage {
    return Storage { example: 0 as int32 };
}

fun load_storage(): Storage {
    val data = contract.getData();
    var slice = data.beginParse();
    if (slice.remainingBitsCount() < 32) {
        return default_storage();
    }
    val example = slice.loadInt(32) as int32;
    return Storage { example };
}

fun save_storage(value: int) {
    var builder = beginCell();
    builder.storeInt(value, 32);
    contract.setData(builder.endCell());
}

fun onInternalMessage(in: InMessage) {
    val body = in.body;
    if (body.isEmpty()) {
        return;
    }
    val opcode = body.preloadUint(32);
    if (opcode != OP_SET_EXAMPLE) {
        return;
    }
    var cursor = body;
    _ = cursor.loadUint(32); // consume opcode
    val value = cursor.loadInt(32);
    save_storage(value);
}

fun onBouncedMessage(_: InMessageBounced) {}

/// Returns the current example value.
get fun get_example(): int {
    val storage = load_storage();
    return storage.example;
}
