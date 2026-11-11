tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments";
import "../shared/jetton/jetton_sweep";
import "../shared/jetton/protected_credit";
import "@stdlib/exotic-cells";
import "@gen/op/dlmm";
import "@gen/op/jetton";
import "@gen/op/oracle";
import "@gen/op/dex";
import "./constants";
import "./pool_state_init";
import "./pool_storage";
import "./pool_codec";
import "./pool_funding";
import "./pool_book";
import "./pool_positions";
import "./farming";
import "./math";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/jetton_quotes";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/tep89_codec";
import "../shared/dex/swap_payload";
import "../shared/oracle/responder";
import "../shared/oracle/evidence";
import "../t3/receipt_tree";
import "../t3/recovery_types";
import "../t3/wallet_types";
import "@gen/op/t3";

const ERR_POOL = 3101;
const POOL_MAX_COINS = (1 << 120) - 1;

struct (0x504e434c) PoolNotificationClaim { receipt: Cell<T3Receipt>; proof: cell }

@inline
fun pool_dispatch(mutate root: PoolStorage, mutate jet: PoolJet, slot: int, amount: coins) {
    if (slot == 0 && amount > 0 && jet.recovery != null) {
        var tail = (jet.recovery! as cell).beginParse(); val dispatched = tail.loadUint(256);
        jet.recovery = beginCell().storeUint(dispatched + amount,256).storeSlice(tail).endCell() as Cell<PoolCreditRecovery>;
        root.jet = jet.toCell();
    }
}
fun pool_restored(mutate jet: PoolJet, slot: int, amount: coins) {
    if (slot == 0 && jet.recovery != null) {
        var recovery = jet.recovery!.load(); recovery.restored += amount;
        jet.recovery = recovery.toCell();
    }
}
fun pool_recovery_rent(): coins { return calculateStorageFee(0,POOL_RENT_SECONDS,19000,25); }
fun pool_recovery_value(ledger: JettonLedger, claim: bool): coins {
    return calculateGasFee(0,300000) + pool_recovery_rent() + calculateForwardFee(0,1400,3)
        + (claim ? ledger.legValue(0,jetton_notify_value(),32,1,POOL_BOUNCE_GAS) : swap_aux_value());
}
fun pool_credit_certificate(sender: address,value: coins,body: slice) {
    var root = PoolStorage.fromCell(contract.getData()); var jet = root.jet.load();
    assert (jet.recovery != null && value >= pool_recovery_value(jet.ledger,false)) throw ERR_POOL;
    setGasLimit(250000);
    var b = body; val notification = b.loadUint(32) == OP_T3_NOTIFICATION_CERTIFICATE; val config = b.loadRef() as Cell<ProofConfig>; var payload = b.loadRef().beginParse();
    val proofCode = b.loadRef(); if (notification) { b.loadUint(256); } b.assertEnd();
    val requestCell = payload.loadRef(); val walletCode = payload.loadRef(); val absent = payload.loadRef(); payload.assertEnd();
    val cfg = config.load(); val credit = cfg.credit.load(); val targets = cfg.targets.load();
    val slot = jet.ledger.slots.mustGet(0,ERR_POOL); assert (slot.wallet != null) throw ERR_POOL;
    var ids = credit.identities.beginParse();
    assert (ids.loadAddress() == contract.getAddress() && ids.loadAddress() == contract.getAddress() && ids.loadAddress() == slot.master) throw ERR_POOL; ids.assertEnd();
    assert (credit.codeHash == walletCode.hash() && t3_wallet_init(contract.getAddress(),slot.master,proofCode.hash() as uint256,walletCode).calculateAddress() == slot.wallet!
        && sender == t3_proof_address(config,proofCode)) throw ERR_POOL;
    var claim: PoolCreditClaim;
    var raw = createEmptySlice();
    if (!notification) {
        var request = requestCell.beginParse();
        assert (request.loadUint(32) == OP_TEP74_TRANSFER && requestCell.hash() == credit.requestHash) throw ERR_POOL;
        val queryId = request.loadUint(64) as uint64; val amount = request.loadCoins();
        val destination = request.loadAddress(); val excessTo = request.loadAddress();
        assert (amount > 0 && jet.ledger.canPay(destination) && !request.loadBool()) throw ERR_POOL;
        request.loadCoins(); var forward: cell? = null;
        if (request.loadBool()) { forward = request.loadRef(); }
        request.assertEnd();
        var w = credit.wallets.beginParse();
        assert (w.loadAddress() == slot.wallet!) throw ERR_POOL; val target = w.loadAddress();
        assert ((target == slot.wallet! || target == contract.getAddress())
            && w.loadUint(64) == queryId && w.loadCoins() == amount) throw ERR_POOL; w.assertEnd();
        if (target == slot.wallet!) { assert (targets.source.hash() == targets.target.hash()) throw ERR_POOL; }
        else { assert (targets.target.load().lt > targets.source.load().lt) throw ERR_POOL; }
        var to = destination;
        if (forward != null) {
            val result = swap_result_try_parse(forward!.beginParse());
            if (result != null && result.queryId == queryId && result.status == SWAP_EXECUTED
                && result.amountOut == amount && result.user != null) { to = excessTo; }
        }
        claim = { amount,refundTo:to,queryId,origin:contract.getAddress(),notify:false,claimed:false };
    } else {
        val attemptCell = requestCell as Cell<WalletAttempt>;
        val a = attemptCell.load(); val terms = a.terms.load(); val details = terms.details.load();
        assert (!terms.burn && terms.recipient == contract.getAddress() && terms.amount > 0
            && t3_wallet_attempt_body(attemptCell).hash() == credit.requestHash) throw ERR_POOL;
        var w = credit.wallets.beginParse();
        assert (w.loadAddress() == slot.wallet! && w.loadAddress() == contract.getAddress()
            && w.loadUint(64) == details.queryId && w.loadCoins() == terms.amount) throw ERR_POOL; w.assertEnd();
        var forward = details.forwardPayload.beginParse();
        raw = forward;
        if (forward.loadBool()) {
            val (revealed,exotic) = forward.loadRef().beginParseSpecial(); raw = exotic ? createEmptySlice() : revealed;
        } else { raw = forward; }
        var request = swap_try_parse(raw); var direct = request != null;
        if (request == null) {
            val result = swap_result_try_parse(raw);
            if (result != null && result.status == SWAP_EXECUTED && result.user != null) {
                val route = route_cont_try_parse(result.user!);
                if (route != null && route.pool == contract.getAddress()) {
                    val (_,_,_,fits) = (route.swap as cell).calculateSize(7);
                    request = fits ? swap_try_parse((route.swap as cell).beginParse()) : null;
                    if (request != null && request.notifyOrigin) { request = null; }
                }
            }
        }
        val to = request != null && jet.ledger.canPay(request.refundTo) ? request.refundTo : terms.owner;
        assert (jet.ledger.canPay(to) && targets.source.load().lt > 0 && targets.target.load().lt > 0) throw ERR_POOL;
        claim = { amount: terms.amount,refundTo: to,queryId: details.queryId,origin: terms.owner,
            notify: direct && request != null && request.notifyOrigin,claimed: false };
    }
    assert (jet.ledger.canPay(claim.refundTo) && targets.source.load().lt > 0 && targets.target.load().lt > 0) throw ERR_POOL;
    val receipt: T3Receipt = { key: targets.source.load().lt,payload: claim.toCell() };
    var recovery = jet.recovery!.load(); var tree = recovery.tree == null ? t3_receipt_tree() : recovery.tree!.load();
    if (!tree.initialized || receipt.key > tree.lastKey) { tree.append(receipt.toCell()); }
    else { tree.replace(null,receipt.toCell(),absent); }
    recovery.tree = tree.toCell(); recovery.pending += claim.amount; if (notification) { recovery.handled += claim.amount; } else { recovery.restored += claim.amount; }
    jet.recovery = recovery.toCell(); root.jet = jet.toCell(); contract.setData(root.toCell());
    val rent = pool_recovery_rent();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+rent,RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:beginCell().storeUint(OP_POOL_NOTIFICATION_CLAIM,32).storeRef(receipt.toCell())}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    if (claim.notify) {
        val c: JettonCredit = { slot: 0,queryId: claim.queryId,amount: claim.amount,from: claim.origin,payloadOk: true,claimReceipt: false,payload: raw };
        pool_swap_outcome(c,SWAP_INPUT_OWED,SWAP_REASON_VALUE,0);
    }
    createMessage({bounce:BounceMode.NoBounce,dest:claim.refundTo,value:0,body:createEmptyCell()}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun pool_credit_claim(sender: address,value: coins,body: slice) {
    var root = PoolStorage.fromCell(contract.getData()); var jet = root.jet.load();
    assert (jet.recovery != null && value >= pool_recovery_value(jet.ledger,true) && jet.ledger.canPay(sender)) throw ERR_POOL;
    setGasLimit(250000); val msg = PoolNotificationClaim.fromSlice(body); var receipt = msg.receipt.load();
    var claim = PoolCreditClaim.fromCell(receipt.payload); assert (!claim.claimed && claim.amount > 0) throw ERR_POOL;
    var recovery = jet.recovery!.load(); assert (recovery.tree != null) throw ERR_POOL; var tree = recovery.tree!.load();
    claim.claimed = true; receipt.payload = claim.toCell(); tree.replace(msg.receipt,receipt.toCell(),msg.proof);
    recovery.pending -= claim.amount; recovery.dispatched += claim.amount; recovery.tree = tree.toCell(); jet.recovery = recovery.toCell();
    root.jet = jet.toCell(); contract.setData(root.toCell());
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    jet.ledger.sendTransfer(0,{queryId:claim.queryId,amount:claim.amount,destination:claim.refundTo,excessTo:sender,
        forwardGram:jetton_notify_value(),forwardPayload:jetton_claim_receipt()},0,SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun pool_identity(root: PoolStorage, ledger: JettonLedger): PoolId {
    val x = ledger.slots.mustGet(1, ERR_POOL);
    return { xMaster: x.master, binSpacing: root.binSpacing, feePips: root.feePips,
        xDecimals: root.xDecimals, walletGasX: x.walletGas, walletGramX: x.walletGram, walletBudgetX: x.budget };
}
fun pool_ready(root: PoolStorage, ledger: JettonLedger): bool {
    return (root.flags & 1) != 0 && ledger.pendingCount() == 0;
}
fun pool_keep(root: PoolStorage, value: coins): coins {
    return pool_tip(root.binCount, root.positionCount, root.campaignCount, max(contract.getOriginalBalance() - value, 0));
}
fun pool_touch(mutate root: PoolStorage, ledger: JettonLedger, amm: PoolAmm, admitted: bool = false) {
    val entry = amm.bins.get(root.activeBin);
    var healthy = false;
    if ((admitted || pool_ready(root, ledger)) && (root.flags & 2) == 0 && entry.isFound) {
        val b = entry.loadValue();
        healthy = b.pq > 0 && b.t >= ORACLE_MIN_SIDE_T3 && mulDivFloor(b.x, 1 << 64, b.pq) >= ORACLE_MIN_SIDE_T3;
    }
    root.oracle = ring_touch(root.oracle, blockchain.now(), root.activeBin, healthy);
}
fun pool_store_book(mutate root: PoolStorage, ledger: JettonLedger, mutate cold: PoolCold, book: BookState) {
    root.activeBin = book.activeBin; root.binCount = book.binCount; root.positionCount = book.positionCount;
    root.protocolFeesT3 = book.protocolFeesT3; root.amm = book.amm.toCell(); cold.positions = book.positions;
    root.cold = cold.toCell(); pool_touch(mutate root, ledger, book.amm); contract.setData(root.toCell());
}
fun pool_event(kind: int, a: coins, b: coins) {
    createExternalLogMessage({ dest: createAddressNone(), body: PoolEvent { kind, a, b } }).send(SEND_MODE_IGNORE_ERRORS);
}
fun pool_excess(to: address, queryId: uint64, value: coins, keep: coins) {
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + keep, RESERVE_MODE_AT_MOST);
    createMessage({ bounce: BounceMode.NoBounce, dest: to, value: 0, body: beginCell().storeUint(OP_TEP74_EXCESSES, 32).storeUint(queryId, 64).endCell() })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// Plain messages may bounce. Their assertions are isolated from credited notifications and bounces.
fun pool_admin(sender: address, value: coins, body: slice) {
    var root = PoolStorage.fromCell(contract.getData());
    var jet = root.jet.load(); val cold = root.cold.load();
    val op = body.preloadUint(32);
    if (op == OP_LIQ_REMOVE || op == OP_LIQ_EVICT) { pool_remove(sender, value, body, op == OP_LIQ_EVICT); return; }
    if (op == OP_FARM_ACTION) { pool_farm_action(sender, value, body); return; }
    if (op == OP_SWEEP_ALLOW) {
        val req = SweepAllow.fromSlice(body);
        assert (sender == cold.factory && value >= calculateGasFee(BASECHAIN, POOL_ADMIN_GAS_MAX) + swap_log_fee()) throw ERR_POOL;
        jet.sweeps.allow(jet.ledger, req.slot, req.amount);
        root.jet = jet.toCell(); contract.setData(root.toCell()); return;
    }
    if (op == OP_SWEEP_PROBE) {
        val req = SweepProbe.fromSlice(body);
        assert (sender.getWorkchain() == BASECHAIN) throw ERR_POOL;
        jet.sweeps.probe(jet.ledger, req.slot, get_jetton_liabilities(req.slot), sender, value, POOL_BOUNCE_GAS,
            req.slot == 0 && jet.recovery != null ? JettonReconciliation { handled: jet.recovery!.load().handled,restored: jet.recovery!.load().restored }.toCell() : null);
        root.jet = jet.toCell(); contract.setData(root.toCell()); return;
    }
    if (op == OP_POOL_FEE_SWEEP) {
        val req = PoolFeeSweep.fromSlice(body);
        assert (root.protocolFeesT3 >= SWEEP_MIN && jet.ledger.canPay(cold.feeSink)
            && sender.getWorkchain() == BASECHAIN && value >= get_min_forward(op, 0)) throw ERR_POOL;
        val amount = root.protocolFeesT3; root.protocolFeesT3 = 0; pool_dispatch(mutate root,mutate jet,0,amount); contract.setData(root.toCell());
        pool_event(4, amount, 0);
        reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + pool_keep(root, value), RESERVE_MODE_AT_MOST);
        jet.ledger.sendTransfer(0, { queryId: req.queryId, amount, destination: cold.feeSink, excessTo: sender,
            forwardGram: jetton_notify_value(), forwardPayload: PoolPayout { kind: 5, queryId: req.queryId, reason: 0 }.toCell() },
            0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    if (op == OP_POOL_INIT) {
        val req = PoolInit.fromSlice(body);
        assert (sender == cold.factory && (req.notifyTo == null || req.notifyTo!.getWorkchain() == BASECHAIN)) throw ERR_POOL;
        if ((root.flags & 1) == 0) {
            assert (value >= pool_init_value(jet.ledger.slots.mustGet(1, ERR_POOL).walletGram)) throw ERR_POOL;
            root.flags |= 1; contract.setData(root.toCell());
            reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + pool_init_balance()
                + jetton_discover_value(jet.ledger.slots.mustGet(1, ERR_POOL).walletGram) + pool_register_value(), RESERVE_MODE_AT_MOST);
            jet.ledger.discover();
        } else if (!pool_ready(root, jet.ledger)) {
            if (value >= jet.ledger.minDiscover()) {
                reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0), RESERVE_MODE_AT_MOST); jet.ledger.discover();
            }
        } else if (req.notifyTo != null) {
            assert (value >= pool_register_value() + calculateGasFee(BASECHAIN, POOL_INIT_GAS)) throw ERR_POOL;
            reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0), RESERVE_MODE_AT_MOST);
            createMessage({ bounce: BounceMode.NoBounce, dest: cold.factory, value: 0,
                body: PoolReady { id: pool_identity(root, jet.ledger).toCell(), notifyTo: req.notifyTo } })
                .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
        return;
    }
    if (op == OP_DISCOVER_WALLETS) {
        if ((root.flags & 1) == 0) { return; }
        val req = DiscoverWallets.fromSlice(body);
        assert (value >= jet.ledger.minDiscover()) throw ERR_POOL;
        reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0), RESERVE_MODE_AT_MOST);
        jet.ledger.discover(); return;
    }
    if (op == OP_POOL_PAUSE) {
        val req = PoolPause.fromSlice(body);
        assert (sender == cold.factory && value >= calculateGasFee(BASECHAIN, POOL_ADMIN_GAS_MAX) + swap_log_fee()) throw ERR_POOL;
        root.flags = req.paused ? root.flags | 2 : root.flags & ~2;
        pool_touch(mutate root, jet.ledger, root.amm.load()); contract.setData(root.toCell());
        pool_event(2, req.paused ? 1 : 0, 0); return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val req = ClaimArchived.fromSlice(body);
        jet.ledger.claimArchived(req, sender, value, false, POOL_BOUNCE_GAS, pool_keep(root, value));
        pool_dispatch(mutate root,mutate jet,req.slot,req.amount);
        root.jet = jet.toCell(); contract.setData(root.toCell()); return;
    }
    if (op == OP_CLAIM_OWED) {
        val req = ClaimOwed.fromSlice(body);
        val amount = jet.ledger.owedOf(req.slot,req.owner);
        jet.ledger.claim(req.slot, req.owner, req.queryId, sender, value, false, POOL_BOUNCE_GAS, pool_keep(root, value));
        pool_dispatch(mutate root,mutate jet,req.slot,amount);
        root.jet = jet.toCell(); contract.setData(root.toCell()); return;
    }
    throw ERR_POOL;
}

fun pool_take(sender: address, body: slice) {
    var root = PoolStorage.fromCell(contract.getData());
    if ((root.flags & 1) == 0) { return; }
    var jet = root.jet.load(); val cold = root.cold.load();
    val take = jet.ledger.checkTake(sender, body);
    if (take == null || take.wallet == cold.factory || take.wallet == cold.feeSink || take.wallet == cold.treasury) { return; }
    jet.ledger.commitTake(take); root.jet = jet.toCell();
    if (take.idx == 0) {
        contract.setData(root.toCell());
        val x = jet.ledger.slots.mustGet(1, ERR_POOL);
        // The first creation funds this one automatic continuation across the discovery round trips.
        createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: x.master, value: jetton_discover_value(x.walletGram),
            body: tep89_provide_body(1, contract.getAddress()) }).send(SEND_MODE_REGULAR);
    } else {
        pool_touch(mutate root, jet.ledger, root.amm.load()); contract.setData(root.toCell()); pool_event(1, 0, 0);
        createMessage({ bounce: BounceMode.NoBounce, dest: cold.factory, value: pool_register_value(),
            body: PoolReady { id: pool_identity(root, jet.ledger).toCell(), notifyTo: null } })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
}

fun pool_swap_event(root: PoolStorage, c: JettonCredit, status: int, reason: int, amountOut: coins,
    grossFee: coins, protocolFee: coins, loaded: int) {
    createExternalLogMessage({ dest: createAddressNone(), body: SwapEvent { queryId: c.queryId, origin: c.from,
        inSide: c.slot, status, reason, amountIn: c.amount, amountOut, grossFeeT3: grossFee,
        protocolFeeT3: protocolFee, activeBin: root.activeBin, binsLoaded: loaded } }).send(SEND_MODE_IGNORE_ERRORS);
}
@inline
fun pool_swap_outcome(c: JettonCredit, status: int, reason: int, amountOut: coins) {
    createMessage({ bounce: BounceMode.NoBounce, dest: c.from, value: swap_notify_value(),
        body: SwapOutcome { queryId: c.queryId, status, reason, inSide: c.slot, amountIn: c.amount, amountOut } })
        .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
}
fun pool_liq_results(req: LiqAdd, changes: map<int32, LiquidityChange>): cell {
    var ids: array<int> = []; var next = req.rows;
    repeat (req.count) {
        val row = LiqAddRow.fromCell(next); ids.push(row.binId);
        if (row.next != null) { next = row.next!; }
    }
    var tail: cell? = null; var i = req.count;
    while (i > 0) {
        i -= 1; val binId = ids.get(i); val change = changes.get(binId);
        tail = LiqResultRow { binId, shares: change.isFound ? change.loadValue().shares : 0, next: tail }.toCell();
    }
    return tail!;
}
fun pool_liq_outcome(c: JettonCredit, req: LiqAdd, status: int, reason: int, changes: map<int32, LiquidityChange>) {
    createMessage({ bounce: BounceMode.NoBounce, dest: c.from, value: swap_notify_value(),
        body: LiqOutcome { queryId: c.queryId, status, reason, side: c.slot, count: req.count,
            amount: c.amount, rows: pool_liq_results(req, changes) } }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
}
fun pool_liq_events(root: PoolStorage, owner: address, queryId: uint64, kind: int, changes: map<int32, LiquidityChange>) {
    var it = changes.findFirst();
    while (it.isFound) {
        val row = it.loadValue();
        createExternalLogMessage({ dest: createAddressNone(), body: LiqEvent { kind, queryId, owner, binId: it.getKey(),
            shares: row.shares, amounts: PoolAmounts { amountT3: row.amountT3, amountX: row.amountX }.toCell(),
            activeBin: root.activeBin } }).send(SEND_MODE_IGNORE_ERRORS);
        it = changes.findKeyGreater(it.getKey());
    }
}

fun pool_refuse(mutate root: PoolStorage, mutate jet: PoolJet, c: JettonCredit, value: coins, reason: int,
    to: address, forwardGram: coins, notified: bool, add: LiqAdd?, farm: bool) {
    var notify = notified;
    val payload: cell = add != null || farm ? PoolPayout { kind: farm ? 6 : 1, queryId: c.queryId, reason }.toCell()
        : SwapResult { queryId: c.queryId, origin: c.from, status: SWAP_REFUND, reason,
            amountIn: c.amount, amountOut: 0, user: null }.toCell();
    val aux = add != null ? pool_liq_aux_value(add.count) : swap_aux_value();
    var refund = JettonRefund { forwardGram, payload, payloadBits: add != null || farm ? 112 : 628, payloadCells: 1,
        plain: !(notify && forwardGram > 0), keep: 0, spent: swap_log_fee() + (notify ? aux : 0 as coins),
        bounceGas: POOL_BOUNCE_GAS, tailGas: POOL_REFUND_SEND_TAIL_GAS, owedCap: 0 };
    var plan = jet.ledger.refundPlan(c, to, value, refund);
    if (plan.result == 0 && notify) {
        notify = false; refund.spent = swap_log_fee(); refund.plain = true;
        plan = jet.ledger.refundPlan(c, to, value, refund);
    }
    if (plan.result == 0) {
        // A transfer never visits the address trie. Reserve its small tail first; only a
        // durable debt needs the worst direct/archive mutation tail.
        refund.tailGas = POOL_REFUND_TAIL_GAS; refund.owedCap = POOL_OWED_CAP;
        plan = jet.ledger.refundPlan(c, to, value, refund);
    }
    assert (plan.result != 0) throw ERR_POOL;
    if (add == null && !farm) {
        pool_swap_event(root, c, plan.result == 3 ? SWAP_INPUT_OWED : plan.result == 2 ? SWAP_REFUND_PLAIN : SWAP_REFUND,
            reason, 0, 0, 0, 0);
    }
    if (notify) {
        if (add != null) { pool_liq_outcome(c, add, plan.result == 3 ? 2 : 1, reason, []); }
        else { pool_swap_outcome(c, plan.result == 3 ? SWAP_INPUT_OWED : SWAP_REFUND, reason, 0); }
    }
    jet.ledger.refundApply(c, plan, value, refund, reason);
    if (plan.result == 1 || plan.result == 2) { pool_dispatch(mutate root,mutate jet,c.slot,c.amount); }
    if (plan.result == 3) { root.jet = jet.toCell(); }
    contract.setData(root.toCell());
}

// The getter and handler share every check and plan. Only the consumed-gas source differs.
fun pool_swap_plan(root: PoolStorage, ledger: JettonLedger, side: int, amount: coins, req: Swap,
    value: coins, tip: coins, simulation: bool): (int, SwapPlan) {
    val amm = root.amm.load();
    var plan = SwapPlan { status: 0, amountOut: 0, grossFeeT3: 0, protocolFeeT3: 0,
        lastBin: root.activeBin, loaded: 0, amm };
    // Live X credit already authenticated X's wallet and required T3 readiness.
    // A T3 credit or getter still needs the optional X discovery check.
    if ((root.flags & 1) == 0 || ((simulation || side == 0) && ledger.pendingCount() != 0)) { return (SWAP_REASON_NOT_READY, plan); }
    if ((root.flags & 2) != 0) { return (SWAP_REASON_PAUSED, plan); }
    if (blockchain.now() > req.deadline) { return (SWAP_REASON_DEADLINE, plan); }
    if (!ledger.canPayPair(req.recipient, req.refundTo)) { return (SWAP_REASON_ADDRESS, plan); }
    var bits = 0; var cells = 0;
    if (req.fwdPayload != null) {
        val (c, b, _, fits) = req.fwdPayload!.calculateSize(8);
        if (!fits) { return (SWAP_REASON_PAYLOAD_SIZE, plan); }
        cells = c!; bits = b!;
        if (side != 1) {
            val payload = req.fwdPayload!.beginParse();
            if (payload.remainingBitsCount() >= 32 && payload.preloadUint(32) == OP_ROUTE_CONT) { return (SWAP_REASON_ROUTE, plan); }
        }
        val t3 = ledger.slots.mustGet(0, ERR_POOL);
        if (req.fwdGram < hop2_floor(t3.walletGas, t3.walletGram, t3.budget.load(), 0)) { return (SWAP_REASON_VALUE, plan); }
    }
    val leg = ledger.legValue(1 - side, req.fwdGram, 628 + bits, 1 + cells, POOL_BOUNCE_GAS);
    val refundLeg = ledger.legValue(side, req.refundFwdGram, 628, 1, POOL_BOUNCE_GAS);
    val aux = swap_log_fee() + (req.notifyOrigin ? swap_aux_value() : 0 as coins);
    val outgoing: int = leg + tip;
    // No rebasing is needed when the output leg already bounds the refund.
    val fixed = (outgoing >= refundLeg ? outgoing : max(outgoing, refundLeg - swap_refund_tail_rebate())) + aux;
    if (value < calculateGasFee(BASECHAIN, SWAP_FLOOR_GAS) + outgoing + aux) { return (SWAP_REASON_VALUE, plan); }
    try {
        plan = swap_compute({ activeBin: root.activeBin, binCount: root.binCount, positionCount: root.positionCount,
            protocolFeesT3: root.protocolFeesT3, amm, positions: [] }, side, amount, root.feePips,
            value, fixed, simulation);
    } catch (_) { return (SWAP_REASON_MATH, plan); }
    if (plan.status != 0) { return (plan.status, plan); }
    if (plan.amountOut < req.minOut) { return (SWAP_REASON_SLIPPAGE, plan); }
    val used = simulation ? min(SWAP_GAS_MAX - APPLY_TAIL_GAS_MAX, SWAP_PREWALK_GAS_MAX + plan.loaded * STEP_GAS_MAX)
        : getGasConsumedAtTheMoment();
    if (value < calculateGasFee(BASECHAIN, used + APPLY_TAIL_GAS_MAX) + outgoing + aux) { return (SWAP_REASON_VALUE, plan); }
    return (0, plan);
}
fun pool_swap(mutate root: PoolStorage, mutate jet: PoolJet, c: JettonCredit, value: coins, req: Swap) {
    val tip = pool_keep(root, value);
    val (reason, plan) = pool_swap_plan(root, jet.ledger, c.slot, c.amount, req, value, tip, false);
    if (reason != 0) {
        pool_refuse(mutate root, mutate jet, c, value, reason, req.refundTo, req.refundFwdGram, req.notifyOrigin, null, false); return;
    }
    pool_dispatch(mutate root,mutate jet,1 - c.slot,plan.amountOut);
    root.amm = plan.amm.toCell(); root.activeBin = plan.lastBin; root.protocolFeesT3 += plan.protocolFeeT3;
    // The successful plan already authenticated readiness in this transaction.
    pool_touch(mutate root, jet.ledger, plan.amm,true); contract.setData(root.toCell());
    pool_swap_event(root, c, SWAP_EXECUTED, 0, plan.amountOut, plan.grossFeeT3, plan.protocolFeeT3, plan.loaded);
    if (req.notifyOrigin) { pool_swap_outcome(c, SWAP_EXECUTED, 0, plan.amountOut); }
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + tip, RESERVE_MODE_AT_MOST);
    jet.ledger.sendTransfer(1 - c.slot, { queryId: c.queryId, amount: plan.amountOut, destination: req.recipient,
        excessTo: req.refundTo, forwardGram: req.fwdGram, forwardPayload: SwapResult { queryId: c.queryId,
            origin: c.from, status: SWAP_EXECUTED, reason: 0, amountIn: c.amount, amountOut: plan.amountOut, user: req.fwdPayload }.toCell() },
        0, SEND_MODE_CARRY_ALL_BALANCE);
}
fun pool_add(mutate root: PoolStorage, mutate jet: PoolJet, c: JettonCredit, value: coins, req: LiqAdd) {
    var reason = !pool_ready(root, jet.ledger) ? SWAP_REASON_NOT_READY : (root.flags & 2) != 0 ? SWAP_REASON_PAUSED
        : !jet.ledger.canPay(req.owner) ? SWAP_REASON_ADDRESS : 0;
    var cold = root.cold.load(); val farm = cold.farming.load();
    var plan = pool_liquidity_plan(pool_book_state(root, root.amm.load(), cold));
    val tip = pool_keep(root, value);
    // The final check prices actual entry rent and the remaining apply work. Only
    // reserve compute here; refusal prices its own wallet leg if it is reached.
    if (reason == 0 && value < calculateGasFee(BASECHAIN, ADD_GAS_MAX + POOL_REFUND_TAIL_GAS)) { reason = SWAP_REASON_VALUE; }
    if (reason == 0) {
        try { plan = add_compute(plan.state, c.slot, req.owner, req.count, req.rows,
            root.binSpacing, root.xDecimals, root.feePips, farm.campaigns);
        } catch (_) { reason = SWAP_REASON_MATH; }
        if (reason == 0) { reason = plan.status; }
    }
    if (reason == 0 && value < calculateGasFee(BASECHAIN, getGasConsumedAtTheMoment() + ADD_TAIL_GAS_MAX)
        + plan.entryFee + tip + req.count * pool_liq_log_fee() + (req.notify ? pool_liq_aux_value(req.count) : 0 as coins)) { reason = SWAP_REASON_VALUE; }
    if (reason != 0) {
        pool_refuse(mutate root, mutate jet, c, value, reason, c.from, swap_notify_value(), req.notify, req, false); return;
    }
    pool_store_book(mutate root, jet.ledger, mutate cold, plan.state);
    pool_liq_events(root, req.owner, c.queryId, 1, plan.changes);
    if (req.notify) { pool_liq_outcome(c, req, 0, 0, plan.changes); }
    pool_excess(c.from, c.queryId, value, tip + plan.entryFee);
}
fun pool_farm_event(kind: int, queryId: uint64, farmId: uint64, owner: address, amount: coins, weight: int) {
    createExternalLogMessage({ dest: createAddressNone(), body: FarmEvent { kind, queryId, farmId, owner, amount, weight } })
        .send(SEND_MODE_IGNORE_ERRORS);
}
fun pool_fund_farm(mutate root: PoolStorage, mutate jet: PoolJet, c: JettonCredit, value: coins, req: FarmCreate) {
    var reason = !pool_ready(root, jet.ledger) ? SWAP_REASON_NOT_READY : (root.flags & 2) != 0 ? SWAP_REASON_PAUSED : 0;
    var cold = root.cold.load(); var farm = cold.farming.load();
    val bin = root.amm.load().bins.get(req.binId);
    if (reason == 0 && (req.duration < 3600 || req.duration > 7776000 || blockchain.now() > 4294967295 - req.duration)) { reason = SWAP_REASON_DEADLINE; }
    if (reason == 0 && (!bin.isFound || bin.loadValue().shares == 0)) { reason = SWAP_REASON_BIN; }
    if (reason == 0 && !jet.ledger.canPay(c.from)) { reason = SWAP_REASON_ADDRESS; }
    if (reason == 0 && (root.campaignCount >= MAX_CAMPAIGNS || farm.nextId == 18446744073709551615)) { reason = SWAP_REASON_CAPACITY; }
    if (reason == 0 && (c.amount == 0 || (c.slot == 0 ? farm.escrowT : farm.escrowX) > POOL_MAX_COINS - c.amount)) { reason = SWAP_REASON_MATH; }
    val fee = pool_entry_fee(root.campaignCount, MAX_CAMPAIGNS, 768);
    val tip = pool_keep(root, value);
    if (reason == 0 && value < calculateGasFee(BASECHAIN, FARM_GAS_MAX) + fee + tip + swap_log_fee()) { reason = SWAP_REASON_VALUE; }
    if (reason != 0) {
        pool_refuse(mutate root, mutate jet, c, value, reason, c.from, swap_notify_value(), false, null, true); return;
    }
    val id = farm.nextId; farm.nextId += 1;
    val terms = PoolCampaignTerms { binId: req.binId, side: c.slot, sponsor: c.from, total: c.amount, start: blockchain.now(), duration: req.duration };
    farm.campaigns.set(id, { end: blockchain.now() + req.duration, lastTs: blockchain.now(), acc: 0, weight: 0, paid: 0, terms: terms.toCell() });
    if (c.slot == 0) { farm.escrowT += c.amount; } else { farm.escrowX += c.amount; }
    root.campaignCount += 1; cold.farming = farm.toCell(); root.cold = cold.toCell(); contract.setData(root.toCell());
    pool_farm_event(1, c.queryId, id, c.from, c.amount, 0); pool_excess(c.from, c.queryId, value, tip + fee);
}
fun pool_remove(sender: address, value: coins, body: slice, evict: bool) {
    var root = PoolStorage.fromCell(contract.getData()); var jet = root.jet.load(); var cold = root.cold.load();
    assert (sender.getWorkchain() == BASECHAIN && value >= get_min_forward(evict ? OP_LIQ_EVICT : OP_LIQ_REMOVE, 0)) throw ERR_POOL;
    var owner = sender; var recipient = sender; var queryId: uint64 = 0; var count = 1;
    var rows = createEmptyCell(); var minT: coins = 0; var minX: coins = 0;
    if (evict) {
        val req = LiqEvict.fromSlice(body); owner = req.owner; recipient = owner; queryId = req.queryId;
        rows = LiqRemoveRow { binId: req.binId, shares: 0, next: null }.toCell();
    } else {
        val req = pool_remove_try_parse(body); assert (req != null && blockchain.now() <= req!.deadline) throw ERR_POOL;
        recipient = req!.recipient; queryId = req!.queryId; count = req!.count; rows = req!.rows; minT = req!.minT3; minX = req!.minX;
    }
    assert (jet.ledger.canPay(recipient)) throw ERR_POOL;
    val plan = remove_compute(pool_book_state(root, root.amm.load(), cold), owner, count, rows, minT, minX,
        root.binSpacing, root.xDecimals, cold.farming.load().campaigns, evict);
    assert (plan.status == 0) throw ERR_POOL;
    pool_dispatch(mutate root,mutate jet,0,plan.amountT3);
    root.jet = jet.toCell();
    val tip = pool_keep(root, value);
    pool_store_book(mutate root, jet.ledger, mutate cold, plan.state);
    pool_liq_events(root, owner, queryId, evict ? 3 : 2, plan.changes);
    val excessTo = evict ? sender : recipient;
    val payload = PoolPayout { kind: evict ? 7 : 2, queryId, reason: 0 }.toCell();
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + tip, RESERVE_MODE_AT_MOST);
    if (plan.amountT3 > 0 && plan.amountX > 0) {
        jet.ledger.sendTransfer(0, { queryId, amount: plan.amountT3, destination: recipient, excessTo, forwardGram: 0, forwardPayload: payload },
            jet.ledger.legValue(0, 0, 112, 1, POOL_BOUNCE_GAS), SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
    if (plan.amountT3 > 0 || plan.amountX > 0) {
        jet.ledger.sendTransfer(plan.amountX > 0 ? 1 : 0,
            { queryId, amount: plan.amountX > 0 ? plan.amountX : plan.amountT3, destination: recipient, excessTo, forwardGram: 0, forwardPayload: payload },
            0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
    if (plan.amountT3 == 0 && plan.amountX == 0) { pool_excess(excessTo, queryId, value, tip); }
}
fun pool_farm_action(sender: address, value: coins, body: slice) {
    val req = FarmAction.fromSlice(body);
    assert (sender.getWorkchain() == BASECHAIN && req.action >= 1 && req.action <= 5) throw ERR_POOL;
    var root = PoolStorage.fromCell(contract.getData()); var jet = root.jet.load(); var cold = root.cold.load(); var farm = cold.farming.load();
    assert (value >= get_min_forward(OP_FARM_ACTION, 0)) throw ERR_POOL;
    val found = farm.campaigns.get(req.farmId); assert (found.isFound) throw ERR_POOL;
    var campaign = found.loadValue(); val terms = campaign.terms.load();
    campaign = pool_farm_update(campaign, terms, blockchain.now());
    var payout: coins = 0; var recipient = req.owner; var payoutKind = 3; var eventKind = req.action + 1;
    if (req.action == 4) {
        assert (sender == terms.sponsor) throw ERR_POOL;
        campaign.end = min(campaign.end, blockchain.now());
    } else if (req.action == 5) {
        assert (blockchain.now() >= campaign.end && (campaign.weight == 0 || blockchain.now() >= campaign.end + FARM_CLAIM_WINDOW)) throw ERR_POOL;
        payout = terms.total - campaign.paid; recipient = terms.sponsor; payoutKind = 4;
        farm.campaigns.delete(req.farmId); root.campaignCount -= 1;
    } else {
        var owned = pool_positions_owner(cold.positions, req.owner);
        val pf = owned.position(terms.binId); val bf = root.amm.load().bins.get(terms.binId);
        assert (pf != null && bf.isFound) throw ERR_POOL;
        var pos = pf!; val bin = bf.loadValue(); val weight = pool_farm_weight(pos, bin);
        if (req.action == 1) {
            assert (sender == req.owner && (root.flags & 2) == 0 && blockchain.now() < campaign.end
                && (pos.farmId == 0 || !farm.campaigns.exists(pos.farmId)) && weight > 0
                && weight <= POOL_FARM_MAX_WEIGHT - campaign.weight) throw ERR_POOL;
            val book = pool_book_state(root, root.amm.load(), cold);
            assert (pool_position_value(pos.shares, bin, pool_pointer_price(book, root.binSpacing, root.xDecimals))
                >= (MIN_ADD_VALUE << pool_crowding(root.binCount, root.positionCount))) throw ERR_POOL;
            pos.farmId = req.farmId; pos.accSnap = campaign.acc; pos.rewardCarry = null; campaign.weight += weight;
        } else {
            assert (pos.farmId == req.farmId && (req.action != 2 || sender == req.owner)) throw ERR_POOL;
            payout = pool_farm_claim(mutate pos, bin, campaign);
            if (req.action == 2 || blockchain.now() >= campaign.end) {
                campaign.weight -= weight; pos.farmId = 0; pos.rewardCarry = null;
            }
        }
        owned.put(terms.binId, pos);
        pool_positions_store(mutate cold.positions, req.owner, owned);
    }
    if (payout > 0) {
        assert (jet.ledger.canPay(recipient)) throw ERR_POOL;
        pool_dispatch(mutate root,mutate jet,terms.side,payout);
        root.jet = jet.toCell();
        if (terms.side == 0) { farm.escrowT -= payout; } else { farm.escrowX -= payout; }
        campaign.paid += payout;
    }
    if (req.action != 5) { farm.campaigns.set(req.farmId, campaign); }
    cold.farming = farm.toCell(); root.cold = cold.toCell(); contract.setData(root.toCell());
    pool_farm_event(eventKind, req.queryId, req.farmId, recipient, payout, campaign.weight);
    val tip = pool_keep(root, value);
    if (payout == 0) { pool_excess(sender, req.queryId, value, tip); return; }
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + tip, RESERVE_MODE_AT_MOST);
    jet.ledger.sendTransfer(terms.side, { queryId: req.queryId, amount: payout, destination: recipient, excessTo: sender, forwardGram: 0,
        forwardPayload: PoolPayout { kind: payoutKind, queryId: req.queryId, reason: 0 }.toCell() },
        0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun pool_credit(sender: address, value: coins, body: slice) {
    var root = PoolStorage.fromCell(contract.getData());
    assert ((root.flags & 1) != 0) throw ERR_POOL;
    var jet = root.jet.load();
    val swept = JettonSweeps.onNotification(mutate jet.sweeps, jet.ledger, sender, body,jet.recovery != null ? jet.recovery! as cell : null);
    if (swept.dirty) { root.jet = jet.toCell(); }
    if (swept.kind == 2) {
        val paid = jetton_sweep_pay(mutate jet.ledger, swept, root.cold.load().treasury, value, swept.nonce,
            PoolPayout { kind: 8, queryId: swept.nonce, reason: 0 }.toCell());
        if (paid != 0) { pool_dispatch(mutate root,mutate jet,swept.slot,swept.pay); }
        root.jet = jet.toCell(); contract.setData(root.toCell()); return;
    }
    assert (swept.credit != null) throw ERR_POOL;
    if (swept.credit!.claimReceipt) {
        if (swept.dirty) { contract.setData(root.toCell()); }
        return;
    }
    var c = swept.credit!;
    if (c.slot == 0 && jet.recovery != null) {
        var recovery = jet.recovery!.load(); recovery.handled += c.amount;
        jet.recovery = recovery.toCell(); root.jet = jet.toCell();
    }
    if (c.payloadOk) {
        var req = swap_try_parse(c.payload);
        if (req == null && c.slot == 0) {
            val result = swap_result_try_parse(c.payload);
            if (result != null && result.status == SWAP_EXECUTED && result.user != null) {
                val route = route_cont_try_parse(result.user!);
                if (route != null && route.pool == contract.getAddress()) {
                    val (_, _, _, fits) = (route.swap as cell).calculateSize(7);
                    req = fits ? swap_try_parse((route.swap as cell).beginParse()) : null;
                    if (req != null && req.notifyOrigin) { req = null; }
                    // The wrapper supplies attribution and instructions, never a token amount.
                    if (req != null) { c.from = result.origin; }
                }
            }
        }
        if (req != null) { pool_swap(mutate root, mutate jet, c, value, req); return; }
        val add = pool_add_try_parse(c.payload, c.amount);
        if (add != null) { pool_add(mutate root, mutate jet, c, value, add); return; }
        val farm = pool_farm_try_parse(c.payload);
        if (farm != null) { pool_fund_farm(mutate root, mutate jet, c, value, farm); return; }
    }
    val result = c.payloadOk ? swap_result_try_parse(c.payload) : null;
    val to = result != null && result.status == SWAP_EXECUTED ? result.origin : c.from;
    pool_refuse(mutate root, mutate jet, c, value, SWAP_REASON_MALFORMED, to, swap_notify_value(), false, null, false);
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    if (in.body.remainingBitsCount() < 32) { pool_admin(in.senderAddress, in.valueCoins, in.body); return; }
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { pool_credit(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { pool_take(in.senderAddress, in.body); return; }
    if (op == OP_T3_NOTIFICATION_CERTIFICATE || op == OP_T3_FAILURE_CERTIFICATE) { pool_credit_certificate(in.senderAddress,in.valueCoins,in.body); return; }
    if (op == OP_POOL_NOTIFICATION_CLAIM) { pool_credit_claim(in.senderAddress,in.valueCoins,in.body); return; }
    if (op == OP_ORACLE_QUERY) {
        val root = PoolStorage.fromCell(contract.getData());
        oracle_serve(in.senderAddress, in.valueCoins, in.body, root.oracle, pool_ready(root, root.jet.load().ledger), root.binSpacing);
        return;
    }
    pool_admin(in.senderAddress, in.valueCoins, in.body);
}
fun onBouncedMessage(in: InMessageBounced) {
    var root = PoolStorage.fromCell(contract.getData());
    var jet = root.jet.load(); val cold = root.cold.load();
    val swept = JettonSweeps.onBounce(mutate jet.sweeps, jet.ledger, in.senderAddress, in.bouncedBody);
    if (swept.dirty) { root.jet = jet.toCell(); contract.setData(root.toCell()); }
    val bounce = swept.b;
    if (swept.probe) {
        if (swept.dirty) { jetton_bounce_excess(bounce.excessTo, bounce.queryId, in.valueCoins, 0); }
        return;
    }
    if (bounce.kind != 1 || bounce.destination == null || bounce.excessTo == null) { return; }
    // Only the exact fee-sweep receipt restores protocol accounting. Ordinary payouts to
    // the same address keep their own beneficiaries.
    var payoutKind = 0;
    if (bounce.payload != null) {
        var (receipt, exotic) = bounce.payload!.beginParseSpecial();
        if (!exotic && receipt.remainingBitsCount() == 112 && receipt.remainingRefsCount() == 0
            && receipt.loadUint(32) == OP_POOL_PAYOUT) {
            val kind = receipt.loadUint(8);
            if (receipt.loadUint(64) == bounce.queryId && receipt.loadUint(8) == 0) { payoutKind = kind; }
        }
    }
    if (!bounce.claimReceipt && payoutKind == 5 && bounce.slot == 0 && bounce.destination! == cold.feeSink) {
        if (root.protocolFeesT3 <= POOL_MAX_COINS - bounce.amount) {
            root.protocolFeesT3 += bounce.amount; pool_restored(mutate jet,bounce.slot,bounce.amount);
            root.jet = jet.toCell(); contract.setData(root.toCell());
        }
        jetton_bounce_excess(bounce.excessTo, bounce.queryId, in.valueCoins, 0); return;
    }
    var recipient = bounce.destination!;
    if (bounce.payloadTag == OP_SWAP_RESULT && bounce.payload != null) {
        val result = swap_result_try_parse(bounce.payload!.beginParse());
        if (result != null && result.queryId == bounce.queryId && result.status == SWAP_EXECUTED
            && result.amountOut == bounce.amount) {
            if (result.user != null) { recipient = bounce.excessTo!; }
        }
    }
    val restored = jet.ledger.bounceToOwed(bounce, recipient, in.valueCoins, POOL_OWED_CAP);
    if (restored != 0) { pool_restored(mutate jet,bounce.slot,bounce.amount); }
    root.jet = jet.toCell(); contract.setData(root.toCell());
}

get fun get_pool_info(): (cell, address, address, address, address, int, bool, int, coins, coins, coins, int, int, int) {
    val r = PoolStorage.fromCell(contract.getData()); val jet = r.jet.load(); val cold = r.cold.load(); val amm = r.amm.load();
    return (pool_identity(r, jet.ledger).toCell(), cold.factory, cold.feeSink, cold.treasury, jet.ledger.slots.mustGet(0, ERR_POOL).master,
        r.flags, pool_ready(r, jet.ledger), r.activeBin, amm.reserveT, amm.reserveX, r.protocolFeesT3, r.binCount, r.positionCount, r.campaignCount);
}
get fun get_jetton_slots(): map<uint8, JettonSlot> { return PoolStorage.fromCell(contract.getData()).jet.load().ledger.slots; }
get fun get_owed(slot: uint8, owner: address): coins { return PoolStorage.fromCell(contract.getData()).jet.load().ledger.owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = PoolStorage.fromCell(contract.getData()).jet.load().ledger;
    return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_jetton_liabilities(slot: uint8): int {
    assert (slot < 2) throw ERR_POOL;
    val root = PoolStorage.fromCell(contract.getData()); val amm = root.amm.load(); val farm = root.cold.load().farming.load();
    val jet = root.jet.load();
    return jet.ledger.owedTotal(slot) + (slot == 0 ? amm.reserveT + root.protocolFeesT3 + farm.escrowT
        + (jet.recovery != null ? jet.recovery!.load().pending : 0 as coins) : amm.reserveX + farm.escrowX);
}
get fun get_credit_recovery(): Cell<PoolCreditRecovery>? { return PoolStorage.fromCell(contract.getData()).jet.load().recovery; }
get fun get_min_credit_recovery(claim: bool): coins { return pool_recovery_value(PoolStorage.fromCell(contract.getData()).jet.load().ledger,claim); }
get fun get_unattributed_surplus(slot: uint8, observedBalance: coins, observedProtected: uint256?, observedAccepted: uint256?): (int, int, int) {
    var liabilities = get_jetton_liabilities(slot);
    val recovery = PoolStorage.fromCell(contract.getData()).jet.load().recovery;
    if (slot == 0 && recovery != null) {
        val r = recovery!.load();
        assert (observedProtected != null && observedAccepted != null && observedProtected! >= r.handled) throw ERR_POOL;
        liabilities += observedProtected! - r.handled + max(r.dispatched - r.restored - observedAccepted!,0);
    }
    return (liabilities, max(observedBalance - liabilities, 0), max(liabilities - observedBalance, 0));
}
get fun get_sweep(slot: uint8): (int, coins, bool, coins, coins, coins, coins) {
    val s = PoolStorage.fromCell(contract.getData()).jet.load().sweeps.get(slot);
    return (s.seq, s.allowance, s.pending, s.pAmount, s.pBase, s.pAllow, s.pCredits);
}
get fun get_sweep_busy(): int { return PoolStorage.fromCell(contract.getData()).jet.load().sweeps.busy; }
get fun get_min_sweep(slot: uint8): coins {
    return PoolStorage.fromCell(contract.getData()).jet.load().ledger.jetton_min_sweep(slot, POOL_BOUNCE_GAS);
}
get fun get_min_claim(slot: uint8): coins {
    val root = PoolStorage.fromCell(contract.getData());
    return root.jet.load().ledger.jetton_min_claim(slot, POOL_BOUNCE_GAS) + pool_keep(root, 0);
}
get fun get_min_discover(): coins { return PoolStorage.fromCell(contract.getData()).jet.load().ledger.minDiscover(); }
get fun get_rent(): (coins, coins) {
    val root = PoolStorage.fromCell(contract.getData());
    return (pool_rent_target(root.binCount, root.positionCount, root.campaignCount), pool_keep(root, 0));
}
get fun get_swap_min_forward(inSide: int, fwdGram: coins, refundFwdGram: coins, notifyOrigin: bool): coins {
    assert (inSide == 0 || inSide == 1) throw ERR_POOL;
    val root = PoolStorage.fromCell(contract.getData()); val ledger = root.jet.load().ledger;
    val aux = swap_log_fee() + (notifyOrigin ? swap_aux_value() : 0 as coins);
    val out = calculateGasFee(BASECHAIN, SWAP_GAS_MAX)
        + ledger.legValue(1 - inSide, fwdGram, 628 + 8 * 1023, 9, POOL_BOUNCE_GAS) + pool_keep(root, 0);
    val refund = calculateGasFee(BASECHAIN, SWAP_GAS_MAX) - swap_refund_tail_rebate()
        + ledger.legValue(inSide, refundFwdGram, 628, 1, POOL_BOUNCE_GAS);
    return max(out, refund) + aux;
}
get fun get_refund_floors(slot: uint8, refundFwdGram: coins, notifyOrigin: bool): (coins, coins) {
    assert (slot < 2) throw ERR_POOL;
    val ledger = PoolStorage.fromCell(contract.getData()).jet.load().ledger;
    val spent = swap_log_fee() + (notifyOrigin ? swap_aux_value() : 0 as coins);
    val refund = JettonRefund { forwardGram: refundFwdGram, payload: null, payloadBits: 628, payloadCells: 1,
        plain: true, keep: 0, spent, bounceGas: POOL_BOUNCE_GAS, tailGas: POOL_REFUND_SEND_TAIL_GAS, owedCap: 0 };
    return (ledger.refundFloor(slot, refund, POOL_REFUND_SEND_GAS_MAX - POOL_REFUND_SEND_TAIL_GAS), jetton_owed_floor(POOL_REFUND_GAS_MAX, spent));
}
get fun get_route_refund_floor(refundFwdGram: coins): coins {
    val slot = PoolStorage.fromCell(contract.getData()).jet.load().ledger.slots.mustGet(0, ERR_POOL);
    return hop2_floor(slot.walletGas, slot.walletGram, slot.budget.load(), refundFwdGram);
}
get fun get_swap_check(inSide: int, amountIn: coins, swap: cell, value: coins): (int, int, coins) {
    if (inSide < 0 || inSide > 1) { return (1, SWAP_REASON_ADDRESS, 0); }
    val opened = pool_open(swap); val req = opened != null ? swap_try_parse(opened) : null;
    if (req == null) { return (1, SWAP_REASON_MALFORMED, 0); }
    val root = PoolStorage.fromCell(contract.getData());
    val (reason, plan) = pool_swap_plan(root, root.jet.load().ledger, inSide, amountIn, req, value, pool_keep(root, 0), true);
    return (reason == 0 ? 0 : 1, reason, reason == 0 ? plan.amountOut : 0 as coins);
}
get fun get_swap_value(inSide: int, amountIn: coins, swap: cell): (int, int, coins, coins) {
    if (inSide < 0 || inSide > 1) { return (1, SWAP_REASON_ADDRESS, 0, 0); }
    val opened = pool_open(swap); val req = opened != null ? swap_try_parse(opened) : null;
    if (req == null) { return (1, SWAP_REASON_MALFORMED, 0, 0); }
    val root = PoolStorage.fromCell(contract.getData()); val ledger = root.jet.load().ledger;
    val tip = pool_keep(root, 0);
    val ceiling = get_swap_min_forward(inSide, req.fwdGram, req.refundFwdGram, req.notifyOrigin);
    val (reason, plan) = pool_swap_plan(root, ledger, inSide, amountIn, req, ceiling, tip, true);
    if (reason != 0) { return (1, reason, 0, 0); }
    var bits = 0; var cells = 0;
    if (req.fwdPayload != null) {
        val (c, b, _, _) = req.fwdPayload!.calculateSize(8); cells = c!; bits = b!;
    }
    val out: int = ledger.legValue(1 - inSide, req.fwdGram, 628 + bits, 1 + cells, POOL_BOUNCE_GAS) + tip;
    val refund = ledger.legValue(inSide, req.refundFwdGram, 628, 1, POOL_BOUNCE_GAS);
    val fixed = out >= refund ? out : max(out, refund - swap_refund_tail_rebate());
    val gas = min(SWAP_GAS_MAX, SWAP_PREWALK_GAS_MAX + plan.loaded * STEP_GAS_MAX + APPLY_TAIL_GAS_MAX);
    val value = max(calculateGasFee(BASECHAIN, gas) + fixed, calculateGasFee(BASECHAIN, SWAP_FLOOR_GAS) + out)
        + swap_log_fee() + (req.notifyOrigin ? swap_aux_value() : 0 as coins);
    return (0, 0, value, plan.amountOut);
}
get fun get_quote(inSide: int, amountIn: coins): (int, coins, coins, coins, int, int) {
    val root = PoolStorage.fromCell(contract.getData());
    var plan = SwapPlan { status: SWAP_REASON_MATH, amountOut: 0, grossFeeT3: 0, protocolFeeT3: 0,
        lastBin: root.activeBin, loaded: 0, amm: root.amm.load() };
    try {
        plan = swap_compute({ activeBin: root.activeBin, binCount: root.binCount, positionCount: root.positionCount,
            protocolFeesT3: root.protocolFeesT3, amm: plan.amm, positions: [] }, inSide, amountIn, root.feePips, -1, 0, true);
    } catch (_) { plan.status = SWAP_REASON_MATH; }
    return (plan.status, plan.status == 0 ? plan.amountOut : 0 as coins, plan.grossFeeT3, plan.protocolFeeT3, plan.lastBin, plan.loaded);
}
get fun get_min_forward(op: int, slot: uint8): coins {
    val root = PoolStorage.fromCell(contract.getData());
    return pool_min_forward(root, root.jet.load().ledger, pool_keep(root, 0), op, slot);
}
fun pool_min_forward(root: PoolStorage, ledger: JettonLedger, tip: coins, op: int, slot: uint8): coins {
    assert (slot < 2) throw ERR_POOL;
    if (op == OP_LIQ_ADD) {
        val fees = MAX_LIQ_ADD_BINS * (pool_entry_fee(root.binCount + MAX_LIQ_ADD_BINS - 1, MAX_BINS, 32)
            + pool_entry_fee(root.positionCount + MAX_LIQ_ADD_BINS - 1, MAX_POSITIONS, 16));
        val apply = fees + tip + MAX_LIQ_ADD_BINS * pool_liq_log_fee() + pool_liq_aux_value(MAX_LIQ_ADD_BINS);
        val refund = swap_log_fee() + pool_liq_aux_value(MAX_LIQ_ADD_BINS)
            + ledger.legValue(slot, swap_notify_value(), 112, 1, POOL_BOUNCE_GAS);
        return calculateGasFee(BASECHAIN, ADD_GAS_MAX + POOL_REFUND_TAIL_GAS) + max(apply, refund);
    }
    if (op == OP_LIQ_REMOVE || op == OP_LIQ_EVICT) {
        return calculateGasFee(BASECHAIN, REMOVE_GAS_MAX) + tip + MAX_LIQ_REMOVE_BINS * pool_liq_log_fee()
            + ledger.legValue(0, 0, 112, 1, POOL_BOUNCE_GAS) + ledger.legValue(1, 0, 112, 1, POOL_BOUNCE_GAS);
    }
    if (op == OP_FARM_CREATE) {
        return calculateGasFee(BASECHAIN, FARM_GAS_MAX + POOL_REFUND_TAIL_GAS) + swap_log_fee()
            + max(pool_entry_fee(root.campaignCount, MAX_CAMPAIGNS, 768) + tip,
                ledger.legValue(slot, swap_notify_value(), 112, 1, POOL_BOUNCE_GAS));
    }
    if (op == OP_FARM_ACTION) {
        return calculateGasFee(BASECHAIN, FARM_GAS_MAX) + swap_log_fee() + tip
            + max(ledger.legValue(0, 0, 112, 1, POOL_BOUNCE_GAS), ledger.legValue(1, 0, 112, 1, POOL_BOUNCE_GAS));
    }
    assert (op == OP_POOL_FEE_SWEEP) throw ERR_POOL;
    return calculateGasFee(BASECHAIN, POOL_ADMIN_GAS_MAX) + swap_log_fee() + tip
        + ledger.legValue(0, jetton_notify_value(), 112, 1, POOL_BOUNCE_GAS);
}
get fun get_entry_fees(): (coins, coins, coins, coins) {
    val root = PoolStorage.fromCell(contract.getData());
    return (pool_entry_fee(root.binCount, MAX_BINS, 32), pool_entry_fee(root.positionCount, MAX_POSITIONS, 16),
        pool_entry_fee(root.campaignCount, MAX_CAMPAIGNS, 768), MIN_ADD_VALUE << pool_crowding(root.binCount, root.positionCount));
}
get fun get_position(owner: address, binId: int32): (int, int, int, int) {
    val root = PoolStorage.fromCell(contract.getData()); val cold = root.cold.load(); val amm = root.amm.load();
    val minimum = MIN_ADD_VALUE << pool_crowding(root.binCount, root.positionCount);
    val pf = pool_positions_owner(cold.positions, owner).position(binId); val bf = amm.bins.get(binId);
    if (pf == null || !bf.isFound) { return (0, 0, 0, minimum); }
    val pos = pf!;
    return (pos.shares, pos.farmId != 0 && cold.farming.load().campaigns.exists(pos.farmId) ? pos.farmId : 0 as uint64,
        pool_position_value(pos.shares, bf.loadValue(), pool_pointer_price(pool_book_state(root, amm, cold), root.binSpacing, root.xDecimals)), minimum);
}
get fun get_bin(binId: int32): cell? {
    val found = PoolStorage.fromCell(contract.getData()).amm.load().bins.get(binId);
    return found.isFound ? found.loadValue().toCell() as cell : null;
}
get fun get_bins(fromBin: int32, limit: int): map<int32, PoolBin> {
    val bins = PoolStorage.fromCell(contract.getData()).amm.load().bins;
    var rows: map<int32, PoolBin> = []; var it = bins.findKeyGreaterOrEqual(fromBin); var left = min(64, max(0, limit));
    while (it.isFound && left > 0) { rows.set(it.getKey(), it.loadValue()); left -= 1; it = bins.findKeyGreater(it.getKey()); }
    return rows;
}
get fun get_positions(owner: address, fromBin: int32, limit: int): map<int32, PoolPosition> {
    val index = PoolStorage.fromCell(contract.getData()).cold.load().positions;
    val owned = pool_positions_owner(index, owner);
    var positions = owned.more;
    if (owned.first.shares > 0) { positions.set(owned.firstBin, owned.first); }
    var rows: map<int32, PoolPosition> = [];
    var it = positions.findKeyGreaterOrEqual(fromBin); var left = min(64, max(0, limit));
    while (it.isFound && left > 0) {
        rows.set(it.getKey(), it.loadValue()); left -= 1; it = positions.findKeyGreater(it.getKey());
    }
    return rows;
}
get fun get_farm(id: uint64): cell? {
    val found = PoolStorage.fromCell(contract.getData()).cold.load().farming.load().campaigns.get(id);
    return found.isFound ? found.loadValue().toCell() as cell : null;
}
get fun get_farm_pending(id: uint64, owner: address): coins {
    val root = PoolStorage.fromCell(contract.getData()); val cold = root.cold.load();
    val found = cold.farming.load().campaigns.get(id);
    if (!found.isFound) { return 0; }
    val campaign = found.loadValue(); val terms = campaign.terms.load();
    val pf = pool_positions_owner(cold.positions, owner).position(terms.binId); val bf = root.amm.load().bins.get(terms.binId);
    if (pf == null || !bf.isFound || pf!.farmId != id) { return 0; }
    return pool_farm_pending(pf!, bf.loadValue(), pool_farm_update(campaign, terms, blockchain.now()));
}
get fun get_next_farm_id(): int { return PoolStorage.fromCell(contract.getData()).cold.load().farming.load().nextId; }
get fun get_fill_limit(inSide: int): (int, int) {
    assert (inSide == 0 || inSide == 1) throw ERR_POOL;
    val root = PoolStorage.fromCell(contract.getData()); val bins = root.amm.load().bins;
    var k = root.activeBin; var amount = 0; var left = MAX_SWAP_BINS;
    var next = inSide == 0 ? bins.findKeyLessOrEqual(k) : bins.findKeyGreaterOrEqual(k);
    while (left > 0 && next.isFound) {
        k = next.getKey(); val b = next.loadValue();
        if (inSide == 0 ? b.x > 0 : b.t > 0) {
            val capacity = inSide == 0 ? pool_gross_for_net(mulDivCeil(b.x, BOOK_Q64, b.pq), root.feePips)
                : pool_x_capacity(b.t, b.pq, root.feePips);
            amount = min(POOL_MAX_COINS, amount + capacity); left -= 1;
            if (amount == POOL_MAX_COINS) { break; }
        }
        next = inSide == 0 ? bins.findKeyLess(k) : bins.findKeyGreater(k);
    }
    val (status, out, _, _, _, _) = get_quote(inSide, amount);
    return status == 0 ? (amount, out as int) : (0, 0);
}
get fun oracle_evidence(at: int): cell {
    val root = PoolStorage.fromCell(contract.getData());
    return oracle_evidence_cell(root.oracle, pool_ready(root, root.jet.load().ledger), root.binSpacing, blockchain.now(), at);
}
get fun twap_at(t: int, window: int): (bool, int, int, int) {
    val root = PoolStorage.fromCell(contract.getData());
    return oracle_twap_at(root.oracle, root.binSpacing, blockchain.now(), t, window);
}
get fun observation_bounds(): (int, int, int, int, bool) { return oracle_observation_bounds(PoolStorage.fromCell(contract.getData()).oracle); }
get fun get_oracle_min_forward(): coins { return oracle_min_forward(); }

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return PoolStorage.fromCell(contract.getData()).jet.load().ledger.owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return PoolStorage.fromCell(contract.getData()).jet.load().ledger.jetton_min_archive_claim(slot, POOL_BOUNCE_GAS) + pool_keep(PoolStorage.fromCell(contract.getData()), 0); }
