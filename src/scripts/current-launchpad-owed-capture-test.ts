import { archiveCheckpointTestStore } from './support/archiveCheckpointTestStore';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { orderShard, verifyOrderTransaction } from '../orders/evidence';
import { collectLaunchpadOwedArchiveEvidence, readLaunchpadOwedArchiveRequest, reconstructLaunchpadOwedArchive } from '../runtime/launchpadOwedArchiveEvidence';
import { launchpadCaptureAdapter } from './current-launchpad-native-evidence-test';
async function main(){
  const [completeDir,requestDir,output,mode]=process.argv.slice(2);assert(isAbsolute(completeDir)&&isAbsolute(requestDir)&&isAbsolute(output));assert(mode===undefined||mode==='--reconstruct-only');
  const cases:unknown[]=[],now=Date.now;
  try{for(const file of readdirSync(completeDir).filter(f=>f.endsWith('-complete.json')).sort()){
    const original=readFileSync(join(completeDir,file)),c=JSON.parse(original.toString()),prefix=file.replace('-complete.json','-');
    const reqFile=readdirSync(requestDir).filter(f=>f.startsWith(prefix)&&f.endsWith('.json')).sort()[0];assert(reqFile);const originalRequest=JSON.parse(readFileSync(join(requestDir,reqFile),'utf8')).request;
    const a=launchpadCaptureAdapter(c,originalRequest);Date.now=()=>a.head.utime*1000;
    const request=readLaunchpadOwedArchiveRequest({network:originalRequest.network,releaseId:originalRequest.releaseId,manifestHash:originalRequest.manifestHash,owner:c.archiveExpected?.owner??originalRequest.owner,
      factory:originalRequest.factory,sale:originalRequest.sale,target:originalRequest.sale,creator:originalRequest.creator,nonce:originalRequest.nonce,model:originalRequest.model,slot:c.archiveExpected?.slot??0},a.manifest);
    const rows=a.checked.filter(r=>r.evidence.account===request.sale).map(r=>({evidence:r.evidence,seqno:a.head.seqno}));assert(rows.length);
    const latest=[...rows].sort((x,y)=>verifyOrderTransaction(x.evidence).tx.lt>verifyOrderTransaction(y.evidence).tx.lt?-1:1)[0],current=orderShard(latest.evidence.afterShardAccountBoc,request.sale).shard;
    const input={rows,holder:request.sale,owner:request.owner,slot:request.slot,codeHash:a.manifest.templates[(['SaleFixed','SaleBonding','SaleAuction'] as const)[request.model]],current,
      identity:{factory:request.factory,creator:request.creator,nonce:BigInt(request.nonce),model:request.model,role:0}};
    const reconstruction=await reconstructLaunchpadOwedArchive(input);
    if(c.archiveExpected){assert.deepEqual(reconstruction.records.map(r=>r.id),c.archiveExpected.ids);assert.deepEqual(reconstruction.records.map(r=>r.amountRaw),c.archiveExpected.amounts);}
    else assert.equal(reconstruction.tree.count,0n,'Nonempty native archive needs independent producer expectations');
    await assert.rejects(reconstructLaunchpadOwedArchive({...input,rows:rows.slice(1)}));
    const abort=new AbortController();abort.abort();await assert.rejects(reconstructLaunchpadOwedArchive({...input,signal:abort.signal}));
    let response:unknown=null;
    if(mode!=='--reconstruct-only'){
      const result=await collectLaunchpadOwedArchiveEvidence(a.manifest,a.source,{...a.store,...archiveCheckpointTestStore()},request);assert(result.coverage.complete,JSON.stringify(result.coverage));response=result;
      a.control.missingAccount=request.sale;assert(!(await collectLaunchpadOwedArchiveEvidence(a.manifest,a.source,{...a.store,...archiveCheckpointTestStore()},request)).coverage.complete);a.control.missingAccount='';
      await assert.rejects(collectLaunchpadOwedArchiveEvidence(a.manifest,a.source,{...a.store,...archiveCheckpointTestStore()},request,abort.signal));
    }
    cases.push({file,sourceSha256:createHash('sha256').update(original).digest('hex'),request,manifest:a.manifest,rows:rows.length,count:reconstruction.tree.count.toString(),root:reconstruction.tree.root.toString(16).padStart(64,'0'),records:reconstruction.records,response});
    console.log(file,rows.length,'original sale transactions',reconstruction.records.length,'selected live archive records',mode??'current endpoint');
  }
  writeFileSync(output,JSON.stringify({schema:'tonswap-launchpad-owed-native-test-v1',qualification:'Unchanged native original execution cells. Explicit synthetic source/head/release adapter. Reconstruct-only does not qualify current getter agreement or a nonempty archive.',mode:mode??'current-endpoint',cases},null,2)+'\n',{flag:'wx'});
  }finally{Date.now=now;}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
