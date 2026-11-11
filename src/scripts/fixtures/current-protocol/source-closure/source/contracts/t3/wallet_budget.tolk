tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments";
import "wallet_types";
import "../shared/jetton/tep74_codec";

// Compute remains bounded independently of the number of accepted claims.
const T3_WALLET_GAS = 250000;
const T3_WALLET_SEND_GAS = 150000;
const T3_WALLET_RECEIVE_GAS = 50000;
const T3_WALLET_BOUNCE_GAS = 125000;
const T3_WALLET_RENT_SECONDS = 157680000;
fun t3_wallet_code_size(code: cell): (int,int) {
    val graph = beginCell().storeRef(code).endCell();
    val (cells,bits,_) = graph.calculateSizeStrict(65536);
    return (cells,bits);
}
fun t3_wallet_rent_for_size(cells: int,bits: int): coins {
    // Pristine config/state/journal add three cells and at most 2069 bits,
    // including a maximum-width Coins balance. Future tree growth is caller funded.
    return calculateStorageFee(0,T3_WALLET_RENT_SECONDS,bits + 2069,cells + 3);
}
fun t3_wallet_rent(code: cell): coins {
    val (cells,bits) = t3_wallet_code_size(code);
    return t3_wallet_rent_for_size(cells,bits);
}
fun t3_wallet_unsigned_bits(value: int): int asm "UBITSIZE";
fun t3_wallet_frontier_size(count: int): int { return min(t3_wallet_unsigned_bits(count),64); }
fun t3_wallet_state_rent_for_size(st: T3WalletState,cells: int,bits: int,append: bool): coins {
    val claims = t3_wallet_frontier_size(st.nextId + (append ? 1 : 0));
    val journal = t3_wallet_frontier_size(st.journal.load().count);
    // Sequential cached keys 0..n-1: n leaves, n-1 forks. A uint8 label uses
    // at most 18 bits; each leaf additionally retains its 256-bit subtree hash.
    val nodes = (claims > 0 ? 2 * claims - 1 : 0) + (journal > 0 ? 2 * journal - 1 : 0);
    return calculateStorageFee(0,T3_WALLET_RENT_SECONDS,bits + 2069 + 292 * (claims + journal),cells + 3 + nodes);
}
fun t3_wallet_state_rent(st: T3WalletState,code: cell,append: bool): coins {
    val (cells,bits) = t3_wallet_code_size(code);
    return t3_wallet_state_rent_for_size(st,cells,bits,append);
}
fun t3_wallet_bounce_value(): coins {
    return calculateGasFee(0,T3_WALLET_BOUNCE_GAS) + calculateStorageFee(0,T3_WALLET_RENT_SECONDS,292,2);
}
fun t3_wallet_excess_body(queryId: uint64): cell {
    return beginCell().storeUint(OP_TEP74_EXCESSES,32).storeUint(queryId,64).endCell();
}
fun t3_wallet_excess_fee(queryId: uint64, response: address?): coins {
    if (response == null) { return 0; }
    return createMessage({ bounce: BounceMode.NoBounce, dest: response!, value: 0, body: t3_wallet_excess_body(queryId) })
        .estimateFeeWithoutSending(SEND_MODE_REGULAR);
}
fun t3_wallet_notification(terms: WalletTerms): cell {
    val d = terms.details.load();
    return beginCell().storeUint(OP_TEP74_TRANSFER_NOTIFICATION,32).storeUint(d.queryId,64).storeCoins(terms.amount)
        .storeAddress(terms.owner).storeSlice(d.forwardPayload.beginParse()).endCell();
}
fun t3_wallet_command_gas(details: WalletDetails): int {
    val graph = beginCell().storeRef(details.forwardPayload).storeMaybeRef(details.customPayload).endCell();
    assert (graph.depth() <= 200) throw 855;
    val (cells,_,_,valid) = graph.calculateSize(384);
    assert (valid) throw 855;
    return cells! <= 64 ? T3_WALLET_SEND_GAS : T3_WALLET_GAS;
}
fun t3_wallet_receive_gas(details: WalletDetails): int {
    if (details.forwardValue == 0) { return T3_WALLET_RECEIVE_GAS; }
    val (_,_,_,small) = details.forwardPayload.calculateSize(64);
    return small ? T3_WALLET_RECEIVE_GAS : T3_WALLET_GAS;
}
fun t3_wallet_receive_value(terms: WalletTerms,coldRent: coins): coins {
    val d = terms.details.load();
    var delivered = coldRent;
    if (d.forwardValue > 0) {
        delivered += d.forwardValue + createMessage({ bounce: BounceMode.NoBounce, dest: terms.recipient,
            value: d.forwardValue, body: t3_wallet_notification(terms) }).estimateFeeWithoutSending(SEND_MODE_PAY_FEES_SEPARATELY);
    }
    // Recipient actions and its rent reserve roll back on failure. The same
    // caller value then funds returned evidence instead of successful delivery.
    return calculateGasFee(0,t3_wallet_receive_gas(d)) + t3_wallet_excess_fee(d.queryId,d.response)
        + max(delivered,t3_wallet_bounce_value()) + 1;
}
fun t3_wallet_mint_value(queryId: uint64, response: address?, code: cell): coins {
    return calculateGasFee(0,T3_WALLET_RECEIVE_GAS) + t3_wallet_rent(code) + t3_wallet_excess_fee(queryId,response) + 1;
}
fun t3_wallet_reserve(incoming: coins, rent: coins): coins {
    val before = max(contract.getOriginalBalance() - incoming,0);
    val reserve = max(before,rent);
    reserveGramsOnBalance(reserve,RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    return reserve - before;
}
fun t3_wallet_excess(queryId: uint64, response: address?) {
    if (response != null) {
        createMessage({ bounce: BounceMode.NoBounce, dest: response!, value: 0, body: t3_wallet_excess_body(queryId) })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
}
