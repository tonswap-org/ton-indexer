tolk 1.5.0
import "./child_types";
import "./option_limits";
import "../shared/oracle/verdict";

fun child_intrinsic(kind: int,o: ChildOracle,notional: coins,base: int,quote: int): int {
    if(kind==OPTION_KIND_SHOUT) {return o.strike>0?notional*max(base-o.strike,0)/o.strike:0;}
    if(o.initial0==0 || o.initial1==0) {return 0;}
    val baseReturn=(base-o.initial0)*10000/o.initial0;
    val quoteReturn=(quote-o.initial1)*10000/o.initial1;
    return notional*max(baseReturn-quoteReturn,0)/10000;
}
fun child_payoff(kind: int,t: ChildTerms,o: ChildOracle,p: ChildPosition,base: int,quote: int,at: int): coins {
    var price=base;
    if(kind==OPTION_KIND_SHOUT && p.lastShoutAt>0 && at>=p.lastShoutAt && at-p.lastShoutAt<=t.floorWindow) {
        price=max(price,p.shoutFloor);
    }
    val amounts=p.amounts.load();
    return min(child_intrinsic(kind,o,amounts.notional,price,quote),amounts.lock);
}
fun child_buy_reason(st: ChildStorage,t: ChildTerms,o: ChildOracle,e: ChildEcho,now: int): int {
    if(o.initial0==0) {return 1;}
    if(o.state!=0) {return 2;}
    if(now>=t.expiry-OPTION_BUY_CUTOFF) {return 3;}
    if(e.notional<OPTION_MIN_NOTIONAL || st.openNotional+e.notional>t.maxNotional
        || st.positionCount>=OPTION_MAX_CHILD_POSITIONS) {return 4;}
    return 0;
}
