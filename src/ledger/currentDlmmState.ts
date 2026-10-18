import { Address, beginCell, Builder, Cell, Dictionary, Slice, type DictionaryValue } from '@ton/core';
import { validJettonWalletProfile } from '../config/runtimeManifest';
/** Fresh native DLMM layout only. Original state is independent of current getters. */
const fail = (message: string): Error => Error(`Current DLMM state: ${message}`);
const spotError = fail;
export function dlmmOrdinary(cell: Cell): Slice { if (cell.isExotic) throw fail('exotic cell'); return cell.beginParse(); }
const readOnly = () => { throw fail('read-only state'); };
const codec = <T>(parse: (s: Slice) => T): DictionaryValue<T> => ({ serialize: readOnly, parse });
const done = <T>(s: Slice, value: T): T => { s.endParse(); return value; };
export const DLMM_BUDGET_WIDTHS = [['senderGas',32],['walletBounceGas',32],['burnWalletGas',32],['smallPayloadCells',16],['largeWalletGas',32],['largeSenderGas',32],['rentSeconds',32],['rentBits',32],['rentCells',16],['initBits',32],['initCells',16],['initCopies',8],['transferBits',16],['transferCells',8],['transferCopies',8]] as const;
export function decodeDlmmBudget(c: Cell) { const s=dlmmOrdinary(c), result: Record<string,number|boolean>={}; for(const[k,w]of DLMM_BUDGET_WIDTHS)result[k]=s.loadUint(w);result.creditProtection=s.loadBit();return done(s,result); }
export function dlmmBudgetCell(v: Record<string,number|boolean>) { const b=beginCell();for(const[k,w]of DLMM_BUDGET_WIDTHS)b.storeUint(Number(v[k]),w);return b.storeBit(Boolean(v.creditProtection)).endCell(); }
const slotCodec=codec(s=>{const v={master:s.loadAddress().toRawString(),wallet:s.loadMaybeAddress()?.toRawString()??null,gas:s.loadUint(32),gram:s.loadCoins(),optional:s.loadBit(),budget:decodeDlmmBudget(s.loadRef())};s.endParse();if(!validJettonWalletProfile(v.gas,String(v.gram),v.budget))throw fail('wallet budget');return v;});
const owedCodec=codec(s=>done(s,{total:s.loadCoins(),count:s.loadUint(16),entries:s.loadDict(Dictionary.Keys.Address(),Dictionary.Values.BigVarUint(4)),archive:s.loadMaybeRef()}));
function position(s:Slice):NativePoolPosition {const p={shares:s.loadUintBig(256),farmId:s.loadUintBig(64),accSnap:s.loadUintBig(256),rewardCarry:0n},c=s.loadMaybeRef();if(c){const r=dlmmOrdinary(c);p.rewardCarry=r.loadUintBig(128);r.endParse();if(!p.rewardCarry)throw fail('noncanonical zero fraction');}return p;}
const positionCodec=codec(s=>done(s,position(s)));
function ownerPositions(s:Slice){return{firstBin:s.loadInt(32),first:position(s),more:s.loadDict(Dictionary.Keys.Int(32),positionCodec)};}
const ownerCodec=codec(s=>done(s,ownerPositions(s)));
const inlineCellCodec=codec(s=>{const c=beginCell().storeSlice(s).endCell();s.skip(s.remainingBits);while(s.remainingRefs)s.loadRef();return c;});
const bucketCodec=codec(s=>{const owner=s.loadAddress(),positions=ownerPositions(s),count=s.loadUint(2),others=s.loadDict(Dictionary.Keys.Address(),ownerCodec);s.endParse();if(others.size!==count||others.has(owner))throw fail('owner bucket count');return{owner,positions,others};});
export function readCurrentDlmmPool(data:Cell,pool:string){
 const s=dlmmOrdinary(data), flags=s.loadUint(8),binSpacing=s.loadUint(16),feePips=s.loadUint(32),xDecimals=s.loadUint(8),activeBin=s.loadInt(32),protocolFeesT3=s.loadCoins(),binCount=s.loadUint(16),positionCount=s.loadUint(16),campaignCount=s.loadUint(8);
 const jet=dlmmOrdinary(s.loadRef()),amm=dlmmOrdinary(s.loadRef()),oracle=s.loadRef(),cold=dlmmOrdinary(s.loadRef());s.endParse();
 const slots=jet.loadDict(Dictionary.Keys.Uint(8),slotCodec),owed=jet.loadDict(Dictionary.Keys.Uint(8),owedCodec),busy=jet.loadUintBig(256),sweeps=jet.loadDict(Dictionary.Keys.Uint(8),inlineCellCodec),recoveryCell=jet.loadMaybeRef();jet.endParse();
 const reserveT=amm.loadCoins(),reserveX=amm.loadCoins(),bins=amm.loadDict(Dictionary.Keys.Int(32),poolBinValue);amm.endParse();
 const factory=cold.loadAddress().toRawString(),feeSink=cold.loadAddress().toRawString(),treasury=cold.loadAddress().toRawString(),buckets=cold.loadDict(Dictionary.Keys.BigUint(128),bucketCodec),farm=dlmmOrdinary(cold.loadRef());cold.endParse();
 const nextId=farm.loadUintBig(64),escrowT=farm.loadCoins(),escrowX=farm.loadCoins(),farms=farm.loadDict(Dictionary.Keys.BigUint(64),inlineCellCodec);farm.endParse();
 const positions=new Map<string,Map<number,NativePoolPosition>>();let count=0,t=0n,x=0n;
 for(const[key,bucket]of buckets){for(const[owner,p]of [[bucket.owner,bucket.positions],...bucket.others] as const){const ownerKey=BigInt('0x'+beginCell().storeAddress(Address.parse(pool)).storeAddress(owner).endCell().hash().toString('hex'))>>128n;if(ownerKey!==key||p.first.shares===0n||p.more.has(p.firstBin)||positions.has(owner.toRawString()))throw fail('position bucket identity');const rows=new Map<number,NativePoolPosition>([[p.firstBin,p.first],...p.more]);for(const[id,v]of rows)if(Math.abs(id)>200000||v.shares===0n)throw fail('position');positions.set(owner.toRawString(),rows);count+=rows.size;}}
 for(const[id,bin]of bins){if(Math.abs(id)>200000)throw fail('bin');t+=bin.t;x+=bin.x;}
 if(binCount!==bins.size||positionCount!==count||campaignCount!==farms.size||binCount>8192||positionCount>12288||campaignCount>32||t!==reserveT||x!==reserveX||feePips>100000||xDecimals>18||slots.size!==2||!slots.has(0)||!slots.has(1))throw fail('book totals');
 for(const[id,c]of farms)if(id===0n||id>=nextId||!decodeNativeFarm(id,c))throw fail('campaign');
 const recovery=recoveryCell?(()=>{const r=dlmmOrdinary(recoveryCell);return done(r,{dispatched:r.loadUintBig(256),handled:r.loadUintBig(256),pending:r.loadCoins(),tree:r.loadMaybeRef(),restored:r.loadUintBig(256)});})():null;
 const o=dlmmOrdinary(oracle),oracleState=done(o,{count:o.loadUint(16),curValue:o.loadInt(32),curHealthy:o.loadBit(),slots:o.loadDict(Dictionary.Keys.Uint(32),codec(v=>done(v,{cumV:v.loadIntBig(64),cumH:v.loadUintBig(40),mask:v.loadUint(8),lanes:v.loadUintBig(256)})))});if(oracleState.count!==oracleState.slots.size||oracleState.count>2049)throw fail('oracle count');
 return{flags,binSpacing,feePips,xDecimals,activeBin,protocolFeesT3,slots,owed,busy,sweeps,recovery,reserveT,reserveX,bins,factory,feeSink,treasury,positions,nextId,escrowT,escrowX,farms,oracle:oracleState};
}
export const POOL_OP={add:0x4c514133,remove:0x4c515233,outcome:0x4c514f33,event:0x4c514533,farmCreate:0x464d4333,farmAction:0x464d4133,farmEvent:0x464d4533,payout:0x50504f33,create:0x50435233} as const;
export type NativePoolBin={t:bigint;x:bigint;shares:bigint;pq:bigint};
export type NativePoolPosition={shares:bigint;farmId:bigint;accSnap:bigint;rewardCarry:bigint};
export type NativeFarm={id:bigint;end:number;lastTs:number;acc:bigint;weight:bigint;paid:bigint;binId:number;side:0|1;sponsor:string;total:bigint;start:number;duration:number};
export const poolBinValue:DictionaryValue<NativePoolBin>={serialize(){throw fail('Read-only bin codec');},parse(s){const r={t:s.loadCoins(),x:s.loadCoins(),shares:s.loadUintBig(256),pq:s.loadUintBig(128)};s.endParse();if(r.pq<1n<<32n)throw fail('Invalid bin price');return r;}};
export const poolPositionValue:DictionaryValue<NativePoolPosition>={serialize(){throw fail('Read-only position codec');},parse(s){const r={shares:s.loadUintBig(256),farmId:s.loadUintBig(64),accSnap:s.loadUintBig(256),rewardCarry:0n},carry=s.loadMaybeRef();s.endParse();if(carry){const p=carry.beginParse();r.rewardCarry=p.loadUintBig(128);p.endParse();}return r;}};
export function decodeNativeFarm(id:bigint,cell:Cell|null):NativeFarm|null{if(!cell)return null;const s=cell.beginParse(),r={id,end:s.loadUint(32),lastTs:s.loadUint(32),acc:s.loadUintBig(256),weight:s.loadUintBig(128),paid:s.loadCoins()},p=s.loadRef().beginParse();s.endParse();const terms={binId:p.loadInt(32),side:p.loadUint(8),sponsor:p.loadAddress().toRawString(),total:p.loadCoins(),start:p.loadUint(32),duration:p.loadUint(32)};p.endParse();if(terms.side>1||terms.duration<3600||terms.duration>7776000||r.end<terms.start||r.end>terms.start+terms.duration||r.paid>terms.total)throw fail('Invalid native farm terms');return{...r,...terms,side:terms.side as 0|1};}

export function nativeLiqAddBody(owner:string,binId:number,amount:bigint,minShares:bigint){if(!Number.isInteger(binId)||Math.abs(binId)>200000||amount<=0n||minShares<=0n||minShares>=1n<<256n)throw fail('Invalid liquidity terms');return beginCell().storeUint(POOL_OP.add,32).storeAddress(Address.parse(owner)).storeBit(true).storeUint(1,3).storeRef(beginCell().storeInt(binId,32).storeCoins(amount).storeUint(minShares,256).storeBit(false).endCell()).endCell();}
export function decodeNativeLiqAdd(body:Cell){const s=body.beginParse();if(s.loadUint(32)!==POOL_OP.add)throw fail('Wrong liquidity opcode');const owner=s.loadAddress().toRawString(),notify=s.loadBit(),count=s.loadUint(3),r=s.loadRef().beginParse();s.endParse();const row={binId:r.loadInt(32),amount:r.loadCoins(),minShares:r.loadUintBig(256)};if(r.loadMaybeRef()||count!==1)throw fail('Wrong liquidity row count');r.endParse();return{owner,notify,...row};}
export function nativeLiqRemoveBody(owner:string,rows:readonly {binId:number;shares:bigint}[],queryId:bigint,deadline:number,minT3:bigint,minX:bigint){
 if(rows.length<1||rows.length>2||!Number.isInteger(deadline)||deadline<=0||deadline>0xffffffff||queryId<=0n||queryId>=1n<<64n||minT3<0n||minX<0n)throw fail('Invalid liquidity removal');let next:Cell|null=null;
 const sorted=[...rows].sort((a,b)=>a.binId-b.binId);for(let i=sorted.length-1;i>=0;i--){const row=sorted[i];if(!Number.isInteger(row.binId)||Math.abs(row.binId)>200000||row.shares<0n||row.shares>=1n<<256n||i>0&&row.binId===sorted[i-1].binId)throw fail('Invalid removal row');next=beginCell().storeInt(row.binId,32).storeUint(row.shares,256).storeMaybeRef(next).endCell();}
 return beginCell().storeUint(POOL_OP.remove,32).storeUint(queryId,64).storeAddress(Address.parse(owner)).storeUint(deadline,32).storeCoins(minT3).storeCoins(minX).storeUint(sorted.length,3).storeRef(next!).endCell();
}
export function decodeNativeLiqRemove(body:Cell){const s=body.beginParse();if(s.loadUint(32)!==POOL_OP.remove)throw fail('Wrong removal opcode');const queryId=s.loadUintBig(64),owner=s.loadAddress().toRawString(),deadline=s.loadUint(32),minT3=s.loadCoins(),minX=s.loadCoins(),count=s.loadUint(3);let next:Cell|null=s.loadRef();s.endParse();const rows:{binId:number;shares:bigint}[]=[];for(let i=0;i<count;i++){if(!next)throw fail('Truncated removal');const v:ReturnType<Cell['beginParse']>=next.beginParse();rows.push({binId:v.loadInt(32),shares:v.loadUintBig(256)});next=v.loadMaybeRef();v.endParse();}if(next||!body.equals(nativeLiqRemoveBody(owner,rows,queryId,deadline,minT3,minX)))throw fail('Invalid removal body');return{owner,queryId,deadline,minT3,minX,rows};}
export const nativeFarmCreateBody=(binId:number,duration:number)=>beginCell().storeUint(POOL_OP.farmCreate,32).storeInt(binId,32).storeUint(duration,32).endCell();
export function nativeFarmActionBody(action:number,id:bigint,owner:string,queryId:bigint){if(action<1||action>5)throw fail('Invalid farm action');return beginCell().storeUint(POOL_OP.farmAction,32).storeUint(queryId,64).storeUint(action,8).storeUint(id,64).storeAddress(Address.parse(owner)).endCell();}


const OP = { SWAP: 0x53575033, SWAP_RESULT: 0x53575233, SWAP_OUTCOME: 0x53574f33, SWAP_EVENT: 0x53574533, ROUTE_CONT: 0x52435433 };
export const SwapStatus = { EXECUTED: 0, REFUND: 1, INPUT_OWED: 2, REFUND_PLAIN: 3 } as const;
export const SwapReason = {
    NONE: 0, MALFORMED: 1, NOT_READY: 2, PAUSED: 3, DEADLINE: 4, ADDRESS: 5, VALUE: 6,
    SLIPPAGE: 7, LIQUIDITY: 8, MATH: 10, PAYLOAD_SIZE: 11, BIN: 12, WRONG_SIDE: 13,
    MIN_VALUE: 14, CAPACITY: 15, STAKED: 16, ROUTE: 17,
} as const;

export type Swap = {
    minOut: bigint; deadline: number; recipient: Address; refundTo: Address; notifyOrigin: boolean;
    fwdGram: bigint; refundFwdGram: bigint; fwdPayload: Cell | null;
};
export type SwapResult = {
    queryId: bigint; origin: Address; status: number; reason: number;
    amountIn: bigint; amountOut: bigint; user: Cell | null;
};
export type SwapOutcome = {
    queryId: bigint; status: number; reason: number; inSide: number; amountIn: bigint; amountOut: bigint;
};
export type SwapEvent = SwapOutcome & {
    origin: Address; grossFeeT3: bigint; protocolFeeT3: bigint; activeBin: number; binsLoaded: number;
};
export type RouteCont = { pool: Address; swap: Cell };
type Payload = Cell | Slice;

// A slice must already have been opened as an ordinary cell by the TEP-74 decoder.
// Cloning leaves that decoder's cursor untouched. A public cell input is checked here.
function parse<T>(payload: Payload, op: number, read: (s: Slice) => T): T | null {
    try {
        if (payload instanceof Cell && payload.isExotic) return null;
        const s = payload instanceof Cell ? payload.beginParse() : payload.clone();
        if (s.loadUint(32) !== op) return null;
        const value = read(s);
        s.endParse();
        return value;
    } catch { return null; }
}

function address(s: Slice): Address {
    if (s.preloadUint(11) !== 0b10000000000) throw spotError('Expected a standard workchain-0 address');
    return s.loadAddress();
}

function ordinary(c: Cell): Cell {
    if (c.isExotic) throw spotError('Expected an ordinary payload cell');
    return c;
}

function maybeRef(s: Slice): Cell | null {
    return s.loadBit() ? ordinary(s.loadRef()) : null;
}

function disposition(status: number, reason: number, maxStatus: number, inSide = 0) {
    if (status > maxStatus || reason > SwapReason.ROUTE || reason === 9 || inSide > 1) {
        throw spotError('Unknown swap disposition');
    }
}

// Apply the same address and disposition rules to outgoing values as to incoming cells.
function encoded<T>(builder: Builder, decode: (cell: Cell) => T | null): Cell {
    const cell = builder.endCell();
    if (decode(cell) === null) throw spotError('Invalid swap wire fields');
    return cell;
}

export function encodeSwap(swap: Swap): Cell {
    return encoded(beginCell().storeUint(OP.SWAP, 32).storeCoins(swap.minOut).storeUint(swap.deadline, 32)
        .storeAddress(swap.recipient).storeAddress(swap.refundTo).storeBit(swap.notifyOrigin)
        .storeCoins(swap.fwdGram).storeCoins(swap.refundFwdGram).storeMaybeRef(swap.fwdPayload), decodeSwap);
}

export function decodeSwap(payload: Payload): Swap | null {
    return parse(payload, OP.SWAP, s => ({
        minOut: s.loadCoins(), deadline: s.loadUint(32), recipient: address(s), refundTo: address(s),
        notifyOrigin: s.loadBit(), fwdGram: s.loadCoins(), refundFwdGram: s.loadCoins(), fwdPayload: maybeRef(s),
    }));
}

export function encodeSwapResult(result: SwapResult): Cell {
    return encoded(beginCell().storeUint(OP.SWAP_RESULT, 32).storeUint(result.queryId, 64).storeAddress(result.origin)
        .storeUint(result.status, 8).storeUint(result.reason, 8).storeCoins(result.amountIn).storeCoins(result.amountOut)
        .storeMaybeRef(result.user), decodeSwapResult);
}

export function decodeSwapResult(payload: Payload): SwapResult | null {
    return parse(payload, OP.SWAP_RESULT, s => {
        const result = {
            queryId: s.loadUintBig(64), origin: address(s), status: s.loadUint(8), reason: s.loadUint(8),
            amountIn: s.loadCoins(), amountOut: s.loadCoins(), user: maybeRef(s),
        };
        disposition(result.status, result.reason, SwapStatus.REFUND);
        return result;
    });
}

export function encodeSwapOutcome(outcome: SwapOutcome): Cell {
    return encoded(beginCell().storeUint(OP.SWAP_OUTCOME, 32).storeUint(outcome.queryId, 64)
        .storeUint(outcome.status, 8).storeUint(outcome.reason, 8).storeUint(outcome.inSide, 8)
        .storeCoins(outcome.amountIn).storeCoins(outcome.amountOut), decodeSwapOutcome);
}

export function decodeSwapOutcome(payload: Payload): SwapOutcome | null {
    return parse(payload, OP.SWAP_OUTCOME, s => {
        const outcome = {
            queryId: s.loadUintBig(64), status: s.loadUint(8), reason: s.loadUint(8), inSide: s.loadUint(8),
            amountIn: s.loadCoins(), amountOut: s.loadCoins(),
        };
        disposition(outcome.status, outcome.reason, SwapStatus.INPUT_OWED, outcome.inSide);
        return outcome;
    });
}

export function encodeSwapEvent(event: SwapEvent): Cell {
    return encoded(beginCell().storeUint(OP.SWAP_EVENT, 32).storeUint(event.queryId, 64).storeAddress(event.origin)
        .storeUint(event.inSide, 8).storeUint(event.status, 8).storeUint(event.reason, 8)
        .storeCoins(event.amountIn).storeCoins(event.amountOut).storeCoins(event.grossFeeT3).storeCoins(event.protocolFeeT3)
        .storeInt(event.activeBin, 32).storeUint(event.binsLoaded, 8), decodeSwapEvent);
}

export function decodeSwapEvent(payload: Payload): SwapEvent | null {
    return parse(payload, OP.SWAP_EVENT, s => {
        const event = {
            queryId: s.loadUintBig(64), origin: address(s), inSide: s.loadUint(8), status: s.loadUint(8), reason: s.loadUint(8),
            amountIn: s.loadCoins(), amountOut: s.loadCoins(), grossFeeT3: s.loadCoins(), protocolFeeT3: s.loadCoins(),
            activeBin: s.loadInt(32), binsLoaded: s.loadUint(8),
        };
        disposition(event.status, event.reason, SwapStatus.REFUND_PLAIN, event.inSide);
        return event;
    });
}

export function encodeRouteCont(cont: RouteCont): Cell {
    return encoded(beginCell().storeUint(OP.ROUTE_CONT, 32).storeAddress(cont.pool).storeRef(cont.swap), decodeRouteCont);
}

/** Keeps the inner cell intact. The destination pool separately parses it as Swap. */
export function decodeRouteCont(payload: Payload): RouteCont | null {
    return parse(payload, OP.ROUTE_CONT, s => ({ pool: address(s), swap: ordinary(s.loadRef()) }));
}

