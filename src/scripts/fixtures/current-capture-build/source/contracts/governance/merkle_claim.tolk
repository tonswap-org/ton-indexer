tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "genesis_types"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "@gen/op/governance"
import "@gen/op/jetton"

// Qualification checks these bounds with full bitmap and vesting dictionaries.
const MC_CLAIM_GAS = 60000
const MC_TAIL_GAS = 20000
const MC_BOUNCE_GAS = 60000
const MC_OWED_CAP = 512
const MC_ALLOW_GAS = 30000
const MCRP_GAS = 8000
const MC_RENT_SECONDS = 315360000

struct (0x4d434556) MerkleClaimEvent { kind: uint8; index: uint32; recipient: address; amount: uint120 }

fun MerkleClaimStorage.load(): MerkleClaimStorage { return MerkleClaimStorage.fromCell(contract.getData()); }
fun MerkleClaimStorage.save(self) { contract.setData(self.toCell()); }

fun vest_group_empty(): VestGroup { return { a0: 0, a1: 0, a2: 0, a3: 0, a4: 0, a5: 0, a6: 0, a7: 0 }; }
fun VestGroup.amount(self, i: int): uint120 {
    if (i == 0) { return self.a0; }
    if (i == 1) { return self.a1; }
    if (i == 2) { return self.a2; }
    if (i == 3) { return self.a3; }
    if (i == 4) { return self.a4; }
    if (i == 5) { return self.a5; }
    if (i == 6) { return self.a6; }
    return self.a7;
}
fun VestGroup.setAmount(mutate self, i: int, amount: uint120) {
    if (i == 0) { self.a0 = amount; }
    else if (i == 1) { self.a1 = amount; }
    else if (i == 2) { self.a2 = amount; }
    else if (i == 3) { self.a3 = amount; }
    else if (i == 4) { self.a4 = amount; }
    else if (i == 5) { self.a5 = amount; }
    else if (i == 6) { self.a6 = amount; }
    else { self.a7 = amount; }
}
fun MerkleClaimStorage.bitmapValue(self, index: uint32): uint256 {
    val entry = self.bitmap.get((index >> 8) as uint16);
    return entry.isFound ? entry.loadValue() : 0;
}
fun MerkleClaimStorage.vestGroup(self, index: uint32): VestGroup {
    val entry = self.vesting.get(index >> 3);
    return entry.isFound ? entry.loadValue() : vest_group_empty();
}
fun MerkleClaimStorage.claimKeep(self, index: uint32, vesting: uint32): coins {
    val exists = vesting > 0 ? self.vesting.get(index >> 3).isFound : self.bitmap.get((index >> 8) as uint16).isFound;
    val entry = calculateStorageFee(BASECHAIN, MC_RENT_SECONDS, 1300, 2);
    return exists ? entry / 10 : entry;
}
fun MerkleClaimStorage.claimValue(self, index: uint32, cliff: uint32, vesting: uint32, flags: uint8, gas: int): coins {
    val reports = (cliff > 0 || vesting > 0) && flags == 0;
    return calculateGasFee(BASECHAIN, gas) + self.claimKeep(index, vesting)
        + calculateForwardFee(BASECHAIN, 1000, 1)
        + (reports ? calculateGasFee(BASECHAIN, MCRP_GAS) + calculateForwardFee(BASECHAIN, 1000, 1) : 0 as coins)
        + self.assets.load().ledger.load().legValue(0, flags == MC_PROTOCOL ? jetton_notify_value() : 0, 0, 0, MC_BOUNCE_GAS);
}
fun merkle_claim_log(kind: uint8, index: uint32, recipient: address, amount: uint120) {
    createExternalLogMessage({ dest: createAddressNone(), body: MerkleClaimEvent { kind, index, recipient, amount } })
        .send(SEND_MODE_IGNORE_ERRORS);
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = MerkleClaimStorage.load();
    var assets = st.assets.load();
    var ledger = assets.ledger.load();
    var sweeps = JettonSweeps.fromCell(assets.sweeps);
    val r = JettonSweeps.onBounce(mutate sweeps, ledger, in.senderAddress, in.bouncedBody);
    if (r.dirty) { assets.sweeps = sweeps.toCell(); st.assets = assets.toCell(); st.save(); }
    val b = r.b;
    if (r.probe) { jetton_bounce_excess(b.excessTo, b.queryId, in.valueCoins, 0); return; }
    if (b.kind != 1 || b.slot != 0) { return; }
    // Sweep and owed retries have a receipt; their query bits never identify a campaign leaf.
    if (b.claimReceipt) {
        if (b.destination != null && b.destination! == assets.treasury) {
            ledger.bounceToOwed(b, assets.treasury, in.valueCoins, MC_OWED_CAP);
            assets.ledger = ledger.toCell(); st.assets = assets.toCell(); st.save();
        }
        return;
    }
    if (b.payload != null || b.payloadTag != 0 || b.queryId >> 35 != 0) { return; }
    val index = (b.queryId & 0xffffffff) as uint32;
    if (index >= st.campaign.load().count) { return; }
    val kind = b.queryId >> 32;
    if ((kind & 1) != 0) {
        var group = st.vestGroup(index);
        group.setAmount(index & 7, max(0, group.amount(index & 7) - b.amount) as uint120);
        st.vesting.set(index >> 3, group);
    } else {
        st.bitmap.set((index >> 8) as uint16, st.bitmapValue(index) & ~(1 << (index & 255)));
    }
    st.acceptedTotal = max(0, st.acceptedTotal - b.amount) as uint120;
    if ((kind & 6) == 4) { st.acceptedDeferred = max(0, st.acceptedDeferred - b.amount) as uint120; }
    st.save();
    merkle_claim_log(2, index, b.destination!, b.amount as uint120);
    jetton_bounce_excess(b.excessTo, b.queryId, in.valueCoins, 0);
}

fun on_take(sender: address, body: slice) {
    var st = MerkleClaimStorage.load();
    var assets = st.assets.load();
    var ledger = assets.ledger.load();
    val take = ledger.checkTake(sender, body);
    if (take == null || take.wallet == st.governance || take.wallet == assets.treasury) { return; }
    ledger.commitTake(take);
    assets.ledger = ledger.toCell();
    st.assets = assets.toCell();
    st.save();
}

fun on_claim(sender: address, value: coins, body: slice) {
    val msg = MerkleClaim.fromSlice(body);
    var st = MerkleClaimStorage.load();
    val ledger = st.assets.load().ledger.load();
    val campaign = st.campaign.load();
    assert (ledger.coreReady() && blockchain.now() >= campaign.start) throw ERR_GOVERNANCE_CONFIG;
    val leaf = merkle_claim_leaf(campaign, msg.proof, msg.index);
    assert (ledger.canPay(leaf.recipient)) throw ERR_JETTON_DEST;
    assert (leaf.flags == 0 || sender == leaf.recipient) throw ERR_GOVERNANCE_UNAUTHORIZED;
    val vested = merkle_vested(leaf.amount, leaf.cliffSeconds, leaf.vestingSeconds, campaign.start, blockchain.now());
    val keep = st.claimKeep(msg.index, leaf.vestingSeconds);
    var release = leaf.amount;
    if (leaf.vestingSeconds == 0) {
        val bit = 1 << (msg.index & 255);
        val bitmap = st.bitmapValue(msg.index);
        assert ((bitmap & bit) == 0 && vested == leaf.amount) throw ERR_GOVERNANCE_CONFIG;
        st.bitmap.set((msg.index >> 8) as uint16, bitmap | bit);
    } else {
        var group = st.vestGroup(msg.index);
        release = vested - group.amount(msg.index & 7);
        assert (release > 0) throw ERR_GOVERNANCE_CONFIG;
        group.setAmount(msg.index & 7, vested);
        st.vesting.set(msg.index >> 3, group);
    }
    val reports = leaf.flags == 0 && (leaf.cliffSeconds > 0 || leaf.vestingSeconds > 0);
    // Price before saving; an underfunded bounceable claim cannot consume its leaf.
    val gas = getGasConsumedAtTheMoment() + MC_TAIL_GAS;
    val minimum = st.claimValue(msg.index, leaf.cliffSeconds, leaf.vestingSeconds, leaf.flags, gas)
        - st.claimKeep(msg.index, leaf.vestingSeconds) + keep;
    assert (value >= minimum) throw ERR_JETTON_VALUE;
    st.acceptedTotal += release;
    if (reports) { st.acceptedDeferred += release; }
    st.save();
    merkle_claim_log(1, msg.index, leaf.recipient, release);
    if (reports) {
        createMessage({ bounce: BounceMode.NoBounce, dest: st.governance, value: calculateGasFee(BASECHAIN, MCRP_GAS),
            body: ClaimedReport { deferred: st.acceptedDeferred } })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
    reserveGramsOnBalance(contract.getOriginalBalance() - value + keep,
        RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    val kind = (leaf.vestingSeconds > 0 ? 1 : 0) | (leaf.flags << 1) | ((leaf.cliffSeconds > 0 || leaf.vestingSeconds > 0) ? 4 : 0);
    ledger.sendTransfer(0, { queryId: (kind << 32) | msg.index, amount: release as coins, destination: leaf.recipient,
        excessTo: sender, forwardGram: leaf.flags == MC_PROTOCOL ? jetton_notify_value() : 0, forwardPayload: null },
        0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun on_notification(sender: address, value: coins, body: slice) {
    var st = MerkleClaimStorage.load();
    var assets = st.assets.load();
    var ledger = assets.ledger.load();
    var sweeps = JettonSweeps.fromCell(assets.sweeps);
    val r = JettonSweeps.onNotification(mutate sweeps, ledger, sender, body);
    if (r.dirty) { assets.sweeps = sweeps.toCell(); }
    if (r.kind == 2) {
        jetton_sweep_pay(mutate ledger, r, assets.treasury, value, 0, null);
        assets.ledger = ledger.toCell();
    }
    if (r.dirty || r.kind == 2) { st.assets = assets.toCell(); st.save(); }
}

fun MerkleClaimStorage.liabilities(self, ledger: JettonLedger, slot: uint8): coins {
    return slot == 0 ? self.campaign.load().total - self.acceptedTotal + ledger.owedTotal(slot) : 0;
}

fun on_sweep_plain(sender: address, value: coins, body: slice) {
    var st = MerkleClaimStorage.load();
    var assets = st.assets.load();
    var ledger = assets.ledger.load();
    var sweeps = JettonSweeps.fromCell(assets.sweeps);
    val op = body.preloadUint(32);
    if (op == OP_SWEEP_ALLOW) {
        val msg = SweepAllow.fromSlice(body);
        assert (sender == st.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
        assert (value >= get_min_allow()) throw ERR_JETTON_VALUE;
        sweeps.allow(ledger, msg.slot, msg.amount);
    } else if (op == OP_SWEEP_PROBE) {
        val msg = SweepProbe.fromSlice(body);
        sweeps.probe(ledger, msg.slot, st.liabilities(ledger, msg.slot), sender, value, MC_BOUNCE_GAS);
    } else if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(body);
        assert (msg.owner == assets.treasury) throw ERR_JETTON_DEST;
        ledger.claimArchived(msg, sender, value, false, MC_BOUNCE_GAS, 0);
    } else {
        val msg = ClaimOwed.fromSlice(body);
        assert (msg.owner == assets.treasury) throw ERR_JETTON_DEST;
        ledger.claim(msg.slot, msg.owner, msg.queryId, sender, value, false, MC_BOUNCE_GAS, 0);
    }
    assets.ledger = ledger.toCell(); assets.sweeps = sweeps.toCell(); st.assets = assets.toCell(); st.save();
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    assert (in.body.remainingBitsCount() >= 32) throw ERR_GOVERNANCE_CONFIG;
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_notification(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_SWEEP_ALLOW || op == OP_SWEEP_PROBE || op == OP_CLAIM_OWED || op == OP_CLAIM_ARCHIVED) {
        on_sweep_plain(in.senderAddress, in.valueCoins, in.body); return;
    }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { on_take(in.senderAddress, in.body); return; }
    if (op == OP_MERKLE_CLAIM) { on_claim(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(in.body);
        val ledger = MerkleClaimStorage.load().assets.load().ledger.load();
        assert (in.valueCoins >= ledger.minDiscover()) throw ERR_JETTON_VALUE;
        ledger.discover();
        return;
    }
    throw ERR_GOVERNANCE_CONFIG;
}

get fun get_campaign(): Campaign { return MerkleClaimStorage.load().campaign.load(); }
get fun get_leaf(proof: cell, index: uint32): MerkleLeaf { return merkle_claim_leaf(MerkleClaimStorage.load().campaign.load(), proof, index); }
get fun get_vested(amount: uint120, cliff: uint32, vesting: uint32, at: uint32): uint120 {
    return merkle_vested(amount, cliff, vesting, MerkleClaimStorage.load().campaign.load().start, at);
}
get fun get_claimed(index: uint32): (bool, uint120) {
    val st = MerkleClaimStorage.load();
    return ((st.bitmapValue(index) & (1 << (index & 255))) != 0, st.vestGroup(index).amount(index & 7));
}
get fun get_totals(): (uint120, uint120) {
    val st = MerkleClaimStorage.load();
    return (st.acceptedTotal, st.acceptedDeferred);
}
get fun get_claim_value(index: uint32, cliff: uint32, vesting: uint32, flags: uint8): coins {
    val st = MerkleClaimStorage.load();
    assert (index < st.campaign.load().count && flags <= MC_PROTOCOL) throw ERR_GOVERNANCE_CONFIG;
    return st.claimValue(index, cliff, vesting, flags, MC_CLAIM_GAS);
}
get fun get_jetton_slots(): map<uint8, JettonSlot> { return MerkleClaimStorage.load().assets.load().ledger.load().slots; }
get fun get_min_discover(): coins { return MerkleClaimStorage.load().assets.load().ledger.load().minDiscover(); }
get fun get_jetton_liabilities(slot: uint8): coins {
    val st = MerkleClaimStorage.load();
    return st.liabilities(st.assets.load().ledger.load(), slot);
}
get fun get_min_allow(): coins {
    return calculateGasFee(BASECHAIN, MC_ALLOW_GAS) + calculateStorageFee(BASECHAIN, 5 * 31536000, 2500, 4);
}
get fun get_treasury(): address { return MerkleClaimStorage.load().assets.load().treasury; }
get fun get_min_sweep(slot: uint8): coins { return MerkleClaimStorage.load().assets.load().ledger.load().jetton_min_sweep(slot, MC_BOUNCE_GAS); }
get fun get_min_claim(slot: uint8): coins { return MerkleClaimStorage.load().assets.load().ledger.load().jetton_min_claim(slot, MC_BOUNCE_GAS); }
get fun get_sweep(slot: uint8): SweepSlot { return MerkleClaimStorage.load().assets.load().sweeps.load().get(slot); }
get fun get_owed(slot: uint8, owner: address): coins { return MerkleClaimStorage.load().assets.load().ledger.load().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = MerkleClaimStorage.load().assets.load().ledger.load();
    return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_unattributed_surplus(slot: uint8, balance: coins): (coins, coins, coins) {
    val liability = get_jetton_liabilities(slot);
    return (liability, max(balance - liability, 0), max(liability - balance, 0));
}
// Five years at the generator's cell ceiling, including a full-cell bit bound.
get fun get_rent_target(): coins { return calculateStorageFee(BASECHAIN, 5 * 31536000, 50000 * 1023, 50000); }

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return MerkleClaimStorage.load().assets.load().ledger.load().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return MerkleClaimStorage.load().assets.load().ledger.load().jetton_min_archive_claim(slot, MC_BOUNCE_GAS); }
