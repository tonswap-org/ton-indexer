/** Original native boundaries with an explicitly synthetic chain/head adapter. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Cell, loadMessage } from '@ton/core';
import { currentFaucetFixtureManifest } from './support/currentFaucetFixture';
import { boundaryState, canonicalPhysicalMessage } from '../runtime/physicalEvidence';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';
import { collectFaucetOperationEvidence, readFaucetOperationRequest, type CurrentFaucetEvidenceRequest } from '../runtime/faucetOperationEvidence';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  const path=process.argv[2],output=process.argv[3];assert(path&&isAbsolute(path));const bytes=readFileSync(path),capture=JSON.parse(bytes.toString());
  for(const artifact of Object.values(capture.artifacts) as any[]){const bytes=readFileSync(artifact.file);assert.equal(sha(bytes),artifact.bocSha256);assert.equal(Cell.fromBoc(bytes)[0].hash().toString('hex'),artifact.codeHash);}
  const exported:unknown[]=[],originalNow=Date.now;
  try{for(const [index,c] of capture.cases.entries() as IterableIterator<[number,any]>){
    Date.now=()=>c.now*1000;const rows=c.transactions as OrderTransactionEvidence[];rows.forEach(verifyOrderTransaction);
    const token=c.tokens.find((t:any)=>t.symbol==='T3'),faucet=boundaryState(c.faucet,c.currentAccounts.find((a:any)=>a.address===c.faucet).shardAccountBoc,1).state;
    const {manifest,fixtureAssets}=currentFaucetFixtureManifest(c,capture.artifacts.T3RecoveryProof.codeHash);
    const body=Cell.fromBase64(c.request.bodyBoc),original=rows.find(row=>row.account===c.faucet&&String(verifyOrderTransaction(row).tx.lt)===c.request.lt&&verifyOrderTransaction(row).hash===c.request.hash);assert(original);
    const input=verifyOrderTransaction(original).incoming!;assert(input);
    const emitters=rows.filter(row=>row.account===c.owner&&[...verifyOrderTransaction(row).outgoing.values()].some(raw=>canonicalPhysicalMessage(raw).equals(canonicalPhysicalMessage(input))));assert.equal(emitters.length,1);
    const dispatch=verifyOrderTransaction(emitters[0]),m=loadMessage(input.beginParse());assert(m.info.type==='internal');
    const request:CurrentFaucetEvidenceRequest={network:'localnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,kind:'claim',owner:c.owner,faucet:c.faucet,
      asset:c.asset,queryId:c.request.queryId,bodyBoc:c.request.bodyBoc,bodyHash:c.request.bodyHash,valueNano:c.request.valueNano,createdAt:c.now*1000,
      dispatch:{lt:String(dispatch.tx.lt),hash:dispatch.hash,valueNano:String(m.info.value.coins)}};
    const a=spotEvidenceFixtureAdapter(manifest,c.currentAccounts,rows,c.now,c.getters),parsed=readFaucetOperationRequest(request,manifest),response=await collectFaucetOperationEvidence(manifest,a.source,a.store,parsed);
    // Complete original failure facts remain unpaid. Coverage never rewrites
    // a source refusal or recovered inventory into a recipient credit.
    assert(response.coverage.complete,`${index}: ${JSON.stringify(response.coverage)}`);response.transactions.forEach(verifyOrderTransaction);
    assert(response.transactions.some(row=>row.transactionBoc===emitters[0].transactionBoc),'owner dispatch retained');
    const badSupply=await collectFaucetOperationEvidence({...manifest,supplyBase:String(BigInt(manifest.supplyBase)+1n)},a.source,a.store,parsed);assert(!badSupply.coverage.complete&&badSupply.coverage.gaps.some(g=>g.code==='faucet_release_config_mismatch'));
    a.control.missingAccount=c.faucet;const missing=await collectFaucetOperationEvidence(manifest,a.source,a.store,parsed);assert(!missing.coverage.complete);a.control.missingAccount='';
    const wrong=readFaucetOperationRequest({...request,dispatch:{...request.dispatch,hash:'0'.repeat(64)}},manifest);assert(!(await collectFaucetOperationEvidence(manifest,a.source,a.store,wrong)).coverage.complete);
    const changed=readFaucetOperationRequest({...request,owner:token.root},manifest);await assert.rejects(collectFaucetOperationEvidence(manifest,a.source,a.store,changed));
    const abort=new AbortController();abort.abort();await assert.rejects(collectFaucetOperationEvidence(manifest,a.source,a.store,parsed,abort.signal));
    exported.push({index,config:c.config,scenario:c.scenario,expected:c.expected,manifest,fixtureAssets,request,response,originalFaucetTransaction:original});
    console.log(index,c.config,c.symbol,c.scenario,response.transactions.length);
  }
  if(output){assert(isAbsolute(output));writeFileSync(output,JSON.stringify({schema:'tonswap-native-faucet-collector-test-v1',qualification:'Original native transaction/account boundaries and captured wallet getters under a synthetic head adapter. Root get_jetton_data is adapted from captured code identity; T3 issuer and head are synthetic. No deployment or consensus qualification.',capturePath:path,captureSha256:sha(bytes),cases:exported},null,2)+'\n',{flag:'wx'});}
  console.log('Native faucet original owner dispatch, complete source/recipient histories and missing/wrong/abort refusals passed.');
  }finally{Date.now=originalNow;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
