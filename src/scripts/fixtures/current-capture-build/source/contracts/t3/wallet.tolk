tolk 1.5.0

import "@gen/op/tep";
import "../shared/jetton/protected_credit";
import "@gen/op/jetton";

import "@stdlib/exotic-cells";
import "@stdlib/gas-payments";
import "wallet_types";
import "wallet_tree";
import "wallet_budget";
import "recovery_types";
import "../shared/utils/rich_bounce";
import "../shared/jetton/tep74_codec";
import "../generated/op/t3";

fun T3WalletState.check(self,record: WalletRecord): WalletAttempt {
    val a = record.attempt.load();
    assert (!record.cancelled && a.id < self.nextId && a.terms.load().owner == self.config.load().owner) throw 844;
    return a;
}
fun t3_wallet_destination(attempt: Cell<WalletAttempt>, cfg: WalletConfig): address {
    val terms = attempt.load().terms.load();
    return terms.burn ? cfg.master : t3_wallet_init(terms.recipient,cfg.master,cfg.proofCodeHash,contract.getCode()).calculateAddress();
}
fun t3_wallet_dispatch_value(attempt: Cell<WalletAttempt>,cfg: WalletConfig,coldRent: coins): coins {
    val terms = attempt.load().terms.load();
    val body = t3_wallet_attempt_body(attempt);
    if (terms.burn) {
        // Redeem callers additionally fund the hub's exact payout quote.
        val value = calculateGasFee(0,T3_WALLET_GAS) + t3_wallet_bounce_value() + t3_wallet_excess_fee(terms.details.load().queryId,terms.details.load().response) + 1;
        return value + 2 * createMessage({ bounce: BounceMode.RichBounce,dest: cfg.master,value,body: body })
            .estimateFeeWithoutSending(SEND_MODE_REGULAR);
    }
    val value = t3_wallet_receive_value(terms,coldRent);
    return value + 2 * createMessage({ bounce: BounceMode.RichBounce,
        dest: t3_wallet_init(terms.recipient,cfg.master,cfg.proofCodeHash,contract.getCode()),value,body: body })
        .estimateFeeWithoutSending(SEND_MODE_REGULAR);
}
fun T3WalletState.dispatch(self,attempt: Cell<WalletAttempt>,incoming: coins,gasBudget: int) {
    val cfg = self.config.load(); val terms = attempt.load().terms.load();
    val (cells,bits) = t3_wallet_code_size(contract.getCode());
    val topup = t3_wallet_reserve(incoming,t3_wallet_state_rent_for_size(self,cells,bits,false));
    assert (incoming >= topup + calculateGasFee(0,gasBudget) + t3_wallet_dispatch_value(attempt,cfg,t3_wallet_rent_for_size(cells,bits))) throw 848;
    contract.setData(self.toCell());
    val body = t3_wallet_attempt_body(attempt);
    if (terms.burn) {
        createMessage({ bounce: BounceMode.RichBounce,dest: cfg.master,value: 0,body: body })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    } else {
        createMessage({ bounce: BounceMode.RichBounce,dest: t3_wallet_init(terms.recipient,cfg.master,cfg.proofCodeHash,contract.getCode()),value: 0,body: body })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
}
fun t3_wallet_recovery_funding(incoming: coins,st: T3WalletState,queryId: uint64,response: address?,gasBudget: int) {
    val topup = t3_wallet_reserve(incoming,t3_wallet_state_rent(st,contract.getCode(),false));
    assert (incoming >= topup + calculateGasFee(0,gasBudget) + t3_wallet_excess_fee(queryId,response) + 1) throw 848;
}
fun t3_wallet_auth_failure(sender: address,cfg: WalletConfig,proofConfig: Cell<ProofConfig>,proofCode: cell,attempt: Cell<WalletAttempt>) {
    val p = proofConfig.load(); val credit = p.credit.load();
    var ids = credit.identities.beginParse();
    assert (ids.loadAddress() == contract.getAddress() && ids.loadAddress() == cfg.master && ids.loadAddress() == cfg.master) throw 851;
    ids.assertEnd();
    val a = attempt.load(); val terms = a.terms.load(); val d = terms.details.load();
    val dest = t3_wallet_destination(attempt,cfg);
    var wallets = credit.wallets.beginParse();
    assert (wallets.loadAddress() == dest && wallets.loadAddress() == dest && wallets.loadUint(64) == d.queryId
        && wallets.loadCoins() == terms.amount) throw 851;
    wallets.assertEnd();
    assert (credit.codeHash == (terms.burn ? (0 as uint256) : contract.getCode().hash())
        && credit.requestHash == t3_wallet_attempt_body(attempt).hash()) throw 851;
    val targets = p.targets.load();
    assert (targets.source.hash() == targets.target.hash() && targets.source.load().lt > a.originLt) throw 851;
    assert (proofCode.hash() == cfg.proofCodeHash && sender == t3_proof_address(proofConfig,proofCode)) throw 851;
}
fun onBouncedMessage(in: InMessageBounced) {
    if (!rich_bounce_is_canonical(in.bouncedBody)) { return; }
    val rich = RichBounceBody.fromSlice(in.bouncedBody);
    var (s,exotic) = rich.originalBody.beginParseSpecial();
    if (exotic || s.remainingBitsCount() != 32 || s.remainingRefsCount() != 1) { return; }
    val op = s.loadUint(32);
    if (op != OP_T3_WALLET_DELIVERY && op != OP_T3_WALLET_BURN) { return; }
    val attempt = s.loadRef() as Cell<WalletAttempt>; s.assertEnd();
    val terms = attempt.load().terms.load();
    var st = T3WalletState.fromCell(contract.getData()); val cfg = st.config.load();
    assert (terms.owner == cfg.owner && in.senderAddress == t3_wallet_destination(attempt,cfg)
        && (op == OP_T3_WALLET_BURN) == terms.burn) throw 846;
    assert (in.valueCoins >= calculateGasFee(0,T3_WALLET_BOUNCE_GAS)) throw 848;
    setGasLimit(T3_WALLET_BOUNCE_GAS);
    val d = terms.details.load();
    var journal = st.journal.load(); journal.append(WalletEvidence { wallet: contract.getAddress(),attempt }.toCell());
    st.journal = journal.toCell(); t3_wallet_recovery_funding(in.valueCoins,st,d.queryId,d.response,T3_WALLET_BOUNCE_GAS); contract.setData(st.toCell());
    t3_wallet_excess(d.queryId,d.response);
    // Evidence only: an old bounce cannot restore tokens or change a newer attempt.
}
fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { return; }
    var body = in.body; val op = body.loadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    val gasBudget = (op == OP_TEP74_TRANSFER || op == OP_TEP74_BURN) ? T3_WALLET_SEND_GAS
        : (op == OP_T3_WALLET_MINT || op == OP_T3_WALLET_DELIVERY) ? T3_WALLET_RECEIVE_GAS : T3_WALLET_GAS;
    assert (in.valueCoins >= calculateGasFee(0,gasBudget)) throw 848;
    setGasLimit(T3_WALLET_GAS);
    var st = T3WalletState.fromCell(contract.getData()); val cfg = st.config.load();
    if (op == OP_T3_WALLET_MINT) {
        val queryId = body.loadUint(64); val amount = body.loadCoins();
        body.loadRef(); val response = body.loadAddressOpt(); body.assertEnd();
        assert (in.senderAddress == cfg.master && amount > 0) throw 847;
        st.balance += amount; t3_wallet_recovery_funding(in.valueCoins,st,queryId,response,T3_WALLET_RECEIVE_GAS); contract.setData(st.toCell()); t3_wallet_excess(queryId,response); return;
    }
    if (op == OP_T3_WALLET_DELIVERY) {
        val a = (body.loadRef() as Cell<WalletAttempt>).load(); body.assertEnd(); val terms = a.terms.load();
        assert (!terms.burn && terms.recipient == cfg.owner && terms.amount > 0 && in.senderAddress ==
            t3_wallet_init(terms.owner,cfg.master,cfg.proofCodeHash,contract.getCode()).calculateAddress()) throw 847;
        val d = terms.details.load();
        st.balance += terms.amount;
        if (terms.owner != cfg.owner && d.forwardValue > 0 && jetton_protected_payload(d.forwardPayload)) {
            st.protectedCredits += terms.amount;
        }
        val topup = t3_wallet_reserve(in.valueCoins,t3_wallet_state_rent(st,contract.getCode(),false));
        val receiveGas = t3_wallet_receive_gas(d); setGasLimit(receiveGas);
        var needed = calculateGasFee(0,receiveGas) + topup + t3_wallet_excess_fee(d.queryId,d.response) + 1;
        if (d.forwardValue > 0) {
            val notification = createMessage({ bounce: BounceMode.NoBounce,dest: cfg.owner,value: d.forwardValue,body: t3_wallet_notification(terms) });
            needed += d.forwardValue + notification.estimateFeeWithoutSending(SEND_MODE_PAY_FEES_SEPARATELY);
            notification.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }
        assert (in.valueCoins >= needed) throw 848;
        contract.setData(st.toCell()); t3_wallet_excess(d.queryId,d.response); return;
    }
    if (op == OP_TEP74_TRANSFER || op == OP_TEP74_BURN) {
        assert (in.senderAddress == cfg.owner) throw 849;
        val queryId = body.loadUint(64); val amount = body.loadCoins();
        val burn = op == OP_TEP74_BURN;
        val recipient = burn ? cfg.owner : body.loadAddress();
        val response = body.loadAddressOpt(); val customPayload = body.loadMaybeRef();
        val forwardValue = burn ? (0 as coins) : body.loadCoins();
        var forwardPayload = beginCell().storeBool(false).endCell();
        if (burn) { body.assertEnd(); }
        else {
            forwardPayload = body.toCell();
            if (body.loadBool()) { body.loadRef(); body.assertEnd(); }
        }
        assert (recipient.getWorkchain() == 0 && amount > 0 && amount <= st.balance && st.nextId < 18446744073709551616) throw 849;
        if (customPayload != null && jetton_exact_tag(customPayload!,OP_JETTON_SNAPSHOT_REQUEST)) {
            assert (!burn && recipient == cfg.owner && forwardValue > 0
                && forwardPayload.beginParse().remainingBitsCount() == 1 && forwardPayload.beginParse().remainingRefsCount() == 0
                && forwardPayload.beginParse().preloadUint(1) == 0) throw 849;
            forwardPayload = beginCell().storeBool(true).storeRef(JettonSnapshotCredit { protectedCredits: st.protectedCredits,acceptedTransfers:st.acceptedTransfers }.toCell()).endCell();
        }
        val details: WalletDetails = { queryId,response,forwardValue,forwardPayload,customPayload };
        val commandGas = t3_wallet_command_gas(details);
        assert (in.valueCoins >= calculateGasFee(0,commandGas)) throw 848; setGasLimit(commandGas);
        val terms: WalletTerms = { owner: cfg.owner,recipient,burn,amount,details: details.toCell() };
        val a: WalletAttempt = { id: st.nextId as uint64,originLt: blockchain.logicalTime() as uint64,attempt: 0,terms: terms.toCell() };
        val record: WalletRecord = { failed: false,cancelled: false,attempt: a.toCell() };
        st.append(record.toCell()); st.balance -= amount;
        if (!burn && recipient != cfg.owner) { st.acceptedTransfers += amount; } st.dispatch(a.toCell(),in.valueCoins,commandGas); return;
    }
    var proofConfig: Cell<ProofConfig>? = null; var proofCode: cell? = null;
    if (op == OP_T3_FAILURE_CERTIFICATE) {
        proofConfig = body.loadRef() as Cell<ProofConfig>; val payload = body.loadRef(); proofCode = body.loadRef(); body.assertEnd(); body = payload.beginParse();
    } else { assert (op == OP_T3_WALLET_MARK || op == OP_T3_WALLET_RETRY || op == OP_T3_WALLET_CANCEL) throw 845; }
    val recordCell = body.loadRef() as Cell<WalletRecord>; var record = recordCell.load();
    val proof = body.loadRef(); val a = st.check(record); val d = a.terms.load().details.load();
    if (op == OP_T3_WALLET_CANCEL) {
        body.assertEnd(); val terms = a.terms.load();
        assert (record.failed && terms.burn && in.senderAddress == cfg.owner) throw 854;
        record.failed = false; record.cancelled = true;
        st.replace(a.id,leaf(recordCell,3),leaf(record.toCell(),3),proof);
        st.balance += terms.amount; t3_wallet_recovery_funding(in.valueCoins,st,d.queryId,d.response,T3_WALLET_GAS);
        contract.setData(st.toCell()); t3_wallet_excess(d.queryId,d.response); return;
    }
    if (op == OP_T3_WALLET_MARK || op == OP_T3_FAILURE_CERTIFICATE) {
        assert (!record.failed) throw 850;
        if (op == OP_T3_WALLET_MARK) {
            val index = body.loadUint(64); val witness = body.loadRef();
            st.journal.load().verify(index,WalletEvidence { wallet: contract.getAddress(),attempt: record.attempt }.toCell(),witness);
        } else { t3_wallet_auth_failure(in.senderAddress,cfg,proofConfig!,proofCode!,record.attempt); }
        body.assertEnd(); record.failed = true;
        st.replace(a.id,leaf(recordCell,3),leaf(record.toCell(),3),proof);
        t3_wallet_recovery_funding(in.valueCoins,st,d.queryId,d.response,T3_WALLET_GAS);
        contract.setData(st.toCell()); t3_wallet_excess(d.queryId,d.response); return;
    }
    val recipient = body.loadAddress(); body.assertEnd(); var terms = a.terms.load();
    assert (record.failed && a.attempt < 18446744073709551615 && recipient.getWorkchain() == 0) throw 852;
    assert (recipient == terms.recipient || (!terms.burn && in.senderAddress == cfg.owner)) throw 853;
    terms.recipient = recipient;
    val next: WalletAttempt = { id: a.id,originLt: a.originLt,attempt: a.attempt + 1,terms: terms.toCell() };
    record = { failed: false,cancelled: false,attempt: next.toCell() };
    st.replace(a.id,leaf(recordCell,3),leaf(record.toCell(),3),proof); st.dispatch(next.toCell(),in.valueCoins,T3_WALLET_GAS);
}
get fun get_wallet_data(): (coins,address,address,cell) {
    val st = T3WalletState.fromCell(contract.getData()); val cfg = st.config.load();
    return (st.balance,cfg.owner,cfg.master,contract.getCode());
}
get fun recovery_state(): (uint65,uint256,uint64,uint256) {
    val st = T3WalletState.fromCell(contract.getData()); val journal = st.journal.load();
    return (st.nextId,st.root,journal.count,journal.root);
}
get fun recovery_value(): coins {
    val cfg = T3WalletState.fromCell(contract.getData()).config.load();
    return t3_wallet_state_rent(T3WalletState.fromCell(contract.getData()),contract.getCode(),true) + calculateGasFee(0,T3_WALLET_GAS)
        + t3_wallet_excess_fee(0,cfg.owner) + 1;
}
get fun accepted_transfers(): uint256 { return T3WalletState.fromCell(contract.getData()).acceptedTransfers; }
get fun protected_credits(): uint256 { return T3WalletState.fromCell(contract.getData()).protectedCredits; }
get fun outgoing_value(attempt: Cell<WalletAttempt>): coins {
    val st = T3WalletState.fromCell(contract.getData()); val cfg = st.config.load();
    var a = attempt.load(); var terms = a.terms.load(); var d = terms.details.load();
    // A new snapshot command becomes a larger authenticated payload before dispatch.
    if (a.attempt == 0 && d.customPayload != null && jetton_exact_tag(d.customPayload!,OP_JETTON_SNAPSHOT_REQUEST)) {
        assert (!terms.burn && terms.recipient == cfg.owner && d.forwardValue > 0) throw 849;
        d.forwardPayload = beginCell().storeBool(true).storeRef(JettonSnapshotCredit { protectedCredits: st.protectedCredits,acceptedTransfers:st.acceptedTransfers }.toCell()).endCell();
        terms.details = d.toCell(); a.terms = terms.toCell();
    }
    val (cells,bits) = t3_wallet_code_size(contract.getCode());
    return t3_wallet_state_rent_for_size(st,cells,bits,true) + calculateGasFee(0,a.attempt == 0 ? t3_wallet_command_gas(d) : T3_WALLET_GAS)
        + t3_wallet_dispatch_value(a.toCell(),cfg,t3_wallet_rent_for_size(cells,bits));
}
get fun mint_value(queryId: uint64,response: address?): coins {
    val cfg = T3WalletState.fromCell(contract.getData()).config.load();
    return t3_wallet_mint_value(queryId,response,contract.getCode());
}
