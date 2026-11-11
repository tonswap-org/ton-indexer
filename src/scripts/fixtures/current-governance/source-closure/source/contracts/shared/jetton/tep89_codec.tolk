tolk 1.5.0

// Strict TEP-89 discoverable-wallet request/response codec.

import "@stdlib/exotic-cells.tolk";
import "@gen/op/tep";
import "./tep74_codec.tolk";

const ERR_TEP89_CODEC: int = 1213;

struct Tep89TakeWalletAddress {
    queryId: uint64;
    walletAddress: any_address;
    ownerAddress: any_address;
}

struct Tep89ProvideWalletAddress {
    queryId: uint64;
    ownerAddress: any_address;
    includeAddress: uint8;
}

// T3 always requests include_address=True so a delayed response is bound to
// the receiver owner as well as the query id.
fun build_tep89_provide_wallet_address(queryId: uint64, ownerAddress: address): cell {
    return beginCell()
        .storeUint(OP_TEP89_PROVIDE_WALLET_ADDRESS, 32)
        .storeUint(queryId as int, 64)
        .storeAddress(ownerAddress)
        .storeUint(1, 1)
        .endCell();
}

fun parse_tep89_provide_wallet_address(body: slice): Tep89ProvideWalletAddress {
    var cursor = body;
    assert (cursor.remainingBitsCount() >= 32 + 64) throw ERR_TEP89_CODEC;
    assert (cursor.loadUint(32) as uint32 == OP_TEP89_PROVIDE_WALLET_ADDRESS) throw ERR_TEP89_CODEC;
    val queryId = cursor.loadUint(64) as uint64;
    val ownerAddress = cursor.loadAddressAny();
    assert (!ownerAddress.isNone()) throw ERR_TEP89_CODEC;
    assert (cursor.remainingBitsCount() == 1) throw ERR_TEP89_CODEC;
    assert (cursor.remainingRefsCount() == 0) throw ERR_TEP89_CODEC;
    val includeAddress = cursor.loadUint(1) as uint8;
    return Tep89ProvideWalletAddress {
        queryId,
        ownerAddress,
        includeAddress,
    };
}

fun build_tep89_take_wallet_address(
    queryId: uint64,
    walletAddress: address,
    ownerAddress: address,
    includeAddress: uint8,
): cell {
    assert (includeAddress <= 1 as uint8) throw ERR_TEP89_CODEC;
    var result = beginCell()
        .storeUint(OP_TEP89_TAKE_WALLET_ADDRESS, 32)
        .storeUint(queryId as int, 64)
        .storeAddress(walletAddress);
    if (includeAddress == 0 as uint8) {
        return result
            .storeUint(0, 1)
            .endCell();
    }
    return result
        .storeUint(1, 1)
        .storeRef(
            beginCell()
                .storeAddress(ownerAddress)
                .endCell()
        )
        .endCell();
}

// Parses:
// take_wallet_address#d1735400 query_id:uint64 wallet_address:MsgAddress
// owner_address:(Maybe ^MsgAddress)
//
// include_address=True makes None invalid for this protocol. Both the outer
// body and owner reference must be consumed exactly.
fun parse_tep89_take_wallet_address(body: slice): Tep89TakeWalletAddress {
    var cursor = body;
    assert (cursor.remainingBitsCount() >= 32 + 64) throw ERR_TEP89_CODEC;
    assert (cursor.loadUint(32) as uint32 == OP_TEP89_TAKE_WALLET_ADDRESS) throw ERR_TEP89_CODEC;

    val queryId = cursor.loadUint(64) as uint64;
    val walletAddress = cursor.loadAddressAny();
    assert (!walletAddress.isNone()) throw ERR_TEP89_CODEC;
    assert (cursor.remainingBitsCount() >= 1) throw ERR_TEP89_CODEC;
    assert (cursor.loadUint(1) == 1) throw ERR_TEP89_CODEC;
    assert (cursor.remainingRefsCount() == 1) throw ERR_TEP89_CODEC;
    val ownerCell = cursor.loadRef();
    assert (cursor.remainingBitsCount() == 0) throw ERR_TEP89_CODEC;
    assert (cursor.remainingRefsCount() == 0) throw ERR_TEP89_CODEC;

    var ownerCursor = ownerCell.beginParse();
    val ownerAddress = ownerCursor.loadAddressAny();
    assert (!ownerAddress.isNone()) throw ERR_TEP89_CODEC;
    assert (ownerCursor.remainingBitsCount() == 0) throw ERR_TEP89_CODEC;
    assert (ownerCursor.remainingRefsCount() == 0) throw ERR_TEP89_CODEC;

    return Tep89TakeWalletAddress {
        queryId,
        walletAddress,
        ownerAddress,
    };
}

// Total codec, like the one of tep74_codec.tolk: nothing below throws.

struct Tep89Take {
    queryId: uint64;
    wallet: address;
    owner: address;
}

// provide_wallet_address#2c76b973 query_id:uint64 owner:MsgAddress
// include_address:Bool, always set: the answer then names the owner it is for.
fun tep89_provide_body(queryId: uint64, owner: address): builder {
    return beginCell()
        .storeUint(OP_TEP89_PROVIDE_WALLET_ADDRESS, 32)
        .storeUint(queryId, 64)
        .storeAddress(owner)
        .storeBool(true);
}

// take_wallet_address#d1735400 query_id:uint64 wallet:MsgAddress
// owner:(Maybe ^MsgAddress)
//
// Null unless the wallet is a workchain-0 standard address, the owner is
// present, the body ends there, and the one ordinary reference holds one
// workchain-0 standard address and nothing else. Whether the sender, the query
// and the owner are the expected ones is the caller's check.
fun tep89_try_parse_take(body: slice): Tep89Take? {
    var s = body;
    if (s.remainingBitsCount() != 32 + 64 + 267 + 1 || s.remainingRefsCount() != 1
        || s.loadUint(32) != OP_TEP89_TAKE_WALLET_ADDRESS) {
        return null;
    }
    val queryId = s.loadUint(64);
    val wallet = s.tryLoadStdAddress();
    if (wallet == null || !s.loadBool()) {
        return null;
    }
    var (inner, exotic) = s.loadRef().beginParseSpecial();
    if (exotic || inner.remainingBitsCount() != 267 || inner.remainingRefsCount() != 0) {
        return null;
    }
    val owner = inner.tryLoadStdAddress();
    if (owner == null) {
        return null;
    }
    return { queryId, wallet, owner };
}
