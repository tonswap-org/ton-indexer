import { archiveCheckpointTestStore } from './support/archiveCheckpointTestStore';
import { createOperationEvidenceGate } from '../runtime/operationEvidenceGate';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {Cell,loadTransaction} from '@ton/core';
import type {OrderTransactionEvidence} from '../orders/evidence';
import {ArchiveReconstructionPending,readLaunchpadOwedArchiveRequest,collectLaunchpadOwedArchiveEvidence} from '../runtime/launchpadOwedArchiveEvidence';
import {originalProductCaptureAdapter} from './current-launchpad-native-evidence-test';
function archiveCaptureAdapter(c:any){
 const originals=new Map<string,{evidence:OrderTransactionEvidence;seqno:number}>(),latest=new Map<string,{evidence:OrderTransactionEvidence;lt:bigint}>();
 for(const evidence of c.completeTransactions as OrderTransactionEvidence[]){
  const cell=Cell.fromBase64(evidence.transactionBoc),tx=loadTransaction(cell.beginParse());
  originals.set(`${evidence.account}:${tx.lt}:${cell.hash().toString('hex')}`,{evidence,seqno:c.head.seqno});
  if(!latest.has(evidence.account)||latest.get(evidence.account)!.lt<tx.lt)latest.set(evidence.account,{evidence,lt:tx.lt});
 }
 const observed=new Set(c.calls.filter((call:any)=>call.kind==='account').map((call:any)=>call.address));
 // Current account observations still verify against their original latest
 // transition. The production reader verifies every requested historical BOC.
 const a=originalProductCaptureAdapter({...c,completeTransactions:[...latest].filter(([address])=>observed.has(address)).map(([,row])=>row.evidence)});
 a.store.evidenceBoundary=async(account,lt,hash)=>a.control.missingAccount===account||a.control.missingBoundary===`${account}:${lt}:${hash}`?null:originals.get(`${account}:${lt}:${hash}`)??null;
 return a;
}
async function main(){
 const[directory,output,selectedStage]=process.argv.slice(2);assert(isAbsolute(directory)&&isAbsolute(output));const cases:unknown[]=[],now=Date.now;
 const stages=['appended','consumed','appended-again'];assert(!selectedStage||stages.includes(selectedStage));
 try{for(const stage of selectedStage?[selectedStage]:stages){const started=performance.now();
  const dir=join(directory,stage),file=readdirSync(dir).find(f=>f.endsWith('-complete.json'));assert(file);
  const bytes=readFileSync(join(dir,file)),metadataBytes=readFileSync(join(dir,'archive.json')),c=JSON.parse(bytes.toString()),expected=JSON.parse(metadataBytes.toString());
  const a=archiveCaptureAdapter(c),manifest=c.release;Date.now=()=>a.head.utime*1000;
  console.log(stage,'fixture indexed ms',Math.round(performance.now()-started));const collectionStarted=performance.now();
  const request=readLaunchpadOwedArchiveRequest(expected.request,manifest), gate=createOperationEvidenceGate(), attempts:unknown[]=[];
  let response:Awaited<ReturnType<typeof collectLaunchpadOwedArchiveEvidence>>|undefined;
  // Append-only durable progress is reopened for every request; no in-memory
  // state, fake timeout, changed gate or resumed current result is involved.
  const journal=output+'.'+manifest.manifestHash+'.checkpoints.jsonl';
  for(let attempt=0;attempt<200&&!response;attempt++){
    const started=performance.now(),store={...a.store,...archiveCheckpointTestStore(journal)};
    try{response=await gate.run(active=>collectLaunchpadOwedArchiveEvidence(manifest,a.source,store,request,active),()=>Error('Shared evidence gate unavailable'));
      attempts.push({attempt,elapsedMs:performance.now()-started,status:200});}
    catch(error){if(!(error instanceof ArchiveReconstructionPending))throw error;
      attempts.push({attempt,elapsedMs:performance.now()-started,status:503,traversed:error.traversed,verified:error.verified});}
    console.log(stage,'request',JSON.stringify(attempts.at(-1)));
  }
  await gate.stop();assert(response,'Bounded repeated requests must complete original history');
  const collectionMs=Math.round(performance.now()-collectionStarted);console.log(stage,'collection ms',collectionMs);
  assert(response.coverage.complete,JSON.stringify({stage,coverage:response.coverage,control:a.control,refused:a.refusedAccounts}));assert(response.archive);
  assert.equal(response.archive.count,expected.archive.count);assert.equal(response.archive.total,expected.archive.total);
  assert.equal(BigInt('0x'+response.archive.root).toString(),expected.archive.root);
  assert.deepEqual(response.archive.records.map(r=>[r.id,r.owner,r.amountRaw]),expected.archive.records.map((r:any)=>[r.id,r.owner,r.amountRaw]));
  for(let i=0;i<response.archive.records.length;i++)assert(Cell.fromBase64(response.archive.records[i].proofBoc).equals(Cell.fromBase64(expected.archive.records[i].proofBoc)));
  a.control.missingAccount=request.sale;assert(!(await collectLaunchpadOwedArchiveEvidence(manifest,a.source,{...a.store,...archiveCheckpointTestStore()},request)).coverage.complete);a.control.missingAccount='';
  const abort=new AbortController();abort.abort();await assert.rejects(collectLaunchpadOwedArchiveEvidence(manifest,a.source,{...a.store,...archiveCheckpointTestStore()},request,abort.signal));
  const relevant=c.completeTransactions.filter((r:OrderTransactionEvidence)=>r.account===request.sale).length;
  cases.push({stage,collectionMs,sharedDeadlineMs:20000,attempts,checkpointJournal:journal,sourceSha256:createHash('sha256').update(bytes).digest('hex'),metadataSha256:createHash('sha256').update(metadataBytes).digest('hex'),originalTransactions:c.completeTransactions.length,relevantSaleTransactions:relevant,manifest,request,response});
  console.log(stage,relevant,'original Sale transactions',response.archive.count,'archive records',response.archive.records.length,'selected live records');
 }
 writeFileSync(output,JSON.stringify({schema:'tonswap-launchpad-owed-native-overflow-test-v1',qualification:'Every live collection request uses the unchanged shared 20s gate and reopens durable append-only verified checkpoints; PostgreSQL SQL is qualified separately. Original native 1024-live-slot overflow, consumed sparse leaf and subsequent append. Exact current getter and independent producer witness comparison; sandbox source/head/release metadata is synthetic, no deployment authority.',cases},null,2)+'\n',{flag:'wx'});
 }finally{Date.now=now;}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
