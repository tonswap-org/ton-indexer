tolk 1.5.0
import "./factory_types";
import "./option_limits";
import "../shared/risk/exposure_cap";
import "../shared/oracle/verdict";

fun of_ceil_bps(amount: coins,bps: int): coins { return (amount*bps+9999)/10000; }
fun of_utilisation(locked: coins,funded: coins): int { return funded>0?min(locked*10000/funded,10000):(locked>0?10000:0); }
fun of_bump(policy: FactoryPolicy,utilisation: int): bool {
    if(policy.bumpActive && utilisation<=policy.bumpDeactivate){return false;}
    if(!policy.bumpActive && utilisation>=policy.bumpActivate){return true;}
    return policy.bumpActive;
}
fun of_quote(policy: FactoryPolicy,s: FactorySeries,notional: coins): FactoryQuote {
    var q=FactoryQuote{status:1,net:0,fee:0,lock:0,utilisation:0,bump:false};
    val t=s.terms.load();if(s.purged || s.fundIntent==0){return q;}
    q.status=3;if(blockchain.now()>=t.expiry-OPTION_BUY_CUTOFF){return q;}
    q.status=4;if(notional<OPTION_MIN_NOTIONAL || s.openNotional+s.pendingNotional+notional>t.maxNotional
        || s.recordCount>=OPTION_MAX_CHILD_POSITIONS || policy.recordCount>=OPTION_MAX_FACTORY_RECORDS
        || !cap_can_add(policy.cap,OPTIONS_AGGREGATE_NOTIONAL_CEILING,notional)){return q;}
    q.lock=of_ceil_bps(notional,t.collateralBps);q.status=7;
    if(q.lock==0 || s.locked+s.pendingLock+q.lock>s.funded){return q;}
    val util=of_utilisation(policy.lockedTotal+q.lock,policy.fundedTotal);q.utilisation=util as uint16;
    if(util>=policy.pauseThreshold){return q;}
    q.bump=of_bump(policy,util);
    val bps=q.bump?t.premiumBps*(10000+policy.bumpPercent)/10000:t.premiumBps as int;
    q.net=of_ceil_bps(notional,bps);q.fee=of_ceil_bps(q.net,policy.protocolFeeBps);q.status=0;return q;
}
fun of_release_pending(mutate policy: FactoryPolicy,mutate s: FactorySeries,p: PendingBuy,accepted: bool) {
    policy.pendingNotional-=p.notional;s.pendingNotional-=p.notional;s.pendingLock-=p.lock;
    if(accepted){s.locked+=p.lock;s.openNotional+=p.notional;}
    else{policy.cap=cap_sub(policy.cap,p.notional);policy.lockedTotal-=p.lock;policy.recordCount-=1;s.recordCount-=1;}
    policy.bumpActive=of_bump(policy,of_utilisation(policy.lockedTotal,policy.fundedTotal));
}
