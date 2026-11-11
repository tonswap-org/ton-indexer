tolk 1.5.0
import "@stdlib/gas-payments";
import "./option_limits";
import "./option_messages";
import "./child_budget";
import "../generated/op/options";
import "../shared/governance/module_gate";
import "../shared/risk/exposure_cap";
import "../shared/oracle/verdict";
import "./factory_types";
import "./factory_math";
import "./factory_budget";
import "./child_types";
import "../shared/utils/error_codes";

fun of_reserve(value: coins,keep: coins) {
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+keep,RESERVE_MODE_EXACT_AMOUNT);
}
fun of_send(dest: address,body: cell) {
    createMessage({bounce:BounceMode.Only256BitsOfBody,dest:dest,value:0,body})
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun of_change(dest: address) {
    createMessage({bounce:BounceMode.NoBounce,dest:dest,value:0}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun of_commit(dest: address,id: uint64,kind: uint8,seriesId: uint64,net: coins,fee: coins,lock: coins,expiry: uint32) {
    of_send(dest,OvCommit{intentId:id,kind,seriesId,net,fee,lock,expiry}.toCell());
}
fun of_reject(dest: address,id: uint64,reason: int) {of_send(dest,OvReject{intentId:id,reason:reason as uint16}.toCell());}
fun of_child(code: cell,id: uint64): AutoDeployAddress {
    val data=ChildStorage{factory:contract.getAddress(),seriesId:id,terms:null,
        oracle:ChildOracle{initial0:0,initial1:0,strike:0,answered0:false,medium0:0,long0:0,
            answered1:false,medium1:0,long1:0,state:0,window:0,decidedAt:0}.toCell(),
        positionCount:0,openNotional:0,positions:createEmptyMap()}.toCell();
    return {stateInit:{code,data}};
}
fun of_child_config(msg: OsCreate): cell {
    val p=msg.pools.load();
    if(msg.kind==OPTION_KIND_SHOUT){return OxShoutCfg{writer:msg.writer,pool:p.base,expiry:msg.expiry,
        cooldownSeconds:300,floorWindowSeconds:600,maxNotional:msg.maxNotional,strikeBps:msg.strikeBps,
        collateralMultiplierBps:msg.collateralMultiplierBps}.toCell();}
    return OxOutperfCfg{writer:msg.writer,basePool:p.base,quotePool:p.quote!,expiry:msg.expiry,
        maxNotional:msg.maxNotional,collateralMultiplierBps:msg.collateralMultiplierBps}.toCell();
}
fun of_store(mutate st: FactoryStorage,policy: FactoryPolicy,id: uint64,s: FactorySeries) {
    st.policy=policy.toCell();st.series.set(id,s);st.save();
}
fun of_buy_reject(mutate st: FactoryStorage,tokenId: uint64,reason: int) {
    val found=st.pending.get(tokenId);if(!found.isFound){return;}
    val p=found.loadValue();var s=st.series.mustGet(p.seriesId);var policy=st.policy.load();
    of_release_pending(mutate policy,mutate s,p,false);st.pending.delete(tokenId);of_store(mutate st,policy,p.seriesId,s);
    of_reject(st.peers.load().vault,tokenId,reason);
}
fun of_create(mutate st: FactoryStorage,sender: address,value: coins,body: slice) {
    val peers=st.peers.load();assert(peers.manager!=null && sender==peers.manager!) throw ERR_GOVERNANCE_UNAUTHORIZED;
    val msg=OsCreate.fromSlice(body);var policy=st.policy.load();val old=st.series.get(msg.seriesId);
    assert(value>=of_min_value(OP_OS_CREATE)) throw ERR_OPTIONS_CONFIG;
    val code=msg.kind==OPTION_KIND_SHOUT?peers.shoutCode:peers.outperfCode;
    val child=of_child(code,msg.seriesId);
    if(old.isFound){assert(old.loadValue().terms.load().creation.hash()==body.toCell().hash()) throw ERR_OPTIONS_CONFIG;}
    else{
        val pools=msg.pools.load();val minCollateral=msg.kind==OPTION_KIND_SHOUT?policy.shoutCollateral:policy.outperfCollateral;
        assert(msg.seriesId>0 && (msg.kind==1 || msg.kind==2) && blockchain.now()<msg.expiry-OPTION_BUY_CUTOFF
            && msg.expiry<=blockchain.now()+OPTION_MAX_TENOR && msg.maxNotional>=OPTION_MIN_NOTIONAL
            && msg.maxNotional<=OPTION_MAX_NOTIONAL && msg.collateralMultiplierBps>0
            && msg.collateralMultiplierBps>=minCollateral && msg.premiumBps>0 && msg.strikeBps>0
            && policy.seriesCount<OPTION_MAX_SERIES && option_basechain(msg.writer)
            && msg.writer!=st.gate.governance && msg.writer!=contract.getAddress() && msg.writer!=sender
            && option_basechain(pools.base) && (msg.kind!=2 || (pools.quote!=null
                && option_basechain(pools.quote!) && pools.quote!=pools.base))) throw ERR_OPTIONS_CONFIG;
        val terms=FactoryTerms{writer:msg.writer,child:child.calculateAddress(),kind:msg.kind,expiry:msg.expiry,
            maxNotional:msg.maxNotional,premiumBps:msg.premiumBps,collateralBps:msg.collateralMultiplierBps,
            requiredReserve:of_ceil_bps(msg.maxNotional,msg.collateralMultiplierBps),creation:msg.toCell()};
        val s=FactorySeries{terms:terms.toCell(),funded:0,fundIntent:0,withdrawnBacking:0,locked:0,pendingLock:0,
            pendingNotional:0,openNotional:0,purged:false,recordCount:0,positions:createEmptyMap()};
        policy.seriesCount+=1;of_store(mutate st,policy,msg.seriesId,s);reserveGramsOnBalance(option_series_rent(),RESERVE_MODE_EXACT_AMOUNT);
    }
    createMessage({bounce:BounceMode.Only256BitsOfBody,dest:child,value:0,body:of_child_config(msg)})
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun of_admit(mutate st: FactoryStorage,msg: OvAdmit,value: coins) {
    val vault=st.peers.load().vault;val found=st.series.get(msg.seriesId);
    if(!found.isFound || msg.intentId==0 || (msg.kind!=1 && msg.kind!=2)){of_reject(vault,msg.intentId,1);return;}
    var s=found.loadValue();val t=s.terms.load();var policy=st.policy.load();
    if(msg.kind==1 && s.fundIntent==msg.intentId && msg.from==t.writer && msg.amount==t.requiredReserve){
        of_commit(vault,msg.intentId,1,msg.seriesId,0,0,0,t.expiry);return;
    }
    val committed=s.positions.get(msg.intentId);
    if(msg.kind==2 && committed.isFound){
        val p=committed.loadValue();
        assert(p.buyer==msg.from && p.notional==msg.notional && p.net+p.fee==msg.amount) throw ERR_OPTIONS_CONFIG;
        of_commit(vault,msg.intentId,2,msg.seriesId,p.net,p.fee,p.lock,t.expiry);return;
    }
    val pending=st.pending.get(msg.intentId);
    if(pending.isFound){
        val p=pending.loadValue();assert(msg.kind==2 && p.seriesId==msg.seriesId && p.buyer==msg.from
            && p.notional==msg.notional && p.net+p.fee==msg.amount) throw ERR_OPTIONS_CONFIG;
        of_send(t.child,OxBuy{tokenId:msg.intentId,owner:p.buyer,notional:p.notional,net:p.net,lock:p.lock}.toCell());return;
    }
    if(st.gate.withdrawalsOnly || s.purged){of_reject(vault,msg.intentId,2);return;}
    if(msg.kind==1){
        if(s.fundIntent!=0 || msg.from!=t.writer || msg.amount!=t.requiredReserve
            || blockchain.now()>=t.expiry-OPTION_BUY_CUTOFF){of_reject(vault,msg.intentId,3);return;}
        s.fundIntent=msg.intentId;s.funded=msg.amount;policy.fundedTotal+=msg.amount;
        policy.bumpActive=of_bump(policy,of_utilisation(policy.lockedTotal,policy.fundedTotal));
        of_store(mutate st,policy,msg.seriesId,s);of_commit(vault,msg.intentId,1,msg.seriesId,0,0,0,t.expiry);return;
    }
    val q=of_quote(policy,s,msg.notional);
    if(q.status!=0 || q.net+q.fee!=msg.amount){of_reject(vault,msg.intentId,q.status==0?8:q.status);return;}
    if(value<of_local_value()+child_min_value(t.kind,OP_OX_BUY)+of_record_rent()){of_reject(vault,msg.intentId,5);return;}
    val p=PendingBuy{seriesId:msg.seriesId,buyer:msg.from,notional:msg.notional,net:q.net,fee:q.fee,lock:q.lock};
    policy.cap=cap_add(policy.cap,msg.notional);policy.pendingNotional+=msg.notional;policy.lockedTotal+=q.lock;
    policy.recordCount+=1;policy.bumpActive=q.bump;s.recordCount+=1;s.pendingLock+=q.lock;s.pendingNotional+=msg.notional;
    st.pending.set(msg.intentId,p);of_store(mutate st,policy,msg.seriesId,s);reserveGramsOnBalance(of_record_rent(),RESERVE_MODE_EXACT_AMOUNT);
    of_send(t.child,OxBuy{tokenId:msg.intentId,owner:msg.from,notional:msg.notional,net:q.net,lock:q.lock}.toCell());
}
fun of_buy_answer(mutate st: FactoryStorage,sender: address,seriesId: uint64,tokenId: uint64,accepted: bool,reason: int) {
    val found=st.series.get(seriesId);if(!found.isFound){return;}var s=found.loadValue();val t=s.terms.load();
    if(sender!=t.child){return;}val pending=st.pending.get(tokenId);
    if(!pending.isFound || pending.loadValue().seriesId!=seriesId){
        // A duplicate ACK must never erase an already committed child's outcome.
        if(accepted && !s.positions.exists(tokenId) && !s.purged){of_send(sender,OxBuyAbort{tokenId}.toCell());}return;
    }
    if(!accepted){of_buy_reject(mutate st,tokenId,reason);return;}
    val p=pending.loadValue();var policy=st.policy.load();of_release_pending(mutate policy,mutate s,p,true);
    s.positions.set(tokenId,FactoryPosition{buyer:p.buyer,notional:p.notional,net:p.net,fee:p.fee,lock:p.lock,released:false});
    st.pending.delete(tokenId);of_store(mutate st,policy,seriesId,s);
    of_commit(st.peers.load().vault,tokenId,2,seriesId,p.net,p.fee,p.lock,t.expiry);
}
fun of_cancel(mutate st: FactoryStorage,msg: OvCancel) {
    val vault=st.peers.load().vault;val found=st.series.get(msg.seriesId);
    if(!found.isFound){of_reject(vault,msg.intentId,1);return;}val s=found.loadValue();val t=s.terms.load();
    val pending=st.pending.get(msg.intentId);
    if(pending.isFound && msg.kind==2 && pending.loadValue().seriesId==msg.seriesId){of_buy_reject(mutate st,msg.intentId,5);return;}
    val p=s.positions.get(msg.intentId);
    if(msg.kind==2 && !s.purged && p.isFound){val v=p.loadValue();of_commit(vault,msg.intentId,2,msg.seriesId,v.net,v.fee,v.lock,t.expiry);return;}
    if(msg.kind==1 && s.fundIntent==msg.intentId){of_commit(vault,msg.intentId,1,msg.seriesId,0,0,0,t.expiry);return;}
    of_reject(vault,msg.intentId,1);
}
fun of_settle(mutate st: FactoryStorage,sender: address,msg: OxSettleR) {
    val found=st.series.get(msg.seriesId);if(!found.isFound){return;}var s=found.loadValue();val t=s.terms.load();
    if(sender!=t.child){return;}if(msg.status==0){of_change(msg.caller);return;}
    if(msg.status>2){return;}val foundPosition=s.positions.get(msg.tokenId);var payout=msg.payout;
    if(!s.purged){
        if(!foundPosition.isFound){of_change(msg.caller);return;}var p=foundPosition.loadValue();
        if(msg.holder!=p.buyer){return;}payout=min(payout,p.lock);
        if(!p.released){
            var policy=st.policy.load();p.released=true;policy.cap=cap_sub(policy.cap,p.notional);
            policy.lockedTotal-=p.lock;s.locked-=p.lock;s.openNotional-=p.notional;
            if(msg.status==1){s.funded-=payout;policy.fundedTotal-=payout;}
            policy.bumpActive=of_bump(policy,of_utilisation(policy.lockedTotal,policy.fundedTotal));
            s.positions.set(msg.tokenId,p);of_store(mutate st,policy,msg.seriesId,s);
        }
    }
    if(msg.status==1){of_send(st.peers.load().vault,OvSettle{seriesId:msg.seriesId,tokenId:msg.tokenId,holder:msg.holder,payout}.toCell());}
    else{of_send(st.peers.load().vault,VoidRefund{queryId:msg.tokenId,seriesId:msg.seriesId,tokenId:msg.tokenId,holder:msg.holder}.toCell());}
}
fun onBouncedMessage(in: InMessageBounced) {
    var body=in.bouncedBody;if(body.remainingBitsCount()<128 || body.loadUint(32)!=0xffffffff
        || body.loadUint(32)!=OP_OX_BUY){return;}val id=body.loadUint(64);var st=FactoryStorage.load();val p=st.pending.get(id);
    if(!p.isFound || st.series.mustGet(p.loadValue().seriesId).terms.load().child!=in.senderAddress){return;}
    of_reserve(in.valueCoins,0);of_buy_reject(mutate st,id,5);
}
fun onInternalMessage(in: InMessage) {
    if(in.body.isEmpty()){return;}assert(in.body.remainingBitsCount()>=32) throw ERR_OPTIONS_CONFIG;
    var st=FactoryStorage.load();val op=in.body.preloadUint(32);val peers=st.peers.load();of_reserve(in.valueCoins,0);
    if(gate_handle(mutate st.gate,in.senderAddress,in.body)){st.save();of_change(in.senderAddress);return;}
    if(op==OP_OS_CREATE){of_create(mutate st,in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_OV_ADMIT || op==OP_OV_CANCEL || op==OP_OPTION_WITHDRAW_REQUEST){
        assert(in.senderAddress==peers.vault) throw ERR_GOVERNANCE_UNAUTHORIZED;
        if(op==OP_OV_ADMIT){of_admit(mutate st,OvAdmit.fromSlice(in.body),in.valueCoins);return;}
        if(op==OP_OV_CANCEL){of_cancel(mutate st,OvCancel.fromSlice(in.body));return;}
        val msg=OptionWithdrawRequest.fromSlice(in.body);var s=st.series.mustGet(msg.seriesId);var policy=st.policy.load();
        assert(blockchain.now()>=s.terms.load().expiry && s.fundIntent!=0) throw ERR_OPTIONS_CONFIG;
        if(msg.cumulativeBacking>s.withdrawnBacking){val delta=msg.cumulativeBacking-s.withdrawnBacking;
            assert(s.funded>=s.locked+s.pendingLock+delta) throw ERR_OPTIONS_CONFIG;
            s.funded-=delta;policy.fundedTotal-=delta;s.withdrawnBacking=msg.cumulativeBacking;
            policy.bumpActive=of_bump(policy,of_utilisation(policy.lockedTotal,policy.fundedTotal));of_store(mutate st,policy,msg.seriesId,s);
        }
        of_send(peers.vault,OptionWithdrawAck{seriesId:msg.seriesId,cumulativeBacking:s.withdrawnBacking}.toCell());return;
    }
    if(op==OP_OX_BUY_OK){val msg=OxBuyOk.fromSlice(in.body);of_buy_answer(mutate st,in.senderAddress,msg.seriesId,msg.tokenId,true,0);return;}
    if(op==OP_OX_BUY_NO){val msg=OxBuyNo.fromSlice(in.body);of_buy_answer(mutate st,in.senderAddress,msg.seriesId,msg.tokenId,false,msg.reason);return;}
    if(op==OP_OX_SETTLE_R){of_settle(mutate st,in.senderAddress,OxSettleR.fromSlice(in.body));return;}
    if(op==OP_FACTORY_EXERCISE || op==OP_OF_EXERCISE){
        var id:uint64=0;var token:uint64=0;var minimum:coins=0;
        if(op==OP_FACTORY_EXERCISE){val msg=FactoryExercise.fromSlice(in.body);id=msg.seriesId;token=msg.tokenId;}
        else{val msg=OfExercise.fromSlice(in.body);id=msg.seriesId;token=msg.tokenId;minimum=msg.minPayout;assert(minimum>0) throw ERR_OPTIONS_CONFIG;}
        val s=st.series.mustGet(id);val t=s.terms.load();assert(in.valueCoins>=of_min_value(op)
            && (op==OP_FACTORY_EXERCISE || blockchain.now()<t.expiry)) throw ERR_OPTIONS_CONFIG;
        of_send(t.child,OxSettleQ{tokenId:token,caller:in.senderAddress,minPayout:minimum}.toCell());return;
    }
    if(op==OP_OF_PURGE){val msg=OfPurge.fromSlice(in.body);var s=st.series.mustGet(msg.seriesId);var p=st.policy.load();
        assert(in.valueCoins>=of_min_value(op) && blockchain.now()>=s.terms.load().expiry+OPTION_BUY_CUTOFF+2592000
            && s.openNotional==0 && s.pendingLock==0) throw ERR_OPTIONS_CONFIG;
        if(!s.purged){p.recordCount-=s.recordCount;s.recordCount=0;s.positions=createEmptyMap();s.purged=true;of_store(mutate st,p,msg.seriesId,s);}
        of_change(in.senderAddress);return;
    }
    gate_require_governance(st.gate,in.senderAddress);assert(in.valueCoins>=of_min_value(op)) throw ERR_OPTIONS_CONFIG;
    var policy=st.policy.load();
    if(op==OP_OF_CONFIG){val msg=OfConfig.fromSlice(in.body);var next=peers;
        assert(option_basechain(msg.manager) && (peers.manager==null || peers.manager==msg.manager)
            && msg.manager!=contract.getAddress()) throw ERR_OPTIONS_CONFIG;next.manager=msg.manager;st.peers=next.toCell();
    }else if(op==OP_OF_FEE){val msg=OfFee.fromSlice(in.body);assert(msg.protocolFeeBps<=10000) throw ERR_OPTIONS_CONFIG;policy.protocolFeeBps=msg.protocolFeeBps;
    }else if(op==OP_OPTION_SET_CAP){val msg=OptionSetCap.fromSlice(in.body);val(next,ok)=cap_set(policy.cap,OPTIONS_AGGREGATE_NOTIONAL_CEILING,msg.cap);
        assert(ok) throw ERR_OPTIONS_CONFIG;policy.cap=next;
    }else if(op==OP_SET_UTILISATION_GUARD){val msg=SetUtilisationGuard.fromSlice(in.body);
        assert(msg.bumpActivateBps>0 && msg.bumpActivateBps<=10000 && msg.bumpDeactivateBps<msg.bumpActivateBps
            && msg.pauseThresholdBps>msg.bumpActivateBps && msg.pauseThresholdBps<=10000 && msg.bumpPercentBps<=20000) throw ERR_OPTIONS_CONFIG;
        policy.bumpActivate=msg.bumpActivateBps;policy.bumpDeactivate=msg.bumpDeactivateBps;policy.pauseThreshold=msg.pauseThresholdBps;policy.bumpPercent=msg.bumpPercentBps;
        policy.bumpActive=of_bump(policy,of_utilisation(policy.lockedTotal,policy.fundedTotal));
    }else if(op==OP_SET_COLLATERAL_MULTIPLIER){val msg=SetCollateralMultiplier.fromSlice(in.body);assert(msg.optionKind==1 || msg.optionKind==2) throw ERR_OPTIONS_CONFIG;
        if(msg.optionKind==1){policy.shoutCollateral=msg.multiplierBps;}else{policy.outperfCollateral=msg.multiplierBps;}
    }else{throw ERR_OPTIONS_CONFIG;}
    st.policy=policy.toCell();st.save();of_change(in.senderAddress);
}
get fun get_min_value(op: int): coins {return of_min_value(op);}
get fun get_factory(): (address,bool,cell,cell) {val s=FactoryStorage.load();return(s.gate.governance,s.gate.withdrawalsOnly,s.peers,s.policy);}
get fun series_info(id: uint64): cell? {val s=FactoryStorage.load().series.get(id);return s.isFound?s.loadValue().toCell():null;}
get fun position_info(id: uint64,tokenId: uint64): cell? {
    val s=FactoryStorage.load().series.get(id);if(!s.isFound){return null;}val p=s.loadValue().positions.get(tokenId);return p.isFound?p.loadValue().toCell():null;
}
get fun get_pending_buy(id: uint64): cell? {val p=FactoryStorage.load().pending.get(id);return p.isFound?p.loadValue().toCell():null;}
get fun get_exposure_cap(scope: int): (coins,coins,coins,coins) {assert(scope==0) throw ERR_OPTIONS_CONFIG;val p=FactoryStorage.load().policy.load();return(p.cap.used,p.pendingNotional,p.cap.operatingCap,OPTIONS_AGGREGATE_NOTIONAL_CEILING);}
get fun buy_quote(id: uint64,notional: coins): (int,coins,coins,coins,int,bool) {
    val st=FactoryStorage.load();val s=st.series.get(id);if(!s.isFound || st.gate.withdrawalsOnly){return(1,0,0,0,0,false);}
    val q=of_quote(st.policy.load(),s.loadValue(),notional);return(q.status,q.net,q.fee,q.lock,q.utilisation,q.bump);
}
get fun get_rent_runway(): (coins,coins) {val p=FactoryStorage.load().policy.load();return(contract.getOriginalBalance(),
    calculateStorageFee(BASECHAIN,31536000,300000+p.seriesCount*5000+p.recordCount*2400,512+p.seriesCount*12+p.recordCount*8));}
get fun get_capacity(): (int,int) {return(OPTION_MAX_SERIES,OPTION_MAX_FACTORY_RECORDS);}
