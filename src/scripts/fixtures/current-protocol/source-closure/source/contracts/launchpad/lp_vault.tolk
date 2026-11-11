tolk 1.5.0
import "@gen/op/tep";
import "../shared/jetton/holder_recovery"
import "../t3/receipt_tree"
import "../t3/recovery_types"
import "../shared/utils/error_codes"
import "@gen/op/t3"
import "sale_config_codec"
import "recovery"
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/dex/swap_payload"
import "../dlmm/constants"
import "../dlmm/pool_state_init"
import "../dlmm/pool_codec"
import "../dlmm/pool_funding"
import "@gen/op/jetton"
import "@gen/op/launchpad"
import "@gen/op/dlmm"

struct (0x4c565344) LpSeed { queryId:uint64; fwdT3:coins; fwdX:coins }
struct (0x4c56524c) LpRelease { queryId:uint64; t3:coins; x:coins; remove:bool }
fun lp_ready(st:ChildStorage):bool{return st.config!=null&&st.ledger().pendingCount()==0&&LpBook.fromCell(st.book).pool!=null;}
fun lp_report(st:ChildStorage,value:coins){if(lp_ready(st)&&value>=launchpad_control_value()){
    launchpad_reserve(value);createMessage({bounce:BounceMode.NoBounce,dest:LpConfig.fromCell(st.config!).peers.load().sale,value:0,body:ChildReady{role:1}}).send(128|2);
}}
fun lp_floor(l:JettonLedger,slot:uint8):coins{return 2*(calculateGasFee(BASECHAIN,ADD_GAS_MAX+POOL_REFUND_TAIL_GAS)+pool_liq_log_fee()+pool_liq_aux_value(1)
    +l.legValue(slot,swap_notify_value(),112,1,POOL_BOUNCE_GAS));}
fun lp_min(st:ChildStorage,op:int):coins{val l=st.ledger();if(op==OP_DISCOVER_WALLETS){return l.minDiscover()+2*launchpad_control_value();}
    if(op==OP_LP_SEED){val b=LpBook.fromCell(st.book);return calculateGasFee(BASECHAIN,SALE_FIN_GAS)+4*calculateForwardFee(BASECHAIN,1400,3)
        +(b.t3Bal>0?l.legValue(0,lp_floor(l,0),716,2,SALE_BOUNCE_GAS):0 as coins)+(b.tokenBal>0?l.legValue(1,lp_floor(l,1),716,2,SALE_BOUNCE_GAS):0 as coins);}
    return calculateGasFee(BASECHAIN,SALE_FIN_GAS)+4*calculateForwardFee(BASECHAIN,1400,3)+l.legValue(0,0,0,0,SALE_BOUNCE_GAS)+l.legValue(1,0,0,0,SALE_BOUNCE_GAS);
}
fun lp_counting(b:LpBook):bool{return b.unlockAt==0||blockchain.now()<b.unlockAt;}
fun lp_add(mutate b:LpBook,slot:uint8,amount:coins){if(slot==0){assert(amount<=JETTON_MAX_COINS-b.t3Bal) throw ERR_JETTON_RECOVERY;b.t3Bal+=amount;}
    else{assert(amount<=JETTON_MAX_COINS-b.tokenBal) throw ERR_JETTON_RECOVERY;b.tokenBal+=amount;}}
fun on_credit_lp(sender:address,value:coins,body:slice){var st=ChildStorage.load();val c=st.ledger().onNotification(sender,body);
    if(c==null){assert(!st.protected(0)) throw ERR_JETTON_RECOVERY;return;}
    var b=LpBook.fromCell(st.book);if(lp_counting(b)){lp_add(mutate b,c.slot,c.amount);}if(!c.claimReceipt){st.handled(c.slot,c.amount);}st.book=b.toCell();st.save();
}
fun lp_peer(st:ChildStorage,w:address):bool{val id=st.identity.load();val p=LpConfig.fromCell(st.config!).peers.load();val b=LpBook.fromCell(st.book);
    return w==id.factory||w==id.creator||w==p.sale||w==p.lpRecipient||w==p.dlmmFactory||(b.pool!=null&&w==b.pool!);
}
fun on_take_lp(sender:address,value:coins,body:slice){var st=ChildStorage.load();if(st.config==null){return;}var l=st.ledger();val t=l.checkTake(sender,body);
    if(t==null||lp_peer(st,t.wallet)){return;}l.commitTake(t);st.setLedger(l);st.save();lp_report(st,value);
}
fun onBouncedMessage(in:InMessageBounced){var st=ChildStorage.load();val l=st.ledger();val b=l.onBounce(in.senderAddress,in.bouncedBody);if(b.kind!=1){return;}
    var state=LpBook.fromCell(st.book);if(lp_counting(state)&&state.pool!=null&&b.destination!=null&&b.destination! ==state.pool!){lp_add(mutate state,b.slot,b.amount);}
    st.restored(b.slot,b.amount);st.book=state.toCell();st.save();jetton_bounce_excess(b.excessTo,b.queryId,in.valueCoins,0);
}
fun lp_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=ChildStorage.load();var managed=st.jetton.load();val item=managed.recovery.claim(msg.receipt,msg.proof);var b=LpBook.fromCell(st.book);var count=false;
    if(item.incoming){val credit=jetton_parse_notification(item.slot,item.body.beginParse());assert(credit!=null&&credit!.amount==item.amount&&!credit!.claimReceipt) throw ERR_JETTON_RECOVERY;count=true;}
    else{val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_JETTON_RECOVERY;count=b.pool!=null&&command.destination==b.pool!;}
    // After terminal unlock, any physical tokens can already have left to the fixed beneficiary.
    if(count&&lp_counting(b)){lp_add(mutate b,item.slot,item.amount);}st.book=b.toCell();st.jetton=managed.toCell();st.save();
    jetton_bounce_excess(sender,0,value,0);
}
fun onInternalMessage(in:InMessage){if(in.body.remainingBitsCount()<32){return;}val op=in.body.preloadUint(32);
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){on_credit_lp(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_T3_NOTIFICATION_CERTIFICATE||op==OP_T3_FAILURE_CERTIFICATE){launchpad_recovery_accept(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){lp_recovery_claim(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){on_take_lp(in.senderAddress,in.valueCoins,in.body);return;}if(op==OP_TEP74_EXCESSES||op==OP_LIQ_OUTCOME){return;}
    var st=ChildStorage.load();val id=st.identity.load();var l=st.ledger();var b=LpBook.fromCell(st.book);
    if(op==OP_LP_INIT){val m=LpInit.fromSlice(in.body);assert(st.config==null&&in.senderAddress==id.factory&&id.role==1) throw ERR_SALE;val more=m.more.load();val profile=more.profile.load();
        st.config=LpConfig{peers:LpPeers{sale:m.sale,lpRecipient:m.lpRecipient,dlmmFactory:more.dlmmFactory}.toCell(),seedBin:m.seedBin,poolId:m.poolId}.toCell();
        l.slotAdd(0,more.t3Master,profile.walletGas,profile.walletGram,false,profile.budget);l.slotAdd(1,more.projectMaster,POOL_PUBLIC_WALLET_GAS_X,0,true,jetton_standard_budget(POOL_PUBLIC_WALLET_GAS_X));st.setLedger(l);st.initRecovery();st.save();
        reserveGramsOnBalance(launchpad_rent(0),RESERVE_MODE_AT_MOST);l.discover();launchpad_return(id.creator);return;}
    assert(st.config!=null) throw ERR_SALE;val cfg=LpConfig.fromCell(st.config!);val p=cfg.peers.load();
    if(op==OP_POOL_CREATED){if(in.senderAddress!=p.dlmmFactory||b.pool!=null){return;}val m=PoolCreated.fromSlice(in.body);
        if(m.id.hash()!=cfg.poolId.hash()||!l.canPay(m.pool)||lp_peer(st,m.pool)){return;}b.pool=m.pool;st.book=b.toCell();st.save();lp_report(st,in.valueCoins);return;}
    if(op==OP_LP_RESULT){val m=LpResult.fromSlice(in.body);if(in.senderAddress!=p.sale||b.unlockAt!=0){return;}b.armedAt=m.success?blockchain.now():0;b.unlockAt=blockchain.now()+(m.success?7776000:0);st.book=b.toCell();st.save();return;}
    assert(in.valueCoins>=lp_min(st,op)) throw ERR_SALE;
    if(op==OP_DISCOVER_WALLETS){val discoveryRequest=DiscoverWallets.fromSlice(in.body);launchpad_reserve(in.valueCoins);l.discover();
        if(b.pool==null){createMessage({bounce:BounceMode.Only256BitsOfBody,dest:p.dlmmFactory,value:0,body:PoolCreate{id:cfg.poolId as Cell<PoolId>,notify:true}}).send(128|16);}
        else{if(lp_ready(st)){createMessage({bounce:BounceMode.NoBounce,dest:p.sale,value:launchpad_control_value(),body:ChildReady{role:1}}).send(1);}launchpad_return(in.senderAddress);}return;}
    if(op==OP_LP_SEED){val m=LpSeed.fromSlice(in.body);assert(b.armedAt>0&&blockchain.now()<b.unlockAt&&lp_ready(st)&&(b.t3Bal>0||b.tokenBal>0)) throw ERR_SALE;
        val values:array<coins> =[b.t3Bal,b.tokenBal];val forwards:array<coins> =[m.fwdT3,m.fwdX];var needed=calculateGasFee(BASECHAIN,SALE_FIN_GAS)+4*calculateForwardFee(BASECHAIN,1400,3);
        var slot=0;repeat(2){if(values.get(slot)>0){assert(forwards.get(slot)>=lp_floor(l,slot as uint8)) throw ERR_SALE;needed+=l.legValue(slot as uint8,forwards.get(slot),716,2,SALE_BOUNCE_GAS);}slot+=1;}
        assert(in.valueCoins>=needed) throw ERR_SALE;b.t3Bal=0;b.tokenBal=0;st.book=b.toCell();st.save();launchpad_reserve(in.valueCoins);
        slot=0;repeat(2){val amount=values.get(slot);val fwd=forwards.get(slot);if(amount>0){st.dispatch(slot as uint8,amount);val payload=LiqAdd{owner:contract.getAddress(),notify:true,count:1,rows:LiqAddRow{binId:cfg.seedBin,amount,minShares:0,next:null}.toCell()}.toCell();
            l.sendTransfer(slot as uint8,{queryId:m.queryId,amount,destination:b.pool!,excessTo:in.senderAddress,forwardGram:fwd,forwardPayload:payload},l.legValue(slot as uint8,fwd,716,2,SALE_BOUNCE_GAS),17);}slot+=1;}
        st.save();launchpad_return(in.senderAddress);return;}
    if(op==OP_LP_RELEASE){val m=LpRelease.fromSlice(in.body);assert(b.unlockAt>0&&blockchain.now()>=b.unlockAt&&(m.t3>0||m.x>0||m.remove)) throw ERR_SALE;
        val pre=max(contract.getOriginalBalance()-in.valueCoins,0);val rent=launchpad_rent(0);if(pre>=rent+10000000){reserveGramsOnBalance(rent,RESERVE_MODE_EXACT_AMOUNT);createMessage({bounce:BounceMode.NoBounce,dest:p.lpRecipient,value:pre-rent}).send(2);}else{launchpad_reserve(in.valueCoins);}
        b.t3Bal-=min(b.t3Bal,m.t3);b.tokenBal-=min(b.tokenBal,m.x);st.book=b.toCell();st.save();
        val amounts:array<coins> =[m.t3,m.x];var slot=0;repeat(2){val amount=amounts.get(slot);if(amount>0){st.dispatch(slot as uint8,amount);l.sendTransfer(slot as uint8,{queryId:m.queryId,amount,destination:p.lpRecipient,excessTo:in.senderAddress,forwardGram:0,forwardPayload:null},l.legValue(slot as uint8,0,0,0,SALE_BOUNCE_GAS),17);}slot+=1;}
        st.save();if(m.remove){assert(b.pool!=null) throw ERR_SALE;createMessage({bounce:BounceMode.Only256BitsOfBody,dest:b.pool!,value:0,body:LiqRemove{queryId:m.queryId,recipient:p.lpRecipient,deadline:blockchain.now()+300,minT3:0,minX:0,count:1,rows:LiqRemoveRow{binId:cfg.seedBin,shares:0,next:null}.toCell()}}).send(128|16);}else{launchpad_return(in.senderAddress);}return;}
    throw ERR_SALE;
}
get fun get_lp_vault():(cell,cell,bool){val st=ChildStorage.load();return(st.config??beginCell().endCell(),st.book,lp_ready(st));}
get fun get_jetton_slots():map<uint8,JettonSlot>{return ChildStorage.load().ledger().slots;}
get fun get_jetton_liabilities(slot:uint8):coins{val st=ChildStorage.load();val b=LpBook.fromCell(st.book);return st.jetton.load().recovery.pending(slot)+(slot==0?b.t3Bal:b.tokenBal);}
get fun get_unattributed_surplus(slot:uint8,observed:coins,protectedCredits:int?,acceptedTransfers:int?):(int,int,int){val l=get_jetton_liabilities(slot)+ChildStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers);return(l,max(observed-l,0),max(l-observed,0));}
get fun get_min_value(op:uint32):coins{return lp_min(ChildStorage.load(),op);}
get fun get_min_discover():coins{return lp_min(ChildStorage.load(),OP_DISCOVER_WALLETS);}
get fun get_min_forward(op:uint32,slot:uint8):coins{return jetton_notify_value();}
get fun get_seed_floor(slot:uint8):coins{return lp_floor(ChildStorage.load().ledger(),slot);}
get fun get_seed_value(fwdT3:coins,fwdX:coins):coins{val st=ChildStorage.load();val l=st.ledger();val b=LpBook.fromCell(st.book);return calculateGasFee(BASECHAIN,SALE_FIN_GAS)+4*calculateForwardFee(BASECHAIN,1400,3)
    +(b.t3Bal>0?l.legValue(0,fwdT3,716,2,SALE_BOUNCE_GAS):0 as coins)+(b.tokenBal>0?l.legValue(1,fwdX,716,2,SALE_BOUNCE_GAS):0 as coins);}
