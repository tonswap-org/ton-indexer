tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/jetton/vendor_minter"
import "../shared/utils/error_codes"
import "@gen/op/jetton"
import "@gen/op/testing"

struct HarnessConfig {
    admin: address
    peer: address
    owedCap: uint16
    bounceGas: uint32
    claimKeep: coins
    refundForward: coins
    refundPlain: bool
    ownerOnly: bool
    excessBeneficiary: bool
    outcome: bool
    refundPayload: cell?
    claimDrain: coins
    bounceWork: uint32
}

struct HarnessStorage {
    config: Cell<HarnessConfig>
    ledger: Cell<JettonLedger>
    liabilities: map<uint8, coins>
    marker: uint8
}

struct (0x4a485059) HarnessPay { destination: address }
struct (0x4a484b50) HarnessKeep {}
struct (0x4a485846) HarnessXfer { queryId: uint64; slot: uint8; kind: uint8; request: cell }

fun HarnessStorage.load(): HarnessStorage { return HarnessStorage.fromCell(contract.getData()); }
fun HarnessStorage.save(self) { contract.setData(self.toCell()); }
fun HarnessStorage.liability(self, slot: uint8): coins {
    val value = self.liabilities.get(slot);
    return value.isFound ? value.loadValue() : 0;
}
fun HarnessConfig.refund(self, spent: coins): JettonRefund {
    return { forwardGram: self.refundForward, payload: self.refundPayload,
        payloadBits: self.refundPayload == null ? 0 : 8192, payloadCells: self.refundPayload == null ? 0 : 8,
        plain: self.refundPlain, keep: 0, spent, bounceGas: self.bounceGas,
        tailGas: JETTON_REFUND_TAIL_GAS + (self.outcome ? 5000 : 0), owedCap: self.owedCap };
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = HarnessStorage.load();
    var ledger = st.ledger.load();
    val b = ledger.onBounce(in.senderAddress, in.bouncedBody);
    if (b.kind == 0) { return; }
    val cfg = st.config.load();
    val stop = getGasConsumedAtTheMoment() + cfg.bounceWork;
    while (getGasConsumedAtTheMoment() < stop) {}
    if (b.kind == 2) {
        val before = st.liability(b.slot);
        if (before > JETTON_MAX_COINS - b.amount) { return; }
        st.liabilities.set(b.slot, before + b.amount);
        jetton_bounce_excess(b.excessTo, b.queryId, in.valueCoins, 0);
    } else {
        st.marker = ledger.bounceToOwed(b, cfg.excessBeneficiary ? b.excessTo! : b.destination!, in.valueCoins, cfg.owedCap) as uint8;
    }
    st.ledger = ledger.toCell();
    st.save();
}

fun onInternalMessage(in: InMessage) {
    var body = in.body;
    if (body.remainingBitsCount() < 32) { return; }
    val op = body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_DISCOVER_WALLETS || op == OP_CLAIM_OWED || op == OP_CLAIM_ARCHIVED || op == OP_HARNESS_XFER) {
        handleHarnessPlain(in.senderAddress, in.valueCoins, body);
        return;
    }
    var st = HarnessStorage.load();
    var ledger = st.ledger.load();
    val cfg = st.config.load();
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) {
        val t = ledger.checkTake(in.senderAddress, body);
        if (t == null || t.wallet == cfg.peer || t.wallet == cfg.admin) { return; }
        ledger.commitTake(t);
        st.ledger = ledger.toCell();
        st.save();
        return;
    }
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) {
        val n = ledger.onNotification(in.senderAddress, body);
        if (n == null) { return; }
        var p = n.payload;
        val before = st.liability(n.slot);
        if (n.claimReceipt || (n.payloadOk && p.remainingBitsCount() == 32 && p.remainingRefsCount() == 0 && p.preloadUint(32) == OP_HARNESS_KEEP)) {
            if (before <= JETTON_MAX_COINS - n.amount) {
                st.liabilities.set(n.slot, before + n.amount);
                st.save();
            }
            return;
        }
        var to = n.from;
        if (n.payloadOk && p.remainingBitsCount() == 32 + 267 && p.remainingRefsCount() == 0 && p.loadUint(32) == OP_HARNESS_PAY) {
            val dst = p.tryLoadStdAddress();
            if (dst != null) { to = dst; }
            if (dst != null && ledger.canPay(dst) && in.valueCoins >= ledger.legValue(n.slot, cfg.refundForward, 0, 0, cfg.bounceGas)
                + calculateGasFee(BASECHAIN, getGasConsumedAtTheMoment() + JETTON_REFUND_TAIL_GAS)) {
                reserveGramsOnBalance(max(contract.getOriginalBalance() - in.valueCoins, 0), RESERVE_MODE_AT_MOST);
                ledger.sendTransfer(n.slot, { queryId: n.queryId, amount: n.amount, destination: dst, excessTo: n.from,
                    forwardGram: cfg.refundForward, forwardPayload: null }, 0, SEND_MODE_CARRY_ALL_BALANCE);
                return;
            }
        }
        val spent: coins = cfg.outcome ? calculateGasFee(BASECHAIN, JETTON_NOTIFY_GAS)
            + calculateForwardFee(BASECHAIN, 500, 1) : 0;
        val r = cfg.refund(spent);
        val plan = ledger.refundPlan(n, to, in.valueCoins, r);
        if (cfg.outcome && plan.result != 0) {
            createMessage({ bounce: BounceMode.NoBounce, dest: n.from, value: calculateGasFee(BASECHAIN, JETTON_NOTIFY_GAS),
                body: HarnessXfer { queryId: n.queryId, slot: n.slot, kind: plan.result, request: beginCell().endCell() } })
                .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
        }
        ledger.refundApply(n, plan, in.valueCoins, r, 1);
        st.marker = plan.result;
        st.ledger = ledger.toCell();
        st.save();
        return;
    }
}

fun handleHarnessPlain(sender: address, value: coins, body: slice) {
    val op = body.preloadUint(32);
    var st = HarnessStorage.load();
    var ledger = st.ledger.load();
    val cfg = st.config.load();
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(body);
        assert (value >= ledger.minDiscover()) throw ERR_JETTON_VALUE;
        ledger.discover();
        return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(body);
        if (cfg.claimDrain > 0) {
            // Test-only fault: an earlier action consumes the funds the claim would reserve.
            createMessage({ bounce: BounceMode.NoBounce, dest: cfg.admin, value: cfg.claimDrain, body: beginCell().endCell() })
                .send(SEND_MODE_PAY_FEES_SEPARATELY);
        }
        ledger.claimArchived(msg, sender, value, cfg.ownerOnly, cfg.bounceGas, cfg.claimKeep);
        st.ledger = ledger.toCell();
        st.save();
        return;
    }
    if (op == OP_CLAIM_OWED) {
        val msg = ClaimOwed.fromSlice(body);
        if (cfg.claimDrain > 0) {
            // Test-only fault: an earlier action consumes the funds the claim would reserve.
            createMessage({ bounce: BounceMode.NoBounce, dest: cfg.admin, value: cfg.claimDrain, body: beginCell().endCell() })
                .send(SEND_MODE_PAY_FEES_SEPARATELY);
        }
        ledger.claim(msg.slot, msg.owner, msg.queryId, sender, value, cfg.ownerOnly, cfg.bounceGas, cfg.claimKeep);
        st.ledger = ledger.toCell();
        st.save();
        return;
    }
    if (op != OP_HARNESS_XFER) { return; }
    assert (sender == cfg.admin) throw ERR_JETTON_NOT_OWNER;
    val msg = HarnessXfer.fromSlice(body);
    var r = msg.request.beginParse();
    if (msg.kind == 2) {
        val master = r.loadAddress();
        val gas = r.loadUint(32) as uint32;
        val floor = r.loadCoins();
        val optional = r.loadBool();
        val budget = r.loadRef() as Cell<JettonWalletBudget>;
        r.assertEnd();
        ledger.slotAdd(msg.slot, master, gas, floor, optional, budget);
    } else if (msg.kind == 3) {
        val owner = r.loadAddress();
        val amount = r.loadCoins();
        r.assertEnd();
        val (result, _) = ledger.owedCredit(msg.slot, owner, amount, cfg.owedCap);
        st.marker = result as uint8;
    } else if (msg.kind == 4) {
        val owner = r.loadAddress();
        r.assertEnd();
        val amount = ledger.owedTake(msg.slot, owner);
        st.liabilities.set(msg.slot, st.liability(msg.slot) + amount);
    } else if (msg.kind == 5) {
        // The test minter is derived by the same helper as product minters.
        val recipient = r.loadAddress();
        val amount = r.loadCoins();
        val forward = r.loadCoins();
        r.assertEnd();
        createMessage({ bounce: BounceMode.RichBounce, dest: jetton_v21_minter_init(contract.getAddress(), beginCell().storeUint(0, 8).storeDict(null).endCell()), value: grams("0.2"),
            body: jetton_v21_mint_body(msg.queryId, recipient, grams("0.1"), amount, cfg.admin, forward) })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    } else {
        val amount = r.loadCoins();
        val destination = r.loadAddress();
        val excessTo = r.loadAddress();
        val forward = r.loadCoins();
        val explicitValue = r.loadCoins();
        val payload = r.loadMaybeRef();
        r.assertEnd();
        assert (st.liability(msg.slot) >= amount) throw ERR_JETTON_VALUE;
        val value = explicitValue == 0 ? ledger.legValue(msg.slot, forward, payload == null ? 0 : 8192, payload == null ? 0 : 8, cfg.bounceGas) : explicitValue;
        if (msg.kind == 1) {
            ledger.sendBurn(msg.slot, msg.queryId, amount, excessTo, value, SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        } else {
            ledger.sendTransfer(msg.slot, { queryId: msg.queryId, amount, destination, excessTo, forwardGram: forward, forwardPayload: payload },
                value, SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }
        st.liabilities.set(msg.slot, st.liability(msg.slot) - amount);
    }
    st.ledger = ledger.toCell();
    st.save();
}

get fun get_jetton_slots(): map<uint8, JettonSlot> { return HarnessStorage.load().ledger.load().slots; }
get fun get_owed(slot: uint8, owner: address): coins { return HarnessStorage.load().ledger.load().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = HarnessStorage.load().ledger.load();
    return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_jetton_liabilities(slot: uint8): coins {
    val st = HarnessStorage.load();
    return st.liability(slot) + st.ledger.load().owedTotal(slot);
}
get fun get_unattributed_surplus(slot: uint8, observedBalance: coins): (coins, coins, coins) {
    val liabilities = get_jetton_liabilities(slot);
    return (liabilities, max(observedBalance - liabilities, 0), max(liabilities - observedBalance, 0));
}
get fun get_min_claim(slot: uint8): coins {
    val st = HarnessStorage.load();
    val cfg = st.config.load();
    return st.ledger.load().jetton_min_claim(slot, cfg.bounceGas) + cfg.claimKeep;
}
get fun get_refund_floor(slot: uint8, prefixGas: int): coins {
    val st = HarnessStorage.load();
    return st.ledger.load().refundFloor(slot, st.config.load().refund(0), prefixGas);
}
get fun get_min_discover(): coins { return HarnessStorage.load().ledger.load().minDiscover(); }
get fun get_marker(): uint8 { return HarnessStorage.load().marker; }
get fun get_ledger_cell(): cell { return HarnessStorage.load().ledger; }
get fun get_leg_value(slot: uint8, forward: coins, bits: int, cells: int): coins {
    val st = HarnessStorage.load();
    return st.ledger.load().legValue(slot, forward, bits, cells, st.config.load().bounceGas);
}
get fun get_burn_value(slot: uint8, hubValue: coins): coins {
    val st = HarnessStorage.load();
    return st.ledger.load().burnValue(slot, hubValue, st.config.load().bounceGas);
}
get fun get_constants(): (coins, coins) {
    return (jetton_recovery_rent(), jetton_notify_value());
}
get fun get_minter_address(admin: address, metadata: cell): address { return jetton_v21_minter_address(admin, metadata); }
get fun get_mint_body(q: uint64, to: address, value: coins, amount: coins, response: address?, forward: coins): cell {
    return jetton_v21_mint_body(q, to, value, amount, response, forward);
}
get fun get_bounced_mint(body: slice): BouncedMint? { return jetton_v21_try_parse_bounced_mint(body); }

get fun get_harness_minter(): address {
    return jetton_v21_minter_address(contract.getAddress(), beginCell().storeUint(0, 8).storeDict(null).endCell());
}

get fun get_quote_gas(): (int, int, int, int) {
    return (JETTON_CLAIM_GAS, JETTON_REFUND_TAIL_GAS, JETTON_PROVIDE_GAS, JETTON_DSCW_GAS);
}

get fun get_bounce(sender: address, body: slice): JettonBounce {
    return HarnessStorage.load().ledger.load().onBounce(sender, body);
}

get fun get_top_up_body(): cell { return jetton_v21_top_up_body(); }

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return HarnessStorage.load().ledger.load().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return HarnessStorage.load().ledger.load().jetton_min_archive_claim(slot, HarnessStorage.load().config.load().bounceGas) + HarnessStorage.load().config.load().claimKeep; }

get fun get_owed_storage_bounds(): (int, int) { return HarnessStorage.load().ledger.load().owedStorageBounds(); }
