/** Native original failure/account histories; proof block wrappers are synthetic
 * test consensus. This does not attest a deployment or public lite-server. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Address,beginCell,Cell,Dictionary,loadMessage,loadShardAccount,storeShardAccount} from '@ton/core';
import {currentFaucetFixtureManifest} from './support/currentFaucetFixture';
import {spotEvidenceFixtureAdapter} from './current-spot-operation-evidence-test';
import {verifyOrderTransaction} from '../orders/evidence';
import {canonicalPhysicalMessage} from '../runtime/physicalEvidence';
import {proofBlock,proofMasterchain} from './support/fakeLiteEngine';
import {collectFaucetProofSession,readFaucetProofSessionRequest} from '../runtime/t3ProofSession';
import {decodeOriginalTransaction} from '../data/transactionEvidence';
import type {RecoveryProofAnchor} from '../data/dataSource';
async function main(){
 const path=process.argv[2],output=process.argv[3];assert(path&&output);const bytes=readFileSync(path),capture=JSON.parse(bytes.toString()),out:any[]=[],savedNow=Date.now;
 const proofCode=Cell.fromBoc(readFileSync(capture.artifacts.T3RecoveryProof.file))[0];assert.equal(proofCode.hash().toString('hex'),capture.artifacts.T3RecoveryProof.codeHash);
 try{for(const c of capture.cases.filter((c:any)=>c.scenario==='source-failure-unrecorded')){
  Date.now=()=>c.now*1000;
  const {manifest}=currentFaucetFixtureManifest(c,proofCode.hash().toString('hex')),a=spotEvidenceFixtureAdapter(manifest,c.currentAccounts,c.transactions,c.now,c.getters);
  const failure=c.transactions.find((r:any)=>verifyOrderTransaction(r).hash===c.recovery.sourceFailureHash),sourceAddress=failure.account;
  const current=Cell.fromBase64(c.currentAccounts.find((r:any)=>r.address===sourceAddress).shardAccountBoc),key=BigInt('0x'+Address.parse(sourceAddress).hash.toString('hex'));
  const map=Dictionary.empty(Dictionary.Keys.BigUint(256),{serialize(v:Cell,b:ReturnType<typeof beginCell>){b.storeUint(0,5).storeCoins(0).storeBit(false).storeSlice(v.beginParse());},parse(s:any){return s.asCell();}}).set(key,current);
  const shard=proofBlock(70,c.now,0,{accounts:beginCell().storeDict(map).storeUint(0,5).storeCoins(0).storeBit(false).endCell()}),master=proofMasterchain(100,c.now,shard);
  Object.assign(a.head,{seqno:100,rootHashHex:master.id.rootHash.toString('hex'),fileHashHex:master.id.fileHash.toString('hex')});
  const anchor:RecoveryProofAnchor={account:sourceAddress,head:a.head,shardBlock:{workchain:0,shard:shard.id.shard,seqno:70,rootHashHex:shard.id.rootHash.toString('hex'),fileHashHex:shard.id.fileHash.toString('hex')},masterchainProofBoc:master.proof.toString('base64'),accountProofBoc:shard.proof.toString('base64'),accountBoc:current.refs[0].toBoc().toString('base64'),shardAccountBoc:current.toBoc().toString('base64')};
  a.source.getRecoveryProofAnchor=async(address,options)=>{assert.equal(address,sourceAddress);assert.deepEqual(options?.at,a.head);return anchor;};
  const read=a.source.getAccountState.bind(a.source);a.source.getAccountState=async(address,options)=>a.states.has(address)?read(address,options):{accountState:'uninitialized',balance:'0',provenAbsent:true};
  const original=c.transactions.find((r:any)=>verifyOrderTransaction(r).hash===c.request.hash),incoming=verifyOrderTransaction(original).incoming!;
  const owner=c.transactions.filter((r:any)=>r.account===c.owner).map(verifyOrderTransaction).find((t:any)=>[...t.outgoing.values()].some((m:any)=>canonicalPhysicalMessage(m).equals(canonicalPhysicalMessage(incoming))));assert(owner);
  const message=loadMessage(incoming.beginParse());assert(message.info.type==='internal');
  const request={network:'localnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,kind:'claim',owner:c.owner,faucet:c.faucet,asset:0,queryId:c.request.queryId,bodyBoc:c.request.bodyBoc,bodyHash:c.request.bodyHash,valueNano:c.request.valueNano,createdAt:c.now*1000,dispatch:{lt:String(owner.tx.lt),hash:owner.hash,valueNano:String(message.info.value.coins)}};
  const wire={original:request,nonce:'0'.repeat(63)+'1',anchor:null,proofCodeBoc:proofCode.toBoc().toString('base64')};
  const response=await collectFaucetProofSession(manifest,a.source,a.store,readFaucetProofSessionRequest(wire,manifest));assert.equal(response.sessionShardAccountBoc,null);assert.equal(response.transactionBocs.length,0);assert.equal(response.recovery.sourceFailure?.targetLt,response.recovery.sourceFailure?.sourceLt);
  const resumed=await collectFaucetProofSession(manifest,a.source,a.store,readFaucetProofSessionRequest({...wire,anchor:a.head},manifest));assert.equal(resumed.address,response.address);
  // A synthetic current session cursor drives the real collector; its source
  // suffix remains original native history. ChainSource cursors are base64.
  const pointer=loadShardAccount(current.beginParse()),session=loadShardAccount(current.beginParse());assert(session.account);
  session.account.addr=Address.parse(response.address);session.account.storage.state={type:'active',state:{code:proofCode,data:beginCell().storeRef(Cell.fromBase64(response.configBoc)).storeUint(2,3).storeUint(0,256).storeRef(beginCell().storeUint(pointer.lastTransactionHash,256).storeUint(0,256).storeUint(0,9).storeUint(pointer.lastTransactionLt,64)).storeUint(0,2).endCell()}};
  const sessionBoc=beginCell().store(storeShardAccount(session)).endCell().toBoc().toString('base64'),previousRead=a.source.getAccountState;
  a.source.getAccountState=async(address,options)=>address===response.address?{accountState:'active',balance:'1000000000',shardAccountBoc:sessionBoc}:previousRead(address,options);
  let cursorChecks=0;
  a.source.getTransactions=async(address,limit,lt,hash,options)=>{assert.equal(Buffer.from(hash,'base64').length,32);assert(!/^[0-9a-f]{64}$/.test(hash));cursorChecks++;const rows=[];let selected=Buffer.from(hash,'base64').toString('hex');for(let n=0;n<limit;n++){const row=c.transactions.find((r:any)=>r.account===address&&Cell.fromBase64(r.transactionBoc).hash().toString('hex')===selected);if(!row)break;const original=decodeOriginalTransaction(Cell.fromBase64(row.transactionBoc),Address.parse(address));if(!n)assert.equal(original.lt,lt);rows.push(original);selected=verifyOrderTransaction(row).tx.prevTransactionHash.toString(16).padStart(64,'0');}return rows;};
  const chunk=await collectFaucetProofSession(manifest,a.source,a.store,readFaucetProofSessionRequest({...wire,anchor:a.head},manifest));assert(cursorChecks>0);assert(chunk.transactionBocs.length>0&&chunk.transactionBocs.length<=4);assert.equal(Cell.fromBase64(chunk.transactionBocs.at(-1)!).hash().toString('hex'),c.recovery.sourceFailureHash);
  a.source.getAccountState=previousRead;
  for(const bad of [{nonce:'1'},{anchor:{...a.head,workchain:0}},{proofCodeBoc:Cell.EMPTY.toBoc().toString('base64')},{extra:true}])assert.throws(()=>readFaucetProofSessionRequest({...wire,...bad},manifest));
  for(const change of [{accountBoc:Cell.EMPTY.toBoc().toString('base64')},{head:{...anchor.head,seqno:anchor.head.seqno+1}}]){a.source.getRecoveryProofAnchor=async()=>({...anchor,...change});await assert.rejects(collectFaucetProofSession(manifest,a.source,a.store,readFaucetProofSessionRequest(wire,manifest)));}
  await assert.rejects(collectFaucetProofSession(manifest,a.source,a.store,readFaucetProofSessionRequest({...wire,anchor:{...a.head,rootHashHex:'f'.repeat(64)}},manifest)));
  out.push({config:c.config,request:wire,manifest,response});console.log('PASS',c.config,'original failure → bounded proof session; resume/base64 cursor suffix and malformed code/anchor/source refusals');
 }}finally{Date.now=savedNow;}
 writeFileSync(output,JSON.stringify({schema:'tonswap-native-faucet-proof-session-test-v1',qualification:'Original native failure/account bytes with synthetic master/shard proof wrappers and head adapter. Not a deployed-chain attestation.',source:path,sourceSha256:createHash('sha256').update(bytes).digest('hex'),cases:out})+'\n',{flag:'wx'});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
