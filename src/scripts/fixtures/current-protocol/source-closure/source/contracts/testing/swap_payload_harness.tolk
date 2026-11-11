tolk 1.5.0

import "../shared/jetton/jetton_quotes";

// Getter-only codec harness. Compiler serializers independently check the TypeScript builders.
import "@stdlib/exotic-cells.tolk";
import "../shared/dex/swap_payload.tolk";
import "../shared/jetton/tep74_codec.tolk";

fun onInternalMessage(in: InMessage) {}

fun payload_echo(kind: int, payload: slice): cell? {
    if (kind == 0) {
        val parsed = swap_try_parse(payload);
        return parsed == null ? null : parsed.toCell();
    }
    if (kind == 1) {
        val parsed = swap_result_try_parse(payload);
        return parsed == null ? null : parsed.toCell();
    }
    if (kind == 2) {
        val parsed = swap_outcome_try_parse(payload);
        return parsed == null ? null : parsed.toCell();
    }
    if (kind == 3) {
        val parsed = swap_event_try_parse(payload);
        return parsed == null ? null : swap_event_body(parsed);
    }
    if (kind == 4) {
        val parsed = route_cont_try_parse(beginCell().storeSlice(payload).endCell());
        return parsed == null ? null : parsed.toCell();
    }
    return null;
}

get fun echo(kind: int, body: cell): cell? {
    if (kind == 4) {
        val parsed = route_cont_try_parse(body);
        return parsed == null ? null : parsed.toCell();
    }
    val (payload, exotic) = body.beginParseSpecial();
    return exotic ? null : payload_echo(kind, payload);
}

// Calls the same total notification codec used by the ledger, preserving its Either normalization.
get fun notification_echo(kind: int, body: cell): cell? {
    val (payload, exotic) = body.beginParseSpecial();
    if (exotic) { return null; }
    val notification = tep74_try_parse_notification(payload);
    if (notification == null || !notification.payloadOk) { return null; }
    return payload_echo(kind, notification.payload);
}

// Reconstruct from independent positional arguments rather than another wire decoder.
get fun encode_swap(minOut: coins, deadline: uint32, recipient: address, refundTo: address,
    notifyOrigin: bool, fwdGram: coins, refundFwdGram: coins, fwdPayload: cell?): cell {
    return Swap { minOut, deadline, recipient, refundTo, notifyOrigin, fwdGram, refundFwdGram, fwdPayload }.toCell();
}

get fun encode_result(queryId: uint64, origin: address, status: uint8, reason: uint8,
    amountIn: coins, amountOut: coins, user: cell?): cell {
    return SwapResult { queryId, origin, status, reason, amountIn, amountOut, user }.toCell();
}

get fun encode_outcome(queryId: uint64, status: uint8, reason: uint8, inSide: uint8, amountIn: coins, amountOut: coins): cell {
    return SwapOutcome { queryId, status, reason, inSide, amountIn, amountOut }.toCell();
}

get fun encode_event(queryId: uint64, origin: address, inSide: uint8, status: uint8, reason: uint8,
    amountIn: coins, amountOut: coins, grossFeeT3: coins, protocolFeeT3: coins, activeBin: int32, binsLoaded: uint8): cell {
    return swap_event_body(SwapEvent { queryId, origin, inSide, status, reason, amountIn, amountOut,
        grossFeeT3, protocolFeeT3, activeBin, binsLoaded });
}

get fun encode_route(pool: address, swap: Cell<Swap>): cell {
    return RouteCont { pool, swap }.toCell();
}

get fun fees(refundFwdGram: coins): (coins, coins, coins, coins, coins) {
    return (swap_notify_value(), swap_aux_value(), swap_log_fee(), hop2_floor(JETTON_V21_WALLET_GAS, 0, jetton_standard_budget(JETTON_V21_WALLET_GAS).load(), refundFwdGram), route_refund_floor(JETTON_V21_WALLET_GAS, 0, jetton_standard_budget(JETTON_V21_WALLET_GAS).load()));
}
