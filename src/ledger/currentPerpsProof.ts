import { Address, beginCell, Cell, Dictionary, contractAddress } from '@ton/core';
import { currentPerpsSlotCodec, decodeNativePerpsState, decodeNativePerpsPosition, decodeNativePerpsPending, nativePerpsPositionKey, decodeNativePerpsTrade, type PerpsBinding } from './currentPerpsState';
import { activeOrderAccount, orderCell as currentT3Cell, verifyOrderTransaction, type OrderTransactionEvidence as CurrentT3TransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage } from '../runtime/physicalEvidence';
import { readCurrentT3Wallet } from './currentT3State';
import { t3Attempt, t3PathRoot } from './currentT3Wire';
const T3_OP = { T3_WALLET_DELIVERY: 0x5433444c, T3_WALLET_RETRY: 0x54335759 };
export type PerpsEvidenceRequest = import('../runtime/perpsOperationEvidence').CurrentPerpsEvidenceRequest;
export type PerpsEffect = { status:'confirmed'|'refunded'|'rejected'|'accepted'; requestBodyHash:string; transactionHash:string; amountRaw:string; gen:string|null; reason:number|null };
export type PerpsEvidence = PerpsEffect | {status:'pending'|'unavailable'};
const verifiedTransactions = new WeakMap<CurrentT3TransactionEvidence, {
    original: CurrentT3TransactionEvidence;
    value: ReturnType<typeof verifyOrderTransaction> & {
        account: string;
    };
}>();
export function verifyCurrentPerpsTransaction(e: CurrentT3TransactionEvidence) {
    const cached = verifiedTransactions.get(e);
    if (cached && cached.original.account === e.account && cached.original.transactionBoc === e.transactionBoc && cached.original.beforeShardAccountBoc === e.beforeShardAccountBoc && cached.original.afterShardAccountBoc === e.afterShardAccountBoc)
        return cached.value;
    const value = { account: e.account, ...verifyOrderTransaction(e) };
    verifiedTransactions.set(e, { original: { ...e }, value });
    return value;
}
const verifyCurrentT3Transaction = verifyCurrentPerpsTransaction;
type CurrentT3Transaction = ReturnType<typeof verifyCurrentT3Transaction>;
function currentT3ActiveState(s: CurrentT3Transaction['after'], pin: string) { return { ...activeOrderAccount(s, pin), splitDepth: null }; }
const messageHashes = new WeakMap<object, {
    incoming: string | null;
    outgoing: Set<string>;
}>();
function cachedMessages(t: CurrentT3Transaction) { let value = messageHashes.get(t); if (!value) {
    value = { incoming: t.incoming ? canonicalPhysicalMessage(t.incoming).hash().toString('hex') : null, outgoing: new Set(t.outgoing.values().map(c => canonicalPhysicalMessage(c).hash().toString('hex'))) };
    messageHashes.set(t, value);
} return value; }
function verifyCurrentT3MessageLink(a: CurrentT3Transaction, b: CurrentT3Transaction) { if (b.tx.lt <= a.tx.lt)
    return false; const incoming = cachedMessages(b).incoming; return incoming !== null && cachedMessages(a).outgoing.has(incoming); }
const walletStorageCache=new WeakMap<Cell,ReturnType<typeof readCurrentT3Wallet>>();
function readT3WalletStorage(c: Cell) { let s = walletStorageCache.get(c);if(!s){s=readCurrentT3Wallet(c);walletStorageCache.set(c,s);} return { ...s, owner: Address.parse(s.owner), master: Address.parse(s.master), proofCodeHash: BigInt('0x' + s.proofCodeHash), count: s.nextId }; }
function t3WalletInitialData(owner: Address, master: Address, proofCodeHash: bigint) {
    let h = beginCell().storeUint(0, 8).endCell().hash();
    for (let i = 0; i < 64; i++)
        h = beginCell().storeUint(4, 8).storeBuffer(h).storeBuffer(h).endCell().hash();
    return beginCell().storeRef(beginCell().storeAddress(owner).storeAddress(master).storeUint(proofCodeHash, 256)).storeCoins(0).storeUint(0, 65).storeBuffer(h).storeRef(beginCell().storeUint(0, 64).storeUint(0, 256).storeDict(null)).storeDict(null).storeUint(0, 256).storeUint(0, 256).endCell();
}
function t3WalletAttemptFromCell(c: Cell) { const a = t3Attempt(c); return { ...a, owner: Address.parse(a.owner), recipient: Address.parse(a.recipient), details: { queryId: a.queryId, response: a.response ? Address.parse(a.response) : null, forwardValue: a.forwardValue, forwardPayload: a.forwardPayload, customPayload: a.customPayload } }; }
function t3WalletAttemptToCell(a: ReturnType<typeof t3WalletAttemptFromCell>) { return a.cell; }
function readT3WalletRecord(c: Cell) { const s = c.beginParse(); check(!c.isExotic, 'wallet record'); const failed = s.loadBit(), cancelled = s.loadBit(), attempt = t3WalletAttemptFromCell(s.loadRef()); s.endParse(); return { failed, cancelled, attempt }; }
function verifyT3Witness(c: Cell, id: bigint, p: Cell, root: bigint) { return t3PathRoot(id, c, p) === root; }
function decodeSpotTokenTransfer(c: Cell) { check(!c.isExotic, 'transfer body'); const s = c.beginParse(); check(s.loadUint(32) === 0x0f8a7ea5, 'TEP74 transfer'); const query = s.loadUintBig(64), amount = s.loadCoins(), owner = s.loadAddress().toRawString(), response = s.loadMaybeAddress()?.toRawString() ?? null, custom = s.loadMaybeRef(), forwardValue = s.loadCoins(), payload = either(s); return { query, amount, owner, response, custom, forwardValue, payload }; }

export type NativePerpsProofBinding={perps:PerpsBinding;network:PerpsEvidenceRequest['network'];releaseId:string;manifestHash:string;riskVaultHash:string;proofCodeHash:string};
const raw=(a:Address|null|undefined)=>a?.toRawString()??null;
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function check(v:unknown,why:string):asserts v{if(!v)throw Error('Current Perps evidence: '+why);}
const maybe=<T>(f:()=>T)=>{try{return f();}catch{return null;}};
const one=<T>(v:T[])=>v.length===1?v[0]:null;
function input(t:CurrentT3Transaction,from?:string){const m=t.tx.inMessage;check(m?.info.type==='internal'&&!m.info.bounced&&(!from||raw(m.info.src)===from),'input');return m;}
function either(s:ReturnType<Cell['beginParse']>){if(s.loadBit()){const c=s.loadRef();s.endParse();return c;}return beginCell().storeSlice(s).endCell();}
export function currentPerpsEngineBoundary(t:CurrentT3Transaction,b:NativePerpsProofBinding,after=true){
 check(t.account===raw(b.perps.engine),'engine account');return readBoundCurrentPerpsEngine(currentT3ActiveState(after?t.after:t.before,b.perps.engineHash).data,b);
}
const engineStateCache=new WeakMap<Cell,ReturnType<typeof decodeNativePerpsState>>();
export function readBoundCurrentPerpsEngine(data:Cell,b:NativePerpsProofBinding){
 let s=engineStateCache.get(data);if(!s){s=decodeNativePerpsState(data);engineStateCache.set(data,s);}const p=b.perps;
 check(s.governance.equals(p.governance)&&s.peers.feeSink.equals(p.feeSink)&&s.peers.treasury.equals(p.treasury)&&s.peers.riskVault.equals(p.riskVault)&&s.peers.riskBucketId===1&&s.ledger.slots.size===1&&s.ledger.slots.get(0)?.master.equals(p.t3Root),'engine peers');
 for(const [id,m]of s.book.markets)check(p.markets.get(id)?.equals(m.pool),'market pin');return s;
}
const cellCodec={serialize(){throw Error('read only');},parse(s:any){return s.loadRef() as Cell;}};
export function currentPerpsRiskBoundary(t:CurrentT3Transaction,b:NativePerpsProofBinding,after=true){
 check(t.account===raw(b.perps.riskVault),'risk account');const a=currentT3ActiveState(after?t.after:t.before,b.riskVaultHash);check(a.splitDepth===null,'risk split depth');return decodeNativePerpsRiskState(a.data,b);
}
export function decodeNativePerpsRiskState(data:Cell,b:NativePerpsProofBinding){
 const s=data.beginParse();check(s.loadAddress().equals(b.perps.governance),'risk governance');s.loadBit();check(s.loadAddress().equals(b.perps.treasury),'risk treasury');
 check(!data.isExotic,'ordinary risk state');
 const managed=s.loadRef().beginParse(),slots=managed.loadDict(Dictionary.Keys.Uint(8),currentPerpsSlotCodec),owed=managed.loadMaybeRef();managed.loadDict(Dictionary.Keys.Uint(8),cellCodec);managed.endParse();check(!s.loadRef().isExotic,'ordinary risk sweeps');
 const buckets=s.loadDict(Dictionary.Keys.Uint(16),{serialize(){throw Error('read only');},parse(q){const controller=q.loadAddress(),payoutHook=q.loadAddress(),floor=q.loadCoins(),c=q.loadRef();check(!c.isExotic&&controller.workChain===0&&payoutHook.workChain===0,'bucket identities');q.endParse();const v=c.beginParse(),value={controller,payoutHook,floor,locked:v.loadCoins(),reserved:v.loadCoins(),notional:v.loadCoins()};v.endParse();return value;}});
 const liabilities=s.loadDict(Dictionary.Keys.BigUint(256),{serialize(){throw Error('read only');},parse(q){const value={notional:q.loadCoins(),reserved:q.loadCoins(),actionId:q.loadUintBig(64),outcome:q.loadUint(8),reason:q.loadUint(16),paid:q.loadCoins(),applied:q.loadBit(),at:q.loadUint(32),deposit:q.loadCoins()};q.endParse();return value;}}),count=s.loadUint(16);s.endParse();
 const bucket=buckets.get(1);check(bucket?.controller.equals(b.perps.engine)&&bucket.payoutHook.equals(b.perps.engine)&&slots.size===1&&slots.get(0)?.master.equals(b.perps.t3Root)&&!slots.get(0)?.optional&&count===liabilities.size&&count<=16384,'risk bucket or ledger');return{slots,owed,buckets,liabilities};
}
function balance(t:CurrentT3Transaction,b:NativePerpsProofBinding,owner:string,after:boolean){
 const shard=after?t.after:t.before;if(!shard.account||shard.account.storage.state.type==='uninit')return 0n;
 const a=currentT3ActiveState(shard,b.perps.t3WalletHash),s=readT3WalletStorage(a.data);
 check(a.splitDepth===null&&raw(s.owner)===owner&&s.master.equals(b.perps.t3Root)&&s.proofCodeHash===BigInt('0x'+b.proofCodeHash)&&raw(contractAddress(0,{code:a.code,data:t3WalletInitialData(Address.parse(owner),b.perps.t3Root,s.proofCodeHash)}))===t.account,'canonical wallet');return s.balance;
}
function delta(t:CurrentT3Transaction,b:NativePerpsProofBinding,owner:string,n:bigint){check(t.succeeded&&t.after.account?.storage.state.type==='active'&&balance(t,b,owner,true)-balance(t,b,owner,false)===n,'physical T3 delta');}
function delivery(source:CurrentT3Transaction,target:CurrentT3Transaction,request:ReturnType<typeof decodeSpotTokenTransfer>,b:NativePerpsProofBinding,from:string,to:string){
 check(verifyCurrentT3MessageLink(source,target),'delivery link');const s=input(target,source.account).body.beginParse();check(s.loadUint(32)===T3_OP.T3_WALLET_DELIVERY,'T3 delivery');const a=t3WalletAttemptFromCell(s.loadRef());s.endParse();
 check(!a.burn&&a.originLt===source.tx.lt&&a.attempt===0n&&raw(a.owner)===from&&raw(a.recipient)===to&&a.amount===request.amount&&a.details.queryId===request.query&&raw(a.details.response)===request.response&&a.details.forwardValue===request.forwardValue&&a.details.customPayload===null&&either(a.details.forwardPayload.beginParse()).equals(request.payload),'exact delivery terms');delta(source,b,from,-request.amount);delta(target,b,to,request.amount);return target;
}
function reached(first:CurrentT3Transaction,txs:CurrentT3Transaction[]){const seen=new Set([first.hash]);for(const t of [...txs].sort((a,b)=>a.tx.lt<b.tx.lt?-1:1))if(!seen.has(t.hash)&&txs.some(a=>seen.has(a.hash)&&a.tx.lt<t.tx.lt&&verifyCurrentT3MessageLink(a,t)))seen.add(t.hash);return seen;}
export function decodeNativePerpsEvent(c:Cell){check(!c.isExotic,'ordinary event');const s=c.beginParse();check(s.loadUint(32)===0x50584556,'PX_EVENT');const e={kind:s.loadUint(8),reason:s.loadUint(16),owner:s.loadAddress(),marketId:s.loadUint(32),queryId:s.loadUintBig(64)},d=s.loadRef().beginParse();s.endParse();const detail={size:d.loadIntBig(128),fill:d.loadCoins(),marginDelta:d.loadIntBig(128),fee:d.loadCoins(),lpPayout:d.loadCoins(),unpaidLoss:d.loadCoins()};d.endParse();check(e.kind>=1&&e.kind<=11&&e.reason<=10,'event bounds');return{...e,...detail};}
function effect(p:PerpsEvidenceRequest,t:CurrentT3Transaction,status:PerpsEffect['status'],amount:bigint,gen:bigint|null,reason:number|null):PerpsEffect{return{status,requestBodyHash:p.bodyHash,transactionHash:t.hash,amountRaw:amount.toString(),gen:gen&&gen>0n?gen.toString():null,reason};}
const position=(s:ReturnType<typeof currentPerpsEngineBoundary>,key:bigint)=>{const c=s.book.positions.get(key);return c?decodeNativePerpsPosition(c):null;};
const equalCell=(a:Cell|undefined,b:Cell|undefined)=>a&&b?a.equals(b):!a&&!b;
function payoutTarget(source:CurrentT3Transaction,request:ReturnType<typeof decodeSpotTokenTransfer>,b:NativePerpsProofBinding,from:string,to:string,txs:CurrentT3Transaction[],used?:Set<string>):CurrentT3Transaction|null{
 used?.add(source.hash);if(!source.succeeded)return null;
 const direct=one(txs.filter(t=>maybe(()=>!!delivery(source,t,request,b,from,to))===true));if(direct){used?.add(direct.hash);return direct;}
 delta(source,b,from,-request.amount);
 const message=one(source.tx.outMessages.values().filter(m=>m.info.type==='internal'&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===T3_OP.T3_WALLET_DELIVERY));if(!message)return null;
 const original=t3WalletAttemptFromCell(message.body.refs[0]),terms=t3WalletAttemptToCell(original).refs[0];
 check(original.originLt===source.tx.lt&&original.attempt===0n&&!original.burn&&raw(original.owner)===from&&raw(original.recipient)===to&&original.amount===request.amount&&original.details.queryId===request.query&&raw(original.details.response)===request.response&&original.details.customPayload===null&&original.details.forwardValue===request.forwardValue&&either(original.details.forwardPayload.beginParse()).equals(request.payload),'original payout attempt');
 for(const t of txs){if(t.account!==source.account||t.tx.lt<=source.tx.lt)continue;const target=maybe(()=>{
  const s=input(t).body.beginParse();check(s.loadUint(32)===T3_OP.T3_WALLET_RETRY,'retry command');const record=s.loadRef(),proof=s.loadRef(),recipient=s.loadAddress();s.endParse();const r=readT3WalletRecord(record),a=r.attempt,w=readT3WalletStorage(currentT3ActiveState(t.before,b.perps.t3WalletHash).data);
  delta(t,b,from,0n);check(r.failed&&!r.cancelled&&a.id===original.id&&a.originLt===original.originLt&&t3WalletAttemptToCell(a).refs[0].equals(terms)&&raw(recipient)===to&&a.id<w.count&&verifyT3Witness(record,a.id,proof,w.root),'fixed retry witness');
  return one(txs.filter(target=>maybe(()=>{check(verifyCurrentT3MessageLink(t,target),'retry link');const s=input(target,source.account).body.beginParse();check(s.loadUint(32)===T3_OP.T3_WALLET_DELIVERY,'retry delivery');const n=t3WalletAttemptFromCell(s.loadRef());s.endParse();check(n.id===a.id&&n.originLt===a.originLt&&n.attempt===a.attempt+1n&&t3WalletAttemptToCell(n).refs[0].equals(terms),'retry terms');delta(target,b,to,request.amount);return true;})===true));
 });if(target){used?.add(t.hash);used?.add(target.hash);return target;}}
 return null;
}
function payout(...args:Parameters<typeof payoutTarget>){return !!payoutTarget(...args);}
function holderOwed(t:CurrentT3Transaction,b:NativePerpsProofBinding,holder:string,owner:string,after:boolean){
 const root=holder===raw(b.perps.engine)?currentPerpsEngineBoundary(t,b,after).ledger.owed:currentPerpsRiskBoundary(t,b,after).owed;return nativePerpsOwed(root,owner);
}
export function nativePerpsOwed(root:Cell|null,owner:string){
 if(!root)return 0n;
 const books=Dictionary.loadDirect(Dictionary.Keys.Uint(8),{serialize(){throw Error('read only');},parse(s){const total=s.loadCoins(),count=s.loadUint(16),entries=s.loadDict(Dictionary.Keys.Address(),Dictionary.Values.BigVarUint(4));s.loadMaybeRef();s.endParse();check(count===entries.size,'owed entry count');return{total,entries};}},root);
 return books.get(0)?.entries.get(Address.parse(owner))??0n;
}
function findOwedClaim(source:CurrentT3Transaction,request:ReturnType<typeof decodeSpotTokenTransfer>,b:NativePerpsProofBinding,holder:string,owner:string,txs:CurrentT3Transaction[],used?:Set<string>){
 used?.add(source.hash);
 if(source.succeeded)return null;
 const before=source.before.account?.storage.state,after=source.after.account?.storage.state;
 if(before?.type==='frozen')check(after?.type==='frozen'&&before.stateHash===after.stateHash,'frozen source preserved');else check(balance(source,b,holder,true)===balance(source,b,holder,false),'refused source did not debit');
 const bounce=one(txs.filter(t=>t.account===holder&&t.succeeded&&verifyCurrentT3MessageLink(source,t)&&t.tx.inMessage?.info.type==='internal'&&t.tx.inMessage.info.bounced&&maybe(()=>holderOwed(t,b,holder,owner,true)-holderOwed(t,b,holder,owner,false)===request.amount)===true));if(!bounce)return null;
 used?.add(bounce.hash);let previous=bounce;
 for(const t of txs.filter(t=>t.account===holder&&t.tx.lt>bounce.tx.lt).sort((a,b)=>a.tx.lt<b.tx.lt?-1:1)){
  used?.add(t.hash);check(t.tx.prevTransactionLt===previous.tx.lt&&t.tx.prevTransactionHash===BigInt('0x'+previous.hash),'continuous owed liability history');previous=t;
  const before=holderOwed(t,b,holder,owner,false),after=holderOwed(t,b,holder,owner,true);if(after>=before)continue;
  const s=input(t).body.beginParse();check(s.loadUint(32)===0x434c4d4a,'owed claim');const query=s.loadUintBig(64);check(s.loadUint(8)===0&&raw(s.loadAddress())===owner,'owed owner');s.endParse();check(t.succeeded&&after===0n&&before>=request.amount,'whole owed debit');
  const wallet=raw(holder===raw(b.perps.engine)?currentPerpsEngineBoundary(t,b).ledger.slots.get(0)?.wallet:currentPerpsRiskBoundary(t,b).slots.get(0)?.wallet);check(wallet,'owed wallet');return{t,wallet,before,query};
 }
 return null;
}
function recoveredOwed(source:CurrentT3Transaction,request:ReturnType<typeof decodeSpotTokenTransfer>,b:NativePerpsProofBinding,holder:string,owner:string,txs:CurrentT3Transaction[],depth:number,used?:Set<string>):{delivered:boolean;cash:CurrentPerpsCashLeg[]}{
 if(depth>16)return {delivered:false,cash:[] as CurrentPerpsCashLeg[]};const claim=findOwedClaim(source,request,b,holder,owner,txs,used);if(!claim)return {delivered:false,cash:[] as CurrentPerpsCashLeg[]};const{t,wallet,before,query}=claim;const p=paid(t,wallet,holder,owner,query,beginCell().storeUint(0x4a434c52,32).endCell(),b,txs,depth+1,used);check(p.amount===before,'owed aggregate payout');return {delivered:p.delivered,cash:p.cash.map(leg=>({...leg,aggregateOwed:true}))};
}
function transfers(t:CurrentT3Transaction,wallet:string,from:string,to:string,query:bigint,marker:Cell){
 return t.tx.outMessages.values().flatMap(m=>{if(m.info.type!=='internal'||m.info.bounced||raw(m.info.dest)!==wallet||raw(m.info.src)!==from)return[];const q=maybe(()=>decodeSpotTokenTransfer(m.body));return q&&q.owner===to&&q.response===to&&q.query===query&&q.custom===null&&q.forwardValue===0n&&q.payload.equals(marker)?[{m,q}]:[];});
}
export type CurrentPerpsCashLeg={direction:'in'|'out';amountRaw:string;ownerTransaction:string;debitTransaction:string;creditTransaction:string;wallet:string;otherOwner:string;aggregateOwed:boolean};
export function currentPerpsCash(source:CurrentT3Transaction,target:CurrentT3Transaction,from:string,to:string,amount:bigint,owner:string):CurrentPerpsCashLeg {
 const direction=from===owner?'out':'in',wallet=direction==='out'?source:target;
 return{direction,amountRaw:amount.toString(),ownerTransaction:wallet.hash,debitTransaction:source.hash,creditTransaction:target.hash,wallet:wallet.account,otherOwner:direction==='out'?to:from,aggregateOwed:false};
}
function paid(t:CurrentT3Transaction,wallet:string,from:string,to:string,query:bigint,marker:Cell,b:NativePerpsProofBinding,txs:CurrentT3Transaction[],depth=0,used?:Set<string>):{amount:bigint;delivered:boolean;cash:CurrentPerpsCashLeg[]}{
 used?.add(t.hash);const commands=transfers(t,wallet,from,to,query,marker);check(commands.length<=1,'unique payment');if(!commands.length)return{amount:0n,delivered:true,cash:[]};const{m,q}=commands[0];
 const source=one(txs.filter(s=>s.account===wallet&&verifyCurrentT3MessageLink(t,s)&&maybe(()=>input(s,from).body.equals(m.body))===true));
 if(!source)return{amount:q.amount,delivered:false,cash:[]};
 used?.add(source.hash);if(!source.succeeded)return{amount:q.amount,...recoveredOwed(source,q,b,from,to,txs,depth,used)};
 const target=payoutTarget(source,q,b,from,to,txs,used);
 return{amount:q.amount,delivered:!!target,cash:target?[currentPerpsCash(source,target,from,to,q.amount,to)]:[]};
}
function settlement(c:Cell){const s=c.beginParse(),marketId=s.loadUint(32),queryId=s.loadUintBig(64),gen=s.loadUintBig(64),body=s.loadRef();s.endParse();return{marketId,queryId,gen,body};}
function rvSettle(c:Cell){const s=c.beginParse();check(s.loadUint(32)===0x52565354,'RVST');const v={actionId:s.loadUintBig(64),bucket:s.loadUint(16),key:s.loadUintBig(256),payout:s.loadCoins(),notional:s.loadCoins(),reserved:s.loadCoins(),recipient:s.loadAddress()};s.endParse();return v;}
export function inspectNativePerpsEvidence(p:PerpsEvidenceRequest,b:NativePerpsProofBinding,evidence:readonly CurrentT3TransactionEvidence[]):PerpsEvidence{
 try{
  check(exact(p,['network','releaseId','manifestHash','owner','engine','riskVault','kind','marketId','queryId','gen','depositRaw','sourceWallet','bodyBoc','bodyHash','valueNano','createdAt','dispatch'])&&exact(p.dispatch,['lt','hash','valueNano']),'request shape');
  const trade=perpsRequestTrade({...p,validUntil:1}),{dispatch,...saved}=p;check(validPerpsRequest({...saved,validUntil:trade.deadline})&&p.network===b.network&&p.releaseId===b.releaseId&&p.manifestHash===b.manifestHash&&p.engine===raw(b.perps.engine)&&p.riskVault===raw(b.perps.riskVault)&&digest(b.riskVaultHash)&&digest(b.proofCodeHash),'request release');
  check(digest(dispatch.hash)&&/^[1-9]\d*$/.test(dispatch.lt)&&dispatch.valueNano===p.valueNano&&evidence.length<=256,'dispatch bounds');
  const txs=evidence.map(verifyCurrentT3Transaction);check(new Set(txs.map(t=>t.hash)).size===txs.length,'duplicate originals');
  const owner=one(txs.filter(t=>t.account===p.owner&&t.hash===dispatch.hash&&t.tx.lt.toString()===dispatch.lt));if(!owner)return{status:'pending'};check(owner.succeeded,'owner execution');
  const body=currentT3Cell(p.bodyBoc),first=one(txs.filter(t=>t.account===(p.sourceWallet??p.engine)&&verifyCurrentT3MessageLink(owner,t)&&maybe(()=>{const m=input(t,p.owner);return m.body.equals(body)&&m.info.type==='internal'&&m.info.value.coins===BigInt(p.valueNano);})===true));if(!first)return{status:'pending'};
  if(!first.succeeded)return{status:'pending'};const graph=reached(first,txs);let intake=first;
  if(p.sourceWallet){const q=decodeSpotTokenTransfer(body),recipient=payoutTarget(first,q,b,p.owner,p.engine,txs);if(!recipient)return{status:'pending'};for(const hash of reached(recipient,txs))graph.add(hash);
   const rows=txs.filter(t=>t.account===p.engine&&verifyCurrentT3MessageLink(recipient,t)&&maybe(()=>{const s=input(t,recipient.account).body.beginParse();check(s.loadUint(32)===0x7362d09c&&s.loadUintBig(64)===q.query&&s.loadCoins()===q.amount&&raw(s.loadAddress())===p.owner,'funding notification');return either(s).equals(q.payload);})===true);const chosen=one(rows);if(!chosen)return{status:'pending'};intake=chosen;
  }
  if(!intake.succeeded)return{status:'pending'};const initial=currentPerpsEngineBoundary(intake,b,false),started=currentPerpsEngineBoundary(intake,b),key=nativePerpsPositionKey(Address.parse(p.owner),p.marketId),query=BigInt(p.queryId),deposit=BigInt(p.depositRaw);
  const events=txs.filter(t=>t.account===p.engine&&t.succeeded&&graph.has(t.hash)).flatMap(t=>t.tx.outMessages.values().flatMap(m=>{if(m.info.type!=='external-out'||raw(m.info.src)!==p.engine)return[];const e=maybe(()=>decodeNativePerpsEvent(m.body));return e&&raw(e.owner)===p.owner&&e.marketId===p.marketId&&e.queryId===query&&e.kind<=8?[{t,e}]:[];}));
  const terminal=one(events);if(!terminal){
   if(p.sourceWallet&&events.length===0&&equalCell(initial.book.positions.get(key),started.book.positions.get(key))&&equalCell(initial.book.pendings.get(key),started.book.pendings.get(key))){const wallet=raw(started.ledger.slots.get(0)?.wallet);check(wallet,'intake refund wallet');const refund=paid(intake,wallet,p.engine,p.owner,query,Cell.EMPTY,b,txs);if(refund.amount===deposit)return effect(p,intake,refund.delivered?'refunded':'accepted',deposit,p.gen===null?null:BigInt(p.gen),null);}
   return{status:'pending'};
  }
  const{t,e}=terminal,before=currentPerpsEngineBoundary(t,b,false),after=currentPerpsEngineBoundary(t,b),old=position(before,key),next=position(after,key),expected={open:1,increase:2,addMargin:3,removeMargin:4,close:5,funding:7}[p.kind];
  check(e.kind===8||e.kind===expected,'operation outcome');check(e.size===(next?.size??0n)&&e.marginDelta===(next?.margin??0n)-(old?.margin??0n)&&e.fee===after.book.feesAccrued-before.book.feesAccrued,'event/state agreement');
  const pending=started.book.pendings.get(key),prior=pending?decodeNativePerpsPending(pending):null;
  if(p.kind==='open'||p.kind==='increase'){
   check(prior&&raw(prior.owner)===p.owner&&prior.queryId===query&&prior.marketId===p.marketId&&prior.deposit===deposit&&prior.terms.size===trade.size&&prior.terms.limit===trade.limit&&prior.terms.deadline===trade.deadline&&prior.terms.gen===(p.gen===null?prior.nonce:BigInt(p.gen)),'original pending');
   const current=before.book.pendings.get(key);check(current&&decodeNativePerpsPending(current).nonce===prior.nonce&&!after.book.pendings.has(key),'pending consumed');
  }
  const generation=next?.gen??old?.gen??(p.gen===null?prior?.terms.gen??null:BigInt(p.gen));
  if(e.kind===8){check(e.reason>=1&&equalCell(before.book.positions.get(key),after.book.positions.get(key)),'refusal preserves position');if(deposit===0n)return effect(p,t,'rejected',0n,generation,e.reason);
   const wallet=raw(after.ledger.slots.get(0)?.wallet);check(wallet,'refund wallet');const refund=paid(t,wallet,p.engine,p.owner,query,Cell.EMPTY,b,txs);check(refund.amount===deposit,'exact deposit refund');return effect(p,t,refund.delivered?'refunded':'accepted',deposit,generation,e.reason);
  }
  check(e.reason===0,'successful reason');
  if(p.kind==='open'||p.kind==='increase'){
   check(next&&next.gen===prior!.terms.gen&&next.size===(old?.size??0n)+trade.size!,'committed position');
   const rv=one(txs.filter(r=>r.account===p.riskVault&&r.succeeded&&graph.has(r.hash)&&verifyCurrentT3MessageLink(r,t)));check(rv,'risk target execution');
   const s=input(t,p.riskVault).body.beginParse();check(s.loadUint(32)===0x52565441&&s.loadUintBig(64)===prior!.nonce&&s.loadUint(16)===1&&s.loadUintBig(256)===key&&s.loadUint(8)===1&&s.loadUint(16)===0&&s.loadCoins()===next.entryNotional&&s.loadCoins()===next.counterparty.reserved,'risk answer');s.endParse();
   currentPerpsRiskBoundary(rv,b,false);const rb=currentPerpsRiskBoundary(rv,b),lk=BigInt('0x'+beginCell().storeUint(1,16).storeUint(key,256).endCell().hash().toString('hex')),liability=rb.liabilities.get(lk);check(liability&&liability.actionId===prior!.nonce&&liability.outcome===1&&liability.applied&&liability.notional===next.entryNotional&&liability.reserved===next.counterparty.reserved,'risk reservation');
   return effect(p,t,'confirmed',deposit,next.gen,null);
  }
  if(p.kind==='addMargin'){check(t.hash===intake.hash&&old&&next&&next.gen===BigInt(p.gen!)&&next.size===old.size&&next.margin===old.margin+deposit&&next.entryNotional===old.entryNotional&&next.lastFundingIndex===old.lastFundingIndex,'margin addition');return effect(p,t,'confirmed',deposit,next.gen,null);}
  check(old&&old.gen===BigInt(p.gen!)&&(!next||next.gen===old.gen),'exit generation');const wallet=raw(after.ledger.slots.get(0)?.wallet);check(wallet,'engine payout wallet');const local=paid(t,wallet,p.engine,p.owner,query,Cell.EMPTY,b,txs);
  if(p.kind==='removeMargin')check(next&&local.amount===trade.amount,'exact margin removal');
  const record=after.book.settlements.get(key);let lp=0n,lpDelivered=true;
  if(record){const r=settlement(record),command=rvSettle(r.body);check(r.marketId===p.marketId&&r.queryId===query&&r.gen===old.gen&&command.bucket===1&&command.key===key&&raw(command.recipient)===p.owner&&command.payout===e.lpPayout,'position settlement');lp=command.payout;
   const executions=txs.filter(v=>v.account===p.riskVault&&v.succeeded&&maybe(()=>input(v,p.engine).body.equals(r.body))===true).filter(v=>txs.some(sender=>sender.account===p.engine&&sender.succeeded&&verifyCurrentT3MessageLink(sender,v)&&(sender.hash===t.hash||maybe(()=>{const state=currentPerpsEngineBoundary(sender,b,false),saved=state.book.settlements.get(key);return !!saved&&saved.equals(record);})===true)));
   const rv=executions.sort((a,b)=>a.tx.lt<b.tx.lt?-1:1)[0];if(!rv)lpDelivered=false;else{currentPerpsRiskBoundary(rv,b,false);const rb=currentPerpsRiskBoundary(rv,b),lk=BigInt('0x'+beginCell().storeUint(1,16).storeUint(key,256).endCell().hash().toString('hex')),liability=rb.liabilities.get(lk),rvWallet=raw(rb.slots.get(0)?.wallet);check(liability&&liability.actionId===command.actionId&&liability.outcome===3&&rvWallet,'risk settlement accounting');
    const payment=paid(rv,rvWallet,p.riskVault,p.owner,0n,beginCell().storeUint(0x4a434c52,32).endCell(),b,txs);check(payment.amount===liability.paid,'risk paid command');lpDelivered=liability.applied&&liability.paid===lp&&payment.delivered;
   }
  }else check(e.lpPayout===0n,'no unbacked LP payout');
  return effect(p,t,local.delivered&&lpDelivered?'confirmed':'accepted',local.amount+lp,generation,null);
 }catch{return{status:'unavailable'};}
}
export type PerpsTransferOrigin={role:'engine'|'risk-vault'|'owner';wallet:string;owner:string;recipient:string;transactionHash:string;lt:string;attemptBoc:string};
/** Exact original source debits causally downstream of the signed operation.
 * These authorize discovery only; a claim/mark never establishes delivery. */
export function inspectNativePerpsRecoveryOrigins(p:PerpsEvidenceRequest,b:NativePerpsProofBinding,evidence:readonly CurrentT3TransactionEvidence[]):PerpsTransferOrigin[]{
 try{
  const outcome=inspectNativePerpsEvidence(p,b,evidence);check(outcome.status!=='unavailable','operation authority');
  const txs=evidence.map(verifyCurrentT3Transaction),owner=one(txs.filter(t=>t.account===p.owner&&t.hash===p.dispatch.hash&&t.tx.lt.toString()===p.dispatch.lt));check(owner?.succeeded,'original dispatch');
  const body=currentT3Cell(p.bodyBoc),first=one(txs.filter(t=>t.account===(p.sourceWallet??p.engine)&&verifyCurrentT3MessageLink(owner,t)&&maybe(()=>{const m=input(t,p.owner);return m.body.equals(body)&&m.info.type==='internal'&&m.info.value.coins===BigInt(p.valueNano);})===true));check(first?.succeeded,'original first execution');const graph=reached(first,txs),origins:PerpsTransferOrigin[]=[];if(p.sourceWallet){const target=payoutTarget(first,decodeSpotTokenTransfer(body),b,p.owner,p.engine,txs);if(target)for(const hash of reached(target,txs))graph.add(hash);}
  if('transactionHash' in outcome){const terminal=txs.find(t=>t.hash===outcome.transactionHash),key=nativePerpsPositionKey(Address.parse(p.owner),p.marketId),record=terminal?currentPerpsEngineBoundary(terminal,b).book.settlements.get(key):null;
   if(record){const saved=settlement(record);for(const v of txs)if(v.account===p.riskVault&&v.succeeded&&maybe(()=>input(v,p.engine).body.equals(saved.body))===true&&txs.some(t=>t.account===p.engine&&t.succeeded&&verifyCurrentT3MessageLink(t,v)&&maybe(()=>currentPerpsEngineBoundary(t,b,false).book.settlements.get(key)?.equals(record))===true))for(const hash of reached(v,txs))graph.add(hash);}
  }
  for(let round=0;round<16;round++){const beforeSize=graph.size;for(const t of txs){if(t.succeeded||!graph.has(t.hash))continue;const m=t.tx.inMessage;if(m?.info.type!=='internal'||m.info.bounced)continue;const holder=raw(m.info.src);if(holder!==p.engine&&holder!==p.riskVault)continue;const q=maybe(()=>decodeSpotTokenTransfer(m.body));if(!q||q.owner!==p.owner)continue;const claim=findOwedClaim(t,q,b,holder,p.owner,txs);if(claim)for(const hash of reached(claim.t,txs))graph.add(hash);}if(graph.size===beforeSize)break;}
  for(const t of txs){if(!t.succeeded||!graph.has(t.hash))continue;
   const m=t.tx.inMessage;if(m?.info.type!=='internal'||m.info.bounced)continue;const from=raw(m.info.src),role=from===p.engine?'engine':from===p.riskVault?'risk-vault':from===p.owner&&t.hash===first.hash?'owner':null;if(!role)continue;
   const q=maybe(()=>decodeSpotTokenTransfer(m.body));if(!q||q.owner!==(role==='owner'?p.engine:p.owner)||q.amount<=0n)continue;
   if(role!=='owner'){const sender=one(txs.filter(v=>v.account===from&&v.succeeded&&graph.has(v.hash)&&verifyCurrentT3MessageLink(v,t)));check(sender,'holder source command');if(role==='engine'){currentPerpsEngineBoundary(sender,b,false);currentPerpsEngineBoundary(sender,b);}else{currentPerpsRiskBoundary(sender,b,false);currentPerpsRiskBoundary(sender,b);}}
   delta(t,b,from!, -q.amount);const message=one(t.tx.outMessages.values().filter(v=>v.info.type==='internal'&&v.body.bits.length>=32&&v.body.beginParse().preloadUint(32)===T3_OP.T3_WALLET_DELIVERY));check(message,'initial delivery');
   const a=t3WalletAttemptFromCell(message.body.refs[0]),state=readT3WalletStorage(currentT3ActiveState(t.before,b.perps.t3WalletHash).data);
   check(a.id===state.count&&a.originLt===t.tx.lt&&a.attempt===0n&&!a.burn&&raw(a.owner)===from&&raw(a.recipient)===q.owner&&a.amount===q.amount&&a.details.queryId===q.query&&raw(a.details.response)===q.response&&a.details.customPayload===null&&a.details.forwardValue===q.forwardValue&&either(a.details.forwardPayload.beginParse()).equals(q.payload),'initial claim authority');
   origins.push({role,wallet:t.account,owner:from!,recipient:q.owner,transactionHash:t.hash,lt:t.tx.lt.toString(),attemptBoc:t3WalletAttemptToCell(a).toBoc().toString('base64')});
  }
  check(origins.length<=32,'origin bound');return origins;
 }catch{return[];}
}


export function perpsRequestTrade(r: Pick<PerpsEvidenceRequest,'bodyBoc'|'sourceWallet'|'queryId'|'depositRaw'|'engine'|'owner'> & {validUntil?: number}) {
 const c = currentT3Cell(r.bodyBoc); const q = r.sourceWallet ? decodeSpotTokenTransfer(c) : null;
 if (q) check(q.query.toString() === r.queryId && q.amount.toString() === r.depositRaw && q.owner === r.engine && q.response === r.owner && q.custom === null && q.forwardValue > 0n, 'funding request');
 return decodeNativePerpsTrade(q ? q.payload : c);
}
function validPerpsRequest(r: Omit<PerpsEvidenceRequest,'dispatch'> & {validUntil: number}) {
 try {
  for (const a of [r.owner,r.engine,r.riskVault,...(r.sourceWallet?[r.sourceWallet]:[])]) check(Address.parse(a).workChain===0 && Address.parse(a).toRawString()===a,'canonical request account');
  const t = perpsRequestTrade(r); const c = currentT3Cell(r.bodyBoc);
  check(c.hash().toString('hex') === r.bodyHash && digest(r.manifestHash) && Number.isSafeInteger(r.createdAt) && r.createdAt > 0, 'request identity');
  for (const n of [r.depositRaw,r.valueNano]) check(/^(0|[1-9]\d*)$/.test(n) && BigInt(n)<1n<<120n,'request amount');
  check(BigInt(r.valueNano)>0n && t.kind===r.kind && t.marketId===r.marketId && t.queryId.toString()===r.queryId && (t.gen?.toString()??null)===r.gen && r.validUntil<=t.deadline && r.validUntil>0,'request trade');
  return (r.sourceWallet!==null)===(BigInt(r.depositRaw)>0n) && (!r.sourceWallet||['open','increase','addMargin'].includes(r.kind)) && (!['open','addMargin'].includes(r.kind)||BigInt(r.depositRaw)>0n);
 } catch {return false;}
}
export function currentPerpsBindingFromManifest(m: import('../config/runtimeManifest').RuntimeReleaseManifest): NativePerpsProofBinding {
 const pin=(key:keyof typeof m.contracts)=>{const p=m.contracts[key];check(p,'manifest peer '+key);return{address:Address.parse(p.address),hash:p.codeHash};};
 const e=pin('PerpsEngine'),r=pin('RiskVault'),hub=pin('T3Hub'),t=m.tokens.find(t=>t.symbol==='T3');
 check(t && t.root===hub.address.toRawString() && t.masterCodeHash===hub.hash && t.walletCodeHash===m.templates.T3Wallet,'T3 manifest identity');
 return {network:m.network.slice(4),releaseId:m.releaseId,manifestHash:m.manifestHash,riskVaultHash:r.hash,proofCodeHash:m.templates.T3RecoveryProof,
  perps:{engine:e.address,engineHash:e.hash,governance:pin('Governance').address,feeSink:pin('FeeRouter').address,treasury:pin('Treasury').address,riskVault:r.address,
   t3Root:hub.address,t3MasterHash:hub.hash,t3WalletHash:t.walletCodeHash,poolHash:m.templates.DlmmPool,markets:new Map(m.perpsMarkets.map(p=>[p.marketId,Address.parse(p.pool)]))}};
}

export { paid as proveCurrentPerpsPayment, payoutTarget as currentPerpsPayoutTarget, decodeSpotTokenTransfer as decodeCurrentPerpsTransfer, verifyCurrentT3MessageLink as currentPerpsMessageLink, reached as currentPerpsDescendants, settlement as currentPerpsSettlement, rvSettle as currentPerpsRiskSettlement };
export type { CurrentT3Transaction as CurrentPerpsTransaction };
