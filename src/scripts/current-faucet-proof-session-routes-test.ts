import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { beginCell } from '@ton/core';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { launchpadRequestFixture } from './current-launchpad-operation-evidence-test';
import { faucetRequestFixture } from './current-product-operation-evidence-test';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { readFaucetProofSessionRequest } from '../runtime/t3ProofSession';
import type { IndexerService } from '../indexerService';
async function main(){
  const code=beginCell().storeUint(0x74657374,32).endCell(),base=runtimeManifestFixture();
  const manifest=runtimeManifestFixture({templates:{...base.templates,T3RecoveryProof:code.hash().toString('hex')}}),bundle=buildRuntimeManifestBundle(manifest);
  const original={...faucetRequestFixture().request,releaseId:manifest.releaseId,manifestHash:manifest.manifestHash};
  const request={original,nonce:'1'.repeat(64),anchor:null,proofCodeBoc:code.toBoc().toString('base64')};
  assert.equal(readFaucetProofSessionRequest(request,manifest).nonce,request.nonce);
  for(const altered of [{...request,extra:1},{...request,nonce:'0'},{...request,proofCodeBoc:beginCell().endCell().toBoc().toString('base64')},{...request,original:{...original,asset:1}},{...request,anchor:{seqno:1}}])assert.throws(()=>readFaucetProofSessionRequest(altered,manifest),ProductEvidenceError);
  let reads=0,unavailable=false;const app=Fastify(),url='/api/indexer/v1/t3/faucet-proof-session';
  registerRoutes(app,{network:'testnet'},{getAdmissionStatus(){return {configured:false,ready:false};}} as IndexerService,
    undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,{source:{} as any,orders:{page:async()=>{throw Error();},faucetProofSession:async(p,signal)=>{
      reads++;assert(signal);assert.equal(p.nonce,request.nonce);if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');
      return {schema:'tonswap-faucet-proof-session-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash} as any;
    }}});
  try{
    for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload:request});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
    assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:request})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,payload:{...request,extra:1}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers:{'x-tonswap-release':'f'.repeat(64)},payload:request})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url,payload:{...request,proofCodeBoc:'a'.repeat(192*1024)}})).statusCode,413);
    unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,503);assert.equal(reads,3);
    assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints.faucetProofSession,url);
    assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
  }finally{await app.close();}
  const launchOriginal={...launchpadRequestFixture('claim').request,releaseId:manifest.releaseId,manifestHash:manifest.manifestHash};
  for(const entry of [
    {method:'launchpadHolderRecoveryEvidence',path:'holder-recovery-evidence',payload:launchOriginal},
    {method:'launchpadHolderProofSession',path:'holder-proof-session',payload:{original:launchOriginal,key:launchOriginal.target+':1:'+ '2'.repeat(64),nonce:'1'.repeat(64),anchor:null,proofCodeBoc:request.proofCodeBoc}},
  ]){
    const app=Fastify(),url='/api/indexer/v1/launchpad/'+entry.path;let reads=0,unavailable=false;
    registerRoutes(app,{network:'testnet'},{getAdmissionStatus(){return{configured:false,ready:false};}} as IndexerService,undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,
      {source:{} as any,orders:{page:async()=>{throw Error();},[entry.method]:async(_parsed:unknown,signal:AbortSignal)=>{assert(signal);reads++;if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');return{releaseId:manifest.releaseId,manifestHash:manifest.manifestHash};}}});
    try{
      for(let i=0;i<2;i++){const response=await app.inject({method:'POST',url,payload:entry.payload});assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-tonswap-release'],manifest.manifestHash);}
      assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:entry.payload})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url,payload:{...entry.payload,extra:1}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url,headers:{'x-tonswap-release':'f'.repeat(64)},payload:entry.payload})).statusCode,409);
      assert.equal((await app.inject({method:'POST',url,payload:{...entry.payload,padding:'a'.repeat(192*1024)}})).statusCode,413);
      unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:entry.payload})).statusCode,503);assert.equal(reads,3);
      assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints[entry.method],url);assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
    }finally{await app.close();}
  }
  console.log('Faucet and Launchpad holder proof-session exact code/request/release, uncached shared-runtime route, bounds and typed failures passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
