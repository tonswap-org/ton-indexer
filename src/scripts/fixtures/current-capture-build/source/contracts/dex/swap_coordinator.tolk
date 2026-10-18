tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments";
import "../shared/utils/error_codes";
import "@gen/op/dex";
import "@gen/op/jetton";
import "@gen/op/t3";
import "../shared/jetton/holder_recovery";
import "../t3/receipt_tree";
import "../t3/recovery_types";
import "../shared/dex/swap_payload";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/jetton_quotes";
import "../shared/jetton/jetton_sweep";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/tep89_codec";

const COORD_OWED_CAP = 256;
const COORD_REFUND_TAIL_GAS = 30000;
const COORD_ALLOW_GAS = 30000;
const ERR_COORD = 3200;

struct CoordinatorLedger { ledger: JettonLedger; recovery: Cell<JettonRecovery>? }
struct CoordinatorState {
    governance: address;
    treasury: address;
    jetton: Cell<CoordinatorLedger>;
    sweeps: Cell<SweepSlot>;
}
struct (0x52544533) RouteEvent {
    queryId: uint64;
    status: uint8;
    reason: uint8;
    amount: coins;
    pool: address?;
    beneficiary: address;
}

fun CoordinatorState.load(): CoordinatorState { return CoordinatorState.fromCell(contract.getData()); }
fun CoordinatorState.save(self) { contract.setData(self.toCell()); }
fun CoordinatorState.managed(self):JettonManagedLedger {
    val fixed=self.jetton.load();var m:JettonManagedLedger={ledger:fixed.ledger,recovery:{slots:[]}};
    if(fixed.recovery!=null){m.recovery.slots.set(0,fixed.recovery!);}return m;
}
fun CoordinatorState.setManaged(mutate self,m:JettonManagedLedger){
    self.jetton=CoordinatorLedger{ledger:m.ledger,recovery:m.recovery.get(0)}.toCell();
}
fun CoordinatorState.ledger(self): JettonLedger { return self.jetton.load().ledger; }
fun CoordinatorState.setLedger(mutate self,ledger:JettonLedger) {
    var managed=self.jetton.load(); managed.ledger=ledger; self.jetton=managed.toCell();
}
// The coordinator has one immutable token. Build the generic adapter only for
// cold policy/proof paths; ordinary routing updates the single fixed sweep row.
fun CoordinatorState.sweepBook(self):JettonSweeps {
    val row=self.sweeps.load();var book:JettonSweeps={busy:row.pending?1:0,slots:[]};
    book.slots.set(0,row);return book;
}
fun CoordinatorState.dispatch(mutate self,slot:uint8,amount:coins) {
    var managed=self.managed(); managed.recovery.dispatch(slot,amount); self.setManaged(managed);
}
fun route_return(to:address,value:coins,keep:coins) {
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+keep,RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({bounce:BounceMode.NoBounce,dest:to,value:0}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

@inline
fun route_event(c: JettonCredit, status: int, reason: int, pool: address?, beneficiary: address) {
    createExternalLogMessage({ dest: createAddressNone(), body: RouteEvent {
        queryId: c.queryId, status: status as uint8, reason: reason as uint8,
        amount: c.amount, pool, beneficiary,
    } }).send(SEND_MODE_IGNORE_ERRORS);
}

// All callers use addresses from the strict basechain swap codecs. The authenticated
// credit already proves the sole immutable T3 slot is ready.
@inline
fun route_payable(a: address, own: address, slot: JettonSlot): bool {
    return a != own && a != slot.master && a != slot.wallet!;
}

@inline
fun route_credit(ledger: JettonLedger, slot: JettonSlot, c: JettonCredit, value: coins): bool {
    if (!c.payloadOk) { return false; }
    val result = swap_result_try_parse(c.payload);
    if (result == null || result.status != SWAP_EXECUTED) { return false; }
    val cont = result.user != null ? route_cont_try_parse(result.user!) : null;
    val request = cont != null ? swap_try_parse(cont.swap.beginParse()) : null;
    var owner = result.origin;
    var reason = SWAP_REASON_MALFORMED;
    var next: address? = null;
    var forward: coins = 0;
    val own = contract.getAddress();
    if (request != null && cont != null) {
        next = cont.pool;
        owner = request.refundTo;
        reason = SWAP_REASON_NONE;
        if (!route_payable(owner, own, slot) || owner == cont.pool) { owner = result.origin; reason = SWAP_REASON_ADDRESS; }
        else if (!route_payable(cont.pool, own, slot) || !route_payable(request.recipient, own, slot)
            || cont.pool == request.recipient) { reason = SWAP_REASON_ADDRESS; }
        else if (blockchain.now() > request.deadline) { reason = SWAP_REASON_DEADLINE; }
        else {
            val (cells, bits, _, fits) = cont.swap.calculateSize(7);
            if (!fits) { reason = SWAP_REASON_PAYLOAD_SIZE; }
            else {
                val budget = slot.budget.load();
                // One geometry bounds both the original inner request and a pool refund.
                val (accepted, refused) = jetton_leg_bounds(slot.walletGas, slot.walletGram, budget, max(bits!,628), max(cells!,1), COORD_BOUNCE_GAS);
                val logFee=swap_log_fee();
                val floor = calculateGasFee(BASECHAIN,POOL_ROUTE_REFUND_SEND_GAS_MAX)+logFee+max(accepted+request.refundFwdGram,refused);
                val ownCost = calculateGasFee(BASECHAIN, ROUTE_GAS_MAX) + logFee;
                if (value < ownCost + max(accepted + floor, refused)) { reason = SWAP_REASON_VALUE; }
                else { forward = value - ownCost - accepted; }
            }
        }
    }
    if (reason == SWAP_REASON_NONE && request != null && cont != null) {
        route_event(c, SWAP_EXECUTED, reason, next, owner);
        reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0), RESERVE_MODE_AT_MOST);
        // Authenticated sole wallet; strict codecs and route_payable above already
        // establish both destinations and exclude this holder, master and wallet.
        jetton_send_raw(slot.wallet!, { queryId: c.queryId, amount: c.amount, destination: cont.pool,
            excessTo: owner, forwardGram: forward, forwardPayload: cont.swap }, 0, SEND_MODE_CARRY_ALL_BALANCE);
        return true;
    }
    if (!route_payable(owner, own, slot)) { return false; }
    val refund = JettonRefund {
        forwardGram: request != null ? request.refundFwdGram : 0,
        payload: SwapResult { queryId: c.queryId, origin: result.origin, status: SWAP_REFUND,
            reason: reason as uint8, amountIn: c.amount, amountOut: 0, user: null }.toCell(),
        payloadBits: 628, payloadCells: 1, plain: true, keep: 0, spent: swap_log_fee(),
        bounceGas: COORD_BOUNCE_GAS, tailGas: COORD_REFUND_TAIL_GAS, owedCap: 0,
    };
    val plan = ledger.refundPlan(c, owner, value, refund);
    if (plan.result == 0) { return false; }
    route_event(c, plan.result == 2 ? SWAP_REFUND_PLAIN : SWAP_REFUND, reason, next, owner);
    // owedCap=0 permits only an immediate requested/plain refund.
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0),RESERVE_MODE_AT_MOST);
    ledger.sendTransfer(0,{queryId:c.queryId,amount:c.amount,destination:plan.dst!,excessTo:plan.dst!,forwardGram:plan.result==1?refund.forwardGram:0,forwardPayload:plan.result==1?refund.payload:null},0,SEND_MODE_CARRY_ALL_BALANCE);
    return true;
}

@inline
fun on_credit_route(sender: address, value: coins, body: slice) {
    var st=lazy CoordinatorState.load();var managed=st.jetton.load();var ledger=managed.ledger;
    val slot=ledger.slots.mustGet(0,ERR_COORD);val state=managed.recovery;
    val c=slot.wallet!=null && sender==slot.wallet!?jetton_parse_notification(0,body):null;
    assert((c!=null && c.amount>0) || state==null) throw ERR_JETTON_RECOVERY;
    if(c==null || c.amount==0){return;}
    if(c.from!=contract.getAddress()){
        var dirty=false;
        var window=lazy st.sweeps.load();
        if(window.pending){
            window.pCredits=min(window.pAllow,window.pCredits+c.amount);
            st.sweeps=window.toCell();dirty=true;
        }
        if(!c.claimReceipt && state!=null){
            var tail=(state! as cell).beginParse();val dispatched=tail.loadUint(256);val handled=tail.loadUint(256);
            managed.recovery=beginCell().storeUint(dispatched+c.amount,256).storeUint(handled+c.amount,256).storeSlice(tail).endCell() as Cell<JettonRecovery>;
            st.jetton=managed.toCell();dirty=true;
        }
        // Any later compute/action failure rolls these fixed counters back.
        if(dirty){st.save();}
        if(!c.claimReceipt){val sent=route_credit(ledger,slot,c,value);assert(sent || state==null) throw ERR_JETTON_RECOVERY;}
        return;
    }
    // Only exact authenticated owner self-transfers can complete a sweep snapshot.
    var sweeps=st.sweepBook();
    val incoming=JettonSweeps.onNotification(mutate sweeps,ledger,sender,body,state!=null?state! as cell:null);
    assert(incoming.kind!=0 || state==null) throw ERR_JETTON_RECOVERY;
    if(incoming.dirty){st.sweeps=sweeps.get(0).toCell();}
    if(incoming.kind==2){
        if(jetton_sweep_pay(mutate ledger,incoming,st.treasury,value,0,null)!=0){st.dispatch(incoming.slot,incoming.pay);}
        st.setLedger(ledger);
    }
    st.save();
}

// Failed delivery never re-executes a delayed trade. Valid routed requests retain
// their chosen refund owner; malformed unsolicited input belongs to its sender.
fun route_recovery_owner(ledger:JettonLedger,c:JettonCredit):address {
    val slot=ledger.slots.mustGet(0,ERR_COORD);val own=contract.getAddress();var owner=c.from;
    val result=c.payloadOk?swap_result_try_parse(c.payload):null;
    if(result!=null && result.status==SWAP_EXECUTED){
        owner=result.origin;
        val cont=result.user!=null?route_cont_try_parse(result.user!):null;
        val request=cont!=null?swap_try_parse(cont.swap.beginParse()):null;
        if(request!=null && route_payable(request.refundTo,own,slot) && request.refundTo!=cont!.pool){owner=request.refundTo;}
    }
    if(!route_payable(owner,own,slot)){owner=c.from;}
    assert(route_payable(owner,own,slot)) throw ERR_COORD;return owner;
}
fun route_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=CoordinatorState.load();var managed=st.managed();
    val e=jetton_recovery_authenticate(managed.ledger,0,sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=managed.recovery.record(e);st.setManaged(managed);st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({bounce:BounceMode.NoBounce,dest:sender,value:0}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun route_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=CoordinatorState.load();var managed=st.managed();val item=managed.recovery.claim(msg.receipt,msg.proof);var ledger=managed.ledger;
    var owner:address;
    if(item.incoming){
        val c=jetton_parse_notification(item.slot,item.body.beginParse());assert(c!=null && c.amount==item.amount && !c.claimReceipt) throw ERR_COORD;
        owner=route_recovery_owner(ledger,c);
    }else{
        val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_COORD;
        owner=command.claimReceipt?command.destination:command.excessTo;
    }
    assert(ledger.canPay(owner)) throw ERR_COORD;
    val (result,keep)=ledger.owedCredit(item.slot,owner,item.amount,1);assert(result!=0) throw ERR_JETTON_RECOVERY;
    jetton_log_owed(item.slot,owner,item.amount,3);
    managed.ledger=ledger;st.setManaged(managed);st.save();route_return(sender,value,keep);
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    assert (in.body.remainingBitsCount() >= 32) throw ERR_COORD;
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit_route(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TEP74_EXCESSES || op == OP_SWAP_OUTCOME) { return; }
    if(op==OP_T3_NOTIFICATION_CERTIFICATE || op==OP_T3_FAILURE_CERTIFICATE){route_recovery_accept(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){route_recovery_claim(in.senderAddress,in.valueCoins,in.body);return;}
    var st = CoordinatorState.load();
    var ledger = st.ledger();
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) {
        val take = ledger.checkTake(in.senderAddress, in.body);
        if (take == null || take.wallet == st.governance || take.wallet == st.treasury) { return; }
        ledger.commitTake(take); st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_DISCOVER_WALLETS) {
        val req = DiscoverWallets.fromSlice(in.body);
        assert (in.valueCoins >= ledger.minDiscover()) throw ERR_COORD;
        reserveGramsOnBalance(max(contract.getOriginalBalance() - in.valueCoins, 0), RESERVE_MODE_AT_MOST);
        ledger.discover(); return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val msg=ClaimArchived.fromSlice(in.body);ledger.claimArchived(msg,in.senderAddress,in.valueCoins,false,COORD_BOUNCE_GAS,0);st.dispatch(msg.slot,msg.amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_CLAIM_OWED) {
        val req = ClaimOwed.fromSlice(in.body);
        val amount=ledger.owedOf(req.slot,req.owner);ledger.claim(req.slot,req.owner,req.queryId,in.senderAddress,in.valueCoins,false,COORD_BOUNCE_GAS,0);st.dispatch(req.slot,amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_SWEEP_ALLOW) {
        val req = SweepAllow.fromSlice(in.body);
        assert (in.senderAddress == st.governance && in.valueCoins>=get_min_allow()) throw ERR_COORD;
        var sweeps = st.sweepBook();
        sweeps.allow(ledger, req.slot, req.amount);
        st.sweeps = sweeps.get(0).toCell(); st.save();route_return(in.senderAddress,in.valueCoins,route_allow_rent());return;
    }
    if (op == OP_SWEEP_PROBE) {
        val req = SweepProbe.fromSlice(in.body);
        var sweeps = st.sweepBook();
        sweeps.probe(ledger,req.slot,get_jetton_liabilities(req.slot),in.senderAddress,in.valueCoins,COORD_BOUNCE_GAS,st.managed().recovery.reconciliation(req.slot));
        st.sweeps = sweeps.get(0).toCell(); st.save(); return;
    }
    throw ERR_COORD;
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = CoordinatorState.load();
    var ledger = st.ledger();
    var sweeps = st.sweepBook();
    val incoming = JettonSweeps.onBounce(mutate sweeps, ledger, in.senderAddress, in.bouncedBody);
    if (incoming.dirty) { st.sweeps = sweeps.get(0).toCell(); }
    if (incoming.probe) { jetton_bounce_excess(incoming.b.excessTo, incoming.b.queryId, in.valueCoins, 0); }
    else if (incoming.b.kind == 1 && incoming.b.excessTo != null) {
        val result=ledger.bounceToOwed(incoming.b,incoming.b.excessTo!,in.valueCoins,COORD_OWED_CAP);
        var managed=st.managed();assert(result!=0 || managed.recovery.get(incoming.b.slot)==null) throw ERR_JETTON_RECOVERY;
        if(result!=0){managed.recovery.restored(incoming.b.slot,incoming.b.amount);}st.setManaged(managed);
        st.setLedger(ledger);
    } else if (!incoming.dirty) { return; }
    st.save();
}

get fun get_coordinator_info(): (address, address, bool) {
    val st = CoordinatorState.load(); return (st.governance, st.treasury, st.ledger().coreReady());
}
get fun get_jetton_slots(): map<uint8, JettonSlot> { return CoordinatorState.load().ledger().slots; }
get fun get_min_discover(): coins { return CoordinatorState.load().ledger().minDiscover(); }
get fun get_route_min_forward(hop2Forward: coins): coins {
    val slot = CoordinatorState.load().ledger().slots.mustGet(0, ERR_COORD);
    val (accepted,refused)=jetton_leg_bounds(slot.walletGas,slot.walletGram,slot.budget.load(),7*1023,7,COORD_BOUNCE_GAS);
    val floor=calculateGasFee(BASECHAIN,POOL_ROUTE_REFUND_SEND_GAS_MAX)+swap_log_fee()+max(accepted,refused);
    return calculateGasFee(BASECHAIN,ROUTE_GAS_MAX)+swap_log_fee()+max(accepted+max(hop2Forward,floor),refused);
}
get fun get_route_refund_floor(): coins {
    val slot = CoordinatorState.load().ledger().slots.mustGet(0, ERR_COORD);
    return route_refund_floor(slot.walletGas, slot.walletGram, slot.budget.load());
}
get fun get_min_claim(slot: uint8): coins { return CoordinatorState.load().ledger().jetton_min_claim(slot, COORD_BOUNCE_GAS); }
get fun get_owed(slot: uint8, owner: address): coins { return CoordinatorState.load().ledger().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = CoordinatorState.load().ledger(); return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_jetton_liabilities(slot:uint8):coins{val m=CoordinatorState.load().managed();return m.ledger.owedTotal(slot)+m.recovery.pending(slot);}
get fun get_unattributed_surplus(slot:uint8,balance:coins,protectedCredits:int?,acceptedTransfers:int?):(int,int,int){
    val owed=get_jetton_liabilities(slot)+CoordinatorState.load().managed().recovery.excluded(slot,protectedCredits,acceptedTransfers);
    return(owed,max(balance-owed,0),max(owed-balance,0));
}
get fun get_sweep(slot: uint8): SweepSlot { assert(slot==0) throw ERR_JETTON_SLOT;return CoordinatorState.load().sweeps.load(); }
get fun get_min_sweep(slot: uint8): coins { return CoordinatorState.load().ledger().jetton_min_sweep(slot, COORD_BOUNCE_GAS); }

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return CoordinatorState.load().ledger().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return CoordinatorState.load().ledger().jetton_min_archive_claim(slot, COORD_BOUNCE_GAS); }

fun route_allow_rent():coins{return calculateStorageFee(0,157680000,2500,4);}
get fun get_min_allow():coins{return calculateGasFee(0,COORD_ALLOW_GAS)+route_allow_rent();}
get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return CoordinatorState.load().managed().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();
    val e=jetton_recovery_authenticate(CoordinatorState.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{return calculateGasFee(0,JETTON_RECEIPT_GAS)+jetton_recovery_rent();}
