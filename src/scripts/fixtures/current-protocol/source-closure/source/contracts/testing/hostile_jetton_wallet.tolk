tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "hostile_jetton_common"
import "@gen/op/testing"
import "../shared/jetton/tep74_codec"

fun onBouncedMessage(in: InMessageBounced) {
    var b = in.bouncedBody;
    if (b.remainingBitsCount() < 128 || b.loadUint(32) != 0xffffffff || b.loadUint(32) != OP_TEP74_INTERNAL_TRANSFER) { return; }
    b.skipBits(64);
    val amount = b.tryLoadCoins();
    if (amount == null) { return; }
    var st = HostileWalletState.fromCell(contract.getData());
    st.balance += amount;
    contract.setData(st.toCell());
}
fun onInternalMessage(in: InMessage) {
    var b = in.body;
    if (b.remainingBitsCount() < 32) { return; }
    val op = b.loadUint(32);
    var st = HostileWalletState.fromCell(contract.getData());
    val params = st.params.load();
    if (op == OP_HOSTILE_JETTON_CONFIG) {
        assert (in.senderAddress == params.issuer) throw 45;
        val p = HostileJettonConfig.fromSlice(in.body);
        st.outgoingLocked = p.outgoingLocked;
        st.incomingLocked = p.incomingLocked;
        contract.setData(st.toCell());
        return;
    }
    if (op != OP_TEP74_TRANSFER && op != OP_TEP74_INTERNAL_TRANSFER) { return; }
    val queryId = b.loadUint(64);
    val amount = b.loadCoins();
    val fromOrTo = b.loadAddress();
    val excess = b.loadAddressOpt();
    if (op == OP_TEP74_TRANSFER) {
        assert (in.senderAddress == st.owner && !st.outgoingLocked) throw 45;
        assert (in.valueCoins >= params.gramFloor) throw 48;
        assert (st.balance >= amount) throw 47;
        // Deliberately exhausts an underfunded message before a bounce can be funded.
        val stop = getGasConsumedAtTheMoment() + params.transferGas;
        while (getGasConsumedAtTheMoment() < stop) {}
        assert (!b.loadBool()) throw 49;
        val forward = b.loadCoins();
        st.balance -= amount;
        contract.setData(st.toCell());
        createMessage({ bounce: BounceMode.Only256BitsOfBody, value: 0,
            dest: hostileWalletInit(fromOrTo, st.master, contract.getCode(), st.params),
            body: beginCell().storeUint(OP_TEP74_INTERNAL_TRANSFER, 32).storeUint(queryId, 64).storeCoins(amount)
                .storeAddress(st.owner).storeAddressOpt(excess).storeCoins(forward).storeSlice(b) })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    assert (!st.incomingLocked) throw 46;
    assert (in.senderAddress == st.master || in.senderAddress == hostileWalletInit(fromOrTo, st.master, contract.getCode(), st.params).calculateAddress()) throw 45;
    val forward = b.loadCoins();
    st.balance += amount;
    contract.setData(st.toCell());
    if (forward > 0) {
        createMessage({ bounce: BounceMode.NoBounce, value: forward, dest: st.owner,
            body: beginCell().storeUint(OP_TEP74_TRANSFER_NOTIFICATION, 32).storeUint(queryId, 64).storeCoins(amount)
                .storeAddress(fromOrTo).storeSlice(b) })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
    if (excess != null) {
        reserveGramsOnBalance(max(contract.getOriginalBalance() - in.valueCoins, 0), RESERVE_MODE_AT_MOST);
        createMessage({ bounce: BounceMode.NoBounce, value: 0, dest: excess!,
            body: beginCell().storeUint(OP_TEP74_EXCESSES, 32).storeUint(queryId, 64) })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
    }
}
get fun get_wallet_data(): (coins, address, address, cell) {
    val st = HostileWalletState.fromCell(contract.getData());
    return (st.balance, st.owner, st.master, contract.getCode());
}
