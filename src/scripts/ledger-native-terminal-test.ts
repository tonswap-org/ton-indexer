import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, beginCell, loadShardAccount } from '@ton/core';
import type { RawTransaction } from '../data/dataSource';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { normalizeLedgerEvent } from '../ledger/normalize';
import { projectOwnerLedger, type LedgerChain } from '../ledger/project';
import { projectionFingerprint } from '../ledger/store';
import type { LedgerEvent, LedgerProjection } from '../ledger/types';
import { ledgerSchemas } from '../ledger/openapi';
import { loadOpcodes } from '../utils/opcodes';

const fixturePath=resolve(__dirname,'fixtures/dlmm-market-settlements.json'), originalBytes=readFileSync(fixturePath), fixture=JSON.parse(originalBytes.toString());
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const selected=fixture.transactions.filter((row:any)=>row.phase==='retry-underfunded-failed');
const decode=(row:any)=>decodeOriginalTransaction(Cell.fromBase64(row.transactionBoc),Address.parse(row.account));
const sourceRows=selected.map((row:any)=>({account:row.account,raw:decode(row)}));
const failed=sourceRows.find((row:any)=>row.raw.status==='failed')!;
const opcodes=loadOpcodes(), checks:{name:string;status:string;error?:string}[]=[], records:Record<string,unknown>={};
const output=process.env.NATIVE_TERMINAL_EXPORT_DIR;
async function test(name:string,fn:()=>void|Promise<void>){try{await fn();checks.push({name,status:'passed'});console.log('PASS',name);}catch(error){checks.push({name,status:'failed',error:error instanceof Error?error.stack:String(error)});console.error('FAIL',name,error);}}
const delta=(event:LedgerEvent)=>event.movements.reduce((sum,m)=>sum+(m.direction==='in'?1n:-1n)*BigInt(m.amountRaw),0n);
const boundary=(row:any)=>fixture.boundaries.find((b:any)=>b.account===row.account&&b.transactionLt===row.raw.lt);
const balance=(side:any)=>loadShardAccount(Cell.fromBase64(side.shardAccountBoc).beginParse()).account!.storage.balance.coins;
async function project(rows=sourceRows, controlled=false):Promise<LedgerProjection>{
 const owner=controlled?fixture.accounts.keeper:failed.account;
 const chains=new Map<string,LedgerChain>();
 for(const row of rows){const chain:LedgerChain=chains.get(row.account)??{account:row.account,generation:null,historyComplete:false,role:row.account===owner?'owner':controlled?'controlled_contract':'counterparty',transactions:[]};chain.transactions.push(row.raw);chains.set(row.account,chain);}
 return projectOwnerLedger({network:fixture.network,owner,chains,wallets:new Map(),pools:new Map(),opcodes,stateAt:async()=>null});
}
function verifyNative(event:LedgerEvent){
 for(const movement of event.movements){
  if(movement.asset.kind!=='native')continue;
  assert.equal(movement.evidence.transactions?.length,1);
  const ref=movement.evidence.transactions![0];
  const original=sourceRows.find((row:any)=>row.account===ref.account&&row.raw.lt===ref.lt&&row.raw.hash===ref.hash);
  assert(original,'Each native movement binds one original transaction, not the merged event anchor.');
  assert.equal(movement.evidence.transactionStatus,original.raw.status);
  assert.equal(ref.utime,original.raw.utime);
 }
}
async function main(){
 await test('original failed transaction BOC retains native input, bounce, fees and exact state conservation',async()=>{
  const raw=failed.raw,event=await normalizeLedgerEvent('localnet',failed.account,raw,opcodes);
  assert.equal(raw.status,'failed');assert.equal(raw.totalFeesRaw,'5721909');assert.equal(raw.inMessage?.value,'149999999');assert.equal(raw.outMessages[0].value,'144233664');assert.equal(raw.outMessages[0].bounced,true);
  assert.deepEqual(event.movements.map(m=>[m.evidence.kind,m.amountRaw]),[['native_message','149999999'],['native_message','144233664'],['transaction_fee','5721909'],['message_forward_fee','44446']]);
  verifyNative(event);assert.equal(delta(event),-20n);const b=boundary(failed);assert.equal(balance(b.after)-balance(b.before),delta(event));
  records.failedStandalone=event;records.failedBalance={beforeRaw:String(balance(b.before)),afterRaw:String(balance(b.after)),deltaRaw:String(delta(event))};
 });
 await test('account-local owner projection emits each native fee slot once with failed terminal evidence',async()=>{
  const projection=await project(),event=projection.events.find(e=>e.lt===failed.raw.lt)!;
  assert.equal(event.status,'failed');verifyNative(event);assert.equal(delta(event),-20n);
  assert.equal(event.movements.filter(m=>m.evidence.kind==='transaction_fee').length,1);assert.equal(event.movements.filter(m=>m.evidence.kind==='message_forward_fee').length,1);
  records.failedAccountProjection=projection;
 });
 await test('mixed success-first grouping preserves the actual failed fee transaction rather than its successful anchor',async()=>{
  // Scope is deliberately constructed over authentic transactions; this is not
  // evidence that an individual owns or controls the captured pool contract.
  const projection=await project(sourceRows,true);assert.equal(projection.events.length,1);const event=projection.events[0];
  assert.equal(event.status,'success');verifyNative(event);
  assert.deepEqual(new Set(event.movements.map(m=>m.evidence.transactionStatus)),new Set(['success','failed']));
  const feeTotal=sourceRows.reduce((sum:bigint,row:any)=>sum+BigInt(row.raw.totalFeesRaw),0n);assert.equal(event.totalFeesRaw,String(feeTotal));
  const grouped=new Map<string,any[]>();for(const row of sourceRows)grouped.set(row.account,[...(grouped.get(row.account)??[]),row]);
  const stateDelta=[...grouped.values()].reduce((sum,rows)=>sum+balance(boundary(rows.at(-1)).after)-balance(boundary(rows[0]).before),0n);
  assert.equal(delta(event),stateDelta);assert(event.movements.every(m=>m.direction==='fee'),'Owned native message pairs are removed, actual charges remain.');
  records.mixedSuccessAnchor=projection;records.mixedBalance={stateDeltaRaw:String(stateDelta),movementDeltaRaw:String(delta(event))};
 });
 await test('mixed failure-first grouping does not overwrite a later successful bounce-receipt charge',async()=>{
  const projection=await project(sourceRows.slice(1),true);assert.equal(projection.events.length,1);const event=projection.events[0];assert.equal(event.status,'failed');verifyNative(event);
  assert(event.movements.some(m=>m.evidence.transactionStatus==='success'));assert(event.movements.some(m=>m.evidence.transactionStatus==='failed'));records.mixedFailureAnchor=projection;
 });
 await test('re-decoding original BOC ignores a contradictory provider summary instead of certifying invented outcome',()=>{
  const row=selected.find((x:any)=>x.account===failed.account), altered={...row,raw:{...row.raw,status:'success',success:true,totalFeesRaw:'0'}};
  const decoded=decode(altered);assert.equal(decoded.status,'failed');assert.equal(decoded.totalFeesRaw,'5721909');assert.equal(decoded.rawBoc,failed.raw.rawBoc);
 });
 await test('explicit nonterminal, missing and contradictory raw outcome cannot produce terminal native evidence',async()=>{
  for(const change of [{status:'pending',success:false},{status:undefined},{status:'failed',success:true},{status:'success',success:false}])
   await assert.rejects(()=>normalizeLedgerEvent('localnet',failed.account,{...failed.raw,...change} as RawTransaction,opcodes),/terminal|outcome|status/i);
 });
 await test('current full-bounce extra_flags are metadata and never an invented native fee',async()=>{
  const raw:RawTransaction={...failed.raw,rawBoc:undefined,outMessages:[{...failed.raw.outMessages[0],forwardFeeRaw:'44446',extraFlagsRaw:'3'}]};
  const event=await normalizeLedgerEvent('localnet',failed.account,raw,opcodes),fees=event.movements.filter(m=>m.evidence.kind==='message_forward_fee');
  assert.equal(fees.length,1);assert(fees[0].id.endsWith(':forward:0'));assert.equal(event.totalFeesRaw,'5721909');
  assert.equal(delta(event),-20n);records.constructedExtraFlags={scope:'Constructed current flags metadata guard; genuine rich-bounce graph is tested separately.',raw,event};
 });
 await test('failed positive jetton instruction retains actual native costs without declaring a token credit',async()=>{
  const owner=fixture.accounts.keeper,master=fixture.accounts.tokenT,body=beginCell().storeUint(0x178d4519,32).storeUint(1n,64).storeCoins(100n).storeAddress(Address.parse(owner)).storeAddress(null).storeCoins(0n).storeBit(0).endCell();
  const raw:RawTransaction={lt:'100',hash:Buffer.alloc(32,7).toString('base64'),utime:failed.raw.utime,status:'failed',success:false,totalFeesRaw:'10',inMessage:{source:owner,destination:failed.account,value:'50',op:0x178d4519,body:body.toBoc().toString('base64')},outMessages:[]};
  const event=await normalizeLedgerEvent('localnet',failed.account,raw,opcodes,async()=>({kind:'jetton',id:`localnet:jetton:${master}`,master,owner,wallet:failed.account,decimals:9}));
  assert(!event.movements.some(m=>m.asset.kind==='jetton'));assert(event.issues.includes('jetton_settlement_unconfirmed'));assert(event.movements.every(m=>m.evidence.transactionStatus==='failed'));
 });
 await test('native terminal data affects durable discovery fingerprints',async()=>{
  const original=await project(),changed=structuredClone(original);changed.events[0].movements[0].evidence.transactionStatus='success';
  assert.notEqual(projectionFingerprint(original,[],[]),projectionFingerprint(changed,[],[]));
 });
 await test('wire schema requires native terminal outcome without extending shared historical evidence references',()=>{
  const schema=ledgerSchemas.LedgerMovement.properties.evidence as any;
  assert.deepEqual(schema.properties.transactionStatus.enum,['success','failed']);assert(schema.allOf.some((branch:any)=>branch.then?.required?.includes('transactionStatus')));
  assert.equal(schema.properties.transactions.items.properties.transactionStatus,undefined);
 });
 await test('original archived Sandbox transaction and state bytes remain immutable',()=>{
  assert(readFileSync(fixturePath).equals(originalBytes));
  for(const row of selected)assert.equal(decode(row).rawBoc,Cell.fromBase64(row.transactionBoc).toBoc().toString('base64'));
 });
 if(output){mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'results.json'),JSON.stringify({checks,passed:checks.filter(x=>x.status==='passed').length,failed:checks.filter(x=>x.status==='failed').length},null,2)+'\n');writeFileSync(resolve(output,'native-terminal-ledger.json'),JSON.stringify({scope:'Original retained Sandbox BOCs with separately constructed controlled-account grouping; no personal ownership, new execution or tax classification claim.',fixtureSha256:sha(originalBytes),...records},null,2)+'\n');writeFileSync(resolve(output,'original-source.json'),JSON.stringify({fixturePath,fixtureSha256:sha(originalBytes),scope:'Immutable existing Sandbox capture, original limitations retained.',sourceDescription:fixture.description,fixtureScope:fixture.scope,transactions:selected,boundaries:selected.map((row:any)=>boundary({account:row.account,raw:decode(row)}))},null,2)+'\n');}
 if(checks.some(x=>x.status==='failed'))process.exitCode=1;
}
void main();
