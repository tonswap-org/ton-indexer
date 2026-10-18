tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/jetton_sweep"
import "../shared/utils/error_codes"
import "@gen/op/jetton"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "@gen/op/testing"

struct SweepHarnessConfig { admin: address; treasury: address; bounceGas: uint32; owedCap: uint16; payoutQueryId: uint64; payoutPayload: cell? }
struct SweepHarnessState {
    config: Cell<SweepHarnessConfig>
    ledger: Cell<JettonLedger>
    sweeps: Cell<JettonSweeps>
    liabilities: map<uint8, coins>
}
struct (0x4a485846) HarnessXfer { queryId: uint64; slot: uint8; kind: uint8; request: cell }

fun SweepHarnessState.load(): SweepHarnessState { return SweepHarnessState.fromCell(contract.getData()); }
fun SweepHarnessState.save(self) { contract.setData(self.toCell()); }
fun SweepHarnessState.liability(self, slot: uint8): coins {
    val v = self.liabilities.get(slot);
    return v.isFound ? v.loadValue() : 0;
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = SweepHarnessState.load();
    var ledger = st.ledger.load();
    var sweeps = JettonSweeps.fromCell(st.sweeps);
    val r = JettonSweeps.onBounce(mutate sweeps, ledger, in.senderAddress, in.bouncedBody);
    if (r.dirty) { st.sweeps = sweeps.toCell(); }
    val cfg = st.config.load();
    if (r.probe) {
        jetton_bounce_excess(r.b.excessTo, r.b.queryId, in.valueCoins, 0);
    } else if (r.b.kind == 1) {
        ledger.bounceToOwed(r.b, r.b.destination!, in.valueCoins, cfg.owedCap);
        st.ledger = ledger.toCell();
    } else if (r.b.kind == 2) {
        val before = st.liability(r.b.slot);
        if (before <= JETTON_MAX_COINS - r.b.amount) { st.liabilities.set(r.b.slot, before + r.b.amount); }
        jetton_bounce_excess(r.b.excessTo, r.b.queryId, in.valueCoins, 0);
    }
    st.save();
}

fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { return; }
    val op = in.body.preloadUint(32);
    if (op == OP_DISCOVER_WALLETS || op == OP_CLAIM_OWED || op == OP_CLAIM_ARCHIVED || op == OP_SWEEP_ALLOW || op == OP_SWEEP_PROBE || op == OP_HARNESS_XFER) {
        handleSweepPlain(in.senderAddress, in.valueCoins, in.body);
        return;
    }
    var st = SweepHarnessState.load();
    var ledger = st.ledger.load();
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) {
        val t = ledger.checkTake(in.senderAddress, in.body);
        val cfg = st.config.load();
        if (t == null || t.wallet == cfg.admin || t.wallet == cfg.treasury) { return; }
        ledger.commitTake(t);
        st.ledger = ledger.toCell();
        st.save();
    } else if (op == OP_TEP74_TRANSFER_NOTIFICATION) {
        var sweeps = JettonSweeps.fromCell(st.sweeps);
        val r = JettonSweeps.onNotification(mutate sweeps, ledger, in.senderAddress, in.body);
        if (r.dirty) { st.sweeps = sweeps.toCell(); }
        if (r.kind == 1) {
            val c = r.credit!;
            val before = st.liability(c.slot);
            if (before <= JETTON_MAX_COINS - c.amount) { st.liabilities.set(c.slot, before + c.amount); }
        }
        st.save();
        if (r.kind == 2) {
            val cfg = st.config.load();
            jetton_sweep_pay(mutate ledger, r, cfg.treasury, in.valueCoins, cfg.payoutQueryId, cfg.payoutPayload);
            st.ledger = ledger.toCell(); st.save();
        }
    }
}

fun handleSweepPlain(sender: address, value: coins, body: slice) {
    var st = SweepHarnessState.load();
    var ledger = st.ledger.load();
    var sweeps = JettonSweeps.fromCell(st.sweeps);
    val cfg = st.config.load();
    val op = body.preloadUint(32);
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(body);
        assert (value >= ledger.minDiscover()) throw ERR_JETTON_VALUE;
        ledger.discover();
    } else if (op == OP_SWEEP_ALLOW) {
        val msg = SweepAllow.fromSlice(body);
        assert (sender == cfg.admin) throw ERR_JETTON_NOT_OWNER;
        sweeps.allow(ledger, msg.slot, msg.amount);
    } else if (op == OP_SWEEP_PROBE) {
        val msg = SweepProbe.fromSlice(body);
        sweeps.probe(ledger, msg.slot, st.liability(msg.slot) + ledger.owedTotal(msg.slot), sender, value, cfg.bounceGas);
    } else if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(body);
        ledger.claimArchived(msg, sender, value, false, cfg.bounceGas, 0);
    } else if (op == OP_CLAIM_OWED) {
        val msg = ClaimOwed.fromSlice(body);
        ledger.claim(msg.slot, msg.owner, msg.queryId, sender, value, false, cfg.bounceGas, 0);
    } else if (op == OP_HARNESS_XFER) {
        val msg = HarnessXfer.fromSlice(body);
        assert (sender == cfg.admin) throw ERR_JETTON_NOT_OWNER;
        var r = msg.request.beginParse();
        val amount = r.loadCoins();
        val dest = r.loadAddress();
        r.assertEnd();
        assert (st.liability(msg.slot) >= amount) throw ERR_JETTON_VALUE;
        val leg = ledger.legValue(msg.slot, 0, 0, 0, cfg.bounceGas);
        if (msg.kind == 0) {
            ledger.sendTransfer(msg.slot, { queryId: msg.queryId, amount, destination: dest, excessTo: sender,
                forwardGram: 0, forwardPayload: null }, leg, SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        } else if (msg.kind == 1) {
            ledger.sendBurn(msg.slot, msg.queryId, amount, sender, ledger.burnValue(msg.slot, 0, cfg.bounceGas),
                SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        } else {
            // Deliberate test-only J-I3 violation: prove why write-down holders cannot sweep.
            assert (msg.kind == 2) throw ERR_JETTON_SWEEP;
        }
        st.liabilities.set(msg.slot, st.liability(msg.slot) - amount);
    }
    st.ledger = ledger.toCell();
    st.sweeps = sweeps.toCell();
    st.save();
}

get fun get_jetton_slots(): map<uint8, JettonSlot> { return SweepHarnessState.load().ledger.load().slots; }
get fun get_min_discover(): coins { return SweepHarnessState.load().ledger.load().minDiscover(); }
get fun get_min_sweep(slot: uint8): coins {
    val st = SweepHarnessState.load();
    return st.ledger.load().jetton_min_sweep(slot, st.config.load().bounceGas);
}
get fun get_min_claim(slot: uint8): coins {
    val st = SweepHarnessState.load();
    return st.ledger.load().jetton_min_claim(slot, st.config.load().bounceGas);
}
get fun get_sweep(slot: uint8): SweepSlot { return SweepHarnessState.load().sweeps.load().get(slot); }
get fun get_busy(): uint256 { return SweepHarnessState.load().sweeps.load().busy; }
get fun get_jetton_liabilities(slot: uint8): coins {
    val st = SweepHarnessState.load();
    return st.liability(slot) + st.ledger.load().owedTotal(slot);
}
get fun get_owed(slot: uint8, owner: address): coins { return SweepHarnessState.load().ledger.load().owedOf(slot, owner); }
get fun get_unattributed_surplus(slot: uint8, balance: coins): (coins, coins, coins) {
    val liability = get_jetton_liabilities(slot);
    return (liability, max(balance - liability, 0), max(liability - balance, 0));
}

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return SweepHarnessState.load().ledger.load().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return SweepHarnessState.load().ledger.load().jetton_min_archive_claim(slot, SweepHarnessState.load().config.load().bounceGas) + 0; }
