import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cell, beginCell, Address, Dictionary } from '@ton/core';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import type { LedgerAsset, LedgerEvent } from '../ledger/types';
import type { LedgerStateSnapshot } from '../ledger/archive';
import type { RawTransaction } from '../data/dataSource';
import { loadOpcodes } from '../utils/opcodes';
import { readFixedSaleState } from '../ledger/launchpadState';
import { readBondingSaleState } from '../ledger/launchpadBondingState';
import { readAuctionSaleState } from '../ledger/launchpadAuctionState';
import { readLaunchpadRequests } from '../ledger/launchpadRequests';
import { launchpadCommand } from '../ledger/launchpadWire';
import { bodyCell, tokenWire, TRANSFER, NOTIFY } from '../ledger/wire';
import type { LedgerLaunchpadSale } from '../ledger/launchpadModels';
import { readCurrentJettonWalletStorage, writeCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
type Model=LedgerLaunchpadSale['model'];
type Trace={accounts:Record<string,string>;compiler:{entrypointFileName:string;codeHash:string}[];transactions:{phase:string;account:string;raw:RawTransaction}[];
 boundaries:{phase:string;account:string;transactionLt:string;transactionHash:string;before:LedgerStateSnapshot['state'];after:LedgerStateSnapshot['state']}[]};
const filenames={fixed:'launchpad-fixed-refund.json',bonding:'launchpad-bonding-contributions.json',auction:'launchpad-auction-bids.json'};
const parsers={fixed:readFixedSaleState,bonding:readBondingSaleState,auction:readAuctionSaleState};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const key=(account:string,lt:string,hash:string)=>`${account}:${lt}:${canonicalLedgerHash(hash)}`;
export function participationFixture(model:Model,participant:'owner'|'otherOwner'='owner') {
 const file=resolve(__dirname,'fixtures',filenames[model]),bytes=readFileSync(file),trace=JSON.parse(bytes.toString()) as Trace,a=trace.accounts,owner=a[participant];assert(owner);
 const states=new Map<string,LedgerStateSnapshot>(),chains=new Map<string,LedgerChain>();
 for(const b of trace.boundaries)for(const state of [b.before,b.after])if(state.lastTxLt&&state.lastTxHash){
  const k=key(b.account,state.lastTxLt,state.lastTxHash),previous=states.get(k);if(previous){assert.equal(previous.state.codeBoc,state.codeBoc);assert.equal(previous.state.dataBoc,state.dataBoc);}states.set(k,{seqno:1,state});}
 for(const row of trace.transactions){if(!chains.has(row.account))chains.set(row.account,{account:row.account,role:row.account===owner?'owner':'counterparty',generation:sha(row.account),historyComplete:true,transactions:[]});chains.get(row.account)!.transactions.push(row.raw);}
 const wallets=new Map<string,LedgerAsset>();
 for(const [walletKey,ownerKey,rootKey]of [['ownerPaymentWallet','owner','paymentRoot'],['otherPaymentWallet','otherOwner','paymentRoot'],['paymentSaleWallet','sale','paymentRoot'],['creatorPaymentWallet','creator','paymentRoot'],['protocolPaymentWallet','protocol','paymentRoot'],['saleWallet','sale','saleRoot']]){
  const wallet=a[walletKey],holder=a[ownerKey],root=a[rootKey];if(!wallet||!holder||!root)continue;
  wallets.set(wallet,{kind:'jetton',id:`testnet:jetton:${root}`,master:root,wallet,owner:holder,decimals:9});if(holder===owner&&chains.has(wallet))chains.get(wallet)!.role='owned_jetton_wallet';}
 const configured=trace.boundaries.find(b=>b.account===a.sale&&b.phase!=='setup')!,state=parsers[model](configured.before.dataBoc!),sale:LedgerLaunchpadSale={model,address:a.sale,factory:state.registry.factory,paymentRoot:a.paymentRoot,paymentWallet:a.paymentSaleWallet,
  paymentWalletCode:Cell.fromBase64(state.paymentRouting.walletCodeBoc),saleCodeHash:trace.compiler.find(c=>c.entrypointFileName.endsWith(`sale_${model}.tolk`))!.codeHash};
 const input:ProjectionInput={network:'testnet',owner,chains,wallets,pools:new Map(),opcodes:loadOpcodes(),launchpadControllers:[a.sale],launchpadSales:new Map([[a.sale,sale]]),stateAt:async(account,lt,h)=>states.get(key(account,lt,h))??null};
 return {input,trace,states,accounts:a,model,fixtureSha256:sha(bytes)};
}
type Fixture=ReturnType<typeof participationFixture>;
const project=async(f:Fixture)=>projectOwnerLedger(f.input);
const accepted=(events:LedgerEvent[])=>events.filter(e=>e.kind==='launchpad_participation'&&e.settlement?.status==='confirmed');
function ownerAcceptance(f:Fixture){const node=f.trace.transactions.find(row=>row.account===f.accounts.sale&&row.raw.inMessage?.op===NOTIFY&&tokenWire(row.raw.inMessage)?.owner===f.input.owner&&
 ['contribute','bid'].includes(launchpadCommand({body:tokenWire(row.raw.inMessage)!.forward.toBoc().toString('base64')})?.kind??''));assert(node);return node;}
function snapshot(f:Fixture,row:{account:string;raw:RawTransaction}){const state=f.states.get(key(row.account,row.raw.lt,row.raw.hash));assert(state);return state;}
function replaceRef(cell:Cell,index:number,next:Cell){const b=beginCell().storeBits(cell.bits);cell.refs.forEach((ref,i)=>b.storeRef(i===index?next:ref));return b.endCell();}
function alterWalletBalance(f:Fixture,account:string,tx:RawTransaction,delta:bigint){const state=snapshot(f,{account,raw:tx}),wallet=readCurrentJettonWalletStorage(Cell.fromBase64(state.state.dataBoc!));state.state.dataBoc=writeCurrentJettonWalletStorage({...wallet,balance:wallet.balance+delta}).toBoc().toString('base64');}
function alterParticipant(f:Fixture,field:'payment'|'tokens'|'claimed'|'beneficiary'|'fill'){
 const row=ownerAcceptance(f),state=snapshot(f,row),root=Cell.fromBase64(state.state.dataBoc!),inner=root.refs[3],entryRef=f.model==='fixed'?1:1,cell=inner.refs[entryRef],cursor=cell.beginParse();
 const entries=cursor.loadDict(Dictionary.Keys.Address(),{serialize:(value:Cell,b:any)=>b.storeSlice(value.beginParse()),parse:(s:any)=>{const value=s.asCell();s.skip(s.remainingBits);while(s.remainingRefs)s.loadRef();return value;}});
 const owner=Address.parse(f.input.owner),old=entries.get(owner)!;assert(old);const s=old.beginParse(),first=s.loadCoins();
 const price=f.model==='auction'?s.loadCoins():null,quantity=s.loadCoins(),claimed=s.loadBoolean(),fillCount=f.model==='bonding'?s.loadUint(16):null,reward=s.loadMaybeAddress(),refund=s.loadMaybeAddress();
 const b=beginCell().storeCoins(first+(field==='payment'?1n:0n));if(price!==null)b.storeCoins(price);b.storeCoins(quantity+(field==='tokens'?1n:0n)).storeBit(field==='claimed'?true:claimed);if(fillCount!==null)b.storeUint(fillCount,16);b
  .storeAddress(field==='beneficiary'?Address.parse(f.accounts.creator):reward).storeAddress(refund);
 if(field==='fill'){const fill=s.loadRef().beginParse(),tokens=fill.loadCoins();b.storeRef(beginCell().storeCoins(tokens+1n).storeSlice(fill).endCell());}b.storeSlice(s);entries.set(owner,b.endCell());
 const updated=beginCell().storeDict(entries).endCell();state.state.dataBoc=replaceRef(root,3,replaceRef(inner,entryRef,updated)).toBoc().toString('base64');parsers[f.model](state.state.dataBoc);
}
function alterFeeJournal(f:Fixture,field:'amount'|'reserve') {
 const row=ownerAcceptance(f),state=snapshot(f,row),root=Cell.fromBase64(state.state.dataBoc!),inner=root.refs[3];
 const journalIndex=f.model==='auction'?2:3,journal=inner.refs[journalIndex],j=journal.beginParse();
 const entries=j.loadDict(Dictionary.Keys.BigUint(64),Dictionary.Values.Cell());
 const next=j.loadUintBig(64),current=j.loadUintBig(64),currentSale=j.loadUintBig(64),tail=j.loadUintBig(64),tailSale=j.loadUintBig(64),reserve=j.loadCoins(),saleReserve=j.loadCoins(),native=j.loadCoins();
 const changed=beginCell().storeDict(entries).storeUint(next,64).storeUint(current,64).storeUint(currentSale,64).storeUint(tail,64).storeUint(tailSale,64)
  .storeCoins(reserve+(field==='reserve'?1n:0n)).storeCoins(saleReserve).storeCoins(native+(field==='amount'?1n:0n)).storeSlice(j).endCell();
 state.state.dataBoc=replaceRef(root,3,replaceRef(inner,journalIndex,changed)).toBoc().toString('base64');parsers[f.model](state.state.dataBoc);
}
const physical=(events:LedgerEvent[])=>events.flatMap(e=>e.movements).map(({purpose,...movement})=>movement).sort((a,b)=>a.id.localeCompare(b.id));

let passed=0;
async function test(name:string,run:()=>Promise<void>|void){await run();passed++;console.log(`ok ${passed} - ${name}`);}
export async function testLaunchpadContributions(){
 const exports:Record<string,unknown>={},provenance:Record<string,string>={};
 for(const model of ['fixed','bonding','auction'] as const){
  await test(`${model}: actual cash and exact participant acceptance anchor`,async()=>{
   const f=participationFixture(model),projection=await project(f),events=accepted(projection.events);assert(events.length>0,JSON.stringify(projection.events.map(e=>({lt:e.lt,issues:e.issues}))));
   for(const e of events){const m=e.settlement!.launchpadParticipation!;assert.equal(m.model,model);assert.equal(m.network,'testnet');assert.equal(m.participant,f.input.owner);assert(m.entitlement);assert.equal(m.tokenDelivery,'separate-settlement');
    assert.deepEqual(e.launchpadRequests?.find(r=>r.originalRequest.messageIndex===m.originalRequest.messageIndex)?.originalRequest,m.originalRequest);
    for(const field of ['account','lt','hash','utime']as const)assert.equal(e[field],m.originalRequest.transaction[field]);
    const raw=f.input.chains.get(f.input.owner)!.transactions.find(t=>t.lt===e.lt&&canonicalLedgerHash(t.hash)===e.hash)!;
    assert.equal(m.originalRequest.incomingBodyHash,bodyCell(raw.inMessage)?.hash().toString('hex')??null);assert.equal(m.originalRequest.messageBodyHash,bodyCell(raw.outMessages[m.originalRequest.messageIndex])!.hash().toString('hex'));assert.equal(m.payment.requestBodyHash,m.originalRequest.messageBodyHash);
    const cash=e.movements.filter(m=>m.asset.kind==='jetton');assert.equal(cash.length,1);assert.equal(cash[0].direction,'out');assert.equal(cash[0].amountRaw,m.payment.amountRaw);assert.equal(cash[0].purpose,'launchpad_participation');assert.equal(cash[0].evidence.kind,'jetton_transfer');
    assert.equal(m.stateEvidence.length,3);const debit=m.stateEvidence.find(e=>e.purpose==='payment-debit')!,credit=m.stateEvidence.find(e=>e.purpose==='payment-credit')!;
    assert.equal(BigInt(debit.balanceBeforeRaw!)-BigInt(debit.balanceAfterRaw!),BigInt(m.payment.amountRaw));assert.equal(BigInt(credit.balanceAfterRaw!)-BigInt(credit.balanceBeforeRaw!),BigInt(m.payment.amountRaw));
   }
   exports[model]={scope:projection.projectionScope,events:projection.events};provenance[model]=f.fixtureSha256;
   const raw=participationFixture(model);raw.input.launchpadSales=new Map();assert.deepEqual(physical(projection.events),physical((await project(raw)).events),'Acceptance preserves exact physical amounts, fee evidence and unique movement IDs');
  });
  await test(`${model}: raw request identities exclude foreign, bounced, unknown and zero-payment messages`,async()=>{
   const f=participationFixture(model),e=accepted((await project(f)).events)[0],raw=f.input.chains.get(f.input.owner)!.transactions.find(t=>t.lt===e.lt)!;
   const node:any={id:e.id,account:f.input.owner,raw:structuredClone(raw),event:e},expected=readLaunchpadRequests(f.input,node);assert.equal(expected.length,1);
   node.account=f.accounts.creator;assert.deepEqual(readLaunchpadRequests(f.input,node),[]);node.account=f.input.owner;
   node.raw.outMessages[expected[0].originalRequest.messageIndex].bounced=true;assert.deepEqual(readLaunchpadRequests(f.input,node),[]);
   node.raw=structuredClone(raw);node.raw.outMessages[expected[0].originalRequest.messageIndex].source=f.accounts.creator;assert.deepEqual(readLaunchpadRequests(f.input,node),[]);
   node.raw=structuredClone(raw);const known=f.input.launchpadControllers,sales=f.input.launchpadSales;f.input.launchpadControllers=[];f.input.launchpadSales=new Map();assert.deepEqual(readLaunchpadRequests(f.input,node),[]);f.input.launchpadControllers=known;f.input.launchpadSales=sales;
   const msg=node.raw.outMessages[expected[0].originalRequest.messageIndex],body=bodyCell(msg)!.beginParse(),opcode=body.loadUint(32),q=body.loadUintBig(64);body.loadCoins();msg.body=beginCell().storeUint(opcode,32).storeUint(q,64).storeCoins(0n).storeSlice(body).endCell().toBoc().toString('base64');assert.deepEqual(readLaunchpadRequests(f.input,node),[]);
  });
  if(model!=='fixed'){
   await test(`${model}: distinct funded requests reuse query and exact body without deduplication`,async()=>{
    const events=accepted((await project(participationFixture(model))).events),sameQuery=events.filter(e=>e.settlement!.launchpadParticipation!.outerQueryId==='101');assert(sameQuery.length>=2);
    assert.equal(new Set(sameQuery.map(e=>e.id)).size,sameQuery.length);assert(sameQuery.some(e=>e.settlement!.launchpadParticipation!.entitlement!.before!==null));
    const bodies=new Map<string,LedgerEvent[]>();for(const e of sameQuery){const h=e.settlement!.launchpadParticipation!.payment.requestBodyHash;bodies.set(h,[...(bodies.get(h)??[]),e]);}assert([...bodies.values()].some(rows=>rows.length>=2));
   });
   await test(`${model}: outer/inner queries retain their distinct authentic values`,async()=>{
    const f=participationFixture(model,'otherOwner'),projection=await project(f),e=accepted(projection.events).find(e=>e.settlement!.launchpadParticipation!.outerQueryId==='1201');assert(e);assert.equal(e.settlement!.launchpadParticipation!.innerQueryId,'201');exports[`${model}-other`]={scope:projection.projectionScope,events:projection.events};
   });
  }
  await test(`${model}: archive-gap typed pending retains original identity without invented entitlement`,async()=>{
   const f=participationFixture(model),complete=await project(f),first=accepted(complete.events)[0],row=ownerAcceptance(f);f.states.delete(key(row.account,row.raw.lt,row.raw.hash));
   const pending=await project(f),e=pending.events.find(e=>e.id===first.id)!;assert.equal(e.kind,'launchpad_participation');assert.equal(e.settlement?.status,'incomplete');assert.deepEqual(e.launchpadRequests,first.launchpadRequests);
   assert.equal(e.settlement?.launchpadParticipation?.entitlement,null);assert.deepEqual(e.settlement?.launchpadParticipation?.stateEvidence,[]);assert.deepEqual(physical(pending.events),physical(complete.events));
   exports[`${model}-archive-missing`]={scope:pending.projectionScope,events:pending.events};
  });
  await test(`${model}: pre-credit raw request has narrow marker and preserves original identity`,async()=>{
   const f=participationFixture(model),first=accepted((await project(f)).events)[0],metadata=first.settlement!.launchpadParticipation!,credit=metadata.stateEvidence.find(e=>e.purpose==='payment-credit')!;
   for(const chain of f.input.chains.values())chain.transactions=chain.transactions.filter(t=>BigInt(t.lt)<BigInt(credit.transaction.lt));
   for(const[k,state]of f.states)if(BigInt(state.state.lastTxLt!)>=BigInt(credit.transaction.lt))f.states.delete(k);
   const pending=await project(f),e=pending.events.find(e=>e.id===first.id)!;assert(e.issues.includes('launchpad_participation_settlement_unverified'));assert.notEqual(e.kind,'launchpad_participation');assert.notEqual(e.settlement?.status,'confirmed');assert.deepEqual(e.launchpadRequests,first.launchpadRequests);
   exports[`${model}-before-credit`]={scope:pending.projectionScope,events:pending.events};
  });
  await test(`${model}: acceptance precedes fee delivery and never needs aggregate finalization`,async()=>{
   const f=participationFixture(model),row=ownerAcceptance(f);for(const chain of f.input.chains.values())chain.transactions=chain.transactions.filter(t=>BigInt(t.lt)<=BigInt(row.raw.lt));
   const result=accepted((await project(f)).events);assert.equal(result.length,1);assert.equal(result[0].settlement!.launchpadParticipation!.tokenDelivery,'separate-settlement');
  });
  if(model!=='fixed')await test(`${model}: actual rejected request cannot borrow another acceptance`,async()=>{
   assert(!accepted((await project(participationFixture(model))).events).some(e=>e.settlement!.launchpadParticipation!.outerQueryId==='301'));
  });
  const negatives:Record<string,(f:Fixture)=>void>={
   ...(model==='fixed'?{}:{'wrong fill-chain head':(f:Fixture)=>alterParticipant(f,'fill')}),
   'wrong fee liability amount':f=>alterFeeJournal(f,'amount'),
   'wrong reserved fee delta':f=>alterFeeJournal(f,'reserve'),
   'missing acceptance archive':f=>{const row=ownerAcceptance(f);f.states.delete(key(row.account,row.raw.lt,row.raw.hash));},
   'wrong historical sale code':f=>{snapshot(f,ownerAcceptance(f)).state.codeBoc=Cell.EMPTY.toBoc().toString('base64');},
   'wrong participant payment delta':f=>alterParticipant(f,'payment'),
   'wrong participant token delta':f=>alterParticipant(f,'tokens'),
   'claimed entry cannot be accepted':f=>alterParticipant(f,'claimed'),
   'changed beneficiary cannot be accepted':f=>alterParticipant(f,'beneficiary'),
   'missing owner original request':f=>{const tx=ownerAcceptance(f),q=tokenWire(tx.raw.inMessage)!.queryId;const c=f.input.chains.get(f.input.owner)!;c.transactions=c.transactions.filter(t=>!t.outMessages.some(m=>m.op===TRANSFER&&tokenWire(m)?.queryId===q));},
   'incomplete wallet history':f=>{f.input.chains.get(f.accounts.ownerPaymentWallet)!.historyComplete=false;},
   'wrong original debit balance':f=>{const accept=ownerAcceptance(f),q=tokenWire(accept.raw.inMessage)!.queryId,tx=f.input.chains.get(f.accounts.ownerPaymentWallet)!.transactions.find(t=>t.inMessage?.op===TRANSFER&&tokenWire(t.inMessage)?.queryId===q)!;alterWalletBalance(f,f.accounts.ownerPaymentWallet,tx,1n);},
   'wrong original credit balance':f=>{const accept=ownerAcceptance(f),q=tokenWire(accept.raw.inMessage)!.queryId,tx=f.input.chains.get(f.accounts.paymentSaleWallet)!.transactions.find(t=>tokenWire(t.inMessage)?.queryId===q&&tokenWire(t.inMessage)?.owner===f.input.owner)!;alterWalletBalance(f,f.accounts.paymentSaleWallet,tx,1n);},
  };
  for(const[name,change]of Object.entries(negatives))await test(`${model}: rejects ${name}`,async()=>{
   const f=participationFixture(model),row=ownerAcceptance(f),q=tokenWire(row.raw.inMessage)!.queryId;change(f);const projection=await project(f);
   assert(!accepted(projection.events).some(e=>e.settlement!.launchpadParticipation!.outerQueryId===q&&e.settlement!.launchpadParticipation!.stateEvidence.some(s=>s.transaction.lt===row.raw.lt)),name);
  });
 }
 const dir=process.env.LAUNCHPAD_PARTICIPATION_EXPORT_DIR;if(dir){mkdirSync(dir,{recursive:true});for(const[name,value]of Object.entries(exports))writeFileSync(resolve(dir,`launchpad-${name}-participation.json`),JSON.stringify(value,null,2)+'\n');writeFileSync(resolve(dir,'participation-provenance.json'),JSON.stringify({recordedAt:new Date().toISOString(),fixtureSha256:provenance,passed,source:'Actual untransformed Sandbox histories projected as testnet simulation; exact original bodies/transaction hashes preserved.'},null,2)+'\n');}
 console.log(`Launchpad participation: ${passed} focused cases passed.`);
}
if(require.main===module)testLaunchpadContributions().catch(error=>{console.error(error);process.exitCode=1;});
