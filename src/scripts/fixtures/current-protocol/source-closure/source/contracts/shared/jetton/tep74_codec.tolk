tolk 1.5.0

// Strict canonical TEP-74 codec for issuer-controlled external jetton wallets.
// External reserve settlement uses the exact canonical wire format.

import "@stdlib/exotic-cells.tolk";
import "@gen/op/tep";

const ERR_TEP74_CODEC: int = 1212;

@overflow1023_policy("suppress")
struct Tep74TransferRef {
    queryId: uint64;
    amount: coins;
    destination: any_address;
    responseDestination: any_address;
    forwardTonAmount: coins;
    forwardPayload: cell;
}

@overflow1023_policy("suppress")
struct Tep74TransferNotificationRef {
    queryId: uint64;
    amount: coins;
    sender: any_address;
    forwardPayload: cell;
}

@overflow1023_policy("suppress")
struct Tep74TransferNotification {
    queryId: uint64;
    amount: coins;
    sender: any_address;
    forwardPayload: cell;
}

struct Tep74Excesses {
    queryId: uint64;
}

// Encodes:
// transfer#0f8a7ea5 ... custom_payload:(Maybe ^Cell)
// forward_payload:(Either Cell ^Cell)
//
// Reserve settlement deliberately uses custom_payload=None and a right/ref
// forward payload. This is accepted by canonical TEP-74 wallets while keeping
// the settlement envelope hash-stable and inexpensive to parse.
fun build_tep74_transfer_ref(msg: Tep74TransferRef): cell {
    assert (!msg.destination.isNone()) throw ERR_TEP74_CODEC;
    assert (msg.amount >= 0) throw ERR_TEP74_CODEC;
    assert (msg.forwardTonAmount >= 0) throw ERR_TEP74_CODEC;

    return beginCell()
        .storeUint(OP_TEP74_TRANSFER, 32)
        .storeUint(msg.queryId as int, 64)
        .storeCoins(msg.amount)
        .storeAddressAny(msg.destination)
        .storeAddressAny(msg.responseDestination)
        .storeUint(0, 1) // custom_payload = None
        .storeCoins(msg.forwardTonAmount)
        .storeUint(1, 1) // forward_payload = Right(^Cell)
        .storeRef(msg.forwardPayload)
        .endCell();
}

fun parse_tep74_transfer_ref(body: slice): Tep74TransferRef {
    var cursor = body;
    assert (cursor.remainingBitsCount() >= 32 + 64) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(32) as uint32 == OP_TEP74_TRANSFER) throw ERR_TEP74_CODEC;
    val queryId = cursor.loadUint(64) as uint64;
    val amount = cursor.loadCoins();
    val destination = cursor.loadAddressAny();
    val responseDestination = cursor.loadAddressAny();
    assert (!destination.isNone()) throw ERR_TEP74_CODEC;
    assert (cursor.remainingBitsCount() >= 1) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(1) == 0) throw ERR_TEP74_CODEC;
    val forwardTonAmount = cursor.loadCoins();
    assert (cursor.remainingBitsCount() == 1) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(1) == 1) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 1) throw ERR_TEP74_CODEC;
    val forwardPayload = cursor.loadRef();
    assert (cursor.remainingBitsCount() == 0) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 0) throw ERR_TEP74_CODEC;
    return Tep74TransferRef {
        queryId,
        amount,
        destination,
        responseDestination,
        forwardTonAmount,
        forwardPayload,
    };
}

// Parses only the canonical right/ref notification form used by T3 reserve
// settlement. Inline payloads and trailing data are rejected rather than
// normalized, because the exact envelope cell is part of the receipt proof.
fun parse_tep74_transfer_notification_ref(body: slice): Tep74TransferNotificationRef {
    var cursor = body;
    assert (cursor.remainingBitsCount() >= 32 + 64) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(32) as uint32 == OP_TEP74_TRANSFER_NOTIFICATION) throw ERR_TEP74_CODEC;

    val queryId = cursor.loadUint(64) as uint64;
    val amount = cursor.loadCoins();
    val sender = cursor.loadAddressAny();
    assert (cursor.remainingBitsCount() >= 1) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(1) == 1) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 1) throw ERR_TEP74_CODEC;
    val forwardPayload = cursor.loadRef();
    assert (cursor.remainingBitsCount() == 0) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 0) throw ERR_TEP74_CODEC;

    return Tep74TransferNotificationRef {
        queryId,
        amount,
        sender,
        forwardPayload,
    };
}

// General canonical notification parser for deposits and settlement receipts.
// The authenticated inner payload, not the outer Either representation, is
// hashed, so both TEP-74 encodings normalize into one payload cell.
fun parse_tep74_transfer_notification(body: slice): Tep74TransferNotification {
    var cursor = body;
    assert (cursor.remainingBitsCount() >= 32 + 64) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(32) as uint32 == OP_TEP74_TRANSFER_NOTIFICATION) throw ERR_TEP74_CODEC;

    val queryId = cursor.loadUint(64) as uint64;
    val amount = cursor.loadCoins();
    val sender = cursor.loadAddressAny();
    assert (!sender.isNone()) throw ERR_TEP74_CODEC;
    assert (cursor.remainingBitsCount() >= 1) throw ERR_TEP74_CODEC;
    val payloadIsRef = cursor.loadUint(1);
    if (payloadIsRef == 0) {
        return Tep74TransferNotification {
            queryId,
            amount,
            sender,
            forwardPayload: beginCell()
                .storeSlice(cursor)
                .endCell(),
        };
    }
    assert (cursor.remainingBitsCount() == 0) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 1) throw ERR_TEP74_CODEC;
    val forwardPayload = cursor.loadRef();
    assert (cursor.remainingBitsCount() == 0) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 0) throw ERR_TEP74_CODEC;

    return Tep74TransferNotification {
        queryId,
        amount,
        sender,
        forwardPayload,
    };
}

fun parse_tep74_excesses(body: slice): Tep74Excesses {
    var cursor = body;
    assert (cursor.remainingBitsCount() == 32 + 64) throw ERR_TEP74_CODEC;
    assert (cursor.remainingRefsCount() == 0) throw ERR_TEP74_CODEC;
    assert (cursor.loadUint(32) as uint32 == OP_TEP74_EXCESSES) throw ERR_TEP74_CODEC;
    val result = Tep74Excesses {
        queryId: cursor.loadUint(64) as uint64,
    };
    assert (cursor.remainingBitsCount() == 0) throw ERR_TEP74_CODEC;
    return result;
}

// Total codec. Nothing below throws on any input, so a handler that cannot
// bounce (a credited notification, a bounce) may call it before it validates.

// addr_std$10 without anycast in workchain 0, or null with the slice untouched.
// Jetton wallets take no other owner, so no other address can be paid or refunded.
fun slice.tryLoadStdAddress(mutate self): address? {
    if (self.remainingBitsCount() < 267 || self.preloadUint(11) != 0b10000000000) {
        return null;
    }
    return self.loadAddress();
}

// Coins is VarUInteger 16: a 4-bit byte count, then that many bytes.
fun slice.tryLoadCoins(mutate self): coins? {
    if (self.remainingBitsCount() < 4) {
        return null;
    }
    if (self.remainingBitsCount() < 4 + self.preloadUint(4) * 8) {
        return null;
    }
    return self.loadCoins();
}

fun jetton_is_payable(a: address): bool {
    return a.getWorkchain() == BASECHAIN;
}

struct Tep74Notification {
    queryId: uint64;
    amount: coins;
    from: address;
    // False when the Either part is neither form, or its reference is an exotic
    // cell: the tokens arrived, and the request that came with them is malformed.
    payloadOk: bool;
    // The inline rest of the body, or the content of the reference: both forms
    // of one payload read the same. Empty unless payloadOk.
    payload: slice;
}

// transfer_notification#7362d09c query_id:uint64 amount:Coins from:MsgAddress
// forward_payload:(Either Cell ^Cell)
//
// Null when the header does not parse or `from` is not a workchain-0 standard
// address: such a sender could not be refunded either. The caller decides what
// a zero amount or its own address as `from` means.
fun tep74_try_parse_notification(body: slice): Tep74Notification? {
    var s = body;
    if (s.remainingBitsCount() < 32 + 64 || s.loadUint(32) != OP_TEP74_TRANSFER_NOTIFICATION) {
        return null;
    }
    val queryId = s.loadUint(64);
    val amount = s.tryLoadCoins();
    if (amount == null) {
        return null;
    }
    val from = s.tryLoadStdAddress();
    if (from == null) {
        return null;
    }
    val nothing = s.getFirstBits(0);
    if (s.remainingBitsCount() == 0) {
        return { queryId, amount, from, payloadOk: false, payload: nothing };
    }
    if (!s.loadBool()) {
        return { queryId, amount, from, payloadOk: true, payload: s };
    }
    if (s.remainingBitsCount() != 0 || s.remainingRefsCount() != 1) {
        return { queryId, amount, from, payloadOk: false, payload: nothing };
    }
    // beginParse would throw on an exotic cell, and would load a library one.
    val (inner, exotic) = s.loadRef().beginParseSpecial();
    return { queryId, amount, from, payloadOk: !exotic, payload: exotic ? nothing : inner };
}

// transfer#0f8a7ea5 query_id:uint64 amount:Coins destination:MsgAddress
// response_destination:MsgAddress custom_payload:(Maybe ^Cell)
// forward_ton_amount:Coins forward_payload:(Either Cell ^Cell)
//
// No custom payload. The forward payload is absent (left, with nothing after
// it) or one reference (right): a wallet may refuse a reference followed by
// more data. `excessTo` is written as response_destination. At most 880 bits.
//
// JettonTransfer in jetton_slots.tolk passes its fields through tep74_transfer_body.
fun tep74_transfer_body_from(queryId: uint64, amount: coins, destination: address, excessTo: address,
    forwardGram: coins, forwardPayload: cell?): builder {
    return beginCell()
        .storeUint(OP_TEP74_TRANSFER, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(destination)
        .storeAddress(excessTo)
        .storeUint(0, 1)
        .storeCoins(forwardGram)
        .storeMaybeRef(forwardPayload);
}

// burn#595f07bc query_id:uint64 amount:Coins response_destination:MsgAddress
// custom_payload:(Maybe ^Cell), which is never written.
fun tep74_burn_body(queryId: uint64, amount: coins, responseTo: address?): builder {
    return beginCell()
        .storeUint(OP_TEP74_BURN, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddressOpt(responseTo)
        .storeUint(0, 1);
}
