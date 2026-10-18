tolk 1.5.0

// Getter-only harness for byte-exact TEP-74/89 codec tests.

import "../shared/jetton/tep74_codec.tolk";
import "../shared/jetton/tep89_codec.tolk";

fun onInternalMessage(_: InMessage) {}

fun onBouncedMessage(_: InMessageBounced) {}

get fun build_tep74_transfer_cell(
    queryId: uint64,
    amount: coins,
    destination: address,
    responseDestination: address,
    forwardTonAmount: coins,
    forwardPayload: cell,
): cell {
    return build_tep74_transfer_ref(
        Tep74TransferRef {
            queryId,
            amount,
            destination: destination as any_address,
            responseDestination: responseDestination as any_address,
            forwardTonAmount,
            forwardPayload,
        }
    );
}

get fun parse_tep74_notification_cell(
    body: cell,
): (uint64, coins, any_address, uint256) {
    val parsed = parse_tep74_transfer_notification_ref(body.beginParse());
    return (
        parsed.queryId,
        parsed.amount,
        parsed.sender,
        parsed.forwardPayload.hash(),
    );
}

get fun parse_tep74_deposit_notification_cell(
    body: cell,
): (uint64, coins, any_address, uint256) {
    val parsed = parse_tep74_transfer_notification(body.beginParse());
    return (
        parsed.queryId,
        parsed.amount,
        parsed.sender,
        parsed.forwardPayload.hash(),
    );
}

get fun build_tep89_discovery_cell(queryId: uint64, owner: address): cell {
    return build_tep89_provide_wallet_address(queryId, owner);
}

get fun parse_tep89_response_cell(
    body: cell,
): (uint64, any_address, any_address) {
    val parsed = parse_tep89_take_wallet_address(body.beginParse());
    return (
        parsed.queryId,
        parsed.walletAddress,
        parsed.ownerAddress,
    );
}
