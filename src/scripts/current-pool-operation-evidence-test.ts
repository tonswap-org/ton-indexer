/** Original native history with an explicitly synthetic source/head adapter. */
import assert from 'node:assert/strict';
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute,join } from 'node:path';
import { Cell,serializeTuple,type TupleItem } from '@ton/core';
import { boundaryState } from '../runtime/physicalEvidence';
import { verifyOrderTransaction,type OrderTransactionEvidence } from '../orders/evidence';
import { spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';
import { collectPoolOperationEvidence,readPoolOperationRequest } from '../runtime/poolOperationEvidence';
import { collectPoolWalletClaimEvidence,readPoolWalletClaimRequest } from '../runtime/poolWalletClaimEvidence';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function stack(items:any[]):TupleItem[]{return items.map(([type,value])=>{
 if(type==='num'||type==='int')return{type:'int',value:BigInt(value)};
 if(type==='null')return{type:'null'};
 if(type==='tuple')return{type:'tuple',items:stack(value)};
 assert(['cell','slice','builder'].includes(type));return{type,cell:Cell.fromBase64(value.bytes??value)};
});}
export function poolCaptureAdapter(c:any){
 const rows=c.completeTransactions as OrderTransactionEvidence[],latest=new Map<string,OrderTransactionEvidence>();
 for(const row of rows){const t=verifyOrderTransaction(row),prior=latest.get(row.account);if(!prior||verifyOrderTransaction(prior).tx.lt<t.tx.lt)latest.set(row.account,row);}
 const current=new Map([...latest].map(([address,row])=>[address,row.afterShardAccountBoc]));
 const manifest=structuredClone(c.binding?.identity.release??c.release) as RuntimeReleaseManifest,head=c.readSnapshots.at(-1).response.head;
 if(c.binding){assert.equal(c.binding.minSeqno,head.seqno);assert.equal(c.binding.minBlockRootHash,head.rootHashHex);}assert.equal(c.unixTime,head.utime);
 const getters=new Map<string,any>();
 for(const snap of c.readSnapshots){if(snap.response.head.seqno!==head.seqno)continue;assert.deepEqual(snap.response.head,head);assert.equal(snap.calls.length,snap.response.results.length);
  snap.calls.forEach((call:any,i:number)=>{const r=snap.response.results[i];assert.equal(call.kind,r.kind);
   if(call.kind==='account'){
    const original=r.originalShardAccountBoc??latest.get(call.address)?.afterShardAccountBoc;assert(original,`Missing original final account ${call.address}`);
    const previous=current.get(call.address);if(previous)assert(Cell.fromBase64(previous).equals(Cell.fromBase64(original)));current.set(call.address,original);
    const s=boundaryState(call.address,original,1).state;
    assert.equal(r.state==='uninit'?'uninitialized':r.state,s.accountState);assert.equal(String(r.balance),s.balance);assert.equal(r.lastTx.lt,s.lastTxLt);assert.equal(r.lastTx.hash,Buffer.from(s.lastTxHash!,'base64').toString('hex'));
    for(const [actual,observed]of [[s.codeBoc,r.codeBoc],[s.dataBoc,r.dataBoc]])if(actual||observed)assert(actual&&observed&&Cell.fromBase64(actual).equals(Cell.fromBase64(observed)));
   }else{
    const args=serializeTuple((call.args??[]).map((a:any)=>a.type==='int'?{type:'int',value:BigInt(a.value)}:{type:a.type,cell:Cell.fromBase64(a.cellBoc)})),key=`${call.address}:${call.method}:${args.hash().toString('hex')}`;
    const g={address:call.address,method:call.method,argsBoc:args.toBoc().toString('base64'),exitCode:r.exitCode,resultBoc:serializeTuple(stack(r.stack)).toBoc().toString('base64')};
    const prior=getters.get(key);if(prior)assert.deepEqual(g,prior);getters.set(key,g);
   }
  });
 }
 // Native untouched wallets may have an original current uninitialized account
 // with LT0 and no transactions. Retain that exact envelope; it is not a
 // consensus dictionary-absence proof and never creates provenAbsent authority.
 const accounts=[...current].map(([address,shardAccountBoc])=>({address,shardAccountBoc}));
 // The source adapter synthesizes only get_jetton_data's generic metadata from
 // exact original master/wallet code pins. Wallet-address/pool getters are actual
 // native observations from this same captured final head, not reconstructed.
 const adapter=spotEvidenceFixtureAdapter(manifest,accounts,rows,c.unixTime,[...getters.values()]);
 Object.assign(adapter.head,{seqno:head.seqno,rootHashHex:head.rootHashHex,utime:head.utime});return{...adapter,manifest,nativeHead:head};
}
async function main(){
 const dir=process.argv[2],output=process.argv[3],filter=process.argv[4]?new RegExp(process.argv[4]):null;assert(dir&&isAbsolute(dir));const exported:unknown[]=[],originalNow=Date.now;
 try{for(const file of readdirSync(dir).filter(f=>f.endsWith('.json')&&(!filter||filter.test(f))).sort()){
  const bytes=readFileSync(join(dir,file)),c=JSON.parse(bytes.toString());Date.now=()=>c.unixTime*1000;
  const a=poolCaptureAdapter(c),parsed=readPoolOperationRequest(c.request,a.manifest),response=await collectPoolOperationEvidence(a.manifest,a.source,a.store,parsed);
  assert(response.coverage.complete,`${file}: ${JSON.stringify(response.coverage)}`);response.transactions.forEach(verifyOrderTransaction);
  assert(response.transactions.some(row=>row.account===c.request.owner&&verifyOrderTransaction(row).hash===c.request.dispatch.hash));
  const walletClaims=await collectPoolWalletClaimEvidence(a.manifest,a.source,a.store,readPoolWalletClaimRequest(c.request,a.manifest));assert(walletClaims.coverage.complete,`${file} claims: ${JSON.stringify(walletClaims.coverage)}`);
  assert.equal(walletClaims.claims.records.length,c.expectedClaimCount??0);
  a.control.missingAccount=c.request.pool;const missing=await collectPoolOperationEvidence(a.manifest,a.source,a.store,parsed);assert(!missing.coverage.complete);a.control.missingAccount='';
  const wrong=readPoolOperationRequest({...c.request,dispatch:{...c.request.dispatch,hash:'0'.repeat(64)}},a.manifest);assert(!(await collectPoolOperationEvidence(a.manifest,a.source,a.store,wrong)).coverage.complete);
  const abort=new AbortController();abort.abort();await assert.rejects(collectPoolOperationEvidence(a.manifest,a.source,a.store,parsed,abort.signal));
  exported.push({file,sourceSha256:sha(bytes),request:c.request,manifest:a.manifest,binding:c.binding,nativeHead:a.nativeHead,response,walletClaims});console.log(file,response.transactions.length,walletClaims.claims.records.length);
 }
 assert(exported.length>0,'No selected native cases');
 if(output){assert(isAbsolute(output));writeFileSync(output,JSON.stringify({schema:'tonswap-native-pool-collector-test-v1',qualification:'Original complete native transaction/account cells plus actual final-head pool/wallet-address getter observations. Synthetic source/head and generic jetton metadata adapter are explicitly outside consensus/deployment qualification.',sourceDirectory:dir,cases:exported},null,2)+'\n',{flag:'wx'});}
 console.log('Native current Pool operation and wallet claims, original owner dispatch, current identities and missing/wrong/abort refusals passed.');
 }finally{Date.now=originalNow;}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
