tolk 1.5.0
import "@gen/op/tep";
import "sale_config_codec"
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../dlmm/constants"
import "@gen/op/jetton"
import "@gen/op/launchpad"

struct (0x5656434c) VestClaim { queryId: uint64 }
struct (0x56565254) VestReturn { queryId: uint64 }
fun vest_ready(st:ChildStorage):bool{if(st.config==null){return false;}val b=VestBook.fromCell(st.book);return st.ledger().pendingCount()==0&&b.deposited>=VestConfig.fromCell(st.config!).terms.load().amount;}
fun vest_report(st:ChildStorage,value:coins){if(vest_ready(st)&&value>=launchpad_control_value()){
    launchpad_reserve(value);createMessage({bounce:BounceMode.NoBounce,dest:VestConfig.fromCell(st.config!).sale,value:0,body:ChildReady{role:2}}).send(128|2);
}}
fun vest_vested(st:ChildStorage):coins{val b=VestBook.fromCell(st.book);val v=VestConfig.fromCell(st.config!).terms.load();val elapsed=blockchain.now()-b.start;
    if(b.start==0||elapsed<v.cliff){return 0;}if(elapsed>=v.duration){return b.deposited;}return b.deposited*(elapsed/v.period*v.period)/v.duration;
}
fun vest_min(st:ChildStorage,op:int):coins{val l=st.ledger();if(op==OP_DISCOVER_WALLETS){return l.minDiscover()+2*launchpad_control_value();}
    return calculateGasFee(BASECHAIN,SALE_CLAIM_GAS)+3*calculateForwardFee(BASECHAIN,1300,2)+l.legValue(0,0,0,0,SALE_BOUNCE_GAS);
}
fun on_credit_vest(sender:address,value:coins,body:slice){var st=ChildStorage.load();val c=st.ledger().onNotification(sender,body);if(c==null||st.config==null){return;}
    var b=VestBook.fromCell(st.book);if(c.amount>JETTON_MAX_COINS-b.deposited){return;}b.deposited+=c.amount;st.book=b.toCell();st.save();vest_report(st,value);
}
fun on_take_vest(sender:address,value:coins,body:slice){var st=ChildStorage.load();if(st.config==null){return;}var l=st.ledger();val t=l.checkTake(sender,body);if(t==null){return;}
    val id=st.identity.load();val cfg=VestConfig.fromCell(st.config!);if(t.wallet==id.factory||t.wallet==id.creator||t.wallet==cfg.sale||t.wallet==cfg.terms.load().beneficiary){return;}
    l.commitTake(t);st.setLedger(l);st.save();vest_report(st,value);
}
fun onBouncedMessage(in:InMessageBounced){var st=ChildStorage.load();val l=st.ledger();val b=l.onBounce(in.senderAddress,in.bouncedBody);if(b.kind!=1){return;}
    var v=VestBook.fromCell(st.book);if(v.failed){v.returned=max(v.returned-b.amount,0);}else{v.claimed=max(v.claimed-b.amount,0);}
    st.book=v.toCell();st.save();jetton_bounce_excess(b.excessTo,b.queryId,in.valueCoins,0);
}
fun onInternalMessage(in:InMessage){if(in.body.remainingBitsCount()<32){return;}val op=in.body.preloadUint(32);
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){on_credit_vest(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){on_take_vest(in.senderAddress,in.valueCoins,in.body);return;}if(op==OP_TEP74_EXCESSES){return;}
    var st=ChildStorage.load();val id=st.identity.load();var l=st.ledger();var b=VestBook.fromCell(st.book);
    if(op==OP_VEST_INIT){val m=VestInit.fromSlice(in.body);assert(st.config==null&&in.senderAddress==id.factory&&id.role==2) throw ERR_SALE;
        st.config=VestConfig{sale:m.sale,terms:m.terms}.toCell();l.slotAdd(0,m.projectMaster,POOL_PUBLIC_WALLET_GAS_X,0,true,jetton_standard_budget(POOL_PUBLIC_WALLET_GAS_X));st.setLedger(l);st.save();
        reserveGramsOnBalance(launchpad_rent(m.terms.load().duration),RESERVE_MODE_AT_MOST);l.discover();launchpad_return(id.creator);return;}
    assert(st.config!=null) throw ERR_SALE;val cfg=VestConfig.fromCell(st.config!);
    if(op==OP_VEST_RESULT){val m=VestResult.fromSlice(in.body);if(in.senderAddress!=cfg.sale||b.start!=0||b.failed){return;}
        if(m.success){b.start=blockchain.now();}else{b.failed=true;}st.book=b.toCell();st.save();return;}
    assert(in.valueCoins>=vest_min(st,op)) throw ERR_SALE;
    if(op==OP_DISCOVER_WALLETS){val discoveryRequest=DiscoverWallets.fromSlice(in.body);launchpad_reserve(in.valueCoins);l.discover();if(vest_ready(st)){
        createMessage({bounce:BounceMode.NoBounce,dest:cfg.sale,value:launchpad_control_value(),body:ChildReady{role:2}}).send(1);}
        launchpad_return(in.senderAddress);return;}
    var amount:coins=0;var q:uint64=0;
    if(op==OP_VEST_CLAIM){q=VestClaim.fromSlice(in.body).queryId;assert(in.senderAddress==cfg.terms.load().beneficiary&&!b.failed&&b.start>0) throw ERR_SALE;amount=vest_vested(st)-b.claimed;b.claimed+=amount;}
    else if(op==OP_VEST_RETURN){q=VestReturn.fromSlice(in.body).queryId;assert(in.senderAddress==id.creator&&b.failed) throw ERR_SALE;amount=b.deposited-b.returned;b.returned+=amount;}
    else{throw ERR_SALE;}assert(amount>0) throw ERR_SALE;st.book=b.toCell();st.save();launchpad_reserve(in.valueCoins);
    l.sendTransfer(0,{queryId:q,amount,destination:in.senderAddress,excessTo:in.senderAddress,forwardGram:0,forwardPayload:null},l.legValue(0,0,0,0,SALE_BOUNCE_GAS),17);launchpad_return(in.senderAddress);
}
get fun get_vesting(): (cell,cell,coins,coins){val st=ChildStorage.load();val b=VestBook.fromCell(st.book);val v:coins=st.config==null?0:vest_vested(st);return(st.config??beginCell().endCell(),st.book,v,v-b.claimed);}
get fun get_jetton_slots():map<uint8,JettonSlot>{return ChildStorage.load().ledger().slots;}
get fun get_jetton_liabilities(slot:uint8):coins{val b=VestBook.fromCell(ChildStorage.load().book);return b.deposited-b.claimed-b.returned;}
get fun get_unattributed_surplus(slot:uint8,observed:coins):(coins,coins,coins){val l=get_jetton_liabilities(slot);return(l,max(observed-l,0),max(l-observed,0));}
get fun get_min_value(op:uint32):coins{return vest_min(ChildStorage.load(),op);}
get fun get_min_discover():coins{return vest_min(ChildStorage.load(),OP_DISCOVER_WALLETS);}
get fun get_min_forward(op:uint32,slot:uint8):coins{return calculateGasFee(BASECHAIN,SALE_CREDIT_GAS)+launchpad_control_value();}
