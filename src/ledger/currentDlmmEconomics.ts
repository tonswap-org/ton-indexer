import { Address, Cell } from '@ton/core';
import { decodeNativeFarm, decodeNativeLiqAdd, decodeNativeLiqRemove, decodeSwap, POOL_OP, readCurrentDlmmPool } from './currentDlmmState';
import { inspectPoolOperation, type PoolEvidenceRequest, type PoolOperationEvidence } from './currentDlmmProof';
import { inspectCurrentDlmmSwap, type CurrentDlmmSwapRequest, type CurrentDlmmSwapProof } from './currentDlmmSwapProof';
import { currentDlmmPoolBinding, currentT3ActiveState, decodeSpotTokenTransfer, readT3WalletRecord, readT3WalletStorage, t3WalletAttemptFromCell, verifyCurrentT3Transaction, verifySpotMessageLink, verifySpotTokenDelivery, verifySpotWalletDelta, verifyT3Witness, type CurrentDlmmProofBinding, type CurrentT3Transaction as Tx, type CurrentT3TransactionEvidence, type SpotProofBinding } from './currentDlmmPhysical';
export type CurrentDlmmRequest=PoolEvidenceRequest|CurrentDlmmSwapRequest;
export type CurrentDlmmCashLeg={direction:'in'|'out';root:string;amountRaw:string;wallet:string;otherOwner:string;ownerTransaction:string;debitTransaction:string;creditTransaction:string;originTransaction:string};
export type CurrentDlmmEconomics={kind:CurrentDlmmRequest['kind']|'order';order?:{address:string;nonce:string;fundedInRaw:string;consumedInRaw:string;receivedOutRaw:string;refundedInRaw:string;executedSlices:number;closeReason:number};outcome:'unresolved'|'accepted'|'delivered'|'refunded';pool:string;owner:string;queryId:string;requestBodyHash:string;dispatch:{lt:string;hash:string};side:0|1;paidInRaw:string;paidOutT3Raw:string;paidOutXRaw:string;pendingOutT3Raw:string;pendingOutXRaw:string;grossFeeT3Raw:string;protocolFeeT3Raw:string;lpFeeT3Raw:string;farmId:string|null;shares:{binId:number;beforeRaw:string;afterRaw:string;deltaRaw:string}[];cash:CurrentDlmmCashLeg[];evidenceHashes:string[];aggregateOwed:boolean};
export type CurrentDlmmOperation={request:CurrentDlmmRequest;proof:PoolOperationEvidence|CurrentDlmmSwapProof;economics:CurrentDlmmEconomics};
export type CurrentDlmmLiquidityBoundary={status:'confirmed'|'pending'|'unavailable';owner:string;pool:string;shares:CurrentDlmmEconomics['shares'];cash:CurrentDlmmCashLeg[];pendingT3Raw:string;pendingXRaw:string;evidenceHashes:string[]};
const one=<T>(a:T[])=>a.length===1?a[0]:null;
const maybe=<T>(f:()=>T)=>{try{return f();}catch{return null;}};
function need(v:unknown,why:string):asserts v{if(!v)throw Error(`Current DLMM ledger: ${why}`);}
function originalInput(t:Tx,owner?:string){const m=t.tx.inMessage;need(m?.info.type==='internal'&&!m.info.bounced&&(!owner||m.info.src.toRawString()===owner),'input');return m;}
const state=(t:Tx,b:SpotProofBinding,after=false)=>readCurrentDlmmPool(currentT3ActiveState(after?t.after:t.before,b.identity.release.templates.DlmmPool).data,b.identity.pool);
function infer(origin:Tx,m:Tx['tx']['outMessages'] extends never?never:ReturnType<Tx['tx']['outMessages']['values']>[number],b:CurrentDlmmProofBinding,txs:Tx[]):CurrentDlmmRequest|null{try{
 if(!origin.succeeded||m.info.type!=='internal'||m.info.bounced||m.body.isExotic||m.body.bits.length<32)return null;
 const owner=origin.account,target=m.info.dest.toRawString(),first=one(txs.filter(t=>t.account===target&&verifySpotMessageLink(origin,t)));if(!first)return null;
 const body=m.body,tag=body.beginParse().preloadUint(32);let pool='',side:0|1=0,kind:CurrentDlmmRequest['kind'],query=0n,amount=0n,binId:number|null=null,farmId:string|null=null,action:number|null=null,sourceWallet:string|null=null;
 if(tag===0x0f8a7ea5){const r=decodeSpotTokenTransfer(body),p=b.pools.find(p=>p.pool===r.owner),wallet=p?.wallets.find(w=>w.address===target&&w.owner===owner);if(!p||!wallet||r.response!==owner||r.custom||r.forwardValue===0n||r.amount===0n)return null;
  pool=p.pool;side=wallet.root===p.t3.root?0:wallet.root===p.x.root?1:2 as never;if(side>1)return null;sourceWallet=target;query=r.query;amount=r.amount;const op=r.payload.beginParse().preloadUint(32);
  if(op===POOL_OP.add){kind='add';const add=decodeNativeLiqAdd(r.payload);if(add.owner!==owner||add.amount!==amount)return null;binId=add.binId;}
  else if(op===POOL_OP.farmCreate){kind='farm-create';const s=r.payload.beginParse();s.loadUint(32);binId=s.loadInt(32);const duration=s.loadUint(32);s.endParse();if(duration<3600||duration>7776000)return null;}
  else if(op===0x53575033){kind='swap';if(!decodeSwap(r.payload))return null;}else return null;
 }else{const p=b.pools.find(p=>p.pool===target);if(!p)return null;pool=p.pool;const s=body.beginParse();s.loadUint(32);
  if(tag===POOL_OP.remove){kind='remove';const r=decodeNativeLiqRemove(body);if(r.owner!==owner)return null;query=r.queryId;}
  else if(tag===POOL_OP.farmAction){kind='farm-action';query=s.loadUintBig(64);action=s.loadUint(8);farmId=String(s.loadUintBig(64));if(s.loadAddress().toRawString()!==owner||action<1||action>5)return null;s.endParse();const config=currentDlmmPoolBinding(b,pool,owner,0),farm=decodeNativeFarm(BigInt(farmId),state(first,config).farms.get(BigInt(farmId))??null);if(!farm)return null;side=farm.side;binId=farm.binId;}
  else if(tag===0x434c4d4a){kind='owed';query=s.loadUintBig(64);const slot=s.loadUint(8);if(slot>1||s.loadAddress().toRawString()!==owner)return null;side=slot as 0|1;s.endParse();const config=currentDlmmPoolBinding(b,pool,owner,side);amount=state(first,config).owed.get(side)?.entries.get(Address.parse(owner))??0n;if(!amount)return null;}else return null;
 }
 if(query===0n)return null;const common={kind,owner,pool,side,queryId:String(query),amountRaw:String(amount),sourceWallet,bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:String(m.info.value.coins),createdAt:origin.tx.now*1000,dispatch:{lt:String(origin.tx.lt),hash:origin.hash,valueNano:String(m.info.value.coins)}};
 return kind==='swap'?{...common,kind,sourceWallet:sourceWallet!}:{...common,kind,network:b.release.network.slice(4) as PoolEvidenceRequest['network'],releaseId:b.release.releaseId,manifestHash:b.release.manifestHash,binId,farmId,action};
}catch{return null;}}
function descendants(origin:Tx,txs:Tx[]){const hashes=new Set([origin.hash]);for(const t of txs)if(txs.some(a=>hashes.has(a.hash)&&verifySpotMessageLink(a,t)))hashes.add(t.hash);return hashes;}
function cashFor(p:CurrentDlmmRequest,b:SpotProofBinding,txs:Tx[],causal:Set<string>):CurrentDlmmCashLeg[]{
 const result:CurrentDlmmCashLeg[]=[],wallets=Object.values(b.wallets),byAddress=new Map(wallets.map(w=>[w.address,w]));
 for(const target of txs){const to=byAddress.get(target.account);if(!to||!target.succeeded)continue;const incoming=maybe(()=>originalInput(target));if(!incoming||incoming.info.type!=='internal')continue;const from=byAddress.get(incoming.info.src.toRawString());if(!from||from.root!==to.root)continue;
  const direction=to.owner===p.owner&&from.owner===p.pool?'in':from.owner===p.owner&&to.owner===p.pool?'out':null;if(!direction)continue;
  const source=one(txs.filter(t=>t.account===from.address&&verifySpotMessageLink(t,target)));if(!source)continue;
  let original=source;
  const leg=maybe(()=>{let transfer=decodeSpotTokenTransfer(originalInput(source,from.owner).body);need(causal.has(source.hash)&&String(transfer.query)===p.queryId,'causal original transfer');verifySpotTokenDelivery(source,target,transfer,from,to,b);return transfer;});
  let amount=leg?.amount;
  if(!leg&&direction==='in'&&from.root===b.identity.t3.root){amount=maybe(()=>{
    const command=originalInput(source).body.beginParse();need(command.loadUint(32)===0x54335759,'retry');const record=command.loadRef(),path=command.loadRef(),recipient=command.loadAddress();command.endParse();const r=readT3WalletRecord(record),a=r.attempt,before=readT3WalletStorage(currentT3ActiveState(source.before,from.codeHash).data);
    need(r.failed&&!r.cancelled&&recipient.toRawString()===p.owner&&a.recipient.equals(recipient)&&a.owner.toRawString()===p.pool&&!a.burn&&String(a.details.queryId)===p.queryId&&verifyT3Witness(record,a.id,path,before.root),'authenticated retry');
    const origin=one(txs.filter(t=>t.account===source.account&&t.tx.lt===a.originLt&&causal.has(t.hash)));need(origin,'original causal debit');original=origin;
    const transfer=decodeSpotTokenTransfer(originalInput(origin,p.pool).body);need(transfer.query===a.details.queryId&&transfer.amount===a.amount&&transfer.owner===p.owner,'original retry transfer');verifySpotWalletDelta(origin,from,-a.amount,b);verifySpotWalletDelta(source,from,0n,b);
    const s=incoming.body.beginParse();need(s.loadUint(32)===0x5433444c,'delivery');const next=t3WalletAttemptFromCell(s.loadRef());s.endParse();need(next.id===a.id&&next.originLt===a.originLt&&next.attempt===a.attempt+1n&&next.cell.refs[0].equals(a.cell.refs[0]),'immutable retry terms');verifySpotWalletDelta(target,to,a.amount,b);return a.amount;
  })??undefined;}
  if(amount===undefined)continue;const wallet=direction==='in'?target:original;
  result.push({direction,root:from.root,amountRaw:String(amount),wallet:wallet.account,otherOwner:direction==='in'?from.owner:to.owner,ownerTransaction:wallet.hash,debitTransaction:source.hash,creditTransaction:target.hash,originTransaction:original.hash});
 }
 need(new Set(result.map(v=>`${v.direction}:${v.originTransaction}`)).size===result.length,'duplicate cash');return result;
}
/** Infer each operation from an original owner message. Query IDs are metadata,
 * never deduplication identities. A sparse retry cannot debit the owner again. */
export function decodeCurrentDlmmOperations(owner:string,b:CurrentDlmmProofBinding,evidence:readonly CurrentT3TransactionEvidence[]):CurrentDlmmOperation[]{
 const txs=evidence.map(verifyCurrentT3Transaction).sort((a,b)=>a.tx.lt<b.tx.lt?-1:a.tx.lt>b.tx.lt?1:a.hash.localeCompare(b.hash));need(txs.length<=10000&&new Set(txs.map(t=>t.hash)).size===txs.length,'duplicate/bounded originals');
 const requests=txs.filter(t=>t.account===owner).flatMap(t=>t.tx.outMessages.values().flatMap(m=>{const p=infer(t,m,b,txs);return p?[p]:[];}));
 return requests.map(request=>{
  const origin=txs.find(t=>t.hash===request.dispatch.hash)!,binding=currentDlmmPoolBinding(b,request.pool,owner,request.side),causal=descendants(origin,txs),selected=new Set(causal);
  // Bound each operation to its original causal graph. A later protected retry
  // is included only when its original wallet debit belongs to that graph;
  // the native proof below independently verifies its sparse witness/terms.
  for(const retry of txs){const attempt=maybe(()=>{const q=originalInput(retry).body.beginParse();if(q.loadUint(32)!==0x54335759)return null;return readT3WalletRecord(q.loadRef()).attempt;});if(attempt&&txs.some(t=>t.account===retry.account&&t.tx.lt===attempt.originLt&&causal.has(t.hash)))for(const hash of descendants(retry,txs))selected.add(hash);}
  const operationEvidence=evidence.filter(e=>selected.has(verifyCurrentT3Transaction(e).hash));
  const proof=request.kind==='swap'?inspectCurrentDlmmSwap(request,binding,operationEvidence):inspectPoolOperation(request,binding,operationEvidence),cash=proof.status==='unavailable'?[]:cashFor(request,binding,txs,causal);
  const economics:CurrentDlmmEconomics={kind:request.kind,outcome:proof.status==='pending'||proof.status==='unavailable'?'unresolved':proof.status==='credited'||proof.status==='accepted'?'accepted':proof.status,pool:request.pool,owner,queryId:request.queryId,requestBodyHash:request.bodyHash,dispatch:{lt:request.dispatch.lt,hash:request.dispatch.hash},side:request.side,paidInRaw:'0',paidOutT3Raw:'0',paidOutXRaw:'0',pendingOutT3Raw:'0',pendingOutXRaw:'0',grossFeeT3Raw:'0',protocolFeeT3Raw:'0',lpFeeT3Raw:'0',farmId:request.kind==='swap'?null:request.farmId,shares:[],cash,evidenceHashes:[...causal],aggregateOwed:request.kind==='owed'};
  for(const leg of cash){if(leg.direction==='out')economics.paidInRaw=String(BigInt(economics.paidInRaw)+BigInt(leg.amountRaw));else{const key=leg.root===binding.identity.t3.root?'paidOutT3Raw':'paidOutXRaw';economics[key]=String(BigInt(economics[key])+BigInt(leg.amountRaw));}for(const h of[leg.debitTransaction,leg.creditTransaction,leg.originTransaction])if(!economics.evidenceHashes.includes(h))economics.evidenceHashes.push(h);}
  if(proof.status==='unavailable')return{request,proof,economics};
  const poolTx=request.kind==='swap'&&'poolTransactionHash'in proof?txs.find(t=>t.hash===proof.poolTransactionHash):one(txs.filter(t=>t.account===request.pool&&t.succeeded&&causal.has(t.hash)&&maybe(()=>{const m=originalInput(t);return request.sourceWallet?m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===0x7362d09c:m.body.hash().toString('hex')===request.bodyHash;})===true));
  if(poolTx){const before=state(poolTx,binding),after=state(poolTx,binding,true),a=before.positions.get(owner)??new Map(),z=after.positions.get(owner)??new Map();for(const id of new Set([...a.keys(),...z.keys()])){const left=a.get(id)?.shares??0n,right=z.get(id)?.shares??0n;if(left!==right)economics.shares.push({binId:id,beforeRaw:String(left),afterRaw:String(right),deltaRaw:String(right-left)});}
   if(request.kind==='swap'){const q=proof as CurrentDlmmSwapProof;economics.grossFeeT3Raw=q.grossFeeT3Raw??'0';economics.protocolFeeT3Raw=q.protocolFeeT3Raw??'0';economics.lpFeeT3Raw=String(BigInt(economics.grossFeeT3Raw)-BigInt(economics.protocolFeeT3Raw));if(q.pendingOutRaw&&q.pendingOutRaw!=='0'){const inputRefund=q.amountOutRaw==='0',side=inputRefund?request.side:1-request.side;economics[side===0?'pendingOutT3Raw':'pendingOutXRaw']=q.pendingOutRaw;}}
   else if(request.kind==='remove'){for(const s of economics.shares){const bin=before.bins.get(s.binId);need(bin&&BigInt(s.deltaRaw)<0n,'removed position');const burned=-BigInt(s.deltaRaw);economics.pendingOutT3Raw=String(BigInt(economics.pendingOutT3Raw)+bin.t*burned/bin.shares);economics.pendingOutXRaw=String(BigInt(economics.pendingOutXRaw)+bin.x*burned/bin.shares);}economics.pendingOutT3Raw=String(BigInt(economics.pendingOutT3Raw)-BigInt(economics.paidOutT3Raw));economics.pendingOutXRaw=String(BigInt(economics.pendingOutXRaw)-BigInt(economics.paidOutXRaw));}
   else if(request.kind==='farm-create'&&'farmId'in proof)economics.farmId=proof.farmId??null;
   else if(request.kind==='farm-action'&&request.action!==1&&request.action!==4){const left=decodeNativeFarm(BigInt(request.farmId!),before.farms.get(BigInt(request.farmId!))??null),right=decodeNativeFarm(BigInt(request.farmId!),after.farms.get(BigInt(request.farmId!))??null);need(left,'campaign before');const amount=request.action===5?left.total-left.paid:(right?.paid??left.paid)-left.paid;const paid=request.side===0?economics.paidOutT3Raw:economics.paidOutXRaw;economics[request.side===0?'pendingOutT3Raw':'pendingOutXRaw']=String(amount-BigInt(paid));}
   else if(request.kind==='owed'){const amount=(before.owed.get(request.side)?.entries.get(Address.parse(owner))??0n)-(after.owed.get(request.side)?.entries.get(Address.parse(owner))??0n);economics[request.side===0?'pendingOutT3Raw':'pendingOutXRaw']=String(amount-BigInt(request.side===0?economics.paidOutT3Raw:economics.paidOutXRaw));}
  }
  need(BigInt(economics.pendingOutT3Raw)>=0n&&BigInt(economics.pendingOutXRaw)>=0n,'negative pending cash');
  return{request,proof,economics};
 });
}
/** Launchpad/controllers may own real LP positions. The caller authenticates
 * that controller; this hook independently binds its exact original outgoing
 * LQA3/LQR3 dispatch and every original share/cash boundary. */
export function verifyCurrentDlmmLiquidityBoundary(request:PoolEvidenceRequest,b:SpotProofBinding,evidence:readonly CurrentT3TransactionEvidence[]):CurrentDlmmLiquidityBoundary{
 const empty:CurrentDlmmLiquidityBoundary={status:'unavailable',owner:request.owner,pool:request.pool,shares:[],cash:[],pendingT3Raw:'0',pendingXRaw:'0',evidenceHashes:[]};
 if(request.kind!=='add'&&request.kind!=='remove')return empty;
 try{const config:CurrentDlmmProofBinding={release:b.identity.release,pools:[{pool:b.identity.pool,market:b.identity.market,t3:b.identity.t3,x:b.identity.x,wallets:Object.values(b.wallets)}]},ops=decodeCurrentDlmmOperations(request.owner,config,evidence),selected=one(ops.filter(o=>o.request.kind===request.kind&&o.request.bodyHash===request.bodyHash&&o.request.dispatch.hash===request.dispatch.hash&&o.request.dispatch.lt===request.dispatch.lt));
  if(!selected||selected.proof.status==='unavailable')return empty;const e=selected.economics;return{status:e.outcome==='unresolved'||e.pendingOutT3Raw!=='0'||e.pendingOutXRaw!=='0'?'pending':'confirmed',owner:e.owner,pool:e.pool,shares:e.shares,cash:e.cash,pendingT3Raw:e.pendingOutT3Raw,pendingXRaw:e.pendingOutXRaw,evidenceHashes:e.evidenceHashes};
 }catch{return empty;}
}
