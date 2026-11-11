tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "../shared/utils/rich_bounce"
import "../shared/oracle/evidence"
import "../shared/oracle/verdict"
import "../shared/dex/swap_payload"
import "../dlmm/constants"
import "../dlmm/pool_funding"
import "@gen/op/treasury"
import "@gen/op/jetton"
import "@gen/op/oracle"
import "@gen/op/t3"
import "../shared/jetton/holder_recovery"
import "../t3/receipt_tree"
import "../t3/recovery_types"

const BB_CREDIT_GAS = 40000
const BB_ADMIN_GAS = 60000
const BB_RUN_GAS = 50000
const BB_RES_GAS = 120000
const BB_BOUNCE_GAS = 250000
const BB_GRAM_TARGET = 1000000000
const BB_GRAM_SWEEP_MIN = 100000000
const BB_INTERVAL = 600
struct BuybackPeers { governance: address; treasury: address; gasVault: address }
struct BuybackBinding { pool: address; remint: address }
struct BuybackStorage {
    peers: Cell<BuybackPeers>
    bound: Cell<BuybackBinding>?
    jetton: Cell<JettonManagedLedger>
    sweeps: Cell<JettonSweeps>
    t3Balance: coins
    sliceMax: coins
    lastSwapAt: uint32
}
struct (0x42424e44) BuybackBind { queryId: uint64; pool: address; remint: address }
struct (0x4242524e) BuybackRun { queryId: uint64 }
struct (0x4242534c) BuybackSetSlice { queryId: uint64; sliceMax: coins }
struct (0x42425452) BuybackToTreasury { queryId: uint64; amount: coins }
struct (0x42424556) BuybackEvent { queryId: uint64; amount: coins; minOut: coins; refPriceE9: uint128 }
struct BuybackEcho { payer: address; sentAt: uint64 }
fun BuybackStorage.load(): BuybackStorage { return BuybackStorage.fromCell(contract.getData()); }
fun BuybackStorage.save(self) { contract.setData(self.toCell()); }
fun BuybackStorage.liabilities(self,slot:uint8): coins { return(slot==0?self.t3Balance:0 as coins)+self.ledger().owedTotal(slot)+self.jetton.load().recovery.pending(slot); }
fun BuybackStorage.ledger(self): JettonLedger { return self.jetton.load().ledger; }
fun BuybackStorage.setLedger(mutate self,ledger: JettonLedger) {
    var managed=self.jetton.load(); managed.ledger=ledger; self.jetton=managed.toCell();
}
fun BuybackStorage.dispatch(mutate self,slot:uint8,amount:coins) {
    var managed=self.jetton.load(); managed.recovery.dispatch(slot,amount); self.jetton=managed.toCell();
}
fun bb_apply_credit(mutate st:BuybackStorage,amount:coins) {
    st.t3Balance+=amount;
}
fun bb_apply_source_failure(mutate st:BuybackStorage,mutate ledger:JettonLedger,slot:uint8,command:JettonSourceFailure,value:coins,cap:int):int {
    if (!command.claimReceipt) { st.t3Balance+=command.amount; jetton_bounce_excess(command.excessTo,command.queryId,value,0); return 1; }
    val (result,keep)=ledger.owedCredit(slot,command.destination,command.amount,cap);
    assert(result!=0 || st.jetton.load().recovery.get(slot)==null) throw ERR_JETTON_RECOVERY;
    jetton_log_owed(slot,command.destination,command.amount,result==0?255:3);
    jetton_bounce_excess(command.excessTo,command.queryId,value,keep); return result;
}
fun bb_log_fee(): coins { return calculateForwardFee(BASECHAIN,1023,1); }
fun bb_remint_forward(): coins { return 2*jetton_notify_value(); }
fun bb_swap_forward_floor(ledger: JettonLedger): coins {
    val t3 = ledger.slots.mustGet(0, ERR_JETTON_CONFIG);
    val out = calculateGasFee(BASECHAIN,SWAP_GAS_MAX)
        + jetton_leg_value(POOL_PUBLIC_WALLET_GAS_X,POOL_PUBLIC_WALLET_GRAM_X,jetton_standard_budget(POOL_PUBLIC_WALLET_GAS_X).load(),bb_remint_forward(),628+8*1023,9,POOL_BOUNCE_GAS)
        + pool_rent_target(MAX_BINS,MAX_POSITIONS,MAX_CAMPAIGNS)/1024;
    val refund = calculateGasFee(BASECHAIN,SWAP_GAS_MAX) - calculateGasFee(BASECHAIN,APPLY_TAIL_GAS_MAX)
        + calculateGasFee(BASECHAIN,POOL_REFUND_SEND_TAIL_GAS)
        + jetton_leg_value(t3.walletGas,t3.walletGram,t3.budget.load(),calculateGasFee(BASECHAIN,BB_CREDIT_GAS),628,1,POOL_BOUNCE_GAS);
    return 3*(max(out,refund)+swap_log_fee())/2;
}
fun bb_run_value(ledger:JettonLedger,swapForward:coins): coins {
    return calculateGasFee(BASECHAIN,BB_RUN_GAS+BB_RES_GAS)+oracle_min_forward()+bb_log_fee()
        +ledger.legValue(0,max(swapForward,bb_swap_forward_floor(ledger)),972,1,BB_BOUNCE_GAS)
        +3*calculateForwardFee(BASECHAIN,1500,3);
}
fun bb_min_value(ledger:JettonLedger,op:int): coins {
    if(op==OP_DISCOVER_WALLETS){return ledger.minDiscover()+calculateForwardFee(BASECHAIN,1300,2);}
    if(op==OP_SWEEP_PROBE){return ledger.jetton_min_sweep(0,BB_BOUNCE_GAS);}
    if(op==OP_BUYBACK_RUN){return bb_run_value(ledger,bb_swap_forward_floor(ledger));}
    if(op==OP_BUYBACK_TO_TREASURY){return calculateGasFee(BASECHAIN,BB_ADMIN_GAS)+ledger.legValue(0,jetton_notify_value(),0,0,BB_BOUNCE_GAS)+calculateForwardFee(BASECHAIN,1300,2);}
    return calculateGasFee(BASECHAIN,BB_ADMIN_GAS)+calculateForwardFee(BASECHAIN,1300,2);
}
fun bb_return(to:address){createMessage({bounce:BounceMode.NoBounce,dest:to,value:0}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);}
fun bb_reply_return(to:address){createMessage({bounce:BounceMode.NoBounce,dest:to,value:0}).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);}
fun bb_reserve(value:coins,gasVault:address,sweep:bool){
    val pre=max(contract.getOriginalBalance()-value,0);
    if(sweep && pre>=BB_GRAM_TARGET+BB_GRAM_SWEEP_MIN){reserveGramsOnBalance(BB_GRAM_TARGET,RESERVE_MODE_EXACT_AMOUNT);
        createMessage({bounce:BounceMode.NoBounce,dest:gasVault,value:pre-BB_GRAM_TARGET}).send(SEND_MODE_IGNORE_ERRORS);
    }else{reserveGramsOnBalance(pre,RESERVE_MODE_EXACT_AMOUNT);}
}
fun bb_echo(c:cell): BuybackEcho? {
    var(s,exotic)=c.beginParseSpecial();if(exotic || s.remainingBitsCount()!=331 || s.remainingRefsCount()!=0){return null;}
    val payer=s.tryLoadStdAddress();if(payer==null || s.remainingBitsCount()!=64){return null;}
    return{payer,sentAt:s.loadUint(64)};
}
fun on_credit_buyback(sender: address, value: coins, body: slice) {
    var st=BuybackStorage.load(); var managed=st.jetton.load(); var ledger=managed.ledger; var sweeps=st.sweeps.load();
    val state=managed.recovery.get(0);
    val r=JettonSweeps.onNotification(mutate sweeps,ledger,sender,body,state!=null?state! as cell:null);
    assert(r.kind!=0 || state==null) throw ERR_JETTON_RECOVERY;
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(r.kind==2){if(jetton_sweep_pay(mutate ledger,r,st.peers.load().treasury,value,0,null)!=0){managed.recovery.dispatch(r.slot,r.pay);}}
    else if(r.kind==1){val c=r.credit!; if(!c.claimReceipt){managed.recovery.handled(c.slot,c.amount);} bb_apply_credit(mutate st,c.amount);}
    managed.ledger=ledger; st.jetton=managed.toCell(); st.save();
}
fun on_take_buyback(sender:address,body:slice){
    var st=BuybackStorage.load();var ledger=st.ledger();val peers=st.peers.load();val take=ledger.checkTake(sender,body);
    if(take==null || take.wallet==peers.governance || take.wallet==peers.treasury || take.wallet==peers.gasVault){return;}
    if(st.bound!=null){val bound=st.bound!.load();if(take.wallet==bound.pool || take.wallet==bound.remint){return;}}
    ledger.commitTake(take);st.setLedger(ledger);st.save();
}
fun onBouncedMessage(in:InMessageBounced){
    var st=BuybackStorage.load();var ledger=st.ledger();var sweeps=st.sweeps.load();
    val r=JettonSweeps.onBounce(mutate sweeps,ledger,in.senderAddress,in.bouncedBody);if(r.dirty){st.sweeps=sweeps.toCell();}
    if(!r.probe && r.b.kind==1){val b=r.b;
        val command:JettonSourceFailure={queryId:b.queryId,amount:b.amount,destination:b.destination!,excessTo:b.excessTo!,claimReceipt:b.claimReceipt,payload:b.payload};
        if(bb_apply_source_failure(mutate st,mutate ledger,b.slot,command,in.valueCoins,JETTON_OWED_CAP)!=0){
            var managed=st.jetton.load();managed.recovery.restored(b.slot,b.amount);st.jetton=managed.toCell();
        }
        st.setLedger(ledger);st.save();return;
    }
    if(r.dirty){st.save();}if(r.probe){jetton_bounce_excess(r.b.excessTo,r.b.queryId,in.valueCoins,0);return;}
    if(st.bound==null || in.senderAddress!=st.bound!.load().pool || !rich_bounce_is_canonical(in.bouncedBody)){return;}
    val rich=RichBounceBody.fromSlice(in.bouncedBody);val(s,exotic)=rich.originalBody.beginParseSpecial();
    if(exotic || s.remainingBitsCount()!=160 || s.remainingRefsCount()!=1 || s.preloadUint(32)!=OP_ORACLE_QUERY){return;}
    val query=OracleQuery.fromSlice(s);if(query.at!=0){return;}val echo=bb_echo(query.echo);if(echo!=null){jetton_bounce_excess(echo.payer,query.queryId,in.valueCoins,0);}
}
fun bb_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=BuybackStorage.load();var managed=st.jetton.load();
    val evidence=jetton_recovery_authenticate(managed.ledger,0,sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:evidence.key,payload:evidence.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=managed.recovery.record(evidence);st.jetton=managed.toCell();st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    bb_return(sender);
}
fun bb_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=BuybackStorage.load();var managed=st.jetton.load();val item=managed.recovery.claim(msg.receipt,msg.proof);var ledger=managed.ledger;st.jetton=managed.toCell();
    if(item.incoming){bb_apply_credit(mutate st,item.amount);bb_reserve(value,st.peers.load().gasVault,false);bb_return(sender);}
    else{val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_JETTON_RECOVERY;
        assert(bb_apply_source_failure(mutate st,mutate ledger,item.slot,command,value,1)!=0) throw ERR_JETTON_RECOVERY;}
    st.setLedger(ledger);st.save();
}
fun on_oracle_buyback(sender:address,value:coins,body:slice){
    var st=BuybackStorage.load();if(st.bound==null || sender!=st.bound!.load().pool || body.remainingBitsCount()!=96 || body.remainingRefsCount()!=2){return;}
    val msg=OracleResult.fromSlice(body);val echo=bb_echo(msg.echo);val(valid,e)=evidence_decode(msg.evidence as cell);
    if(!valid || echo==null){return;}val payer=echo.payer;val nowTs=blockchain.now();val(pass,reference)=verdict_market_buy(e,nowTs);
    val ledger=st.ledger();val bound=st.bound!.load();val amount=min(st.t3Balance,st.sliceMax);
    val slot=ledger.slots.mustGet(0,ERR_JETTON_CONFIG);
    val(accepted,refused)=jetton_leg_bounds(slot.walletGas,slot.walletGram,slot.budget.load(),972,1,BB_BOUNCE_GAS);
    val walletValue=value-calculateGasFee(BASECHAIN,BB_RES_GAS)-bb_log_fee();
    val fwd=walletValue-accepted;
    val minOut=reference>0?amount*1000000000*9900/(reference*10000):0;
    if(!oracle_request_live(echo.sentAt,nowTs) || !pass || nowTs<st.lastSwapAt+BB_INTERVAL || st.t3Balance<1000000000
        || walletValue<refused || fwd<bb_swap_forward_floor(ledger) || minOut==0 || !ledger.coreReady() || !ledger.canPay(bound.pool)) {bb_reply_return(payer);return;}
    st.t3Balance-=amount;st.lastSwapAt=nowTs;st.dispatch(0,amount);st.save();
    val payload=Swap{minOut,deadline:nowTs+120,recipient:bound.remint,refundTo:contract.getAddress(),notifyOrigin:false,
        fwdGram:bb_remint_forward(),refundFwdGram:calculateGasFee(BASECHAIN,BB_CREDIT_GAS),fwdPayload:null}.toCell();
    createExternalLogMessage({dest:createAddressNone(),body:BuybackEvent{queryId:msg.queryId,amount,minOut,refPriceE9:reference as uint128}}).send(SEND_MODE_IGNORE_ERRORS);
    bb_reserve(value,st.peers.load().gasVault,true);
    ledger.sendTransfer(0,{queryId:msg.queryId,amount,destination:bound.pool,excessTo:payer,forwardGram:fwd,forwardPayload:payload},
        walletValue,SEND_MODE_PAY_FEES_SEPARATELY);
    bb_return(payer);
}
fun bb_query(pool:address,payer:address,queryId:uint64){
    createMessage({bounce:BounceMode.RichBounce,dest:pool,value:0,body:OracleQuery{queryId,at:0,echo:BuybackEcho{payer,sentAt:blockchain.now()}.toCell()}})
        .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun onInternalMessage(in:InMessage){
    if(in.body.isEmpty()){return;}val op=in.body.preloadUint(32);
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){on_credit_buyback(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_T3_NOTIFICATION_CERTIFICATE || op==OP_T3_FAILURE_CERTIFICATE){bb_recovery_accept(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){bb_recovery_claim(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_TEP74_EXCESSES){return;}
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){on_take_buyback(in.senderAddress,in.body);return;}
    if(oracle_is_result(in.body)){on_oracle_buyback(in.senderAddress,in.valueCoins,in.body);return;}
    var st=BuybackStorage.load();var ledger=st.ledger();val peers=st.peers.load();
    assert(in.valueCoins>=bb_min_value(ledger,op)) throw ERR_JETTON_VALUE;
    if(op==OP_DISCOVER_WALLETS){val msg=DiscoverWallets.fromSlice(in.body);bb_reserve(in.valueCoins,peers.gasVault,false);ledger.discover();bb_return(in.senderAddress);return;}
    if(op==OP_BUYBACK_RUN){val msg=BuybackRun.fromSlice(in.body);assert(st.bound!=null && ledger.coreReady() && st.t3Balance>=1000000000 && blockchain.now()>=st.lastSwapAt+BB_INTERVAL) throw ERR_JETTON_CONFIG;
        bb_query(st.bound!.load().pool,in.senderAddress,msg.queryId);return;}
    if(op==OP_CLAIM_ARCHIVED){val msg=ClaimArchived.fromSlice(in.body);ledger.claimArchived(msg,in.senderAddress,in.valueCoins,false,BB_BOUNCE_GAS,0);st.dispatch(msg.slot,msg.amount);st.setLedger(ledger);st.save();return;}
    if(op==OP_CLAIM_OWED){val msg=ClaimOwed.fromSlice(in.body);val amount=ledger.owedOf(msg.slot,msg.owner);ledger.claim(msg.slot,msg.owner,msg.queryId,in.senderAddress,in.valueCoins,false,BB_BOUNCE_GAS,0);st.dispatch(msg.slot,amount);st.setLedger(ledger);st.save();return;}
    if(op==OP_SWEEP_PROBE){val msg=SweepProbe.fromSlice(in.body);var sweeps=st.sweeps.load();sweeps.probe(ledger,msg.slot,st.liabilities(msg.slot),in.senderAddress,in.valueCoins,BB_BOUNCE_GAS,st.jetton.load().recovery.reconciliation(msg.slot));st.sweeps=sweeps.toCell();st.save();return;}
    assert(in.senderAddress==peers.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
    if(op==OP_BUYBACK_BIND){val msg=BuybackBind.fromSlice(in.body);assert(st.bound==null && msg.pool!=msg.remint && ledger.canPay(msg.pool) && ledger.canPay(msg.remint)
        && msg.pool!=peers.governance && msg.pool!=peers.treasury && msg.pool!=peers.gasVault && msg.remint!=peers.governance && msg.remint!=peers.treasury && msg.remint!=peers.gasVault) throw ERR_JETTON_CONFIG;
        st.bound=BuybackBinding{pool:msg.pool,remint:msg.remint}.toCell();
    }else if(op==OP_BUYBACK_SET_SLICE){val msg=BuybackSetSlice.fromSlice(in.body);assert(msg.sliceMax>=1000000000 && msg.sliceMax<=10000000000000) throw ERR_JETTON_CONFIG;st.sliceMax=msg.sliceMax;
    }else if(op==OP_BUYBACK_TO_TREASURY){val msg=BuybackToTreasury.fromSlice(in.body);assert(msg.amount>0 && msg.amount<=st.t3Balance && ledger.coreReady()) throw ERR_JETTON_CONFIG;st.t3Balance-=msg.amount;st.dispatch(0,msg.amount);
        ledger.sendTransfer(0,{queryId:msg.queryId,amount:msg.amount,destination:peers.treasury,excessTo:in.senderAddress,forwardGram:jetton_notify_value(),forwardPayload:null},
            ledger.legValue(0,jetton_notify_value(),0,0,BB_BOUNCE_GAS),SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }else if(op==OP_SWEEP_ALLOW){val msg=SweepAllow.fromSlice(in.body);var sweeps=st.sweeps.load();sweeps.allow(ledger,msg.slot,msg.amount);st.sweeps=sweeps.toCell();
    }else{throw ERR_JETTON_CONFIG;}
    st.save();bb_reserve(in.valueCoins,peers.gasVault,false);bb_return(in.senderAddress);
}
get fun get_buyback(): (coins,coins,int,address?,address?){val st=BuybackStorage.load();if(st.bound==null){return(st.t3Balance,st.sliceMax,st.lastSwapAt,null,null);}val b=st.bound!.load();return(st.t3Balance,st.sliceMax,st.lastSwapAt,b.pool,b.remint);}
get fun get_peers(): BuybackPeers{return BuybackStorage.load().peers.load();}
get fun get_jetton_slots(): map<uint8,JettonSlot>{return BuybackStorage.load().ledger().slots;}
get fun get_jetton_liabilities(slot:uint8): coins{return BuybackStorage.load().liabilities(slot);}
get fun get_unattributed_surplus(slot:uint8,observed:coins,protectedCredits:int?,acceptedTransfers:int?): (int,int,int){val l=get_jetton_liabilities(slot)+BuybackStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers);return(l,max(observed-l,0),max(l-observed,0));}
get fun get_owed(slot:uint8,owner:address): coins{return BuybackStorage.load().ledger().owedOf(slot,owner);}
get fun get_owed_book(slot:uint8): (coins,int){val l=BuybackStorage.load().ledger();return(l.owedTotal(slot),l.owedCount(slot));}
get fun get_sweep(slot:uint8): SweepSlot{return BuybackStorage.load().sweeps.load().get(slot);}
get fun get_min_value(op:uint32): coins{return bb_min_value(BuybackStorage.load().ledger(),op);}
get fun get_min_forward(): coins{return calculateGasFee(BASECHAIN,BB_CREDIT_GAS);}
get fun get_min_sweep(slot:uint8): coins{return BuybackStorage.load().ledger().jetton_min_sweep(slot,BB_BOUNCE_GAS);}
get fun get_min_claim(slot:uint8): coins{return BuybackStorage.load().ledger().jetton_min_claim(slot,BB_BOUNCE_GAS);}
get fun get_min_discover(): coins{return bb_min_value(BuybackStorage.load().ledger(),OP_DISCOVER_WALLETS);}
get fun get_run_value(swapForward:coins): coins{return bb_run_value(BuybackStorage.load().ledger(),swapForward);}
get fun get_swap_forward_floor(): coins{return bb_swap_forward_floor(BuybackStorage.load().ledger());}
get fun get_remint_forward(): coins{return bb_remint_forward();}

get fun get_owed_archive(slot:uint8): (uint65,uint256,coins){return BuybackStorage.load().ledger().owedArchive(slot);}
get fun get_min_archive_claim(slot:uint8): coins{return BuybackStorage.load().ledger().jetton_min_archive_claim(slot,BB_BOUNCE_GAS);}

get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return BuybackStorage.load().jetton.load().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();
    val e=jetton_recovery_authenticate(BuybackStorage.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{
    val item=JettonRecoveryItem.fromCell(receipt.load().payload);
    return calculateGasFee(0,JETTON_RECEIPT_GAS)+(item.incoming?0 as coins:jetton_recovery_rent());
}
