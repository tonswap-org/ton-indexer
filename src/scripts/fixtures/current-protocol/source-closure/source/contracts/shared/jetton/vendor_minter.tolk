tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/exotic-cells"
import "@gen/JettonMinter.code"
import "@gen/op/restricted_jetton_mint"
import "@gen/op/restricted_jetton_top_up"
import "tep74_codec"
import "../utils/rich_bounce"

struct BouncedMint { queryId: uint64; recipient: address; amount: coins; responseTo: address? }

fun jetton_v21_minter_init(admin: address, metadata: cell): AutoDeployAddress {
    return { workchain: BASECHAIN, stateInit: {
        code: jettonMinterCompiledCode(),
        data: beginCell().storeCoins(0).storeAddress(admin).storeAddressNone().storeRef(metadata).endCell()
    } };
}

fun jetton_v21_minter_address(admin: address, metadata: cell): address {
    return jetton_v21_minter_init(admin, metadata).calculateAddress();
}

fun jetton_v21_mint_body(queryId: uint64, recipient: address, tonAmount: coins, amount: coins,
    responseTo: address?, forwardGram: coins): cell {
    val transfer = beginCell().storeUint(OP_TEP74_INTERNAL_TRANSFER, 32).storeUint(queryId, 64)
        .storeCoins(amount).storeAddress(contract.getAddress()).storeAddressOpt(responseTo)
        .storeCoins(forwardGram).storeBool(false).endCell();
    return beginCell().storeUint(OP_JETTON_MINT, 32).storeUint(queryId, 64).storeAddress(recipient)
        .storeCoins(tonAmount).storeRef(transfer).endCell();
}

fun jetton_v21_top_up_body(): cell {
    return beginCell().storeUint(OP_JETTON_TOP_UP, 32).endCell();
}

fun jetton_v21_try_parse_bounced_mint(bouncedBody: slice): BouncedMint? {
    if (!rich_bounce_is_canonical(bouncedBody)) { return null; }
    val rich = RichBounceBody.fromSlice(bouncedBody);
    var (s, exotic) = rich.originalBody.beginParseSpecial();
    if (exotic || s.remainingBitsCount() < 96 || s.loadUint(32) != OP_JETTON_MINT) { return null; }
    val queryId = s.loadUint(64) as uint64;
    val recipient = s.tryLoadStdAddress();
    val value = s.tryLoadCoins();
    if (recipient == null || value == null || s.remainingBitsCount() != 0 || s.remainingRefsCount() != 1) { return null; }
    var (transfer, exoticTransfer) = s.loadRef().beginParseSpecial();
    if (exoticTransfer || transfer.remainingBitsCount() < 96 || transfer.loadUint(32) != OP_TEP74_INTERNAL_TRANSFER
        || transfer.loadUint(64) != queryId) { return null; }
    val amount = transfer.tryLoadCoins();
    val from = transfer.tryLoadStdAddress();
    if (amount == null || from == null || from != contract.getAddress()) { return null; }
    var responseTo: address? = null;
    if (transfer.remainingBitsCount() >= 2 && transfer.preloadUint(2) == 0) { transfer.skipBits(2); }
    else {
        responseTo = transfer.tryLoadStdAddress();
        if (responseTo == null) { return null; }
    }
    val forwardGram = transfer.tryLoadCoins();
    if (forwardGram == null || transfer.remainingBitsCount() != 1 || transfer.remainingRefsCount() != 0 || transfer.loadBool()) { return null; }
    return { queryId, recipient, amount, responseTo };
}
