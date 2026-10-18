/** Native Options operation and complete source wallet roots, no fixture witness authority. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { beginCell, Cell } from '@ton/core';
import { optionsCaptureAdapter } from './current-options-operation-evidence-test';
import { collectOptionsWalletClaimEvidence, readOptionsWalletClaimRequest } from '../runtime/optionsWalletClaimEvidence';
import { t3PathRoot } from '../ledger/currentT3Wire';
import { verifyOrderTransaction } from '../orders/evidence';
function failureRoot(key: bigint, record: Cell, proof: Cell) {
  let hash=beginCell().storeUint(1,8).storeRef(record).endCell().hash(),path=proof.beginParse();
  for(let i=0;i<64;i++){
    const sibling=path.loadBuffer(32),left=(key>>BigInt(i)&1n)===0n;
    hash=beginCell().storeUint(2,8).storeBuffer(left?hash:sibling).storeBuffer(left?sibling:hash).endCell().hash();
    const tail=path.loadMaybeRef();path.endParse();assert.equal(tail===null,i===63);if(tail)path=tail.beginParse();
  }return hash.toString('hex');
}
async function main(){
  const dir=process.argv[2],output=process.argv[3],diagnostic=process.argv[4]==='--diagnostic';assert(dir&&isAbsolute(dir));
  const exported:unknown[]=[],originalNow=Date.now;let selected=0;
  try{for(const file of readdirSync(dir).filter(f=>f.endsWith('.json')).sort()){
    const bytes=readFileSync(join(dir,file)),c=JSON.parse(bytes.toString());Date.now=()=>c.unixTime*1000;
    const a=optionsCaptureAdapter(c),parsed=readOptionsWalletClaimRequest(c.request,a.manifest),response=await collectOptionsWalletClaimEvidence(a.manifest,a.source,a.store,parsed);
    if(!diagnostic)assert(response.coverage.complete,`${file}: ${JSON.stringify(response.coverage)}`);
    if(!response.coverage.complete)assert.equal(response.claims.records.length+response.claims.failures.length,0,'incomplete graph cannot authorize a witness');
    if(file.startsWith('retry-before-mark-')||file.startsWith('retry-marked-')){
      assert.equal(response.claims.records.length,1);assert.equal(response.claims.failures.length,1);
      assert.equal(response.claims.records[0].failed,file.startsWith('retry-marked-'));
    }else if(/^retry-(default|x6)\.json$/.test(file)&&response.coverage.complete)assert.equal(response.claims.records.length,0,'recovered attempt no longer offers recovery');
    for(const record of response.claims.records){
      assert(record.failed||response.claims.failures.length>0);assert.equal(record.owner,c.request.vault);assert(!record.burn&&!record.cancelled);
      assert.equal(t3PathRoot(BigInt(record.id),Cell.fromBase64(record.recordBoc),Cell.fromBase64(record.proofBoc)).toString(16).padStart(64,'0'),response.claims.root);
      assert.equal(String(verifyOrderTransaction(record.transferTransaction).tx.lt),record.originLt);selected++;
    }
    for(const failure of response.claims.failures)assert.equal(failureRoot(BigInt(failure.index),Cell.fromBase64(failure.evidenceBoc),Cell.fromBase64(failure.proofBoc)),response.claims.failureRoot);
    a.control.missingAccount=response.wallet.address;const missing=await collectOptionsWalletClaimEvidence(a.manifest,a.source,a.store,parsed);assert(!missing.coverage.complete);a.control.missingAccount='';
    const wrong=readOptionsWalletClaimRequest({...c.request,dispatch:{...c.request.dispatch,hash:'0'.repeat(64)}},a.manifest);
    assert(!(await collectOptionsWalletClaimEvidence(a.manifest,a.source,a.store,wrong)).coverage.complete);
    const abort=new AbortController();abort.abort();await assert.rejects(collectOptionsWalletClaimEvidence(a.manifest,a.source,a.store,parsed,abort.signal));
    exported.push({file,sourceSha256:createHash('sha256').update(bytes).digest('hex'),manifest:a.manifest,request:c.request,refusedAccounts:a.refusedAccounts,response});
    console.log(file,response.coverage.complete?'complete':JSON.stringify(response.coverage.gaps),response.claims.records.length,response.claims.failures.length);
  }
  if(output){assert(isAbsolute(output));writeFileSync(output,JSON.stringify({schema:'tonswap-native-options-wallet-claim-test-v1',qualification:'Original native transaction/account histories and exact observed getters under explicit synthetic sandbox head/release binding. Sparse witnesses are reconstructed from originals; no deployed-chain qualification.',sourceDirectory:dir,selected,cases:exported},null,2)+'\n',{flag:'wx'});}
  console.log('Options native claim collection and missing/wrong/abort checks finished; selected',selected);
  }finally{Date.now=originalNow;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
