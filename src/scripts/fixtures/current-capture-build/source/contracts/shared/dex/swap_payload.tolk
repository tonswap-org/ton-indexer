tolk 1.5.0

// SWP3 wire shared by pools, the coordinator and callers. Parsers consume the decoded TEP-74
// payload slice, so both Either encodings use the same path and malformed credits never throw.

import "@stdlib/exotic-cells.tolk";
import "@stdlib/gas-payments.tolk";
import "../../generated/op/dex.tolk";
import "../jetton/tep74_codec.tolk";
import "../jetton/jetton_quotes.tolk";

const NOTIFY_GAS: int = 24000;
const POOL_REFUND_GAS_MAX: int = 400000;
const POOL_REFUND_SEND_GAS_MAX: int = 95000;
const POOL_ROUTE_REFUND_SEND_GAS_MAX: int = 110000;
const POOL_BOUNCE_GAS: int = 250000;
const COORD_BOUNCE_GAS: int = 250000;
const ROUTE_GAS_MAX: int = 48000;
const PAYLOAD_RECIPIENT_GAS: int = 65000;

fun swap_notify_value(): coins {
    return calculateGasFee(BASECHAIN, NOTIFY_GAS);
}

fun swap_aux_value(): coins {
    return swap_notify_value() + calculateForwardFee(BASECHAIN, 500, 1);
}

fun swap_log_fee(): coins {
    return calculateForwardFee(BASECHAIN, 1023, 1);
}

fun hop2_floor(walletGas: int, walletGram: coins, budget: JettonWalletBudget, refundFwdGram: coins): coins {
    return calculateGasFee(BASECHAIN, POOL_ROUTE_REFUND_SEND_GAS_MAX) + swap_log_fee()
        + jetton_leg_value(walletGas, walletGram, budget, refundFwdGram, 628, 1, POOL_BOUNCE_GAS);
}

fun route_refund_floor(walletGas: int, walletGram: coins, budget: JettonWalletBudget): coins {
    return calculateGasFee(BASECHAIN, PAYLOAD_RECIPIENT_GAS) + swap_log_fee()
        + jetton_leg_value(walletGas, walletGram, budget, 0, 628, 1, COORD_BOUNCE_GAS);
}

const SWAP_EXECUTED: int = 0;
const SWAP_REFUND: int = 1;
const SWAP_INPUT_OWED: int = 2;
const SWAP_REFUND_PLAIN: int = 3;

const SWAP_REASON_NONE: int = 0;
const SWAP_REASON_MALFORMED: int = 1;
const SWAP_REASON_NOT_READY: int = 2;
const SWAP_REASON_PAUSED: int = 3;
const SWAP_REASON_DEADLINE: int = 4;
const SWAP_REASON_ADDRESS: int = 5;
const SWAP_REASON_VALUE: int = 6;
const SWAP_REASON_SLIPPAGE: int = 7;
const SWAP_REASON_LIQUIDITY: int = 8;
const SWAP_REASON_MATH: int = 10;
const SWAP_REASON_PAYLOAD_SIZE: int = 11;
const SWAP_REASON_BIN: int = 12;
const SWAP_REASON_WRONG_SIDE: int = 13;
const SWAP_REASON_MIN_VALUE: int = 14;
const SWAP_REASON_CAPACITY: int = 15;
const SWAP_REASON_STAKED: int = 16;
const SWAP_REASON_ROUTE: int = 17;

struct (0x53575033) Swap {
    minOut: coins;
    deadline: uint32;
    recipient: address;
    refundTo: address;
    notifyOrigin: bool;
    fwdGram: coins;
    refundFwdGram: coins;
    fwdPayload: cell?;
}

struct (0x53575233) SwapResult {
    queryId: uint64;
    origin: address;
    status: uint8;
    reason: uint8;
    amountIn: coins;
    amountOut: coins;
    user: cell?;
}

struct (0x53574f33) SwapOutcome {
    queryId: uint64;
    status: uint8;
    reason: uint8;
    inSide: uint8;
    amountIn: coins;
    amountOut: coins;
}

struct (0x53574533) SwapEvent {
    queryId: uint64;
    origin: address;
    inSide: uint8;
    status: uint8;
    reason: uint8;
    amountIn: coins;
    amountOut: coins;
    grossFeeT3: coins;
    protocolFeeT3: coins;
    activeBin: int32;
    binsLoaded: uint8;
}

struct (0x52435433) RouteCont {
    pool: address;
    swap: Cell<Swap>;
}

fun swap_reason_valid(reason: int): bool {
    return reason <= SWAP_REASON_ROUTE && reason != 9;
}

// The payload is opaque here: size limits and any route contents are validated by the consumer.
// Its root still must be ordinary, including when the caller will only forward it.
@inline
fun swap_maybe_ref(mutate s: slice): (bool, cell?) {
    if (s.remainingBitsCount() < 1) { return (false, null); }
    if (!s.loadBool()) { return (true, null); }
    if (s.remainingRefsCount() < 1) { return (false, null); }
    val c = s.loadRef();
    val (_, exotic) = c.beginParseSpecial();
    return (!exotic, exotic ? null : c);
}

@inline
fun swap_try_parse(payload: slice): Swap? {
    var s = payload;
    if (s.remainingBitsCount() < 32 || s.loadUint(32) != OP_SWAP) { return null; }
    val minOut = s.tryLoadCoins();
    if (minOut == null || s.remainingBitsCount() < 32) { return null; }
    val deadline = s.loadUint(32);
    val recipient = s.tryLoadStdAddress();
    val refundTo = s.tryLoadStdAddress();
    if (recipient == null || refundTo == null || s.remainingBitsCount() < 1) { return null; }
    val notifyOrigin = s.loadBool();
    val fwdGram = s.tryLoadCoins();
    val refundFwdGram = s.tryLoadCoins();
    if (fwdGram == null || refundFwdGram == null) { return null; }
    val (ok, fwdPayload) = swap_maybe_ref(mutate s);
    if (!ok || !s.isEmpty()) { return null; }
    return { minOut, deadline, recipient, refundTo, notifyOrigin, fwdGram, refundFwdGram, fwdPayload };
}

fun swap_result_try_parse(payload: slice): SwapResult? {
    var s = payload;
    if (s.remainingBitsCount() < 96 || s.loadUint(32) != OP_SWAP_RESULT) { return null; }
    val queryId = s.loadUint(64);
    val origin = s.tryLoadStdAddress();
    if (origin == null || s.remainingBitsCount() < 16) { return null; }
    val status = s.loadUint(8);
    val reason = s.loadUint(8);
    val amountIn = s.tryLoadCoins();
    val amountOut = s.tryLoadCoins();
    if (status > SWAP_REFUND || !swap_reason_valid(reason) || amountIn == null || amountOut == null) { return null; }
    val (ok, user) = swap_maybe_ref(mutate s);
    if (!ok || !s.isEmpty()) { return null; }
    return { queryId, origin, status, reason, amountIn, amountOut, user };
}

fun swap_outcome_try_parse(body: slice): SwapOutcome? {
    var s = body;
    if (s.remainingBitsCount() < 120 || s.loadUint(32) != OP_SWAP_OUTCOME) { return null; }
    val queryId = s.loadUint(64);
    val status = s.loadUint(8);
    val reason = s.loadUint(8);
    val inSide = s.loadUint(8);
    val amountIn = s.tryLoadCoins();
    val amountOut = s.tryLoadCoins();
    if (status > SWAP_INPUT_OWED || !swap_reason_valid(reason) || inSide > 1 || amountIn == null || amountOut == null || !s.isEmpty()) { return null; }
    return { queryId, status, reason, inSide, amountIn, amountOut };
}

fun swap_event_try_parse(body: slice): SwapEvent? {
    var s = body;
    if (s.remainingBitsCount() < 96 || s.loadUint(32) != OP_SWAP_EVENT) { return null; }
    val queryId = s.loadUint(64);
    val origin = s.tryLoadStdAddress();
    if (origin == null || s.remainingBitsCount() < 24) { return null; }
    val inSide = s.loadUint(8);
    val status = s.loadUint(8);
    val reason = s.loadUint(8);
    val amountIn = s.tryLoadCoins();
    val amountOut = s.tryLoadCoins();
    val grossFeeT3 = s.tryLoadCoins();
    val protocolFeeT3 = s.tryLoadCoins();
    if (inSide > 1 || status > SWAP_REFUND_PLAIN || !swap_reason_valid(reason)
        || amountIn == null || amountOut == null || grossFeeT3 == null || protocolFeeT3 == null
        || s.remainingBitsCount() != 40 || s.remainingRefsCount() != 0) { return null; }
    val activeBin = s.loadInt(32);
    val binsLoaded = s.loadUint(8);
    return { queryId, origin, inSide, status, reason, amountIn, amountOut, grossFeeT3, protocolFeeT3, activeBin, binsLoaded };
}

fun route_cont_try_parse(c: cell): RouteCont? {
    var (s, exotic) = c.beginParseSpecial();
    if (exotic || s.remainingBitsCount() != 299 || s.remainingRefsCount() != 1 || s.loadUint(32) != OP_ROUTE_CONT) { return null; }
    val pool = s.tryLoadStdAddress();
    if (pool == null) { return null; }
    val swap = s.loadRef();
    val (_, innerExotic) = swap.beginParseSpecial();
    if (innerExotic) { return null; }
    return { pool, swap: swap as Cell<Swap> };
}

fun swap_event_body(e: SwapEvent): cell {
    return e.toCell();
}
