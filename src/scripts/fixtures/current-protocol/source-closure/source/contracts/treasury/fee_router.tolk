tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "fee_router_quote"
import "../shared/jetton/holder_recovery"
import "@gen/op/t3"
import "../t3/receipt_tree"
import "../t3/recovery_types"
import "@gen/op/treasury"
import "@gen/op/jetton"

const FR_FLUSH_GAS = 90000
const FR_ADMIN_GAS = 30000
const FR_BOUNCE_GAS = 250000
const FR_GRAM_TARGET = 1000000000
const FR_GRAM_SWEEP_MIN = 100000000

struct FeeRouterPeers { treasury: address; buyback: address; gasVault: address }
struct FeeRouterStorage {
    governance: address
    peers: Cell<FeeRouterPeers>
    jetton: Cell<JettonManagedLedger>
    sweeps: Cell<JettonSweeps>
    balance: coins
    buybackBps: uint16
    totalIn: coins
}
struct (0x4652464c) FeeFlush { queryId: uint64 }
struct (0x46524250) FeeSetBuybackBps { queryId: uint64; bps: uint16 }
fun FeeRouterStorage.load(): FeeRouterStorage { return FeeRouterStorage.fromCell(contract.getData()); }
fun FeeRouterStorage.save(self) { contract.setData(self.toCell()); }
fun FeeRouterStorage.liabilities(self, slot: uint8): coins { return (slot == 0 ? self.balance : 0 as coins) + self.ledger().owedTotal(slot) + self.jetton.load().recovery.pending(slot); }
fun FeeRouterStorage.ledger(self): JettonLedger { return self.jetton.load().ledger; }
fun FeeRouterStorage.setLedger(mutate self,ledger: JettonLedger) {
    var managed=self.jetton.load(); managed.ledger=ledger; self.jetton=managed.toCell();
}
fun FeeRouterStorage.dispatch(mutate self,slot:uint8,amount:coins) {
    var managed=self.jetton.load(); managed.recovery.dispatch(slot,amount); self.jetton=managed.toCell();
}
fun fr_apply_credit(mutate st:FeeRouterStorage,amount:coins) {
    st.balance+=amount; st.totalIn=min(JETTON_MAX_COINS,st.totalIn+amount);
}
fun fr_apply_source_failure(mutate st:FeeRouterStorage,mutate ledger:JettonLedger,slot:uint8,command:JettonSourceFailure,value:coins,cap:int):int {
    if (!command.claimReceipt) { st.balance+=command.amount; jetton_bounce_excess(command.excessTo,command.queryId,value,0); return 1; }
    val (result,keep)=ledger.owedCredit(slot,command.destination,command.amount,cap);
    assert(result!=0 || st.jetton.load().recovery.get(slot)==null) throw ERR_JETTON_RECOVERY;
    jetton_log_owed(slot,command.destination,command.amount,result==0?255:3);
    jetton_bounce_excess(command.excessTo,command.queryId,value,keep); return result;
}
fun fr_return(to: address) {
    createMessage({ bounce: BounceMode.NoBounce, dest: to, value: 0 }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun fr_reserve(value: coins, gasVault: address, sweep: bool) {
    val pre = max(contract.getOriginalBalance() - value, 0);
    if (sweep && pre >= FR_GRAM_TARGET + FR_GRAM_SWEEP_MIN) {
        reserveGramsOnBalance(FR_GRAM_TARGET, RESERVE_MODE_EXACT_AMOUNT);
        createMessage({ bounce: BounceMode.NoBounce, dest: gasVault, value: pre - FR_GRAM_TARGET })
            .send(SEND_MODE_IGNORE_ERRORS);
    } else { reserveGramsOnBalance(pre, RESERVE_MODE_EXACT_AMOUNT); }
}
fun fr_min_value(ledger: JettonLedger, op: int): coins {
    if (op == OP_DISCOVER_WALLETS) { return ledger.minDiscover() + calculateForwardFee(BASECHAIN, 1300, 2); }
    if (op == OP_SWEEP_PROBE) { return ledger.jetton_min_sweep(0, FR_BOUNCE_GAS); }
    if (op == OP_FEE_FLUSH) { return calculateGasFee(BASECHAIN, FR_FLUSH_GAS) + 3 * calculateForwardFee(BASECHAIN, 1300, 2)
        + 2 * ledger.legValue(0, jetton_notify_value(), 0, 0, FR_BOUNCE_GAS); }
    return calculateGasFee(BASECHAIN, FR_ADMIN_GAS) + calculateForwardFee(BASECHAIN, 1300, 2);
}
fun on_credit_fee(sender: address, value: coins, body: slice) {
    var st=FeeRouterStorage.load(); var managed=st.jetton.load(); var ledger=managed.ledger; var sweeps=st.sweeps.load();
    val state=managed.recovery.get(0);
    val r=JettonSweeps.onNotification(mutate sweeps,ledger,sender,body,state!=null?state! as cell:null);
    assert(r.kind!=0 || state==null) throw ERR_JETTON_RECOVERY;
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(r.kind==2){if(jetton_sweep_pay(mutate ledger,r,st.peers.load().treasury,value,0,null)!=0){managed.recovery.dispatch(r.slot,r.pay);}}
    else if(r.kind==1){val c=r.credit!; if(!c.claimReceipt){managed.recovery.handled(c.slot,c.amount);} fr_apply_credit(mutate st,c.amount);}
    managed.ledger=ledger; st.jetton=managed.toCell(); st.save();
}
fun onBouncedMessage(in: InMessageBounced) {
    var st=FeeRouterStorage.load(); var ledger=st.ledger(); var sweeps=st.sweeps.load();
    val r=JettonSweeps.onBounce(mutate sweeps,ledger,in.senderAddress,in.bouncedBody);
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(!r.probe && r.b.kind==1){val b=r.b;
        val command:JettonSourceFailure={queryId:b.queryId,amount:b.amount,destination:b.destination!,excessTo:b.excessTo!,claimReceipt:b.claimReceipt,payload:b.payload};
        if(fr_apply_source_failure(mutate st,mutate ledger,b.slot,command,in.valueCoins,JETTON_OWED_CAP)!=0){
            var managed=st.jetton.load();managed.recovery.restored(b.slot,b.amount);st.jetton=managed.toCell();
        }
        st.setLedger(ledger);st.save();return;
    }
    if(r.dirty){st.save();}if(r.probe){jetton_bounce_excess(r.b.excessTo,r.b.queryId,in.valueCoins,0);}
}
fun fr_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=FeeRouterStorage.load();var managed=st.jetton.load();
    val evidence=jetton_recovery_authenticate(managed.ledger,0,sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:evidence.key,payload:evidence.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=managed.recovery.record(evidence);st.jetton=managed.toCell();st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    fr_return(sender);
}
fun fr_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=FeeRouterStorage.load();var managed=st.jetton.load();val item=managed.recovery.claim(msg.receipt,msg.proof);var ledger=managed.ledger;st.jetton=managed.toCell();
    if(item.incoming){fr_apply_credit(mutate st,item.amount);fr_reserve(value,st.peers.load().gasVault,false);fr_return(sender);}
    else{val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_JETTON_RECOVERY;
        assert(fr_apply_source_failure(mutate st,mutate ledger,item.slot,command,value,1)!=0) throw ERR_JETTON_RECOVERY;}
    st.setLedger(ledger);st.save();
}
fun on_take_fee(sender: address, body: slice) {
    var st = FeeRouterStorage.load(); var ledger = st.ledger(); val peers = st.peers.load();
    val take = ledger.checkTake(sender, body);
    if (take == null || take.wallet == st.governance || take.wallet == peers.treasury
        || take.wallet == peers.buyback || take.wallet == peers.gasVault) { return; }
    ledger.commitTake(take); st.setLedger(ledger); st.save();
}
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit_fee(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_T3_NOTIFICATION_CERTIFICATE || op == OP_T3_FAILURE_CERTIFICATE) { fr_recovery_accept(in.senderAddress,in.valueCoins,in.body);return; }
    if (op == OP_JETTON_RECOVERY_CLAIM) { fr_recovery_claim(in.senderAddress,in.valueCoins,in.body);return; }
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { on_take_fee(in.senderAddress, in.body); return; }
    var st = FeeRouterStorage.load(); var ledger = st.ledger(); val peers = st.peers.load();
    assert (in.valueCoins >= fr_min_value(ledger, op)) throw ERR_JETTON_VALUE;
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(in.body); fr_reserve(in.valueCoins, peers.gasVault, false);
        ledger.discover(); fr_return(in.senderAddress); return;
    }
    if (op == OP_FEE_FLUSH) {
        val msg = FeeFlush.fromSlice(in.body);
        assert (ledger.coreReady() && ledger.canPay(peers.treasury) && ledger.canPay(peers.buyback) && st.balance >= 1000000000) throw ERR_JETTON_CONFIG;
        st.dispatch(0,st.balance); val a = st.balance * st.buybackBps / 10000; val b = st.balance - a; st.balance = 0; st.save();
        fr_reserve(in.valueCoins, peers.gasVault, true);
        if (a > 0) { ledger.sendTransfer(0, { queryId: msg.queryId, amount: a, destination: peers.buyback, excessTo: in.senderAddress,
            forwardGram: jetton_notify_value(), forwardPayload: null }, ledger.legValue(0, jetton_notify_value(), 0, 0, FR_BOUNCE_GAS),
            SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL); }
        if (b > 0) { ledger.sendTransfer(0, { queryId: msg.queryId, amount: b, destination: peers.treasury, excessTo: in.senderAddress,
            forwardGram: jetton_notify_value(), forwardPayload: null }, ledger.legValue(0, jetton_notify_value(), 0, 0, FR_BOUNCE_GAS),
            SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL); }
        fr_return(in.senderAddress); return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(in.body); ledger.claimArchived(msg,in.senderAddress,in.valueCoins,false,FR_BOUNCE_GAS,0); st.dispatch(msg.slot,msg.amount);
        st.setLedger(ledger);st.save();return;
    }
    if (op == OP_CLAIM_OWED) {
        val msg = ClaimOwed.fromSlice(in.body); val amount=ledger.owedOf(msg.slot,msg.owner); ledger.claim(msg.slot, msg.owner, msg.queryId, in.senderAddress, in.valueCoins, false, FR_BOUNCE_GAS, 0); st.dispatch(msg.slot,amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_SWEEP_PROBE) {
        val msg = SweepProbe.fromSlice(in.body); var sweeps = st.sweeps.load();
        sweeps.probe(ledger, msg.slot, st.liabilities(msg.slot), in.senderAddress, in.valueCoins, FR_BOUNCE_GAS,st.jetton.load().recovery.reconciliation(msg.slot));
        st.sweeps = sweeps.toCell(); st.save(); return;
    }
    assert (in.senderAddress == st.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
    if (op == OP_FEE_SET_BUYBACK_BPS) { val msg = FeeSetBuybackBps.fromSlice(in.body);
        assert (msg.bps <= 10000) throw ERR_JETTON_CONFIG; st.buybackBps = msg.bps;
    } else if (op == OP_SWEEP_ALLOW) { val msg = SweepAllow.fromSlice(in.body); var sweeps = st.sweeps.load();
        sweeps.allow(ledger, msg.slot, msg.amount); st.sweeps = sweeps.toCell();
    } else { throw ERR_JETTON_CONFIG; }
    st.save(); fr_reserve(in.valueCoins, peers.gasVault, false); fr_return(in.senderAddress);
}
get fun get_fee_router(): (coins, int, coins) { val st = FeeRouterStorage.load(); return (st.balance, st.buybackBps, st.totalIn); }
get fun get_peers(): (address, address, address, address) { val st=FeeRouterStorage.load(); val p=st.peers.load(); return (st.governance,p.treasury,p.buyback,p.gasVault); }
get fun get_jetton_slots(): map<uint8, JettonSlot> { return FeeRouterStorage.load().ledger().slots; }
get fun get_jetton_liabilities(slot: uint8): coins { return FeeRouterStorage.load().liabilities(slot); }
get fun get_unattributed_surplus(slot: uint8, observed: coins, protectedCredits:int?,acceptedTransfers:int?): (int,int,int) { val l = get_jetton_liabilities(slot)+FeeRouterStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers); return (l, max(observed-l,0), max(l-observed,0)); }
get fun get_owed(slot: uint8, owner: address): coins { return FeeRouterStorage.load().ledger().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) { val l = FeeRouterStorage.load().ledger(); return (l.owedTotal(slot),l.owedCount(slot)); }
get fun get_sweep(slot: uint8): SweepSlot { return FeeRouterStorage.load().sweeps.load().get(slot); }
get fun get_min_value(op: uint32): coins { return fr_min_value(FeeRouterStorage.load().ledger(), op); }
get fun get_min_forward(op: uint32, slot: uint8): coins { return fee_router_min_forward(); }
get fun get_min_sweep(slot: uint8): coins { return FeeRouterStorage.load().ledger().jetton_min_sweep(slot, FR_BOUNCE_GAS); }
get fun get_min_claim(slot: uint8): coins { return FeeRouterStorage.load().ledger().jetton_min_claim(slot, FR_BOUNCE_GAS); }
get fun get_min_discover(): coins { return fr_min_value(FeeRouterStorage.load().ledger(), OP_DISCOVER_WALLETS); }

get fun get_owed_archive(slot:uint8): (uint65,uint256,coins){return FeeRouterStorage.load().ledger().owedArchive(slot);}
get fun get_min_archive_claim(slot:uint8): coins{return FeeRouterStorage.load().ledger().jetton_min_archive_claim(slot,FR_BOUNCE_GAS);}

get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return FeeRouterStorage.load().jetton.load().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();
    val e=jetton_recovery_authenticate(FeeRouterStorage.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{
    val item=JettonRecoveryItem.fromCell(receipt.load().payload);
    return calculateGasFee(0,JETTON_RECEIPT_GAS)+(item.incoming?0 as coins:jetton_recovery_rent());
}
