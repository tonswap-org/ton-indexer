/** Native original holder histories; synthetic proof-block wrappers are test
 * consensus only and never attest a deployment or a public lite-server. */
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {Address,beginCell,Cell,Dictionary,loadShardAccount,storeShardAccount} from '@ton/core';
import {launchpadCaptureAdapter} from './current-launchpad-native-evidence-test';
import {collectLaunchpadHolderRecoveryEvidence,readLaunchpadHolderRecoveryRequest} from '../runtime/launchpadHolderRecoveryEvidence';
import {collectLaunchpadHolderProofSession,readLaunchpadHolderProofSessionRequest} from '../runtime/launchpadHolderProofSession';
import {proofBlock,proofMasterchain} from './support/fakeLiteEngine';
import {verifyOrderTransaction} from '../orders/evidence';
import {decodeOriginalTransaction} from '../data/transactionEvidence';
import type {RecoveryProofAnchor} from '../data/dataSource';
async function main(){
 const[root,codePath,output]=process.argv.slice(2);assert([root,codePath,output].every(isAbsolute));const out:any[]=[],savedNow=Date.now;
 const code=Cell.fromBoc(readFileSync(codePath))[0];
 try{for(const name of readdirSync(root).sort()){
  const completePath=join(root,name,readdirSync(join(root,name)).find(n=>n.endsWith('-complete.json'))!),bytes=readFileSync(completePath),capture=JSON.parse(bytes.toString()),original=JSON.parse(readFileSync(join(root,name,'original.json'),'utf8'));
  Date.now=()=>capture.head.utime*1000;const a=launchpadCaptureAdapter(capture,original.request);assert.equal(code.hash().toString('hex'),a.manifest.templates.T3RecoveryProof);
  const first=await collectLaunchpadHolderRecoveryEvidence(a.manifest,a.source,a.store,readLaunchpadHolderRecoveryRequest(original.request,a.manifest));assert(first.coverage.complete);assert.equal(first.candidates.length,1);const candidate=first.candidates[0],holder=first.holders.find(h=>h.address===candidate.holder)!;
  const originals=[holder.shardAccountBoc,holder.wallet.shardAccountBoc].map(v=>Cell.fromBase64(v));
  const dict=Dictionary.empty(Dictionary.Keys.BigUint(256),{serialize(v:Cell,b:ReturnType<typeof beginCell>){b.storeUint(0,5).storeCoins(0).storeBit(false).storeSlice(v.beginParse());},parse(s:any){return s.asCell();}});
  for(const s of originals)dict.set(BigInt('0x'+loadShardAccount(s.beginParse()).account!.addr.hash.toString('hex')),s);
  const shard=proofBlock(70,capture.head.utime,0,{accounts:beginCell().storeDict(dict).storeUint(0,5).storeCoins(0).storeBit(false).endCell()}),master=proofMasterchain(a.head.seqno+1,capture.head.utime,shard);
  Object.assign(a.head,{seqno:a.head.seqno+1,rootHashHex:master.id.rootHash.toString('hex'),fileHashHex:master.id.fileHash.toString('hex')});
  const anchor=(address:string):RecoveryProofAnchor=>{const current=originals.find(s=>loadShardAccount(s.beginParse()).account!.addr.toRawString()===address)!;assert(current);return{account:address,head:{...a.head},shardBlock:{workchain:0,shard:shard.id.shard,seqno:70,rootHashHex:shard.id.rootHash.toString('hex'),fileHashHex:shard.id.fileHash.toString('hex')},masterchainProofBoc:master.proof.toString('base64'),accountProofBoc:shard.proof.toString('base64'),accountBoc:current.refs[0].toBoc().toString('base64'),shardAccountBoc:current.toBoc().toString('base64')};};
  a.source.getRecoveryProofAnchor=async(address,options)=>{assert.deepEqual(options?.at,a.head);return anchor(address);};
  const read=a.source.getAccountState.bind(a.source);let sessionBoc:string|null=null,sessionAddress='';
  a.source.getAccountState=async(address,options)=>address===sessionAddress?sessionBoc?{accountState:'active',balance:'1000000000',shardAccountBoc:sessionBoc}:{accountState:'uninitialized',balance:'0',provenAbsent:true}:a.checked.some(r=>r.evidence.account===address)?read(address,options):{accountState:'uninitialized',balance:'0',provenAbsent:true};
  const wire={original:original.request,key:candidate.key,nonce:'0'.repeat(63)+'1',anchor:null,proofCodeBoc:code.toBoc().toString('base64')},parsed=readLaunchpadHolderProofSessionRequest(wire,a.manifest);
  const response=await collectLaunchpadHolderProofSession(a.manifest,a.source,a.store,parsed);sessionAddress=response.address;
  assert.equal(response.sessionShardAccountBoc,null);assert.equal(response.transactionBocs.length,0);assert.equal(response.target,null);
  assert.equal((await collectLaunchpadHolderProofSession(a.manifest,a.source,a.store,readLaunchpadHolderProofSessionRequest({...wire,anchor:a.head},a.manifest))).address,response.address);
  const config=Cell.fromBase64(response.configBoc),recordSession=(phase:number,evidence:number,address:string)=>{const account=loadShardAccount(originals[0].beginParse()),pointer=loadShardAccount(Cell.fromBase64(anchor(address).shardAccountBoc).beginParse());assert(account.account);account.account.addr=Address.parse(sessionAddress);account.account.storage.state={type:'active',state:{code,data:beginCell().storeRef(config).storeUint(phase,3).storeUint(0,256).storeRef(beginCell().storeUint(pointer.lastTransactionHash,256).storeUint(0,256).storeUint(0,9).storeUint(pointer.lastTransactionLt,64)).storeUint(evidence,2).endCell()}};sessionBoc=beginCell().store(storeShardAccount(account)).endCell().toBoc().toString('base64');};
  let cursorReads=0;a.source.getTransactions=async(address,limit,lt,hash)=>{assert.equal(Buffer.from(hash,'base64').length,32);assert(!/^[0-9a-f]{64}$/.test(hash));cursorReads++;const rows=[];let selected=Buffer.from(hash,'base64').toString('hex');for(let n=0;n<limit;n++){const row=capture.completeTransactions.find((r:any)=>r.account===address&&Cell.fromBase64(r.transactionBoc).hash().toString('hex')===selected);if(!row)break;const decoded=decodeOriginalTransaction(Cell.fromBase64(row.transactionBoc),Address.parse(address));if(!n)assert.equal(decoded.lt,lt);rows.push(decoded);selected=verifyOrderTransaction(row).tx.prevTransactionHash.toString(16).padStart(64,'0');}return rows;};
  for(const phase of[2,5]){recordSession(phase,phase===2?0:candidate.kind==='notification'?1:2,phase===2?candidate.wallet:candidate.target);const r=await collectLaunchpadHolderProofSession(a.manifest,a.source,a.store,parsed);assert(r.transactionBocs.length>0&&r.transactionBocs.length<=4);assert.equal(r.target?.account??null,phase===5?candidate.target:null);}
  assert(cursorReads>=2);recordSession(5,0,candidate.target);await assert.rejects(collectLaunchpadHolderProofSession(a.manifest,a.source,a.store,parsed));sessionBoc=null;
  for(const bad of[{nonce:'1'},{nonce:'F'.repeat(64)},{key:'other'},{anchor:{...a.head,workchain:0}},{anchor:{...a.head,extra:true}},{proofCodeBoc:Cell.EMPTY.toBoc().toString('base64')},{extra:true}])assert.throws(()=>readLaunchpadHolderProofSessionRequest({...wire,...bad},a.manifest));
  await assert.rejects(collectLaunchpadHolderProofSession(a.manifest,a.source,a.store,readLaunchpadHolderProofSessionRequest({...wire,key:candidate.key.replace(candidate.sourceHash,'f'.repeat(64))},a.manifest)));
  for(const change of[(r:RecoveryProofAnchor)=>({...r,accountBoc:Cell.EMPTY.toBoc().toString('base64')}),(r:RecoveryProofAnchor)=>({...r,head:{...r.head,seqno:r.head.seqno+1}}),()=>anchor(candidate.target)]){a.source.getRecoveryProofAnchor=async()=>change(anchor(candidate.wallet));await assert.rejects(collectLaunchpadHolderProofSession(a.manifest,a.source,a.store,parsed));}
  out.push({name,completePath,sourceSha256:createHash('sha256').update(bytes).digest('hex'),request:wire,manifest:a.manifest,response});console.log('PASS',name,'original holder source+target, resumed address, bounded base64-cursor suffix, wrong-stage/code/key/anchor refusals');
 }}finally{Date.now=savedNow;}
 writeFileSync(output,JSON.stringify({schema:'tonswap-native-launchpad-holder-proof-collector-v1',qualification:'Original native source/target histories; synthetic proof-block wrappers and current session states. Not deployment/consensus authority.',cases:out})+'\n',{flag:'wx'});
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
