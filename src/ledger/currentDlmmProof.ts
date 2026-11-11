import { Address, beginCell, Cell, Dictionary, type Slice } from '@ton/core';
import { decodeNativeLiqAdd, decodeNativeLiqRemove, decodeNativeFarm, poolBinValue, POOL_OP, readCurrentDlmmPool, type NativePoolPosition } from './currentDlmmState';
import {decodeSpotTokenTransfer,verifySpotMessageLink,verifySpotPoolBoundary,verifySpotTokenDelivery,verifySpotWalletDelta,currentT3Cell,currentT3ActiveState,verifyCurrentT3Transaction,readT3WalletStorage,readT3WalletRecord,t3WalletAttemptFromCell,t3WalletAttemptToCell,verifyT3Witness,T3_OP,type SpotProofBinding,type CurrentT3Transaction,type CurrentT3TransactionEvidence} from './currentDlmmPhysical';
export type {CurrentDlmmConfigBinding,CurrentDlmmProofBinding} from './currentDlmmPhysical';
export {currentDlmmBindingFromManifest} from './currentDlmmPhysical';
export type PoolEvidenceRequest={network:'testnet'|'mainnet'|'localnet';releaseId:string;manifestHash:string;kind:'add'|'farm-create'|'farm-action'|'remove'|'owed';owner:string;pool:string;side:0|1;queryId:string;amountRaw:string;binId:number|null;farmId:string|null;action:number|null;sourceWallet:string|null;bodyBoc:string;bodyHash:string;valueNano:string;createdAt:number;dispatch:{lt:string;hash:string;valueNano:string}};
export type PoolTransferOrigin={wallet:string;transactionHash:string;lt:string;attemptBoc:string};
export type PoolOperationEffect={status:'credited'|'delivered'|'refunded'|'accepted';bodyHash:string;transactionHash:string;lt:string;utime:number;amountRaw:string;farmId?:string;mintedSharesRaw?:string;sharesBeforeRaw?:string;sharesAfterRaw?:string;returnedT3Raw?:string;returnedXRaw?:string;recoveredT3Raw?:string};
export type PoolOperationEvidence=PoolOperationEffect|{status:'pending'|'unavailable';transferOrigins?:PoolTransferOrigin[]};
export type PoolProofBinding=Omit<SpotProofBinding,'dispatch'>;
const raw=(a:Address|null|undefined)=>a?.toRawString()??null;
const one=<T>(v:T[])=>v.length===1?v[0]:null;
const maybe=<T>(f:()=>T)=>{try{return f();}catch{return null;}};
function requireProof(v:unknown,why:string):asserts v{if(!v)throw Error(`Current pool proof: ${why}`);}
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function input(t:CurrentT3Transaction,source?:string){const m=t.tx.inMessage;requireProof(m?.info.type==='internal'&&!m.info.bounced&&(!source||raw(m.info.src)===source),'input');return m;}
function either(s:Slice){if(s.loadBit()){const c=s.loadRef();s.endParse();return c;}return beginCell().storeSlice(s).endCell();}
export function nativePoolBook(data:Cell,owner:string,pool:string){const s=readCurrentDlmmPool(data,pool);return{...s,positions:s.positions.get(owner)??new Map<number,NativePoolPosition>()};}
function books(t:CurrentT3Transaction,b:PoolProofBinding,owner:string){verifySpotPoolBoundary(t,b);const pin=b.identity.release.templates.DlmmPool;return{before:nativePoolBook(currentT3ActiveState(t.before,pin).data,owner,b.identity.pool),after:nativePoolBook(currentT3ActiveState(t.after,pin).data,owner,b.identity.pool)};}
function effect(p:PoolEvidenceRequest,t:CurrentT3Transaction,status:PoolOperationEffect['status'],amount:bigint):PoolOperationEffect{return{status,bodyHash:p.bodyHash,transactionHash:t.hash,lt:t.tx.lt.toString(),utime:t.tx.now,amountRaw:amount.toString()};}
function payout(p:PoolEvidenceRequest,t:CurrentT3Transaction,b:PoolProofBinding,txs:CurrentT3Transaction[],amount:bigint,kind:number,status:'delivered'|'refunded'):PoolOperationEvidence{
 if(amount===0n)return effect(p,t,status,0n);const from=b.wallets.poolPay,to=b.wallets.pay;
 const sources=txs.filter(s=>s.account===from.address&&s.succeeded&&verifySpotMessageLink(t,s)).filter(s=>maybe(()=>{const req=decodeSpotTokenTransfer(input(s,p.pool).body),q=req.payload.beginParse();requireProof(req.query===BigInt(p.queryId)&&req.amount===amount&&req.owner===p.owner&&req.custom===null,'payout terms');if(p.kind==='owed'){requireProof(q.loadUint(32)===0x4a434c52,'owed receipt');}else{requireProof(q.loadUint(32)===POOL_OP.payout&&q.loadUint(8)===kind&&q.loadUintBig(64)===BigInt(p.queryId),'payout payload');q.loadUint(8);}q.endParse();return true;})===true);
 const source=one(sources);if(!source)return{status:'pending'};const req=decodeSpotTokenTransfer(input(source,p.pool).body),target=one(txs.filter(d=>maybe(()=>{verifySpotTokenDelivery(source,d,req,from,to,b);return true;})===true));
 if(target)return effect(p,target,status,amount);
 if(from.root!==b.identity.t3.root)return{status:'pending'};
 // Recovery starts at the original pool-authorized physical debit. An event or
 // current claim alone cannot associate a failed transfer with this operation.
 verifySpotWalletDelta(source,from,-amount,b);
 const outgoing=one(source.tx.outMessages.values().filter(m=>m.info.type==='internal'&&!m.info.bounced&&m.info.dest.toRawString()===to.address&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===T3_OP.T3_WALLET_DELIVERY));
 if(!outgoing)return{status:'pending'};
 const body=outgoing.body.beginParse();body.loadUint(32);const initial=t3WalletAttemptFromCell(body.loadRef());body.endParse();
 requireProof(initial.originLt===source.tx.lt&&initial.attempt===0n&&!initial.burn&&raw(initial.owner)===p.pool&&raw(initial.recipient)===p.owner&&initial.amount===amount&&initial.details.queryId===req.query&&raw(initial.details.response)===req.response&&initial.details.forwardValue===req.forwardValue&&initial.details.customPayload===null&&either(initial.details.forwardPayload.beginParse()).equals(req.payload),'original recovery attempt');
 const terms=t3WalletAttemptToCell(initial).refs[0],walletHash=b.identity.release.templates.T3Wallet;
 const retried=txs.filter(t=>t.account===source.account&&t.succeeded&&t.tx.lt>source.tx.lt).flatMap(retry=>{
  const recovered=maybe(()=>{
   const s=input(retry).body.beginParse();requireProof(s.loadUint(32)===T3_OP.T3_WALLET_RETRY,'wallet retry');const record=s.loadRef(),proof=s.loadRef(),recipient=s.loadAddress();s.endParse();
   const r=readT3WalletRecord(record),a=r.attempt,state=readT3WalletStorage(currentT3ActiveState(retry.before,walletHash).data);
   verifySpotWalletDelta(retry,from,0n,b);
   requireProof(r.failed&&!r.cancelled&&a.id===initial.id&&a.originLt===initial.originLt&&a.attempt<(1n<<64n)-1n&&t3WalletAttemptToCell(a).refs[0].equals(terms)&&recipient.equals(initial.recipient)&&a.id<state.count&&verifyT3Witness(record,a.id,proof,state.root),'authenticated fixed retry');
   return one(txs.filter(t=>maybe(()=>{
    requireProof(t.account===to.address&&verifySpotMessageLink(retry,t),'retry recipient link');const s=input(t,retry.account).body.beginParse();requireProof(s.loadUint(32)===T3_OP.T3_WALLET_DELIVERY,'retry delivery');const next=t3WalletAttemptFromCell(s.loadRef());s.endParse();
    requireProof(next.id===a.id&&next.originLt===a.originLt&&next.attempt===a.attempt+1n&&t3WalletAttemptToCell(next).refs[0].equals(terms),'same retry terms');verifySpotWalletDelta(t,to,amount,b);return true;
   })===true));
  });return recovered?[recovered]:[];
 });
 const recovered=one(retried);return recovered?{...effect(p,recovered,status,amount),recoveredT3Raw:amount.toString()}:{status:'pending',transferOrigins:[{wallet:source.account,transactionHash:source.hash,lt:source.tx.lt.toString(),attemptBoc:t3WalletAttemptToCell(initial).toBoc().toString('base64')}]};
}
/** Caller authenticates the preceding authorization graph. This verifier binds
 * its exact pool input, the LP owner's original share decrease, and both physical
 * recipient credits. A zero row share means the native complete-position burn. */
export function verifyNativePoolRemoval(poolTx:CurrentT3Transaction,owner:string,recipient:string,body:Cell,b:PoolProofBinding,txs:CurrentT3Transaction[]):{status:'delivered'|'pending';returnedT3Raw:string;returnedXRaw:string;recoveredT3Raw?:string;transferOrigins?:PoolTransferOrigin[]}{
 requireProof(poolTx.account===b.identity.pool&&poolTx.succeeded&&input(poolTx,owner).body.equals(body),'removal pool input');
 const q=body.beginParse();requireProof(q.loadUint(32)===POOL_OP.remove,'removal opcode');const queryId=q.loadUintBig(64);requireProof(raw(q.loadAddress())===recipient,'removal recipient');const deadline=q.loadUint(32),minT=q.loadCoins(),minX=q.loadCoins(),count=q.loadUint(3);let next:Cell|null=q.loadRef();q.endParse();requireProof(count>0&&count<=2&&deadline>=poolTx.tx.now,'removal terms');
 const state=books(poolTx,b,owner);let totalT=0n,totalX=0n,last=-200001;
 for(let i=0;i<count;i++){requireProof(next,'removal rows');const row=next.beginParse(),binId=row.loadInt(32),requested=row.loadUintBig(256);next=row.loadMaybeRef();row.endParse();requireProof(binId>last&&Math.abs(binId)<=200000,'removal bin');last=binId;
  const before=state.before.positions.get(binId)?.shares??0n,burned=requested===0n?before:requested,after=state.after.positions.get(binId)?.shares??0n;requireProof(burned>0n&&before-after===burned,'removed owner shares');
  const event=one(poolTx.tx.outMessages.values().flatMap(m=>{if(m.info.type!=='external-out')return[];const e=maybe(()=>{const v=m.body.beginParse();requireProof(v.loadUint(32)===POOL_OP.event&&v.loadUint(8)===2&&v.loadUintBig(64)===queryId&&raw(v.loadAddress())===owner&&v.loadInt(32)===binId&&v.loadUintBig(256)===burned,'removal event');const a=v.loadRef().beginParse(),t=a.loadCoins(),x=a.loadCoins();a.endParse();v.loadInt(32);v.endParse();return{t,x};});return e?[e]:[];}));requireProof(event,'removal event missing');const originalBin=state.before.bins.get(binId),remainingBin=state.after.bins.get(binId);requireProof(originalBin&&originalBin.shares>=burned&&event.t===originalBin.t*burned/originalBin.shares&&event.x===originalBin.x*burned/originalBin.shares&&(remainingBin?.t??0n)===originalBin.t-event.t&&(remainingBin?.x??0n)===originalBin.x-event.x&&(remainingBin?.shares??0n)===originalBin.shares-burned,'removal reserve/share conservation');totalT+=event.t;totalX+=event.x;
 }
 requireProof(!next&&totalT>=minT&&totalX>=minX,'removal minimums');
 const p={kind:'remove',owner:recipient,pool:b.identity.pool,queryId:queryId.toString(),bodyHash:body.hash().toString('hex')} as PoolEvidenceRequest;
 const first=payout(p,poolTx,b,txs,totalT,2,'delivered'),other:PoolProofBinding={...b,identity:{...b.identity,inSide:1},wallets:{pay:b.wallets.receive,poolPay:b.wallets.poolReceive,receive:b.wallets.pay,poolReceive:b.wallets.poolPay}},second=payout(p,poolTx,other,txs,totalX,2,'delivered');
 const transferOrigins=[...('transferOrigins'in first?first.transferOrigins??[]:[]),...('transferOrigins'in second?second.transferOrigins??[]:[])];
 return{status:first.status==='delivered'&&second.status==='delivered'?'delivered':'pending',returnedT3Raw:totalT.toString(),returnedXRaw:totalX.toString(),...('recoveredT3Raw'in first&&first.recoveredT3Raw?{recoveredT3Raw:first.recoveredT3Raw}:{}),...(transferOrigins.length?{transferOrigins}:{})};
}
function farmEvent(t:CurrentT3Transaction,p:PoolEvidenceRequest){return one(t.tx.outMessages.values().flatMap(m=>{if(m.info.type!=='external-out')return[];const e=maybe(()=>{const s=m.body.beginParse();requireProof(s.loadUint(32)===POOL_OP.farmEvent,'farm event');const r={kind:s.loadUint(8),query:s.loadUintBig(64),id:s.loadUintBig(64),owner:raw(s.loadAddress()),amount:s.loadCoins(),weight:s.loadUintBig(128)};s.endParse();return r;});return e&&e.query===BigInt(p.queryId)&&e.owner===p.owner?[e]:[];}));}
export function inspectPoolOperation(p:PoolEvidenceRequest,b:PoolProofBinding,evidence:readonly CurrentT3TransactionEvidence[]):PoolOperationEvidence{try{
 const uint=(v:unknown,bits:number)=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&v.length<=78&&BigInt(v)<1n<<BigInt(bits);
 requireProof(p&&['add','farm-create','farm-action','remove','owed'].includes(p.kind)&&[0,1].includes(p.side)&&[p.owner,p.pool].every(v=>Address.parse(v).toRawString()===v)&&uint(p.queryId,64)&&p.queryId!=='0'&&uint(p.amountRaw,120)&&uint(p.valueNano,120)&&p.valueNano!=='0'&&Number.isSafeInteger(p.createdAt)&&p.createdAt>0,'request terms');
 if(p.kind==='add'||p.kind==='farm-create')requireProof(p.binId!==null&&Number.isInteger(p.binId)&&Math.abs(p.binId)<=200000&&p.farmId===null&&p.action===null&&p.amountRaw!=='0','token metadata');
 if(p.kind==='farm-action')requireProof(p.binId!==null&&Number.isInteger(p.binId)&&Math.abs(p.binId)<=200000&&uint(p.farmId,64)&&p.farmId!=='0'&&p.action!==null&&Number.isInteger(p.action)&&p.action>=1&&p.action<=5&&p.sourceWallet===null&&p.amountRaw==='0','farm metadata');
 if(p.kind==='remove'||p.kind==='owed')requireProof(p.binId===null&&p.farmId===null&&p.action===null&&p.sourceWallet===null&&(p.kind==='remove'?p.side===0&&p.amountRaw==='0':p.amountRaw!=='0'),'exit metadata');
 const r=b.identity.release;requireProof(p.releaseId===r.releaseId&&p.manifestHash===r.manifestHash&&r.network===`ton:${p.network}`&&p.pool===b.identity.pool&&p.side===b.identity.inSide&&/^[0-9a-f]{64}$/.test(p.bodyHash)&&p.valueNano===p.dispatch.valueNano&&/^[1-9]\d*$/.test(p.dispatch.lt)&&/^[0-9a-f]{64}$/.test(p.dispatch.hash),'release/dispatch');
 const body=currentT3Cell(p.bodyBoc);requireProof(body.hash().toString('hex')===p.bodyHash&&evidence.length<=256,'body/bounds');
 const txs=evidence.map(verifyCurrentT3Transaction);requireProof(new Set(txs.map(t=>t.hash)).size===txs.length&&new Set(txs.map(t=>t.account)).size<=16&&txs.reduce((n,t)=>n+t.tx.outMessages.size,0)<=1024,'transaction graph bounds');
 const dispatch=one(txs.filter(t=>t.account===p.owner&&t.tx.lt.toString()===p.dispatch.lt&&t.hash===p.dispatch.hash&&t.succeeded));if(!dispatch)return{status:'pending'};
 const token=p.kind==='add'||p.kind==='farm-create',destination=token?p.sourceWallet:p.pool;requireProof(!token||destination===b.wallets.pay.address,'source wallet');
 const first=one(txs.filter(t=>t.account===destination&&verifySpotMessageLink(dispatch,t)&&maybe(()=>{const m=input(t,p.owner);return m.body.equals(body)&&m.info.type==='internal'&&m.info.value.coins.toString()===p.valueNano;})===true));if(!first||!first.succeeded)return{status:'pending'};
 let poolTx=first,transfer:ReturnType<typeof decodeSpotTokenTransfer>|null=null;
 if(token){transfer=decodeSpotTokenTransfer(body);requireProof(transfer.query===BigInt(p.queryId)&&transfer.amount===BigInt(p.amountRaw)&&transfer.owner===p.pool&&transfer.response===p.owner&&transfer.custom===null,'transfer authorization');
  const credit=one(txs.filter(t=>maybe(()=>{verifySpotTokenDelivery(first,t,transfer!,b.wallets.pay,b.wallets.poolPay,b);return true;})===true));if(!credit)return{status:'pending'};
  const accepted=one(txs.filter(t=>t.account===p.pool&&t.succeeded&&verifySpotMessageLink(credit,t)&&maybe(()=>{const s=input(t,credit.account).body.beginParse();requireProof(s.loadUint(32)===0x7362d09c&&s.loadUintBig(64)===transfer!.query&&s.loadCoins()===transfer!.amount&&raw(s.loadAddress())===p.owner&&either(s).equals(transfer!.payload),'notification');return true;})===true));if(!accepted)return{status:'pending'};poolTx=accepted;
 }
 const state=books(poolTx,b,p.owner);
 if(p.kind==='add'){
  const add=decodeNativeLiqAdd(transfer!.payload);requireProof(add.owner===p.owner&&add.binId===p.binId&&add.amount===BigInt(p.amountRaw),'add terms');
  const event=one(poolTx.tx.outMessages.values().flatMap(m=>{if(m.info.type!=='external-out')return[];const e=maybe(()=>{const s=m.body.beginParse();requireProof(s.loadUint(32)===POOL_OP.event&&s.loadUint(8)===1&&s.loadUintBig(64)===BigInt(p.queryId)&&raw(s.loadAddress())===p.owner&&s.loadInt(32)===p.binId,'liquidity event');const shares=s.loadUintBig(256),a=s.loadRef().beginParse(),t=a.loadCoins(),x=a.loadCoins();a.endParse();s.loadInt(32);s.endParse();return{shares,t,x};});return e?[e]:[];}));
  if(event){const before=state.before.positions.get(add.binId)?.shares??0n,after=state.after.positions.get(add.binId)?.shares??0n;requireProof(event.shares>=add.minShares&&after-before===event.shares&&(p.side===0?event.t===add.amount&&event.x===0n:event.x===add.amount&&event.t===0n),'mint delta');return{...effect(p,poolTx,'credited',add.amount),mintedSharesRaw:event.shares.toString(),sharesBeforeRaw:before.toString(),sharesAfterRaw:after.toString()};}
  requireProof((state.before.positions.get(add.binId)?.shares??0n)===(state.after.positions.get(add.binId)?.shares??0n),'refusal minted shares');return payout(p,poolTx,b,txs,add.amount,1,'refunded');
 }
 if(p.kind==='farm-create'){
  const s=transfer!.payload.beginParse();requireProof(s.loadUint(32)===POOL_OP.farmCreate&&s.loadInt(32)===p.binId,'farm create');const duration=s.loadUint(32);s.endParse();const event=farmEvent(poolTx,p);
  if(event){const campaign=decodeNativeFarm(event.id,state.after.farms.get(event.id)??null);requireProof(event.kind===1&&campaign&&!state.before.farms.has(event.id)&&event.id===state.before.nextId&&state.after.nextId===event.id+1n&&campaign.binId===p.binId&&campaign.sponsor===p.owner&&campaign.side===p.side&&campaign.total===BigInt(p.amountRaw)&&campaign.duration===duration&&event.amount===campaign.total,'funded campaign');return{...effect(p,poolTx,'credited',campaign.total),farmId:event.id.toString()};}
  return payout(p,poolTx,b,txs,BigInt(p.amountRaw),6,'refunded');
 }
 if(p.kind==='farm-action'){
  const s=body.beginParse();requireProof(s.loadUint(32)===POOL_OP.farmAction&&s.loadUintBig(64)===BigInt(p.queryId)&&s.loadUint(8)===p.action&&s.loadUintBig(64)===BigInt(p.farmId!)&&raw(s.loadAddress())===p.owner,'farm action');s.endParse();
  const id=BigInt(p.farmId!),before=decodeNativeFarm(id,state.before.farms.get(id)??null),after=decodeNativeFarm(id,state.after.farms.get(id)??null),event=farmEvent(poolTx,p);requireProof(before&&before.side===p.side&&before.binId===p.binId&&event&&event.id===id&&event.kind===p.action!+1,'farm accounting');
  if(p.action===1){requireProof(after&&state.after.positions.get(before.binId)?.farmId===id&&state.before.positions.get(before.binId)?.farmId!==id&&event.amount===0n,'stake');return{...effect(p,poolTx,'credited',0n),farmId:id.toString()};}
  if(p.action===4){requireProof(before.sponsor===p.owner&&after&&after.end===Math.min(before.end,poolTx.tx.now)&&event.amount===0n,'stop campaign');return{...effect(p,poolTx,'credited',0n),farmId:id.toString()};}
  if(p.action===5)requireProof(before.sponsor===p.owner&&!after&&event.amount===before.total-before.paid,'campaign remainder');
  else requireProof(after&&after.paid-before.paid===event.amount&&state.before.positions.get(before.binId)?.farmId===id,'claim accounting');
  return payout(p,poolTx,b,txs,event.amount,p.action===5?4:3,'delivered');
 }
 if(p.kind==='remove'){
  const remove=decodeNativeLiqRemove(body);requireProof(remove.owner===p.owner&&remove.queryId===BigInt(p.queryId),'removal authorization');const result=verifyNativePoolRemoval(poolTx,p.owner,p.owner,body,b,txs);return result.status==='pending'?{status:'pending',...(result.transferOrigins?{transferOrigins:result.transferOrigins}:{})}:{...effect(p,poolTx,'delivered',0n),...result};
 }
 if(p.kind==='owed'){
  const s=body.beginParse();requireProof(s.loadUint(32)===0x434c4d4a&&s.loadUintBig(64)===BigInt(p.queryId)&&s.loadUint(8)===p.side&&raw(s.loadAddress())===p.owner,'owed claim');s.endParse();const before=state.before.owed.get(p.side),after=state.after.owed.get(p.side),amount=before?.entries.get(Address.parse(p.owner));requireProof(before&&after&&amount&&amount>=BigInt(p.amountRaw)&&!after.entries.has(Address.parse(p.owner))&&after.total===before.total-amount&&after.count===before.count-1,'owed reduction');return payout(p,poolTx,b,txs,amount,0,'delivered');
 }
 return{status:'pending'};
}catch{return{status:'unavailable'};}}
