tolk 1.5.0

import "../shared/math/full_math"

const T3_MATH_MINT = 0
const T3_MATH_PAIR = 1
const T3_MATH_SWAP = 2
const T3_MATH_SINGLE = 3
const T3_MATH_PROPORTIONAL = 4
const T3_MATH_OK = 0
const T3_MATH_REQUEST = 1
const T3_MATH_CAP = 5
const T3_MATH_MIN_OUT = 6
const T3_MATH_ZERO = 7
const T3_MATH_SUPPLY = 9
const T3_MATH_FAILED = 10
const T3_MATH_RESERVE = 11
const T3_MATH_PAIR_MIN = 12
const T3_MATH_PAIR_SHORT = 14
const T3_MATH_PAIR_UNAVAILABLE = 15
const T3_MATH_DETAIL_NONE = 0
const T3_MATH_DETAIL_OVERFLOW = 1
const T3_MATH_DETAIL_CONVERGENCE = 2
const T3_MATH_DETAIL_DIVISOR = 3
const T3_MATH_DETAIL_CONFIG = 4
const T3_MATH_DETAIL_EXCEPTION = 5
const T3_MATH_LIMIT = 1298074214633706907132624082305024 // 2^110, exclusive
const T3_MATH_MAX_COINS = 1329227995784915872903807060280344575
const T3_MATH_DEAD = 1000000000
const T3_MATH_PAIR_MIN_LEG = 75000000000000
const T3_MATH_MAX_ITER = 16
const T3_MATH_QUOTE_GAS = 100000

struct T3MathBasket { r0: int; r1: int; r2: int }
struct T3MathState { reserve: T3MathBasket; scale: T3MathBasket; supply: int; amp: int; feeBps: int }
struct T3MathRequest { kind: int; input: int; output: int; amount: int; staged: int; minOut: int }
struct T3MathQuote {
    status: int
    detail: int
    next: T3MathState
    payout: T3MathBasket
    minted: int
    usedIn: int
    usedStaged: int
    feeBps: int
    iterations: int
}
struct T3MathSolve { value: int; detail: int; iterations: int }

fun t3_math_zero(): T3MathBasket { return {r0:0,r1:0,r2:0}; }
fun T3MathBasket.sum(self): int { return self.r0+self.r1+self.r2; }
fun T3MathBasket.at(self, i:int): int { return i==0?self.r0:(i==1?self.r1:self.r2); }
fun T3MathBasket.put(self, i:int, value:int): T3MathBasket {
    var next=self;
    if(i==0){next.r0=value;}else if(i==1){next.r1=value;}else{next.r2=value;}
    return next;
}
fun T3MathBasket.normalized(self, scale:T3MathBasket): T3MathBasket {
    return {r0:self.r0*scale.r0,r1:self.r1*scale.r1,r2:self.r2*scale.r2};
}
fun t3_math_abs(x:int): int { return x<0?-x:x; }
fun t3_math_count(x:T3MathBasket): int { return x.r2==0?2:3; }
fun t3_math_dev(x:T3MathBasket): int {
    val n=t3_math_count(x);val total=x.sum();
    var d=max(t3_math_abs(n*x.r0-total),t3_math_abs(n*x.r1-total));
    if(n==3){d=max(d,t3_math_abs(3*x.r2-total));}
    return d;
}
fun t3_math_not_worse(pre:T3MathBasket, post:T3MathBasket): bool {
    return t3_math_dev(post)*pre.sum()<=t3_math_dev(pre)*post.sum();
}
fun t3_math_allowed(pre:T3MathBasket, post:T3MathBasket): bool {
    return t3_math_dev(post)*10000<=post.sum()*500 || t3_math_not_worse(pre,post);
}
fun t3_math_scale_ok(scale:int): bool {
    var p=1;repeat(10){if(scale==p){return true;}p*=10;}return false;
}
fun t3_math_refuse(st:T3MathState, status:int, detail:int): T3MathQuote {
    return {status,detail,next:st,payout:t3_math_zero(),minted:0,usedIn:0,usedStaged:0,feeBps:0,iterations:0};
}
fun t3_math_solve_refuse(detail:int, iterations:int): T3MathSolve { return {value:0,detail,iterations}; }

// Each solver has its own hard bound and never substitutes an unconverged value.
fun t3_math_d(amp:int, x:T3MathBasket): T3MathSolve {
    val total=x.sum();val n=t3_math_count(x);val ann=amp*n;
    if(total<=0 || ann<=1 || x.r0<=0 || x.r1<=0 || (n==3 && x.r2<=0)){
        return t3_math_solve_refuse(T3_MATH_DETAIL_DIVISOR,0);
    }
    var d=total;var k=0;
    repeat(T3_MATH_MAX_ITER){
        k+=1;var p=d;var i=0;
        repeat(n){p=mulDivFloor(p,d,n*x.at(i));i+=1;}
        val denominator=(ann-1)*d+(n+1)*p;
        if(denominator<=0){return t3_math_solve_refuse(T3_MATH_DETAIL_DIVISOR,k);}
        val next=mulDivFloor(ann*total+n*p,d,denominator);
        if(t3_math_abs(next-d)<=1){return {value:next,detail:0,iterations:k};}
        d=next;
    }
    return t3_math_solve_refuse(T3_MATH_DETAIL_CONVERGENCE,k);
}
fun t3_math_y(amp:int, x:T3MathBasket, d:int, out:int): T3MathSolve {
    val n=t3_math_count(x);val ann=amp*n;
    if(d<=0 || ann<=1 || out<0 || out>=n){return t3_math_solve_refuse(T3_MATH_DETAIL_DIVISOR,0);}
    var c=d;var sum=0;var i=0;
    repeat(n){
        if(i!=out){val balance=x.at(i);if(balance<=0){return t3_math_solve_refuse(T3_MATH_DETAIL_DIVISOR,0);}
            sum+=balance;c=mulDivFloor(c,d,balance*n);}
        i+=1;
    }
    c=mulDivFloor(c,d,ann*n);val b=sum+d/ann;var y=d;var k=0;
    repeat(T3_MATH_MAX_ITER){
        k+=1;val denominator=2*y+b-d;
        if(denominator<=0){return t3_math_solve_refuse(T3_MATH_DETAIL_DIVISOR,k);}
        val next=(y*y+c)/denominator;
        if(t3_math_abs(next-y)<=1){return {value:next,detail:0,iterations:k};}
        y=next;
    }
    return t3_math_solve_refuse(T3_MATH_DETAIL_CONVERGENCE,k);
}

// Precondition: raw reserves >=0, 0<=amount<=supply and supply>0.
// No solver, normalization, composition, admission, fee or freeze gate belongs here.
fun t3_proportional_raw(reserve:T3MathBasket, amount:int, supply:int): T3MathBasket {
    return {r0:mulDivFloor(reserve.r0,amount,supply),r1:mulDivFloor(reserve.r1,amount,supply),r2:mulDivFloor(reserve.r2,amount,supply)};
}

fun t3_quote_pure(st:T3MathState, req:T3MathRequest): T3MathQuote {
    if(req.kind<0 || req.kind>T3_MATH_PROPORTIONAL || req.amount<=0 || req.amount>T3_MATH_MAX_COINS || req.minOut<0 || req.staged<0 || req.staged>T3_MATH_MAX_COINS){
        return t3_math_refuse(st,T3_MATH_REQUEST,0);
    }
    var i=0;
    repeat(3){
        if(st.reserve.at(i)<0 || st.reserve.at(i)>T3_MATH_MAX_COINS || !t3_math_scale_ok(st.scale.at(i))){
            return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_CONFIG);
        }i+=1;
    }
    if(st.supply<0 || st.supply>T3_MATH_MAX_COINS){return t3_math_refuse(st,T3_MATH_SUPPLY,0);}
    var q=t3_math_refuse(st,T3_MATH_OK,0);
    if(req.kind==T3_MATH_PROPORTIONAL){
        if(req.output!=0){return t3_math_refuse(st,T3_MATH_REQUEST,0);}
        if(st.supply<T3_MATH_DEAD || req.amount>st.supply-T3_MATH_DEAD){return t3_math_refuse(st,T3_MATH_SUPPLY,0);}
        q.payout=t3_proportional_raw(st.reserve,req.amount,st.supply);
        val total=q.payout.normalized(st.scale).sum();
        if(total==0){return t3_math_refuse(st,T3_MATH_ZERO,0);}
        if(total<req.minOut){return t3_math_refuse(st,T3_MATH_MIN_OUT,0);}
        q.next.reserve={r0:st.reserve.r0-q.payout.r0,r1:st.reserve.r1-q.payout.r1,r2:st.reserve.r2-q.payout.r2};
        q.next.supply-=req.amount;q.usedIn=req.amount;return q;
    }
    if(st.amp<100 || st.amp>250 || st.feeBps<0 || st.feeBps>100){return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_CONFIG);}
    val pre=st.reserve.normalized(st.scale);val total=pre.sum();
    if(total>=T3_MATH_LIMIT){return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_OVERFLOW);}
    if(st.supply>0 && (st.supply<T3_MATH_DEAD || st.supply>total)){return t3_math_refuse(st,T3_MATH_SUPPLY,0);}
    if((req.kind!=T3_MATH_SINGLE && (req.input<0 || req.input>2))
        || ((req.kind==T3_MATH_SWAP || req.kind==T3_MATH_SINGLE) && (req.output<0 || req.output>2))){return t3_math_refuse(st,T3_MATH_REQUEST,0);}
    val x=req.kind==T3_MATH_SINGLE?req.amount:req.amount*st.scale.at(req.input);
    if(x>=T3_MATH_LIMIT || total+x>=T3_MATH_LIMIT){return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_OVERFLOW);}
    if(req.kind==T3_MATH_PAIR){
        if(req.input>1 || st.reserve.r2!=0){return t3_math_refuse(st,T3_MATH_PAIR_UNAVAILABLE,0);}
        if(req.staged<=0){return t3_math_refuse(st,T3_MATH_REQUEST,0);}
        val j=1-req.input;var need=0;var minted=0;
        if(st.supply==0){
            if(total!=0){return t3_math_refuse(st,T3_MATH_SUPPLY,0);}
            val staged=req.staged*st.scale.at(j);
            if(staged<T3_MATH_PAIR_MIN_LEG){return t3_math_refuse(st,T3_MATH_PAIR_MIN,0);}
            need=mulDivCeil(staged,1,st.scale.at(req.input));
            q.next.supply=staged+need*st.scale.at(req.input);minted=q.next.supply-T3_MATH_DEAD;
        }else{
            if(st.reserve.r0<=0 || st.reserve.r1<=0){return t3_math_refuse(st,T3_MATH_RESERVE,0);}
            need=mulDivCeil(req.staged,st.reserve.at(req.input),st.reserve.at(j));
            minted=mulDivFloor(st.supply,req.staged,st.reserve.at(j));q.next.supply+=minted;
        }
        if(req.amount<need){return t3_math_refuse(st,T3_MATH_PAIR_SHORT,0);}
        if(minted<=0){return t3_math_refuse(st,T3_MATH_ZERO,0);}
        if(minted<req.minOut){return t3_math_refuse(st,T3_MATH_MIN_OUT,0);}
        q.next.reserve=st.reserve.put(req.input,st.reserve.at(req.input)+need).put(j,st.reserve.at(j)+req.staged);
        if(q.next.reserve.normalized(st.scale).sum()>=T3_MATH_LIMIT || q.next.supply>T3_MATH_MAX_COINS){return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_OVERFLOW);}
        q.minted=minted;q.usedIn=need;q.usedStaged=req.staged;q.payout=t3_math_zero().put(req.input,req.amount-need);return q;
    }
    if(st.supply<T3_MATH_DEAD || total<=0){return t3_math_refuse(st,T3_MATH_SUPPLY,0);}
    if(st.reserve.r0<=0 || st.reserve.r1<=0){return t3_math_refuse(st,T3_MATH_RESERVE,0);}
    if(req.kind==T3_MATH_MINT){
        val post=pre.put(req.input,pre.at(req.input)+x);var minted=0;
        if(st.reserve.at(req.input)==0){
            if(req.input!=2){return t3_math_refuse(st,T3_MATH_RESERVE,0);}
            if(max(max(3*post.r0-post.sum(),3*post.r1-post.sum()),3*post.r2-post.sum())*10000>post.sum()*500){return t3_math_refuse(st,T3_MATH_CAP,0);}
            minted=mulDivFloor(st.supply,x,total);
        }else{
            if(!t3_math_allowed(pre,post)){return t3_math_refuse(st,T3_MATH_CAP,0);}
            val d0=t3_math_d(st.amp,pre);if(d0.detail!=0){return t3_math_refuse(st,T3_MATH_FAILED,d0.detail);}
            val d1=t3_math_d(st.amp,post);if(d1.detail!=0){return t3_math_refuse(st,T3_MATH_FAILED,d1.detail);}
            q.iterations=d0.iterations+d1.iterations;
            if(d0.value<=0 || d1.value<d0.value){return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_DIVISOR);}
            val gross=min(min(mulDivFloor(st.supply,d1.value-d0.value,d0.value),mulDivFloor(st.supply,x,total)),x);
            q.feeBps=t3_math_not_worse(pre,post)?0:st.feeBps;minted=mulDivFloor(gross,10000-q.feeBps,10000);
        }
        if(minted<=0){return t3_math_refuse(st,T3_MATH_ZERO,0);}
        if(minted<req.minOut){return t3_math_refuse(st,T3_MATH_MIN_OUT,0);}
        q.next.reserve=st.reserve.put(req.input,st.reserve.at(req.input)+req.amount);q.next.supply+=minted;
        if(q.next.supply>T3_MATH_MAX_COINS){return t3_math_refuse(st,T3_MATH_FAILED,T3_MATH_DETAIL_OVERFLOW);}
        q.minted=minted;q.usedIn=req.amount;return q;
    }
    if(st.reserve.at(req.output)<=0){return t3_math_refuse(st,T3_MATH_RESERVE,0);}
    var solveState=pre;var d=t3_math_d(st.amp,pre);if(d.detail!=0){return t3_math_refuse(st,T3_MATH_FAILED,d.detail);}
    var notional=0;
    if(req.kind==T3_MATH_SWAP){
        if(req.input==req.output){return t3_math_refuse(st,T3_MATH_REQUEST,0);}
        if(st.reserve.at(req.input)<=0){return t3_math_refuse(st,T3_MATH_RESERVE,0);}
        solveState=pre.put(req.input,pre.at(req.input)+x);notional=x;
        q.next.reserve=st.reserve.put(req.input,st.reserve.at(req.input)+req.amount);
    }else{
        if(req.amount>st.supply-T3_MATH_DEAD){return t3_math_refuse(st,T3_MATH_SUPPLY,0);}
        notional=mulDivFloor(total,req.amount,st.supply);d.value=mulDivCeil(d.value,st.supply-req.amount,st.supply);q.next.supply-=req.amount;
    }
    val y=t3_math_y(st.amp,solveState,d.value,req.output);if(y.detail!=0){return t3_math_refuse(st,T3_MATH_FAILED,y.detail);}
    q.iterations=d.iterations+y.iterations;
    val gross=min(pre.at(req.output)-y.value-1,notional);
    if(gross<=0){return t3_math_refuse(st,T3_MATH_ZERO,0);}
    val scale=st.scale.at(req.output);val freePost=q.next.reserve.put(req.output,st.reserve.at(req.output)-gross/scale).normalized(st.scale);
    q.feeBps=t3_math_not_worse(pre,freePost)?0:st.feeBps;
    val rawOut=mulDivFloor(gross,10000-q.feeBps,10000)/scale;
    if(rawOut<=0){return t3_math_refuse(st,T3_MATH_ZERO,0);}
    if(rawOut<req.minOut){return t3_math_refuse(st,T3_MATH_MIN_OUT,0);}
    q.next.reserve=q.next.reserve.put(req.output,st.reserve.at(req.output)-rawOut);
    if(q.next.reserve.at(req.output)<=0 || !t3_math_allowed(pre,q.next.reserve.normalized(st.scale))){return t3_math_refuse(st,T3_MATH_CAP,0);}
    q.payout=t3_math_zero().put(req.output,rawOut);q.usedIn=req.amount;return q;
}

// Credit handlers call this pure wrapper before accepting or writing a claim.
// Catch covers TVM arithmetic faults only; this graph has no sends or storage writes.
fun t3_quote_guarded(st:T3MathState, req:T3MathRequest): T3MathQuote {
    try { return t3_quote_pure(st,req); }
    catch(excNo,excArg){return t3_math_refuse(st,T3_MATH_FAILED,excNo==4?T3_MATH_DETAIL_OVERFLOW:T3_MATH_DETAIL_EXCEPTION);}
}
