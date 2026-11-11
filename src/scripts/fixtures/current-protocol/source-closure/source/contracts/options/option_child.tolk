tolk 1.5.0
import "./child_math";
import "@stdlib/gas-payments";
import "./child_types";
import "./option_limits";
import "./option_messages";
import "../generated/op/options";
import "../generated/op/oracle";
import "./child_budget";
import "../shared/utils/rich_bounce";
import "../shared/utils/error_codes";
import "../shared/oracle/evidence";
import "../shared/oracle/verdict";
import "../shared/jetton/tep74_codec";
import "@stdlib/exotic-cells";

fun child_reserve(value: coins) {
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0),RESERVE_MODE_EXACT_AMOUNT);
}
fun child_return(to: address) {
    createMessage({bounce:BounceMode.NoBounce,dest:to,value:0}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun child_forward(to: address,body: cell) {
    createMessage({bounce:BounceMode.Only256BitsOfBody,dest:to,value:0,body}).send(SEND_MODE_CARRY_ALL_BALANCE);
}
fun child_query(t: ChildTerms,e: ChildEcho,queryId: uint64,at: uint64) {
    val pools=t.pools.load();val dest=e.side==0?pools.base:pools.quote!;
    createMessage({bounce:BounceMode.RichBounce,dest:dest,value:0,body:OracleQuery{queryId,at,echo:e.encode()}})
        .send(SEND_MODE_CARRY_ALL_BALANCE);
}
fun child_buy_no(st: ChildStorage,tokenId: uint64,reason: int) {
    child_forward(st.factory,OxBuyNo{seriesId:st.seriesId,tokenId,reason:reason as uint16}.toCell());
}
fun child_buy_ok(st: ChildStorage,tokenId: uint64) {
    child_forward(st.factory,OxBuyOk{seriesId:st.seriesId,tokenId}.toCell());
}
fun child_settle_reply(st: ChildStorage,e: ChildEcho,status: int,holder: address,payout: coins) {
    child_forward(st.factory,OxSettleR{seriesId:st.seriesId,tokenId:e.tokenId,caller:e.actor,
        status:status as uint2,holder,payout}.toCell());
}
fun child_fail(st: ChildStorage,e: ChildEcho,reason: int) {
    if(e.kind==CHILD_BUY) {child_buy_no(st,e.tokenId,reason);}
    else if(e.kind==CHILD_EXERCISE) {child_settle_reply(st,e,0,e.actor,0);}
    else {child_return(e.actor);}
}
fun child_auth(t: ChildTerms,kind: int,sender: address,e: ChildEcho): bool {
    val pools=t.pools.load();
    return (e.side==0 && sender==pools.base) || (kind==OPTION_KIND_OUTPERF && e.side==1 && pools.quote!=null && sender==pools.quote!);
}
fun child_terminal(mutate st: ChildStorage,mutate o: ChildOracle,window: int) {
    o.state=window==0?2:1;o.window=window as uint16;o.decidedAt=blockchain.now();st.oracle=o.toCell();st.save();
    createExternalLogMessage({dest:createAddressNone(),body:OptionTerminal{seriesId:st.seriesId,state:o.state,window:o.window,
        decidedAt:o.decidedAt,priceE9:window==1800?o.medium0:window==7200?o.long0:0 as uint128,
        quotePriceE9:window==1800?o.medium1:window==7200?o.long1:0 as uint128}}).send(SEND_MODE_IGNORE_ERRORS);
}
fun child_mark(mutate st: ChildStorage,e: ChildEcho,mutate p: ChildPosition,status: int,payout: coins) {
    var a=p.amounts.load();a.payout=payout;p.amounts=a.toCell();p.outcome=status as uint2;
    st.openNotional-=a.notional;st.positions.set(e.tokenId,p);st.save();child_settle_reply(st,e,status,p.owner,payout);
}
fun child_on_result(kind: int,sender: address,value: coins,body: slice) {
    var st=ChildStorage.load();if(st.terms==null || body.remainingBitsCount()!=96 || body.remainingRefsCount()!=2){return;}
    val t=st.terms!.load();val msg=OracleResult.fromSlice(body);val echo=child_echo_decode(msg.echo);
    if(echo==null || !child_auth(t,kind,sender,echo)){return;}
    val e=echo;val(valid,price)=evidence_decode(msg.evidence as cell);child_reserve(value);
    if(!valid){child_fail(st,e,5);return;}
    var o=st.oracle.load();val now=blockchain.now();
    if(e.kind==CHILD_SETTLE) {
        if(o.state!=0 || e.sentAt<t.expiry || e.sentAt>t.expiry+OPTION_BUY_CUTOFF
            || (e.side==0?o.answered0:o.answered1)){child_return(e.actor);return;}
        val(ok,medium,long)=verdict_expiry(price,t.expiry);if(!ok){child_return(e.actor);return;}
        if(e.side==0){o.answered0=true;o.medium0=medium as uint128;o.long0=long as uint128;}
        else{o.answered1=true;o.medium1=medium as uint128;o.long1=long as uint128;}
        if(medium==0 && long==0){child_terminal(mutate st,mutate o,0);}
        else if(o.answered0 && (kind==OPTION_KIND_SHOUT || o.answered1)){
            child_terminal(mutate st,mutate o,verdict_expiry_window(o.medium0,o.long0,
                kind==OPTION_KIND_SHOUT?o.medium0:o.medium1,kind==OPTION_KIND_SHOUT?o.long0:o.long1));
        }else{st.oracle=o.toCell();st.save();}
        child_return(e.actor);return;
    }
    if(!oracle_request_live(e.sentAt,now)){child_fail(st,e,5);return;}
    if(e.kind==CHILD_EXERCISE) {
        val found=st.positions.get(e.tokenId);
        if(kind!=OPTION_KIND_SHOUT || o.state!=0 || now>=t.expiry || !found.isFound
            || !verdict_exit(price,now)){child_fail(st,e,5);return;}
        var p=found.loadValue();
        if(p.outcome!=0 || p.owner!=e.actor || e.minimum==0){child_fail(st,e,5);return;}
        val payout=child_payoff(kind,t,o,p,verdict_fill(price,false),0,now);
        if(payout<e.minimum || value<child_callback_value()){child_fail(st,e,5);return;}
        child_mark(mutate st,e,mutate p,1,payout);return;
    }
    if(!verdict_admission(price,now)){child_fail(st,e,5);return;}
    if(e.kind==CHILD_SEED) {
        if(o.initial0!=0 || now>=t.expiry || e.actor!=t.writer){child_fail(st,e,5);return;}
        if(kind==OPTION_KIND_OUTPERF && e.side==0) {
            var next=e;next.side=1;next.firstServedAt=price.servedAt;next.firstPrice=verdict_median(price) as uint128;
            child_query(t,next,msg.queryId,0);return;
        }
        if(kind==OPTION_KIND_OUTPERF){
            if(e.firstPrice==0 || price.servedAt-e.firstServedAt>30){child_fail(st,e,5);return;}
            o.initial0=e.firstPrice;o.initial1=verdict_median(price) as uint128;
        }else{
            val initial=verdict_median(price);val strike=initial*t.strikeBps/10000;
            if(strike==0 || strike>=(1<<128)){child_fail(st,e,5);return;}
            o.initial0=initial as uint128;o.strike=strike as uint128;
        }
        st.oracle=o.toCell();st.save();child_return(e.actor);return;
    }
    if(e.kind==CHILD_BUY) {
        val existing=st.positions.get(e.tokenId);
        if(existing.isFound){val p=existing.loadValue();val a=p.amounts.load();
            if(p.owner==e.actor && a.notional==e.notional && a.net==e.net && a.lock==e.lock){child_buy_ok(st,e.tokenId);}
            else{child_buy_no(st,e.tokenId,4);}return;}
        val reason=child_buy_reason(st,t,o,e,now);if(reason!=0){child_buy_no(st,e.tokenId,reason);return;}
        if(kind==OPTION_KIND_OUTPERF && e.side==0) {
            var next=e;next.side=1;next.firstServedAt=price.servedAt;next.firstPrice=verdict_fill(price,true) as uint128;
            child_query(t,next,msg.queryId,0);return;
        }
        if(kind==OPTION_KIND_OUTPERF && (e.firstPrice==0 || price.servedAt-e.firstServedAt>30)){child_buy_no(st,e.tokenId,5);return;}
        val intrinsic=child_intrinsic(kind,o,e.notional,kind==OPTION_KIND_SHOUT?verdict_fill(price,true):e.firstPrice,
            kind==OPTION_KIND_OUTPERF?verdict_fill(price,false):0);
        if(intrinsic>=e.net){child_buy_no(st,e.tokenId,6);return;}
        if(value<child_callback_value()){child_buy_no(st,e.tokenId,5);return;}
        st.positions.set(e.tokenId,ChildPosition{owner:e.actor,
            amounts:ChildAmounts{notional:e.notional,net:e.net,lock:e.lock,payout:0}.toCell(),shoutFloor:0,lastShoutAt:0,outcome:0});
        st.positionCount+=1;st.openNotional+=e.notional;st.save();child_buy_ok(st,e.tokenId);return;
    }
    if(e.kind==CHILD_SHOUT) {
        val found=st.positions.get(e.tokenId);
        if(kind==OPTION_KIND_SHOUT && o.state==0 && now<t.expiry && found.isFound){
            var p=found.loadValue();if(p.owner==e.actor && p.outcome==0 && (p.lastShoutAt==0 || now>=p.lastShoutAt+t.cooldown)){
                p.shoutFloor=verdict_fill(price,false) as uint128;p.lastShoutAt=now as uint32;st.positions.set(e.tokenId,p);st.save();
            }
        }
        child_return(e.actor);
    }
}
fun child_on_bounce(kind: int,sender: address,value: coins,bouncedBody: slice) {
    val st=ChildStorage.load();if(st.terms==null || !rich_bounce_is_canonical(bouncedBody)){return;}
    val rich=RichBounceBody.fromSlice(bouncedBody);val(body,exotic)=rich.originalBody.beginParseSpecial();
    if(exotic || body.remainingBitsCount()!=160 || body.remainingRefsCount()!=1 || body.preloadUint(32)!=OP_ORACLE_QUERY){return;}
    val query=OracleQuery.fromSlice(body);val echo=child_echo_decode(query.echo);
    if(echo==null || !child_auth(st.terms!.load(),kind,sender,echo)){return;}
    child_reserve(value);child_fail(st,echo,5);
}
fun child_decode_buy(body: slice): OxBuy? {
    if(body.remainingBitsCount()<96 || body.loadUint(32)!=OP_OX_BUY || body.remainingRefsCount()!=0){return null;}
    val tokenId=body.loadUint(64);val owner=body.tryLoadStdAddress();
    val notional=body.tryLoadCoins();val net=body.tryLoadCoins();val lock=body.tryLoadCoins();
    if(owner==null || notional==null || net==null || lock==null || !body.isEmpty()){return null;}
    return{tokenId,owner,notional,net,lock};
}
fun child_on_internal(kind: int,sender: address,value: coins,body: slice) {
    if(body.isEmpty()){return;}assert(body.remainingBitsCount()>=32) throw ERR_OPTIONS_CONFIG;
    val op=body.preloadUint(32);
    if(oracle_is_result(body)){child_on_result(kind,sender,value,body);return;}
    var st=ChildStorage.load();
    if(op==OP_OX_SHOUT_CFG || op==OP_OX_OUTPERF_CFG){
        assert(sender==st.factory) throw ERR_OPTIONS_CONFIG;
        var t:ChildTerms;
        if(op==OP_OX_SHOUT_CFG){assert(kind==OPTION_KIND_SHOUT) throw ERR_OPTIONS_CONFIG;val m=OxShoutCfg.fromSlice(body);
            t={writer:m.writer,expiry:m.expiry,maxNotional:m.maxNotional,strikeBps:m.strikeBps,collateralBps:m.collateralMultiplierBps,
                cooldown:m.cooldownSeconds,floorWindow:m.floorWindowSeconds,pools:OptionPools{base:m.pool,quote:null}.toCell()};
        }else{assert(kind==OPTION_KIND_OUTPERF) throw ERR_OPTIONS_CONFIG;val m=OxOutperfCfg.fromSlice(body);
            t={writer:m.writer,expiry:m.expiry,maxNotional:m.maxNotional,strikeBps:0,collateralBps:m.collateralMultiplierBps,
                cooldown:0,floorWindow:0,pools:OptionPools{base:m.basePool,quote:m.quotePool}.toCell()};}
        assert(st.terms==null || st.terms!.hash()==t.toCell().hash()) throw ERR_OPTIONS_CONFIG;
        val pre=max(contract.getOriginalBalance()-value,0);
        reserveGramsOnBalance(st.terms==null?max(pre,option_child_rent(max(t.expiry-blockchain.now(),0))):pre,RESERVE_MODE_EXACT_AMOUNT);
        if(st.terms==null){st.terms=t.toCell();st.save();}child_return(st.factory);return;
    }
    child_reserve(value);assert(st.terms!=null) throw ERR_OPTIONS_CONFIG;
    val t=st.terms!.load();var o=st.oracle.load();val now=blockchain.now();
    if(op==OP_OX_BUY){
        assert(sender==st.factory) throw ERR_OPTIONS_CONFIG;
        val m=child_decode_buy(body);if(m==null){child_return(st.factory);return;}
        var e=child_echo(CHILD_BUY,m.owner,m.tokenId);e.notional=m.notional;e.net=m.net;e.lock=m.lock;
        val existing=st.positions.get(m.tokenId);
        if(existing.isFound){val p=existing.loadValue();val a=p.amounts.load();
            if(p.owner==m.owner && a.notional==m.notional && a.net==m.net && a.lock==m.lock){child_buy_ok(st,m.tokenId);}
            else{child_buy_no(st,m.tokenId,4);}return;}
        val reason=child_buy_reason(st,t,o,e,now);if(reason!=0){child_buy_no(st,m.tokenId,reason);return;}
        if(value<child_min_value(kind,op)){child_buy_no(st,m.tokenId,5);return;}
        child_query(t,e,m.tokenId,0);return;
    }
    if(op==OP_OX_BUY_ABORT){
        assert(sender==st.factory) throw ERR_OPTIONS_CONFIG;val m=OxBuyAbort.fromSlice(body);val found=st.positions.get(m.tokenId);
        if(found.isFound){val p=found.loadValue();if(p.outcome==0){st.openNotional-=p.amounts.load().notional;}
            st.positions.delete(m.tokenId);st.positionCount-=1;st.save();}child_return(st.factory);return;
    }
    assert(value>=child_min_value(kind,op)) throw ERR_OPTIONS_CONFIG;
    if(op==OP_OPTION_SEED){val m=OptionSeed.fromSlice(body);
        assert(sender==t.writer && o.initial0==0 && now<t.expiry) throw ERR_OPTIONS_CONFIG;
        child_query(t,child_echo(CHILD_SEED,sender,0),m.queryId,0);return;}
    if(op==OP_OPTION_SETTLE){val m=OptionSettle.fromSlice(body);
        assert(now>=t.expiry && (kind==OPTION_KIND_OUTPERF || m.side==0)) throw ERR_OPTIONS_CONFIG;
        if(o.state!=0){child_return(sender);return;}
        if(now>t.expiry+OPTION_BUY_CUTOFF){child_terminal(mutate st,mutate o,0);child_return(sender);return;}
        if(m.side==0?o.answered0:o.answered1){child_return(sender);return;}
        var e=child_echo(CHILD_SETTLE,sender,0);e.side=m.side;child_query(t,e,m.queryId,t.expiry as uint64);return;}
    if(op==OP_SHOUT){val m=Shout.fromSlice(body);val found=st.positions.get(m.tokenId);
        assert(kind==OPTION_KIND_SHOUT && o.state==0 && now<t.expiry && found.isFound) throw ERR_OPTIONS_CONFIG;
        val p=found.loadValue();assert(p.owner==sender && p.outcome==0 && (p.lastShoutAt==0 || now>=p.lastShoutAt+t.cooldown)) throw ERR_OPTIONS_CONFIG;
        child_query(t,child_echo(CHILD_SHOUT,sender,m.tokenId),m.tokenId,0);return;}
    if(op==OP_OX_SETTLE_Q){assert(sender==st.factory) throw ERR_OPTIONS_CONFIG;val m=OxSettleQ.fromSlice(body);
        var e=child_echo(CHILD_EXERCISE,m.caller,m.tokenId);e.minimum=m.minPayout;val found=st.positions.get(m.tokenId);
        if(!found.isFound){child_fail(st,e,5);return;}var p=found.loadValue();
        if(p.outcome!=0){child_settle_reply(st,e,p.outcome,p.owner,p.amounts.load().payout);return;}
        if(o.state==2){child_mark(mutate st,e,mutate p,2,0);return;}
        if(o.state==1){val payout=child_payoff(kind,t,o,p,o.window==1800?o.medium0:o.long0,o.window==1800?o.medium1:o.long1,t.expiry);
            child_mark(mutate st,e,mutate p,1,payout);return;}
        if(kind!=OPTION_KIND_SHOUT || now>=t.expiry || m.caller!=p.owner || m.minPayout==0
            || value<child_min_value(kind,OP_OF_EXERCISE)){child_fail(st,e,5);return;}
        child_query(t,e,m.tokenId,0);return;
    }
    throw ERR_OPTIONS_CONFIG;
}
fun child_get_position(tokenId: uint64): cell? {val p=ChildStorage.load().positions.get(tokenId);return p.isFound?p.loadValue().toCell():null;}
fun child_get_terminal(): (int,int,int,int,int){val o=ChildStorage.load().oracle.load();return(o.state,o.window,o.decidedAt,o.window==1800?o.medium0:o.long0,o.window==1800?o.medium1:o.long1);}
fun child_get_strike(): (int,int,int){val o=ChildStorage.load().oracle.load();return(o.initial0,o.initial1,o.strike);}
fun child_get_preview(kind: int,tokenId: uint64,priceE9: int): coins {
    val st=ChildStorage.load();val p=st.positions.get(tokenId);
    if(kind!=OPTION_KIND_SHOUT || st.terms==null || !p.isFound || p.loadValue().outcome!=0
        || st.oracle.load().state!=0 || blockchain.now()>=st.terms!.load().expiry){return 0;}
    return child_payoff(kind,st.terms!.load(),st.oracle.load(),p.loadValue(),priceE9,0,blockchain.now());
}
fun child_get_runway(): (coins,coins){val st=ChildStorage.load();return(contract.getOriginalBalance(),calculateStorageFee(BASECHAIN,31536000,100000+1700*st.positionCount,256+3*st.positionCount));}
