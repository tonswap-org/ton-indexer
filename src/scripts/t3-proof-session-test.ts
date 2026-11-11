import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, beginCell, Cell, Dictionary, loadShardAccount } from '@ton/core';
import { FakeLiteEngine, proofBlock, proofMasterchain, merkleProof } from './support/fakeLiteEngine';
import { createLiteChainSource } from '../data/liteClientSource';
import { validateRecoveryProofAnchor, validateRecoveryProofHistory, recoveryAccountPath } from '../data/t3ProofBundle';
import { recoveryInitialData, readRecoverySessionData } from '../runtime/t3ProofSession';
import type { ChainHead, RecoveryProofAnchor } from '../data/dataSource';
const original=Cell.fromBoc(readFileSync(join(__dirname,'fixtures/perps-intermediate-state/predecessor.boc')))[0], account=original.refs[0],address=loadShardAccount(original.beginParse()).account!.addr;
const accounts=Dictionary.empty(Dictionary.Keys.BigUint(256),{serialize(c:Cell,b:ReturnType<typeof beginCell>){b.storeUint(0,5).storeCoins(0).storeBit(false).storeSlice(c.beginParse());},parse(s:any){return s.asCell();}}).set(BigInt('0x'+address.hash.toString('hex')),original);
const shard=proofBlock(70,1000,0,{accounts:beginCell().storeDict(accounts).storeUint(0,5).storeCoins(0).storeBit(false).endCell()}),master=proofMasterchain(100,1001,shard);
const head:ChainHead={workchain:-1,shard:master.id.shard,seqno:100,utime:1001,rootHashHex:master.id.rootHash.toString('hex'),fileHashHex:master.id.fileHash.toString('hex')};
const a:RecoveryProofAnchor={account:address.toRawString(),head,shardBlock:{workchain:0,shard:shard.id.shard,seqno:70,rootHashHex:shard.id.rootHash.toString('hex'),fileHashHex:shard.id.fileHash.toString('hex')},masterchainProofBoc:master.proof.toString('base64'),accountProofBoc:shard.proof.toString('base64'),accountBoc:account.toBoc().toString('base64'),shardAccountBoc:original.toBoc().toString('base64')};
const p=validateRecoveryProofAnchor(a),cursor={hash:BigInt('0x'+p.root.hash(0).toString('hex')),key:p.key,bits:256,lt:0n};
const chunk=recoveryAccountPath(a,cursor);assert.equal(chunk.done,true);assert.equal(chunk.next.lt,loadShardAccount(original.beginParse()).lastTransactionLt);
for(const changed of [{head:{...head,utime:1002}},{head:{...head,rootHashHex:'ff'.repeat(32)}},{account:Address.parse(`0:${'11'.repeat(32)}`).toRawString()},{accountBoc:Cell.EMPTY.toBoc().toString('base64')},{shardAccountBoc:Cell.EMPTY.toBoc().toString('base64')}])assert.throws(()=>validateRecoveryProofAnchor({...a,...changed}));
for(const changed of [{hash:1n},{key:0n},{bits:255},{lt:1n}])assert.throws(()=>recoveryAccountPath(a,{...cursor,...changed}));
// Exact native augmented prev_blocks leaf; these block roots are test-only.
const prior=Dictionary.empty(Dictionary.Keys.Uint(32),{serialize(_:number,b:ReturnType<typeof beginCell>){b.storeBit(false).storeUint(0,64).storeBit(false).storeUint(0,64).storeUint(head.seqno,32).storeBuffer(master.id.rootHash).storeBuffer(master.id.fileHash);},parse(){return 0;}}).set(head.seqno,0);
const oldExtras=master.state.refs[3].beginParse();oldExtras.loadUint(16);const hashes=oldExtras.loadMaybeRef();oldExtras.loadUintBig(256);const config=oldExtras.loadRef();
const info=beginCell().storeUint(0,16).storeUint(0,32).storeUint(0,32).storeBit(false).storeDict(prior).endCell();
const extras=beginCell().storeUint(0xcc26,16).storeMaybeRef(hashes).storeUint(0,256).storeRef(config).storeRef(info).storeCoins(0).storeBit(false).endCell();
const newer=proofBlock(101,1002,-1,{extras}),newHead={...head,seqno:101,utime:1002,rootHashHex:newer.id.rootHash.toString('hex'),fileHashHex:newer.id.fileHash.toString('hex')};
const history={head:newHead,anchor:head,blockBoc:newer.cell.toBoc().toString('base64'),stateBoc:newer.state.toBoc().toString('base64')};
validateRecoveryProofHistory(history);assert.throws(()=>validateRecoveryProofHistory({...history,anchor:{...head,fileHashHex:'ff'.repeat(32)}}));assert.throws(()=>validateRecoveryProofHistory({...history,stateBoc:master.state.toBoc().toString('base64')}));
const cfg=beginCell().storeUint(1,256).storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).endCell();assert.equal(readRecoverySessionData(recoveryInitialData(cfg),cfg).phase,0);assert.throws(()=>readRecoverySessionData(recoveryInitialData(cfg),Cell.EMPTY));
async function main(){
 const engine=new FakeLiteEngine(async q=>{
  if(q.kind==='liteServer.lookupBlock')return q.id.seqno===101?{id:newer.id,headerProof:newer.headerProof}:{id:master.id,headerProof:master.headerProof};
  if(q.kind==='liteServer.getAccountState')return{id:master.id,shardblk:shard.id,state:account.toBoc(),proof:shard.proof,shardProof:master.proof};
  if(q.kind==='liteServer.getBlockProof')return{complete:true,from:newer.id,to:master.id,steps:[{kind:'liteServer.blockLinkBack',from:newer.id,to:master.id,proof:newer.headerProof,stateProof:merkleProof(newer.state).toBoc(),destProof:master.headerProof,toKeyBlock:false}]};
  throw Error(q.kind);
 });
 const source=createLiteChainSource({network:'testnet',logger:{info(){},warn(){},debug(){},error(){}},peers:[{host:'127.0.0.1',port:1,publicKey:Buffer.alloc(32)}],engineFactory:()=>engine});
 try{const actual=await source.getRecoveryProofAnchor(address.toRawString(),{at:head});assert.deepEqual(actual,a);const old=await source.getRecoveryProofHistory(head,{at:newHead});assert.deepEqual(old,history);
  await assert.rejects(source.getRecoveryProofAnchor(address.toRawString(),{at:{...head,rootHashHex:'ff'.repeat(32)}}));
 }finally{await source.close();}
 console.log('PASS T3 original anchor, native account cursor, historical prev_blocks and ChainSource transport (17 checks)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
