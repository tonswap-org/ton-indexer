tolk 1.5.0

import "@gen/op/tep";
import "hostile_jetton_common"
import "@gen/op/testing"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"

struct HostileMinterState { walletCode: cell; params: Cell<HostileParams>; silent: bool }
fun onBouncedMessage(in: InMessageBounced) {}
fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { return; }
    val st = HostileMinterState.fromCell(contract.getData());
    val params = st.params.load();
    val op = in.body.preloadUint(32);
    if (op == OP_TEP89_PROVIDE_WALLET_ADDRESS) {
        if (st.silent) { return; }
        assert (in.valueCoins >= params.provideFloor) throw 48;
        val p = parse_tep89_provide_wallet_address(in.body);
        val owner = p.ownerAddress as address;
        val wallet = hostileWalletInit(owner, contract.getAddress(), st.walletCode, st.params).calculateAddress();
        createMessage({ bounce: BounceMode.NoBounce, value: 0, dest: in.senderAddress,
            body: build_tep89_take_wallet_address(p.queryId, wallet, owner, p.includeAddress) })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    if (op == OP_HOSTILE_JETTON_MINT) {
        assert (in.senderAddress == params.issuer) throw 45;
        val p = HostileJettonMint.fromSlice(in.body);
        createMessage({ bounce: BounceMode.Only256BitsOfBody, value: 0,
            dest: hostileWalletInit(p.recipient, contract.getAddress(), st.walletCode, st.params),
            body: beginCell().storeUint(OP_TEP74_INTERNAL_TRANSFER, 32).storeUint(p.queryId, 64).storeCoins(p.amount)
                .storeAddress(params.issuer).storeAddress(params.issuer).storeCoins(p.forward).storeBool(true).storeRef(p.payload) })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
}
get fun get_wallet_address(owner: address): address {
    val st = HostileMinterState.fromCell(contract.getData());
    return hostileWalletInit(owner, contract.getAddress(), st.walletCode, st.params).calculateAddress();
}
