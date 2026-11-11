tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "governance_types"
import "governance_book"
import "governance_policy"
import "governance_proposals"
import "genesis_types"
import "../shared/governance/policy_types"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "@gen/op/governance"
import "@gen/op/jetton"

const GOV_HANDLER_GAS = 300000
const GOV_LOCK_TAIL = 250000
const GOV_REFUND_TAIL = 350000
const GOV_BOUNCE_GAS = 300000
const GOV_MAX_TIME = 4294967295

struct (0x47424f54) GovBootstrap { queryId: uint64; actions: cell }
struct (0x47504f4c) GovPolicy { queryId: uint64; items: Cell<PolicyItem>?; removes: Cell<PolicyRef>? }
struct (0x47544f4b) GovToken { queryId: uint64; master: address; merkleClaim: address; genesisTotal: uint120; supplyBase: uint120; treasury: Cell<GovernanceTreasury> }
struct (0x47484e44) GovHandoff { queryId: uint64; policyRoot: uint256; policyCount: uint16; master: address; merkleClaim: address }
struct (0x474c5854) GovLockExtend { queryId: uint64; duration: uint32 }
struct (0x47554e4c) GovUnlock { queryId: uint64 }
struct (0x474c4558) GovLockEvict { queryId: uint64; owner: address }
struct (0x4750524f) GovPropose { queryId: uint64; class: uint2; descriptionHash: uint256; actions: cell }
struct (0x47565445) GovVote { queryId: uint64; id: uint32; support: uint2 }
struct (0x47414456) GovAdvance { queryId: uint64; id: uint32 }
struct (0x47524f4c) GovRoll { queryId: uint64 }
struct (0x47484556) GovHandoffEvent {
    policyRoot: uint256; policyCount: uint16; master: address; genesisTotal: uint120; supplyBase: uint120; gated: bool
}
struct (0x47504556) GovProposalEvent { kind: uint8; id: uint32; class: uint2; proposer: address; eta: uint32; actionsHash: uint256 }
struct (0x474c4556) GovLockEvent { kind: uint8; owner: address; amount: coins; commitUntil: uint32; bucket: uint32 }

fun governance_plain_value(): coins {
    return calculateGasFee(BASECHAIN, GOV_HANDLER_GAS) + 3 * calculateForwardFee(BASECHAIN, 900, 1);
}
fun governance_actions_value(): coins {
    return governance_plain_value() + 4 * calculateForwardFee(BASECHAIN, 7700, 32);
}
fun governance_lock_keep(): coins { return calculateStorageFee(BASECHAIN, JETTON_WALLET_RENT_SECONDS, 1200, 2); }
fun governance_refund(): JettonRefund {
    return { forwardGram: 0, payload: null, payloadBits: 0, payloadCells: 0, plain: true, keep: 0, spent: 0,
        bounceGas: GOV_BOUNCE_GAS, tailGas: GOV_REFUND_TAIL, owedCap: GOV_OWED_CAP };
}
fun GovernanceStorage.lockValue(self): coins {
    return governance_lock_keep() + self.ledger().refundFloor(0, governance_refund(), GOV_HANDLER_GAS);
}
fun GovernanceStorage.unlockValue(self): coins {
    return governance_plain_value() + self.ledger().legValue(0, 0, 32, 1, GOV_BOUNCE_GAS);
}
fun governance_reserve(inValue: coins, change: int) {
    reserveGramsOnBalance(contract.getOriginalBalance() - inValue + change,
        RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun governance_return(sender: address) {
    createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0, body: createEmptyCell() })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun governance_done(sender: address, value: coins, change: int) {
    governance_reserve(value, change); governance_return(sender);
}
fun GovernanceStorage.authorizeBootstrap(self, sender: address) {
    assert (self.phase == 0 && self.bootstrap != null && sender == self.bootstrap
        && blockchain.now() >= self.bootstrapDeadline - GOV_BOOTSTRAP_WINDOW && blockchain.now() < self.bootstrapDeadline)
        throw ERR_GOVERNANCE_UNAUTHORIZED;
}
fun governance_log_lock(kind: uint8, owner: address, lock: GovernanceLock) {
    createExternalLogMessage({ dest: createAddressNone(), body: GovLockEvent {
        kind, owner, amount: lock.amount, commitUntil: lock.commitUntil, bucket: lock.bucket } }).send(SEND_MODE_IGNORE_ERRORS);
}
fun governance_log_proposal(kind: uint8, id: uint32, proposal: GovernanceProposal) {
    val eta = proposal.closeAt() + governance_params(proposal.class).delay;
    createExternalLogMessage({ dest: createAddressNone(), body: GovProposalEvent {
        kind, id, class: proposal.class, proposer: proposal.proposer, eta: eta as uint32, actionsHash: proposal.actions.hash() } })
        .send(SEND_MODE_IGNORE_ERRORS);
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = GovernanceStorage.load(); var ledger = st.ledger();
    var assets = st.assets.load(); var sweeps = JettonSweeps.fromCell(assets.sweeps);
    val result = JettonSweeps.onBounce(mutate sweeps, ledger, in.senderAddress, in.bouncedBody);
    if (result.dirty) { assets.sweeps = sweeps.toCell(); st.assets = assets.toCell(); st.save(); }
    val bounced = result.b;
    if (result.probe) { jetton_bounce_excess(bounced.excessTo, bounced.queryId, in.valueCoins, 0); return; }
    if (bounced.kind == 1 && bounced.destination != null) {
        ledger.bounceToOwed(bounced, bounced.destination!, in.valueCoins, GOV_OWED_CAP);
        st.setLedger(ledger); st.save();
    }
}
fun on_take(sender: address, body: slice) {
    var st = GovernanceStorage.load(); var ledger = st.ledger();
    val take = ledger.checkTake(sender, body);
    val treasury = st.assets.load().treasury;
    if (take == null || (treasury != null && take.wallet == treasury) || (st.bootstrap != null && take.wallet == st.bootstrap!) || (st.ts != null && take.wallet == st.ts!.merkleClaim)) { return; }
    ledger.commitTake(take); st.setLedger(ledger); st.save(); return;
}
fun on_credit(sender: address, value: coins, body: slice) {
    var st = GovernanceStorage.load(); var ledger = st.ledger();
    var assets = st.assets.load(); var sweeps = JettonSweeps.fromCell(assets.sweeps);
    val result = JettonSweeps.onNotification(mutate sweeps, ledger, sender, body);
    if (result.dirty) { assets.sweeps = sweeps.toCell(); st.assets = assets.toCell(); st.save(); }
    if (result.kind == 2) {
        if (assets.treasury != null) {
            jetton_sweep_pay(mutate ledger, result, assets.treasury!, value, 0, null);
            st.setLedger(ledger); st.save();
        }
        return;
    }
    val credit = result.credit;
    if (credit == null || credit.claimReceipt || st.ts == null) { return; }
    var duration = 0;
    if (credit.payloadOk && credit.payload.remainingBitsCount() == 64 && credit.payload.remainingRefsCount() == 0
            && credit.payload.preloadUint(32) == OP_GOV_LOCK) { duration = credit.payload.getLastBits(32).preloadUint(32); }
    val now = blockchain.now(); val bucket = governance_bucket();
    // A cheap refusal must not traverse a full address path on notification-floor funding.
    if (duration < 31 || duration > 365 || now + duration * bucket > GOV_MAX_TIME
            || value < calculateGasFee(BASECHAIN, GOV_LOCK_TAIL)) {
        ledger.refundOrOwe(credit, credit.from, value, governance_refund(), 1);
        st.setLedger(ledger); st.save(); return;
    }
    var stake = st.stake.load();
    val found = stake.locks.get(credit.from);
    val keep = found.isFound ? 0 as coins : governance_lock_keep();
    val enough = value >= calculateGasFee(BASECHAIN, getGasConsumedAtTheMoment() + GOV_LOCK_TAIL)
        + 2 * calculateForwardFee(BASECHAIN, 900, 1) + keep;
    val valid = ledger.canPay(credit.from) && enough && stake.totalLocked <= st.ts!.genesisTotal - credit.amount
        && (found.isFound || (stake.lockCount < GOV_MAX_LOCKS && credit.amount >= max(1, st.ts!.genesisTotal >> 17)));
    if (!valid) {
        ledger.refundOrOwe(credit, credit.from, value, governance_refund(), 1);
        st.setLedger(ledger); st.save(); return;
    }
    stake.roll(now / bucket, 8);
    val commitment = (now + duration * bucket) as uint32;
    var lock = GovernanceLock { amount: 0, bucket: 0, commitUntil: commitment, prevCommit: commitment,
        commitChangedAt: now, voteLock: 0, proposal: 0, proposeAfter: 0, voteMask: 0, voteStamp: st.props.load().nextId };
    if (found.isFound) {
        lock = found.loadValue(); stake.removeWeight(lock, bucket);
        lock.prevCommit = lock.commitUntil; lock.commitUntil = max(lock.commitUntil, commitment) as uint32;
    } else { stake.lockCount += 1; }
    lock.amount += credit.amount; lock.bucket = (now / bucket + 1) as uint32; lock.commitChangedAt = now;
    stake.addWeight(lock, bucket); stake.totalLocked += credit.amount; stake.locks.set(credit.from, lock);
    st.stake = stake.toCell(); st.save(); governance_log_lock(found.isFound ? 2 : 1, credit.from, lock);
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + keep, RESERVE_MODE_AT_MOST);
    governance_return(credit.from); return;
}

fun governance_unlock(mutate st: GovernanceStorage, owner: address, sender: address, queryId: uint64, value: coins, evict: bool) {
    var ledger = st.ledger(); var stake = st.stake.load();
    assert (value >= st.unlockValue()) throw ERR_JETTON_VALUE;
    val lock = stake.locks.mustGet(owner, ERR_GOVERNANCE_CONFIG);
    val now = blockchain.now(); val bucket = governance_bucket();
    assert (now >= max(lock.commitUntil, lock.voteLock) + (evict ? 30 * bucket : 0)
        && !st.props.load().proposals.exists(lock.proposal)) throw ERR_GOVERNANCE_CONFIG;
    stake.roll(now / bucket, 8); stake.removeWeight(lock, bucket); stake.locks.delete(owner);
    stake.totalLocked -= lock.amount; stake.lockCount -= 1; st.stake = stake.toCell(); st.setLedger(ledger); st.save();
    governance_log_lock(evict ? 5 : 4, owner, lock); governance_reserve(value, 0);
    ledger.sendTransfer(0, { queryId, amount: lock.amount, destination: owner, excessTo: sender, forwardGram: 0,
        forwardPayload: jetton_claim_receipt() },
        0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun governance_propose(mutate st: GovernanceStorage, sender: address, value: coins, msg: GovPropose) {
    assert (st.phase == 1 && msg.class <= 2) throw ERR_GOVERNANCE_CONFIG;
    val (status, total, _, _, _) = st.checkActions(msg.class, msg.actions);
    assert (status == 0) throw ERR_GOVERNANCE_CONFIG;
    assert (value >= total + GOV_PROPOSAL_FEE + governance_actions_value()) throw ERR_JETTON_VALUE;
    val now = blockchain.now(); val bucket = governance_bucket();
    var stake = st.stake.load(); var props = st.props.load();
    var lock = stake.locks.mustGet(sender, ERR_GOVERNANCE_CONFIG);
    val (slot, open) = props.group(msg.class);
    assert (slot >= 0 && props.live < GOV_MAX_PROPOSALS && (msg.class == 2 || props.live < 40)
        && props.nextId < 4294967295 && (msg.class != 1 || now / bucket >= st.handoffBucket + 30)
        && now / bucket - lock.bucket >= 7 && lock.commitUntil / bucket > now / bucket
        && !props.proposals.exists(lock.proposal) && now >= lock.proposeAfter
        && lock.amount >= max(1, (st.supply(stake) + 999) / 1000) << open) throw ERR_GOVERNANCE_CONFIG;
    val rolled = stake.roll(now / bucket, 24);
    if (rolled > 0) { st.stake = stake.toCell(); st.save(); governance_done(sender, value, 0); return; }
    val weight = stake.snapshot(now / bucket); val quorum = governance_quorum(msg.class, weight, st.supply(stake));
    assert (weight >= quorum) throw ERR_GOVERNANCE_CONFIG;
    val proposal = GovernanceProposal { proposer: sender, class: msg.class, queued: false, slot: slot as uint4,
        start: now, decidedAt: 0, valueTotal: total, descriptionHash: msg.descriptionHash,
        tally: GovernanceTally { quorum, partQ: 0, yes: 0, no: 0 }.toCell(), actions: msg.actions };
    val p = governance_params(msg.class);
    assert (now + p.maxVote + p.review + p.delay + p.grace <= GOV_MAX_TIME) throw ERR_GOVERNANCE_CONFIG;
    val id = props.nextId; props.nextId += 1; props.live += 1; props.escrow += total;
    props.slots.put(slot, id); props.proposals.set(id, proposal);
    lock.proposal = id; lock.voteLock = max(lock.voteLock, proposal.lockUntil()) as uint32; stake.locks.set(sender, lock);
    st.stake = stake.toCell(); st.props = props.toCell(); st.save(); governance_log_proposal(1, id, proposal);
    governance_done(sender, value, GOV_PROPOSAL_FEE + total);
}
fun governance_vote(mutate st: GovernanceStorage, sender: address, value: coins, msg: GovVote) {
    assert (st.phase == 1 && msg.support <= 2) throw ERR_GOVERNANCE_CONFIG;
    assert (value >= governance_plain_value()) throw ERR_JETTON_VALUE;
    var props = st.props.load(); var proposal = props.proposals.mustGet(msg.id, ERR_GOVERNANCE_CONFIG);
    assert (!proposal.queued && blockchain.now() < proposal.closeAt()) throw ERR_GOVERNANCE_CONFIG;
    var stake = st.stake.load(); var lock = stake.locks.mustGet(sender, ERR_GOVERNANCE_CONFIG);
    lock.clearVotes(props);
    assert ((lock.voteMask & (1 << proposal.slot)) == 0) throw ERR_GOVERNANCE_CONFIG;
    val (q, v) = lock.weight(proposal.start, governance_bucket());
    assert (q > 0) throw ERR_GOVERNANCE_CONFIG;
    var tally = proposal.tally.load(); tally.partQ += q;
    if (msg.support == 1) { tally.yes += v; } else if (msg.support == 0) { tally.no += v; }
    proposal.tally = tally.toCell();
    if (!proposal.passes()) { proposal.decidedAt = 0; }
    else if (proposal.decidedAt == 0) { proposal.decidedAt = blockchain.now(); }
    lock.voteMask |= 1 << proposal.slot; lock.voteStamp = props.nextId;
    lock.voteLock = max(lock.voteLock, proposal.lockUntil()) as uint32;
    stake.locks.set(sender, lock); props.proposals.set(msg.id, proposal);
    st.stake = stake.toCell(); st.props = props.toCell(); st.save();
    createExternalLogMessage({ dest: createAddressNone(), body: GovVoteEvent { id: msg.id, voter: sender, support: msg.support, q, v } })
        .send(SEND_MODE_IGNORE_ERRORS);
    governance_done(sender, value, 0);
}
fun governance_advance(mutate st: GovernanceStorage, sender: address, value: coins, msg: GovAdvance) {
    assert (st.phase == 1) throw ERR_GOVERNANCE_CONFIG;
    assert (value >= governance_actions_value()) throw ERR_JETTON_VALUE;
    var props = st.props.load(); var proposal = props.proposals.mustGet(msg.id, ERR_GOVERNANCE_CONFIG);
    val now = blockchain.now(); val close = proposal.closeAt(); val eta = close + governance_params(proposal.class).delay;
    var remove = false; var refund = false; var kind = 0;
    if (!proposal.queued) {
        assert (now >= close) throw ERR_GOVERNANCE_CONFIG;
        props.slots.put(proposal.slot, 0);
        if (proposal.decidedAt == 0) {
            remove = true; refund = true; kind = 4;
            val tally = proposal.tally.load();
            if (tally.partQ * 2 < tally.quorum) {
                var stake = st.stake.load(); val found = stake.locks.get(proposal.proposer);
                if (found.isFound) {
                    var lock = found.loadValue(); lock.proposeAfter = min(GOV_MAX_TIME, now + 30 * governance_bucket()) as uint32;
                    stake.locks.set(proposal.proposer, lock); st.stake = stake.toCell();
                }
            }
        } else {
            proposal.queued = true; governance_log_proposal(2, msg.id, proposal);
        }
    } else { assert (now >= eta) throw ERR_GOVERNANCE_CONFIG; }
    if (!remove && now > eta + governance_params(proposal.class).grace) { remove = true; refund = true; kind = 5; }
    if (!remove && now >= eta) {
        val (status, _, policy, count, sweeps) = st.checkActions(proposal.class, proposal.actions);
        remove = true;
        if (status != 0) { refund = true; kind = 6; }
        else {
            kind = 3; st.policy = policy; st.policyCount = count;
            var assets = st.assets.load(); assets.sweeps = sweeps.toCell(); st.assets = assets.toCell();
            val actions = action_list_decode(proposal.actions)!; var i = 0;
            while (i < actions.size()) {
                val action = actions.get(i);
                if (action.target != contract.getAddress()) {
                    createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: action.target, value: action.value, body: action.body })
                        .send(SEND_MODE_BOUNCE_ON_ACTION_FAIL);
                }
                i += 1;
            }
        }
    }
    var released: coins = 0;
    if (remove) {
        released = proposal.valueTotal; props.escrow -= released; props.live -= 1; props.proposals.delete(msg.id);
        governance_log_proposal(kind as uint8, msg.id, proposal);
        if (refund && released >= 2 * calculateForwardFee(BASECHAIN, 400, 1)) {
            createMessage({ bounce: BounceMode.NoBounce, dest: proposal.proposer, value: released, body: createEmptyCell() }).send(SEND_MODE_IGNORE_ERRORS);
        } else if (refund) { released = 0; }
    } else { props.proposals.set(msg.id, proposal); }
    st.props = props.toCell(); st.save(); governance_done(sender, value, -released);
}

fun governance_report(mutate st: GovernanceStorage, sender: address, msg: ClaimedReport) {
    assert (st.ts != null && sender == st.ts!.merkleClaim) throw ERR_GOVERNANCE_UNAUTHORIZED;
    var stake = st.stake.load();
    stake.deferredMax = max(stake.deferredMax, min(msg.deferred, st.ts!.genesisTotal - st.ts!.supplyBase));
    st.stake = stake.toCell(); st.save();
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    assert (in.body.remainingBitsCount() >= 32) throw ERR_GOVERNANCE_CONFIG;
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { on_take(in.senderAddress, in.body); return; }
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit(in.senderAddress, in.valueCoins, in.body); return; }
    var st = GovernanceStorage.load();
    if (op == OP_CLAIMED_REPORT) { governance_report(mutate st, in.senderAddress, ClaimedReport.fromSlice(in.body)); return; }
    if (op == OP_GOV_PROPOSE) { governance_propose(mutate st, in.senderAddress, in.valueCoins, GovPropose.fromSlice(in.body)); return; }
    if (op == OP_GOV_VOTE) { governance_vote(mutate st, in.senderAddress, in.valueCoins, GovVote.fromSlice(in.body)); return; }
    if (op == OP_GOV_ADVANCE) { governance_advance(mutate st, in.senderAddress, in.valueCoins, GovAdvance.fromSlice(in.body)); return; }
    if (op == OP_GOV_UNLOCK) {
        val msg = GovUnlock.fromSlice(in.body);
        governance_unlock(mutate st, in.senderAddress, in.senderAddress, msg.queryId, in.valueCoins, false); return;
    }
    if (op == OP_GOV_LOCK_EVICT) {
        val msg = GovLockEvict.fromSlice(in.body);
        governance_unlock(mutate st, msg.owner, in.senderAddress, msg.queryId, in.valueCoins, true); return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(in.body); var ledger = st.ledger();
        ledger.claimArchived(msg, in.senderAddress, in.valueCoins, false, GOV_BOUNCE_GAS, 0);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_CLAIM_OWED) {
        val msg = ClaimOwed.fromSlice(in.body); var ledger = st.ledger();
        ledger.claim(msg.slot, msg.owner, msg.queryId, in.senderAddress, in.valueCoins, false, GOV_BOUNCE_GAS, 0);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_SWEEP_PROBE) {
        val msg = SweepProbe.fromSlice(in.body); var assets = st.assets.load(); var sweeps = JettonSweeps.fromCell(assets.sweeps); val ledger = st.ledger();
        assert (st.ts != null && assets.treasury != null) throw ERR_GOVERNANCE_CONFIG;
        sweeps.probe(ledger, msg.slot, (msg.slot == 0 ? st.stake.load().totalLocked : 0 as coins) + ledger.owedTotal(msg.slot),
            in.senderAddress, in.valueCoins, GOV_BOUNCE_GAS);
        assets.sweeps = sweeps.toCell(); st.assets = assets.toCell(); st.save(); return;
    }
    assert (in.valueCoins >= governance_plain_value()) throw ERR_JETTON_VALUE;
    if (op == OP_GOV_LOCK_EXTEND) {
        val msg = GovLockExtend.fromSlice(in.body); var stake = st.stake.load();
        var lock = stake.locks.mustGet(in.senderAddress, ERR_GOVERNANCE_CONFIG); val now = blockchain.now(); val bucket = governance_bucket();
        assert (now < lock.commitUntil && now >= lock.commitChangedAt + 15 * bucket && msg.duration >= 31 && msg.duration <= 365
            && now + msg.duration * bucket <= GOV_MAX_TIME && now + msg.duration * bucket > lock.commitUntil) throw ERR_GOVERNANCE_CONFIG;
        stake.roll(now / bucket, 8); stake.removeWeight(lock, bucket); lock.prevCommit = lock.commitUntil;
        lock.commitUntil = (now + msg.duration * bucket) as uint32; lock.commitChangedAt = now; stake.addWeight(lock, bucket);
        stake.locks.set(in.senderAddress, lock); st.stake = stake.toCell(); st.save(); governance_log_lock(3, in.senderAddress, lock);
    } else if (op == OP_GOV_ROLL) {
        val msg = GovRoll.fromSlice(in.body); var stake = st.stake.load();
        assert (stake.roll(blockchain.now() / governance_bucket(), 32) > 0) throw ERR_GOVERNANCE_CONFIG;
        st.stake = stake.toCell(); st.save();
    } else if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(in.body); val ledger = st.ledger();
        assert (in.valueCoins >= ledger.minDiscover() + governance_plain_value()) throw ERR_JETTON_VALUE;
        ledger.discover();
    } else if (op == OP_GOV_TOKEN) {
        st.authorizeBootstrap(in.senderAddress); val msg = GovToken.fromSlice(in.body); var ledger = st.ledger();
        assert (st.ts == null && msg.genesisTotal > 0 && msg.supplyBase <= msg.genesisTotal && ledger.canPay(msg.merkleClaim)
            && msg.merkleClaim != msg.master) throw ERR_GOVERNANCE_CONFIG;
        val treasury = msg.treasury.load().treasury;
        assert (ledger.canPay(treasury) && treasury != msg.master && treasury != msg.merkleClaim
            && treasury != st.bootstrap!) throw ERR_GOVERNANCE_CONFIG;
        var assets = st.assets.load(); assets.treasury = treasury; st.assets = assets.toCell();
        ledger.slotAdd(0, msg.master, JETTON_V21_WALLET_GAS, 0, false, jetton_standard_budget(JETTON_V21_WALLET_GAS));
        assert (in.valueCoins >= ledger.minDiscover() + governance_plain_value()) throw ERR_JETTON_VALUE;
        st.ts = { merkleClaim: msg.merkleClaim, genesisTotal: msg.genesisTotal, supplyBase: msg.supplyBase };
        st.setLedger(ledger); st.save(); ledger.discover();
    } else if (op == OP_GOV_POLICY) {
        st.authorizeBootstrap(in.senderAddress); val msg = GovPolicy.fromSlice(in.body);
        val items = policy_items_decode(msg.items); val removes = policy_refs_decode(msg.removes);
        assert (items != null && removes != null && items.size() + removes.size() <= POLICY_LIST_MAX) throw ERR_GOVERNANCE_CONFIG;
        var i = 0;
        while (i < removes.size()) { if (policy_drop(mutate st.policy, removes.get(i).row)) { st.policyCount -= 1; } i += 1; }
        i = 0;
        while (i < items.size()) {
            val item = items.get(i);
            assert (item.row.target != contract.getAddress() && policy_item_ok(item)) throw ERR_GOVERNANCE_CONFIG;
            val result = policy_put(mutate st.policy, item.row, policy_entry_of(item));
            assert (result != POLICY_PUT_REFUSED) throw ERR_GOVERNANCE_CONFIG;
            if (result == POLICY_PUT_ADDED) { st.policyCount += 1; } i += 1;
        }
        assert (st.policyCount <= POLICY_ENTRIES_MAX) throw ERR_GOVERNANCE_CONFIG; st.save();
    } else if (op == OP_GOV_BOOTSTRAP) {
        st.authorizeBootstrap(in.senderAddress); val msg = GovBootstrap.fromSlice(in.body); val actions = action_list_decode(msg.actions);
        assert (actions != null) throw ERR_GOVERNANCE_CONFIG;
        var total: coins = 0; var i = 0;
        while (i < actions.size()) {
            val action = actions.get(i); assert (st.externalTarget(action) && action_body_fits(action.body)) throw ERR_GOVERNANCE_CONFIG;
            total += action.value; i += 1;
        }
        assert (in.valueCoins >= total + governance_actions_value()) throw ERR_JETTON_VALUE;
        i = 0;
        while (i < actions.size()) {
            val action = actions.get(i);
            createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: action.target, value: action.value, body: action.body })
                .send(SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            i += 1;
        }
    } else if (op == OP_GOV_HANDOFF) {
        val msg = GovHandoff.fromSlice(in.body);
        assert (st.phase == 0 && st.ts != null && st.ledger().coreReady() && st.policyCount > 0) throw ERR_GOVERNANCE_CONFIG;
        val gated = blockchain.now() < st.bootstrapDeadline;
        if (gated) {
            st.authorizeBootstrap(in.senderAddress); val stake = st.stake.load();
            assert (msg.policyRoot == policy_root(st.policy) && msg.policyCount == st.policyCount
                && msg.master == st.ledger().slots.mustGet(0).master && msg.merkleClaim == st.ts!.merkleClaim
                && stake.rollComplete(blockchain.now() / governance_bucket())
                && stake.snapshot(blockchain.now() / governance_bucket()) >= max(1, (st.supply(stake) * 2 + 99) / 100)) throw ERR_GOVERNANCE_CONFIG;
        }
        st.phase = 1; st.bootstrap = null; st.handoffBucket = (blockchain.now() / governance_bucket()) as uint32; st.save();
        createExternalLogMessage({ dest: createAddressNone(), body: GovHandoffEvent { policyRoot: policy_root(st.policy),
            policyCount: st.policyCount, master: st.ledger().slots.mustGet(0).master,
            genesisTotal: st.ts!.genesisTotal, supplyBase: st.ts!.supplyBase, gated } }).send(SEND_MODE_IGNORE_ERRORS);
    } else { throw ERR_GOVERNANCE_CONFIG; }
    governance_done(in.senderAddress, in.valueCoins, 0);
}

get fun get_storage(): cell { return contract.getData(); }
get fun get_governance(): (int, address?, int, int, GovernanceToken?, int, int, int, int, coins, coins) {
    val st = GovernanceStorage.load(); val props = st.props.load();
    return (st.phase, st.bootstrap, st.bootstrapDeadline, st.handoffBucket, st.ts, policy_root(st.policy), st.policyCount,
        props.nextId, props.live, props.escrow, contract.getOriginalBalance() - props.escrow);
}
get fun get_params(class: int): (int, GovernanceParams) { return (governance_bucket(), governance_params(class)); }
get fun get_policy_entry(target: address, op: uint32, sub: uint8?): PolicyEntry? {
    return policy_find(GovernanceStorage.load().policy, { target, op, sub });
}
get fun check_actions(class: int, actions: cell): (int, coins) {
    val (status, value, _, _, _) = GovernanceStorage.load().checkActions(class, actions); return (status, value);
}
get fun get_stake(): (cell, coins, coins, bool) {
    val st = GovernanceStorage.load(); val stake = st.stake.load(); val today = blockchain.now() / governance_bucket();
    return (st.stake, st.supply(stake), stake.weightAt(today), stake.rollComplete(today));
}
get fun get_w_at(day: uint32): coins {
    assert (day >= blockchain.now() / governance_bucket()) throw ERR_GOVERNANCE_CONFIG;
    return GovernanceStorage.load().stake.load().weightAt(day);
}
get fun get_handoff_gate(): (coins, coins, bool) {
    val st = GovernanceStorage.load(); val stake = st.stake.load(); val today = blockchain.now() / governance_bucket();
    val weight = stake.weightAt(today); val required = max(1, (st.supply(stake) * 2 + 99) / 100);
    return (weight, required, weight >= required && stake.rollComplete(today));
}
get fun get_lock(owner: address): GovernanceLock? {
    val found = GovernanceStorage.load().stake.load().locks.get(owner); return found.isFound ? found.loadValue() : null;
}
get fun get_min_lock(): coins { return max(1, GovernanceStorage.load().ts!.genesisTotal >> 17); }
get fun get_vote_weight(owner: address, id: uint32): (coins, uint122) {
    val st = GovernanceStorage.load(); val found = st.stake.load().locks.get(owner);
    return found.isFound ? found.loadValue().weight(st.props.load().proposals.mustGet(id, ERR_GOVERNANCE_CONFIG).start, governance_bucket()) : (0, 0);
}
get fun get_proposal(id: uint32): (GovernanceProposal?, int, int, int) {
    val found = GovernanceStorage.load().props.load().proposals.get(id);
    if (!found.isFound) { return (null, 0, 0, 0); }
    val p = found.loadValue(); val close = p.closeAt(); val eta = close + governance_params(p.class).delay;
    return (p, close, eta, blockchain.now() > eta + governance_params(p.class).grace ? 4 : p.queued ? 3 : blockchain.now() >= close ? 2 : 1);
}
get fun get_slots(): GovernanceSlots { return GovernanceStorage.load().props.load().slots; }
get fun get_proposer_threshold(class: int): coins {
    val st = GovernanceStorage.load(); val (_, open) = st.props.load().group(class);
    return max(1, (st.supply(st.stake.load()) + 999) / 1000) << open;
}
get fun get_quorum_preview(class: int): coins {
    val st = GovernanceStorage.load(); val stake = st.stake.load();
    return governance_quorum(class, stake.weightAt(blockchain.now() / governance_bucket()), st.supply(stake));
}
get fun get_min_values(): (coins, coins, coins, coins, coins, coins) {
    val st = GovernanceStorage.load();
    return (st.ts == null ? 0 : st.lockValue(), governance_plain_value(), governance_actions_value() + GOV_PROPOSAL_FEE,
        governance_actions_value(), st.ts == null ? 0 : st.unlockValue(), governance_plain_value());
}
get fun get_min_bind(): coins { return jetton_min_discover(1) + governance_plain_value(); }
get fun get_min_plain(): coins { return governance_plain_value(); }
get fun get_min_bootstrap(): coins { return governance_actions_value(); }
get fun get_min_discover(): coins { return GovernanceStorage.load().ledger().minDiscover() + governance_plain_value(); }
get fun get_jetton_slots(): map<uint8, JettonSlot> { return GovernanceStorage.load().ledger().slots; }
get fun get_jetton_liabilities(slot: uint8): coins {
    val st = GovernanceStorage.load(); return (slot == 0 ? st.stake.load().totalLocked : 0 as coins) + st.ledger().owedTotal(slot);
}
get fun get_owed(slot: uint8, owner: address): coins { return GovernanceStorage.load().ledger().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = GovernanceStorage.load().ledger(); return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_min_claim(slot: uint8): coins { return GovernanceStorage.load().ledger().jetton_min_claim(slot, GOV_BOUNCE_GAS); }

get fun get_sweep(slot: uint8): SweepSlot { return GovernanceStorage.load().assets.load().sweeps.load().get(slot); }
get fun get_min_sweep(slot: uint8): coins { return GovernanceStorage.load().ledger().jetton_min_sweep(slot, GOV_BOUNCE_GAS); }
get fun get_treasury(): address? { return GovernanceStorage.load().assets.load().treasury; }

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return GovernanceStorage.load().ledger().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return GovernanceStorage.load().ledger().jetton_min_archive_claim(slot, GOV_BOUNCE_GAS); }
