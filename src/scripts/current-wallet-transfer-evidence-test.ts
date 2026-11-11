import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { originalProductCaptureAdapter } from './current-launchpad-native-evidence-test';
import { readWalletTransferEvidenceRequest, collectWalletTransferEvidence } from '../runtime/walletTransferEvidence';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
function adapter(c:any){
 const first=c.observation.accounts[0].response,head={seqno:first.block_id.seqno,utime:c.observation.unixTime,rootHashHex:Buffer.from(first.block_id.root_hash,'base64').toString('hex')},calls:any[]=[],results:any[]=[];
 for(const row of c.observation.accounts){const a=row.response;assert.equal(a.block_id.seqno,head.seqno);calls.push({kind:'account',address:row.account});results.push({kind:'account',state:a.state,balance:a.balance,code:a.code||null,data:a.data||null,lastTx:{lt:a.last_transaction_id.lt,hash:Buffer.from(a.last_transaction_id.hash,'base64').toString('hex')}});}
 const seen=new Set<string>();for(const row of c.observation.getters){const call={kind:'getter',...row.request,args:row.request.args.map((a:any)=>({type:a.type,cell:a.cellBoc}))},key=JSON.stringify(call);if(seen.has(key))continue;seen.add(key);assert.equal(row.response.block_id.seqno,head.seqno);calls.push(call);results.push({kind:'getter',exitCode:row.response.exit_code,stack:row.response.stack});}
 return originalProductCaptureAdapter({head,calls,results,completeTransactions:c.transactions});
}
async function main(){const [input,output]=process.argv.slice(2),directory=input??join(__dirname,'fixtures/current-wallet-transfer');assert(isAbsolute(directory));const result:any[]=[],now=Date.now;
 const pins=input?null:JSON.parse(readFileSync(join(directory,'index.json'),'utf8'));
 try{for(const file of readdirSync(directory).filter(f=>/^wallet-transfer-.*\.json(?:\.br)?$/.test(f))){const stored=readFileSync(join(directory,file)),bytes=file.endsWith('.br')?brotliDecompressSync(stored):stored;
  if(pins){const pin=pins.files.find((p:any)=>p.file===file);assert(pin);assert.equal(createHash('sha256').update(stored).digest('hex'),pin.sha256);assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.originalSha256);}
  const c=JSON.parse(bytes.toString());assert.equal(c.schema,'current-native-wallet-transfer-capture-v1');Date.now=()=>c.observation.unixTime*1000;
  const a=adapter(c),manifest=c.manifest as RuntimeReleaseManifest;// Sandbox treasury creation replaces its startup balance. Never admit those
  // unlinked current states; unrelated setup accounts are not transfer evidence.
  const refused=new Set(a.refusedAccounts.map((r:any)=>r.account));
  for(const test of c.captures){const parsed=readWalletTransferEvidenceRequest(test.request,manifest),response=await collectWalletTransferEvidence(manifest,a.source,a.store,parsed);assert(response.coverage.complete,JSON.stringify(response.coverage));assert(response.transactions.every(t=>!refused.has(t.account)),'A refused current boundary entered the transfer graph');
   assert(response.transactions.some(t=>t.account===test.request.senderWallet));assert(response.transactions.some(t=>t.account===test.request.recipientWallet));
   for(const account of [test.request.owner,test.request.senderWallet,test.request.recipientWallet]){a.control.missingAccount=account;assert(!(await collectWalletTransferEvidence(manifest,a.source,a.store,parsed)).coverage.complete);}a.control.missingAccount='';
   for(const field of ['bodyHash','queryId','amountRaw','recipient','root','senderWallet','manifestHash']){const bad={...test.request,[field]:field==='queryId'||field==='amountRaw'?'999':field==='recipient'||field==='root'||field==='senderWallet'?`0:${'9'.repeat(64)}`:'0'.repeat(64)};if(field==='senderWallet'){const p=readWalletTransferEvidenceRequest(bad,manifest);await assert.rejects(collectWalletTransferEvidence(manifest,a.source,a.store,p));}else assert.throws(()=>readWalletTransferEvidenceRequest(bad,manifest));}
   const wrong=readWalletTransferEvidenceRequest({...test.request,dispatch:{...test.request.dispatch,hash:'0'.repeat(64)}},manifest);assert(!(await collectWalletTransferEvidence(manifest,a.source,a.store,wrong)).coverage.complete);
   const abort=new AbortController();abort.abort();await assert.rejects(collectWalletTransferEvidence(manifest,a.source,a.store,parsed,abort.signal));
   result.push({file,sourceSha256:createHash('sha256').update(bytes).digest('hex'),record:test.record,request:test.request,response,manifest});console.log(`${file} ${test.record.draft.symbol} memo=${!!test.record.draft.memo}: original graph complete (${response.transactions.length})`);
  }
 }
 if(output){assert(isAbsolute(output));writeFileSync(output,JSON.stringify({schema:'current-wallet-transfer-collector-native-v1',scope:'Native original VM cells and observed getters; sandbox release/head adapter only.',cases:result},null,2)+'\n',{flag:'wx'});}
 assert.equal(result.length,12);console.log(`${result.length} current native transfer collectors and request/history/identity/cancellation negatives passed`);
 }finally{Date.now=now;}}
main().catch(e=>{console.error(e);process.exitCode=1;});
