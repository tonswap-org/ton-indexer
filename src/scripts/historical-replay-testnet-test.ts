import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadShardAccount, loadTransaction, storeShardAccount } from '@ton/core';
import { Executor, type IExecutor } from '@ton/sandbox';
import { replayHistoricalAccount, type HistoricalReplayStep } from '../data/historicalReplay';
import { readPerpsState, perpsPosition } from '../ledger/perpsState';

// Original live testnet OPEN plus its four canonical callbacks, captured through
// the authenticated archival path. These are not sandbox-generated transactions.
const dir=join(__dirname,'fixtures/perps-testnet-open-20260912');
const proof=JSON.parse(readFileSync(join(dir,'provenance.json'),'utf8'));
assert.equal(proof.schema,'tonswap-authenticated-live-replay-fixture-v1');
assert.equal(proof.network,'ton:testnet');
assert.equal(proof.containingMasterSeqno,84297582);
for(const [file,expected]of Object.entries(proof.files))assert.equal(createHash('sha256').update(readFileSync(join(dir,file))).digest('hex'),expected);
const cell=(file:string)=>Cell.fromBoc(readFileSync(join(dir,file)))[0];
const address=Address.parse('0:38697fcef0a87c58390747ccc5f39eb7adc0388bafa93b99dc2a14ec449755f0');
const predecessor=cell(proof.predecessor);
const steps:HistoricalReplayStep[]=proof.steps.map((s:{transaction:string;block:string;config:string})=>({transaction:cell(s.transaction),block:cell(s.block),config:cell(s.config)}));
const cursor=(index:number)=>({lt:loadTransaction(steps[index].transaction.beginParse()).lt.toString(),hash:steps[index].transaction.hash().toString('hex')});
const input={address,predecessor,steps:[steps[0]],cursor:cursor(0)};

async function main(){
 assert.equal(steps.length,5);
 assert.equal(input.cursor.lt,'96066824000007');
 assert.equal(input.cursor.hash,'cf677711093bea5550207cd76a6e204a342a1b3c563bf055bb1c3feda7c18f02');
 assert.equal(cursor(4).hash,'5bfc365626a79a7808612f618ca3b5a52d3cddaddd9e0823f09722c20a586691');
 const config=steps[0].config.beginParse().loadDictDirect(Dictionary.Keys.Int(32),Dictionary.Values.Cell());
 const version=config.get(8)!.beginParse();assert.equal(version.loadUint(8),0xc4);assert.equal(version.loadUint(32),15);
 assert.equal(config.get(43)!.beginParse().preloadUint(8),2);
 assert.equal(config.get(43)!.bits.length,401,'actual extended size-limit config escaped old default-config tests');
 const executor=await Executor.create();
 for(let i=0;i<steps.length;i++){
   const state=await replayHistoricalAccount({...input,cursor:cursor(i),steps:steps.slice(0,i+1)},executor);
   assert.equal(state.lastTxLt,cursor(i).lt);
   assert.equal(Buffer.from(state.lastTxHash!,'base64').toString('hex'),cursor(i).hash);
   const engine=readPerpsState(state.dataBoc!,'aae9a68a6cf0a37fe07cca90c9ceadce3e06081ce3c87faad0f6bba02376c7cd');
   const position=perpsPosition(engine,'0:9c0406499ed9f40c3d35ab7e77e34551e79b12b33038f5e172cf76a8bbb0e5c9',2);
   assert.equal(position?.sizeRaw,'1000000000');assert.equal(position?.marginRaw,'1000000000');assert.equal(position?.entryNotionalRaw,'1000400000');
 }
 console.log('PASS authentic TVM15/config43 OPEN and four callbacks reproduce every original transaction and Account commitment');
 const changed=loadShardAccount(predecessor.beginParse());
 assert.equal(changed.account!.storage.state.type,'active');
 if(changed.account!.storage.state.type!=='active')throw Error('fixture inactive');
 changed.account!.storage.state.state.code=Cell.EMPTY;
 await assert.rejects(replayHistoricalAccount({...input,predecessor:beginCell().store(storeShardAccount(changed)).endCell()},executor),/binding mismatch/);
 await assert.rejects(replayHistoricalAccount({...input,steps:[{...steps[0],config:Cell.EMPTY}]},executor));
 const forged={runTransaction:async()=>({result:{success:true,transaction:steps[0].transaction.toBoc().toString('base64'),shardAccount:predecessor.toBoc().toString('base64')}})} as unknown as IExecutor;
 await assert.rejects(replayHistoricalAccount(input,forged),/commitment mismatch/);
 await assert.rejects(replayHistoricalAccount({...input,cursor:{...input.cursor,hash:'00'.repeat(32)}},executor),/cursor mismatch/);
 console.log('PASS tampered original code/config, invented after-state and unrelated cursor cannot produce accepted evidence');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
