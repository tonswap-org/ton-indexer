tolk 1.5.0

// funding_rejector.tolk
// Test helper wallet that forwards requests to the Perps engine
// and deliberately bounces funding payouts so we can exercise
// bounce-handling logic.

import "@stdlib/common.tolk";
import "@stdlib/gas-payments.tolk";
import "../shared/utils/error_codes.tolk";
import "@gen/op/testing";

@overflow1023_policy("suppress")
struct Storage {
    engine: any_address;
    rejectFunding: uint8;
}

const FORWARD_GAS_RESERVE: coins = 5000000000; // 5 TON gas cushion for forwarded calls
const ERR_REJECTOR_BOUNCE: int = 9901;

fun default_storage(): Storage {
    return Storage {
        engine: createAddressNone(),
        rejectFunding: 0 as uint8,
    };
}

fun load_storage(): Storage {
    val data = contract.getData();
    val slice = data.beginParse();
    if (slice.isEmpty()) {
        return default_storage();
    }
    return Storage.fromCell(data);
}

fun save_storage(storage: Storage) {
    contract.setData(storage.toCell());
}

fun onInternalMessage(in: InMessage) {
    val body = in.body;
    if (body.isEmpty()) {
        return;
    }

    var slice = body;
    if (slice.remainingBitsCount() < 32) {
        return;
    }

    val opcode = slice.loadUint(32);

    var storage = load_storage();

    if (opcode == (OP_REJECTOR_CONFIGURE as int)) {
        setGasLimitToMaximum();
        storage.engine = slice.loadAddressAny();
        if (slice.remainingBitsCount() >= 1) {
            storage.rejectFunding = slice.loadUint(1) as uint8;
        }
        save_storage(storage);
        reserveGramsOnBalance(0, 0);
        return;
    }

    if (opcode == (OP_REJECTOR_FORWARD as int)) {
        setGasLimitToMaximum();
        val target = storage.engine;
        assert (!target.isNone()) throw 700;
        val value = slice.loadCoins();
        val payload = slice.loadRef();
        val message = createMessage({
            bounce: true,
            value: value + FORWARD_GAS_RESERVE,
            dest: target.castToInternal(),
            body: payload,
        });
        message.send(0);
        save_storage(storage);
        reserveGramsOnBalance(0, 0);
        return;
    }

    if (storage.rejectFunding != 0 as uint8) {
        throw ERR_REJECTOR_BOUNCE;
    }
}

fun onBouncedMessage(_: InMessageBounced) {
    reserveGramsOnBalance(0, 0);
}
