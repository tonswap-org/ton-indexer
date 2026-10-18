import { Address, type ShardAccount } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { orderHash } from '../orders/discovery';
import { readArchiveCheckpointHistory, type ArchiveCheckpointStore } from './archiveCheckpoint';
import { createPhysicalEvidenceReader, type PhysicalEvidenceStore } from './physicalEvidence';
import { ArchiveReconstructionPending, OWED_ARCHIVE_LIMITS, replayArchiveFacts, summarizeArchiveBoundary, type ArchiveState } from './launchpadOwedArchiveEvidence';
import { publicPoolIdentity } from './poolOperationEvidence';
import { emptyOwedArchive, owedHolderPin, readCurrentOwedState } from './currentOwedState';
import { productAddress, productCell, productDispatch, productUint, ProductEvidenceError, requireProduct,
  collectProductPhysicalGraph, boundProductResponse, type ProductDispatch } from './productEvidence';

export type OwedRequest={network:string;releaseId:string;manifestHash:string;owner:string;holder:string;slot:number};
const unavailable=()=>new ProductEvidenceError(503,'upstream_unavailable');
function check(ok:unknown):asserts ok {if(!ok)throw unavailable();}
const keys=(v:Record<string,unknown>,expected:string[])=>requireProduct(Object.keys(v).sort().join()===expected.sort().join());
export function readOwedRequest(value:unknown,manifest:RuntimeReleaseManifest):OwedRequest {
  try {requireProduct(!!value&&typeof value==='object'&&!Array.isArray(value));const v=value as Record<string,unknown>;keys(v,['network','releaseId','manifestHash','owner','holder','slot']);
    if(v.network!==manifest.network.slice(4)||v.releaseId!==manifest.releaseId||v.manifestHash!==manifest.manifestHash)throw new ProductEvidenceError(409,'release_mismatch');
    productAddress(v.owner);productAddress(v.holder);requireProduct(Number.isInteger(v.slot)&&Number(v.slot)>=0&&Number(v.slot)<256);owedHolderPin(manifest,String(v.holder),true);
    return structuredClone(v) as OwedRequest;
  }catch(error){if(error instanceof ProductEvidenceError)throw error;throw new ProductEvidenceError(400,'bad_request');}
}
export type OwedOperationRequest=OwedRequest & {kind:'direct'|'archive';queryId:string;amountRaw:string;bodyBoc:string;bodyHash:string;valueNano:string;dispatch:ProductDispatch};
export function readOwedOperationRequest(value:unknown,manifest:RuntimeReleaseManifest){
  try {requireProduct(!!value&&typeof value==='object'&&!Array.isArray(value));const v=value as Record<string,unknown>;keys(v,['network','releaseId','manifestHash','owner','holder','slot','kind','queryId','amountRaw','bodyBoc','bodyHash','valueNano','dispatch']);
    const {kind,queryId,amountRaw,bodyBoc,bodyHash,valueNano,dispatch,...scope}=v;readOwedRequest(scope,manifest);requireProduct(kind==='direct'||kind==='archive');
    const query=productUint(queryId,64),amount=productUint(amountRaw,120,true),funding=productUint(valueNano,120,true),d=productDispatch(dispatch),body=productCell(bodyBoc,bodyHash),s=body.beginParse();
    requireProduct(BigInt(d.valueNano)<=funding&&s.loadUint(32)===(kind==='direct'?0x434c4d4a:0x434c4d41)&&s.loadUintBig(64)===query&&s.loadUint(8)===scope.slot);
    if(kind==='archive')s.loadUintBig(64);requireProduct(s.loadAddress().toRawString()===scope.owner);
    if(kind==='archive'){requireProduct(s.loadCoins()===amount);let proof=s.loadRef();for(let i=0;i<64;i++){requireProduct(!proof.isExotic);const q=proof.beginParse();q.loadUintBig(256);const next=q.loadMaybeRef();q.endParse();requireProduct((next===null)===(i===63));if(next)proof=next;}}
    s.endParse();return{request:structuredClone(v) as OwedOperationRequest,body};
  }catch(error){if(error instanceof ProductEvidenceError)throw error;throw new ProductEvidenceError(400,'bad_request');}
}
export async function readOwedEvidenceContext(manifest:RuntimeReleaseManifest,source:ChainSource,request:OwedRequest,signal?:AbortSignal){
  check(`ton:${source.network}`===manifest.network);const head=await source.head({signal});assertFreshHeadTime(head.utime);const pin=owedHolderPin(manifest,request.holder,true),account=await source.getAccountState(request.holder,{at:head,signal});
  check(account.shardAccountBoc);const shard=orderShard(account.shardAccountBoc,request.holder).shard,data=activeOrderAccount(shard,pin.codeHash).data;
  let identityManifest=manifest;if(pin.role==='DlmmPool'&&!manifest.spotMarkets.some(m=>m.pool===request.holder)){const p=await publicPoolIdentity(manifest,source,head,request.holder,data,signal);identityManifest={...p.identityManifest,spotMarkets:[...p.identityManifest.spotMarkets,p.market]};}
  const state=readCurrentOwedState(data,pin.role,identityManifest,request.holder),slot=state.slots.get(request.slot);
  check(slot?.wallet);const token=identityManifest.tokens.find(t=>t.root===slot.master);check(token);
  const wallets=createJettonWalletReader({source,tokens:[{master:token.root,masterCodeHash:token.masterCodeHash,walletCodeHash:token.walletCodeHash}]}),[holderWallet,ownerWallet]=await Promise.all([wallets.identity(token.root,request.holder,{at:head,signal}),wallets.identity(token.root,request.owner,{at:head,signal})]);
  check(holderWallet.wallet===slot.wallet&&ownerWallet.wallet!==slot.wallet);
  const readState=(value:ShardAccount,empty:ArchiveState,allowUninitialized:boolean)=>{
    if(value.account?.storage.state.type!=='active'){check(allowUninitialized&&value.lastTransactionLt===0n&&value.lastTransactionHash===0n);return empty;}
    const parsed=readCurrentOwedState(activeOrderAccount(value,pin.codeHash).data,pin.role,identityManifest,request.holder),historical=parsed.slots.get(request.slot);
    if(historical)check(historical.master===token.root&&(historical.wallet===null||historical.wallet===slot.wallet));
    return parsed.owed.get(request.slot)?.archive??empty;
  };
  return{head,pin,account,shard,state,slot,token,holderWallet,ownerWallet,readState};
}
/** A bounded, restartable original-history reconstruction. No partially built
 * tree or getter-only owner label authorizes an archived claim. */
export async function collectOwedEvidence(manifest:RuntimeReleaseManifest,source:ChainSource,store:PhysicalEvidenceStore&ArchiveCheckpointStore,request:OwedRequest,signal?:AbortSignal){
  const c=await readOwedEvidenceContext(manifest,source,request,signal),{head,pin,shard}=c,book=c.state.owed.get(request.slot),archive=book?.archive??emptyOwedArchive(),direct=book?.entries.get(Address.parse(request.owner))??0n;
  const records:Awaited<ReturnType<typeof replayArchiveFacts>>['records']=[];
  if(archive.count>0n){
    const reader=createPhysicalEvidenceReader(source,store,head,{signal,newTransactions:OWED_ARCHIVE_LIMITS.newTransactions}),scope=orderHash({schema:'tonswap-current-owed-boundary-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,holder:request.holder,slot:request.slot,role:pin.role,codeHash:pin.codeHash,master:c.token.root,wallet:c.slot.wallet});
    const input={scope,holder:request.holder,slot:request.slot,codeHash:pin.codeHash,readState:c.readState};
    const history=await readArchiveCheckpointHistory({scope,account:request.holder,store,signal,historyLimit:OWED_ARCHIVE_LIMITS.history,current:{lt:String(shard.lastTransactionLt),hash:shard.lastTransactionHash.toString(16).padStart(64,'0'),shardHash:orderCell(c.account.shardAccountBoc!).hash().toString('hex'),seqno:head.seqno,unixTime:head.utime},verify:async(lt,hash)=>summarizeArchiveBoundary(await reader.exact(request.holder,lt,hash),input)});
    if(!history.complete)throw new ArchiveReconstructionPending(history.rows.length,history.verified);
    const replay=await replayArchiveFacts({...input,rows:history.rows,owner:request.owner,current:shard,signal,evidence:async row=>(await reader.exact(request.holder,row.lt,row.hash)).evidence});
    check(replay.candidateCount<=OWED_ARCHIVE_LIMITS.records);records.push(...replay.records);
  }
  const query=async(method:string,args:any[])=>{const result=await source.runGetMethod(request.holder,method,args,{at:head,signal});check([0,1].includes(result.exitCode));return result.stack;},arg=[{type:'int',value:BigInt(request.slot)}];
  const [a,minimum,archiveMinimum]=await Promise.all([query('get_owed_archive',arg),query('get_min_claim',arg),query('get_min_archive_claim',arg)]);
  check(a.length===3&&a.every((v,i)=>v.type==='int'&&v.value===[archive.count,archive.root,archive.total][i]));
  const value=(stack:typeof minimum)=>{check(stack.length===1&&stack[0].type==='int'&&stack[0].value>0n&&stack[0].value<1n<<120n);return String(stack[0].value);};
  const response={schema:'tonswap-owed-evidence-v1' as const,releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex},request:{owner:request.owner,holder:request.holder,slot:request.slot},coverage:{complete:true as const,gaps:[]},holder:{address:request.holder,shardAccountBoc:c.account.shardAccountBoc!},tokenRoot:c.token.root,holderWallet:c.slot.wallet,ownerWallet:c.ownerWallet.wallet,directRaw:String(direct),minimumNano:value(minimum),archiveMinimumNano:value(archiveMinimum),archive:{count:String(archive.count),root:archive.root.toString(16).padStart(64,'0'),total:String(archive.total),records}};
  check(Buffer.byteLength(JSON.stringify(response))<=OWED_ARCHIVE_LIMITS.bytes);signal?.throwIfAborted();assertFreshHeadTime(head.utime);return response;
}
export async function collectOwedOperationEvidence(manifest:RuntimeReleaseManifest,source:ChainSource,store:PhysicalEvidenceStore,parsed:ReturnType<typeof readOwedOperationRequest>,signal?:AbortSignal){
  const p=parsed.request,c=await readOwedEvidenceContext(manifest,source,p,signal),pins=new Map([[p.holder,c.pin.codeHash],[c.holderWallet.wallet,c.token.walletCodeHash],[c.ownerWallet.wallet,c.token.walletCodeHash]]);
  const reader=createPhysicalEvidenceReader(source,store,c.head,{signal,newTransactions:64}),historyOnlyAccounts:string[]=[];
  for(const address of [c.holderWallet.wallet,c.ownerWallet.wallet]){const state=await reader.current(address);if(orderShard(state.shardAccountBoc!,address).shard.account?.storage.state.type==='frozen')historyOnlyAccounts.push(address);}
  const graph=await collectProductPhysicalGraph(source,store,c.head,{owner:p.owner,target:p.holder,body:parsed.body,dispatch:p.dispatch,pins,reader,completeAccounts:[],historyOnlyAccounts,historyLimit:historyOnlyAccounts.length?10000:256,includeAccounts:[p.holder,c.holderWallet.wallet,c.ownerWallet.wallet],allowFrozenPins:new Set([c.holderWallet.wallet,c.ownerWallet.wallet])},signal);
  for(const row of graph.transactions)if(row.account===p.holder){const tx=verifyOrderTransaction(row);for(const shard of [tx.before,tx.after])if(shard.account?.storage.state.type==='active')c.readState(shard,emptyOwedArchive(),false);}
  signal?.throwIfAborted();assertFreshHeadTime(c.head.utime);
  return boundProductResponse({schema:'tonswap-owed-operation-evidence-v1' as const,releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:c.head.seqno,unixTime:c.head.utime,blockRootHash:c.head.rootHashHex},request:{kind:p.kind,owner:p.owner,holder:p.holder,slot:p.slot,bodyHash:p.bodyHash},...graph},p.holder);
}
