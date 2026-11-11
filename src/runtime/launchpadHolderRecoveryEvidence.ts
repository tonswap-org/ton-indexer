import { Address, beginCell, Cell, Dictionary, loadMessage, type ShardAccount } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { currentT3WalletAddress, readCurrentT3Wallet } from '../ledger/currentT3State';
import { t3Attempt, t3PathRoot } from '../ledger/currentT3Wire';
import { SparseT3Tree } from '../ledger/currentT3Receipts';
import { activeOrderAccount, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalEvidenceStore } from './physicalEvidence';
import { collectProductPhysicalGraph, ProductEvidenceError, type ProductPhysicalGraph } from './productEvidence';
import { readLaunchpadEvidenceContext, readLaunchpadOperationRequest } from './launchpadOperationEvidence';
import { readLaunchChild } from './launchpadEvidenceState';

export const HOLDER_RECOVERY_LIMITS = { candidates: 32, holders: 2, transactions: 256, bytes: 8 * 1024 * 1024 } as const;
export const readLaunchpadHolderRecoveryRequest = readLaunchpadOperationRequest;
export type HolderRecoveryCandidate = { key: string; kind: 'notification'|'failure'; holder: string; wallet: string;
  sourceLt: string; sourceHash: string; target: string; targetLt: string; targetHash: string;
  requestBoc: string; receiverRequestBoc: string; receiptBodyBoc: string; wire: string; amountRaw: string;
  recordBoc: string|null; proofBoc: string };
export type CurrentLaunchpadHolderRecoveryEvidence = ProductPhysicalGraph & {
  schema: 'tonswap-launchpad-holder-recovery-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: string; owner: string; bodyHash: string };
  holders: Array<{ address: string; shardAccountBoc: string; wallet: { address: string; shardAccountBoc: string } }>;
  candidates: HolderRecoveryCandidate[];
};
function check(v: unknown): asserts v { if (!v) throw new ProductEvidenceError(503,'upstream_unavailable'); }
const ordinary = (c: Cell) => { check(!c.isExotic); return c.beginParse(); };
const boc = (c: Cell) => c.toBoc().toString('base64');
const raw = (a: Address) => a.toRawString();
const one = <T>(rows: T[]) => { check(rows.length === 1); return rows[0]; };
const attemptRead = (body: Cell) => { const s=ordinary(body); check(s.loadUint(32)===0x5433444c); const c=s.loadRef(); s.endParse(); return t3Attempt(c); };
const notification = (a: ReturnType<typeof t3Attempt>) => beginCell().storeUint(0x7362d09c,32).storeUint(a.queryId,64).storeCoins(a.amount).storeAddress(Address.parse(a.owner)).storeSlice(a.forwardPayload.beginParse()).endCell();
function transfer(c: Cell) {
  const s=ordinary(c); check(s.loadUint(32)===0x0f8a7ea5); const wire=s.loadUintBig(64),amount=s.loadCoins(),recipient=s.loadAddress(); s.loadAddress();
  check(amount>0n&&!s.loadBit()); s.loadCoins(); if(s.loadBit())s.loadRef(); s.endParse(); return {wire,amount,recipient};
}
export function readHolderReceipt(c: Cell) {
  const s=ordinary(c),key=s.loadUintBig(64),v=ordinary(s.loadRef()); s.endParse();
  const incoming=v.loadBit(),slot=v.loadUint(8),amount=v.loadCoins(),claimed=v.loadBit(),body=v.loadRef(); v.endParse(); check(key>0n&&slot===0&&amount>0n);
  return {key,incoming,slot,amount,claimed,body};
}
export function readHolderRecoveryState(data: Cell) {
  const s=ordinary(data); s.loadRef(); s.loadMaybeRef(); const m=ordinary(s.loadRef()); s.loadRef(); s.endParse();
  m.loadMaybeRef(); m.loadMaybeRef(); const recovery=m.loadDict(Dictionary.Keys.Uint(8),Dictionary.Values.Cell()); m.endParse();
  const c=recovery.get(0); if(!c)return null; const r=ordinary(c); r.loadUintBig(256); r.loadUintBig(256); const pending=r.loadCoins(),tree=r.loadMaybeRef(); r.loadUintBig(256); r.endParse();
  if(!tree)return {pending,root:new SparseT3Tree().root,initialized:false,lastKey:0n};
  const t=ordinary(tree),root=t.loadUintBig(256),initialized=t.loadBit(),lastKey=t.loadUintBig(64); t.loadUintBig(256); t.loadMaybeRef(); t.endParse(); return {pending,root,initialized,lastKey};
}
function protectedSlot(data: Cell) {
  const s=ordinary(data); s.loadRef(); s.loadMaybeRef(); const m=ordinary(s.loadRef());
  const slots=m.loadDict(Dictionary.Keys.Uint(8),{serialize(){throw Error('read only');},parse(p){const master=p.loadAddress(),wallet=p.loadMaybeAddress();p.loadUint(32);p.loadCoins();p.loadBit();const b=ordinary(p.loadRef());p.endParse();b.skip(32*8+16*4+8*3);const protectedCredit=b.loadBit();b.endParse();return {master,wallet,protectedCredit};}});
  return slots.get(0);
}
type Verified = ReturnType<typeof verifyOrderTransaction> & {account:string};
const linked = (a:Verified,b:Verified) => !!b.incoming&&a.tx.lt<b.tx.lt&&[...a.outgoing.values()].some(m=>canonicalPhysicalMessage(m).equals(canonicalPhysicalMessage(b.incoming!)));
const failed = (t:Verified) => t.tx.description.type==='generic'&&t.tx.description.aborted;
function currentWallet(shard: ShardAccount, holder: string, manifest: RuntimeReleaseManifest, address: string) {
  const active=activeOrderAccount(shard,manifest.templates.T3Wallet),state=readCurrentT3Wallet(active.data);
  check(state.owner===holder&&state.master===manifest.contracts.T3Hub!.address&&state.proofCodeHash===manifest.templates.T3RecoveryProof
    &&currentT3WalletAddress(Address.parse(holder),Address.parse(state.master),state.proofCodeHash,active.code)===address); return state;
}
/** The operation graph restricts discovery. Complete linked holder history is
 * additionally required to reproduce every receipt-tree transition. */
export async function collectLaunchpadHolderRecoveryEvidence(manifest:RuntimeReleaseManifest,source:ChainSource,store:PhysicalEvidenceStore,
  parsed:ReturnType<typeof readLaunchpadHolderRecoveryRequest>,signal?:AbortSignal):Promise<CurrentLaunchpadHolderRecoveryEvidence> {
  const context=await readLaunchpadEvidenceContext(manifest,source,parsed,signal),{head,request:p,pins,completeAccounts}=context;
  const reader=createPhysicalEvidenceReader(source,store,head,{signal,newTransactions:64});
  const graph=await collectProductPhysicalGraph(source,store,head,{owner:p.owner,target:parsed.dispatchTarget,body:parsed.body,dispatch:p.dispatch,pins,completeAccounts,reader},signal);
  const response:CurrentLaunchpadHolderRecoveryEvidence={schema:'tonswap-launchpad-holder-recovery-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,
    asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex},request:{kind:p.kind,owner:p.owner,bodyHash:p.bodyHash},...graph,holders:[],candidates:[]};
  if(!graph.coverage.complete)return response;
  try {
    const txs=graph.transactions.map(e=>({...verifyOrderTransaction(e),account:e.account})).sort((a,b)=>a.tx.lt<b.tx.lt?-1:1),origin=one(txs.filter(t=>t.account===p.owner&&t.tx.lt.toString()===p.dispatch.lt&&t.hash===p.dispatch.hash));
    const first=one(txs.filter(t=>t.account===parsed.dispatchTarget&&linked(origin,t)&&t.tx.inMessage?.body.equals(parsed.body)));
    const causal=new Set([first.hash]); for(const t of txs)if(txs.some(a=>causal.has(a.hash)&&linked(a,t)))causal.add(t.hash);
    for(const child of context.children.filter(c=>c.role<2)) {
      const current=await reader.current(child.address); if(current.accountState!=='active')continue;
      check(current.shardAccountBoc); const currentShard=orderShard(current.shardAccountBoc,child.address).shard,active=activeOrderAccount(currentShard,child.hash),native=readLaunchChild(active.data),slot=protectedSlot(active.data),now=readHolderRecoveryState(active.data);
      check(native.id.factory===p.factory&&native.id.creator===p.creator&&native.id.nonce.toString()===p.nonce&&native.id.model===p.model&&native.id.role===child.role);
      if(!slot?.wallet||!now)continue; check(slot.protectedCredit&&raw(slot.master)===context.t3.root);
      const wallet=raw(slot.wallet);if(!txs.some(t=>t.account===wallet&&causal.has(t.hash)))continue;const walletAccount=await reader.current(wallet); check(walletAccount.shardAccountBoc);
      currentWallet(orderShard(walletAccount.shardAccountBoc,wallet).shard,child.address,manifest,wallet);
      response.holders.push({address:child.address,shardAccountBoc:current.shardAccountBoc,wallet:{address:wallet,shardAccountBoc:walletAccount.shardAccountBoc}});
      const rows=txs.filter(t=>t.account===child.address),records=new Map<bigint,Cell>(),tree=new SparseT3Tree();let lastKey=0n,previous:Verified|null=null;
      const roots=(shard:ShardAccount) => {if(shard.account?.storage.state.type!=='active')return;const a=activeOrderAccount(shard,child.hash),state=readHolderRecoveryState(a.data);check(readLaunchChild(a.data).id.factory===p.factory);if(state)check(state.root===tree.root&&state.initialized===(records.size>0)&&state.lastKey===lastKey);else check(records.size===0);};
      for(const t of rows){
        check(previous?t.tx.prevTransactionLt===previous.tx.lt&&t.tx.prevTransactionHash===BigInt('0x'+previous.hash):t.tx.prevTransactionLt===0n); roots(t.before);
        if(t.succeeded){
          for(const m of t.tx.outMessages.values())if(m.info.type==='external-out'&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===0x4a524543){const s=ordinary(m.body);s.skip(32);const rec=s.loadRef();s.endParse();const r=readHolderReceipt(rec);check(!r.claimed&&!records.has(r.key));records.set(r.key,rec);tree.set(r.key,rec);if(r.key>lastKey)lastKey=r.key;}
          const m=t.tx.inMessage;if(m?.info.type==='internal'&&!m.info.bounced&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===0x4a52434d){const s=ordinary(m.body);s.skip(32);const rec=s.loadRef(),proof=s.loadRef();s.endParse();const r=readHolderReceipt(rec);check(!r.claimed&&records.get(r.key)?.equals(rec)&&t3PathRoot(r.key,rec,proof)===tree.root);const claimed=beginCell().storeUint(r.key,64).storeRef(beginCell().storeBit(r.incoming).storeUint(0,8).storeCoins(r.amount).storeBit(true).storeRef(r.body)).endCell();records.set(r.key,claimed);tree.set(r.key,claimed);}
        }
        roots(t.after);previous=t;
      }
      check(previous&&previous.tx.lt===currentShard.lastTransactionLt&&BigInt('0x'+previous.hash)===currentShard.lastTransactionHash);roots(currentShard);
      for(const src of txs.filter(t=>t.account===wallet&&causal.has(t.hash))){
        const incoming=src.tx.inMessage;if(incoming?.info.type!=='internal'||incoming.info.bounced||incoming.body.bits.length<32)continue;
        const op=incoming.body.beginParse().preloadUint(32);let kind:'notification'|'failure',request:Cell,receiptBody:Cell,wire:bigint,amount:bigint,target:Verified;
        if(op===0x5433444c&&src.succeeded){
          const a=attemptRead(incoming.body);if(a.burn||a.recipient!==child.address||a.forwardValue<=0n)continue;
          check(!src.before.account||['active','uninit'].includes(src.before.account.storage.state.type));
          const after=currentWallet(src.after,child.address,manifest,wallet),before=src.before.account?.storage.state.type==='active'?currentWallet(src.before,child.address,manifest,wallet):null;
          if(!before){check(incoming.init?.code&&incoming.init.data&&incoming.init.code.hash().toString('hex')===manifest.templates.T3Wallet);const initial=readCurrentT3Wallet(incoming.init.data);check(initial.owner===child.address&&initial.master===context.t3.root&&initial.proofCodeHash===manifest.templates.T3RecoveryProof&&initial.balance===0n&&initial.protectedCredits===0n);}
          check(after.balance-(before?.balance??0n)===a.amount&&after.protectedCredits-(before?.protectedCredits??0n)===a.amount&&after.acceptedTransfers===(before?.acceptedTransfers??0n));
          receiptBody=notification(a);const targets=rows.filter(t=>linked(src,t)&&t.tx.inMessage?.body.equals(receiptBody));if(targets.length!==1||!failed(targets[0]))continue;
          target=targets[0];kind='notification';request=a.cell;wire=a.queryId;amount=a.amount;
        }else if(op===0x0f8a7ea5&&failed(src)&&raw(incoming.info.src)===child.address){
          const command=transfer(incoming.body),emitter=one(rows.filter(t=>t.succeeded&&causal.has(t.hash)&&linked(t,src)));check(emitter);
          const internal=src.tx.outMessages.values().filter(m=>m.info.type==='internal'),targets=rows.filter(t=>linked(src,t)&&t.tx.inMessage?.info.type==='internal'&&t.tx.inMessage.info.bounced);
          if(internal.length===0){target=src;}else{if(internal.length!==1||targets.length!==1||!failed(targets[0]))continue;target=targets[0];const b=ordinary(target.tx.inMessage!.body);check(b.loadUint(32)===0xfffffffe&&b.loadRef().equals(incoming.body));}
          kind='failure';request=incoming.body;receiptBody=request;wire=command.wire;amount=command.amount;
        }else continue;
        check(response.candidates.length<HOLDER_RECOVERY_LIMITS.candidates);
        const record=records.get(src.tx.lt)??null;if(record){const r=readHolderReceipt(record);check(r.incoming===(kind==='notification')&&r.amount===amount&&r.body.equals(receiptBody));}
        response.candidates.push({key:`${child.address}:${src.tx.lt}:${src.hash}`,kind,holder:child.address,wallet,sourceLt:String(src.tx.lt),sourceHash:src.hash,target:target.account,targetLt:String(target.tx.lt),targetHash:target.hash,
          requestBoc:boc(incoming.body),receiverRequestBoc:boc(request),receiptBodyBoc:boc(receiptBody),wire:String(wire),amountRaw:String(amount),recordBoc:record?boc(record):null,proofBoc:boc(tree.proof(src.tx.lt))});
      }
    }
    check(response.holders.length<=HOLDER_RECOVERY_LIMITS.holders&&Buffer.byteLength(JSON.stringify(response))<=HOLDER_RECOVERY_LIMITS.bytes);
  }catch(error){signal?.throwIfAborted();response.coverage.complete=false;response.coverage.gaps.push({code:'holder_recovery_unavailable',account:p.sale});response.candidates=[];}
  signal?.throwIfAborted();assertFreshHeadTime(head.utime);return response;
}
