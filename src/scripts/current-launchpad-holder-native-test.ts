/** Native account/transaction originals with a synthetic sandbox source head. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { launchpadCaptureAdapter } from './current-launchpad-native-evidence-test';
import { collectLaunchpadHolderRecoveryEvidence, readLaunchpadHolderRecoveryRequest } from '../runtime/launchpadHolderRecoveryEvidence';
async function main(){
 const [root,output,requestDir]=process.argv.slice(2);assert(isAbsolute(root)&&isAbsolute(output));const cases:any[]=[],now=Date.now;
 try{for(const name of readdirSync(root).filter(n=>!requestDir||n.endsWith('-complete.json')).sort()){
  const prefix=name.replace('-complete.json','-'); const originalPath=requestDir?join(requestDir,readdirSync(requestDir).find(n=>n===prefix+'finalize.json')!):join(root,name,'original.json'),completePath=requestDir?join(root,name):join(root,name,readdirSync(join(root,name)).find(n=>n.endsWith('-complete.json'))!);
  const originalBytes=readFileSync(originalPath),completeBytes=readFileSync(completePath),original=JSON.parse(originalBytes.toString()),capture=JSON.parse(completeBytes.toString());Date.now=()=>capture.head.utime*1000;
  const a=launchpadCaptureAdapter(capture,original.request),p=readLaunchpadHolderRecoveryRequest(original.request,a.manifest);
  const response=await collectLaunchpadHolderRecoveryEvidence(a.manifest,a.source,a.store,p).catch(e=>{console.error(name,a.control,a.refusedAccounts);throw e;});
  assert(response.coverage.complete,`${name}: ${JSON.stringify(response.coverage)}`);assert.equal(response.candidates.length,requestDir?0:1);const c=response.candidates[0];if(c){assert.equal(c.holder,original.boundaries.holder);assert.equal(c.wallet,original.boundaries.wallet);assert.equal(c.sourceHash,original.boundaries.sourceHash);assert.equal(c.targetHash,original.boundaries.targetHash);assert.equal(c.recordBoc,null);
  a.control.missingBoundary=`${c.wallet}:${c.sourceLt}:${c.sourceHash}`;assert(!(await collectLaunchpadHolderRecoveryEvidence(a.manifest,a.source,a.store,p)).coverage.complete);a.control.missingBoundary='';}
  const wrong=readLaunchpadHolderRecoveryRequest({...original.request,dispatch:{...original.request.dispatch,hash:'0'.repeat(64)}},a.manifest);assert(!(await collectLaunchpadHolderRecoveryEvidence(a.manifest,a.source,a.store,wrong)).coverage.complete);
  const abort=new AbortController();abort.abort();await assert.rejects(collectLaunchpadHolderRecoveryEvidence(a.manifest,a.source,a.store,p,abort.signal));
  cases.push({name,originalPath,completePath,originalSha256:createHash('sha256').update(originalBytes).digest('hex'),completeSha256:createHash('sha256').update(completeBytes).digest('hex'),request:original.request,manifest:a.manifest,response});console.log(name,c?.kind??'empty',response.transactions.length,'originals, missing-boundary/wrong-dispatch/abort refused');
 }writeFileSync(output,JSON.stringify({schema:'tonswap-native-launchpad-holder-qualification-v1',qualification:'Original native execution cells; synthetic source/head adapter, not consensus or deployment authority.',cases},null,2)+'\n',{flag:'wx'});
 }finally{Date.now=now;}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
