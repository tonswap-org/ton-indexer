import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import Fastify from 'fastify';
import { Address, Cell, beginCell, loadMessage } from '@ton/core';
import { runtimeManifestFixture, runtimeAddress } from './fixtures/runtimeManifest';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { readOptionsOperationRequest, type CurrentOptionsEvidenceRequest } from '../runtime/optionsOperationEvidence';
import { readFaucetOperationRequest, type CurrentFaucetEvidenceRequest } from '../runtime/faucetOperationEvidence';
import { ProductEvidenceError, collectProductPhysicalGraph, boundProductResponse, PRODUCT_EVIDENCE_LIMITS } from '../runtime/productEvidence';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
import { scopedSpotEvidenceManifest, spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';

const owner=runtimeAddress(900), sourceWallet=runtimeAddress(901), tokenId='7', queryId='42', seriesId='1';
export function optionsRequestFixture(kind:CurrentOptionsEvidenceRequest['kind']='buy') {
  const manifest=runtimeManifestFixture(), vault=manifest.contracts.OptionVault!.address, factory=manifest.contracts.OptionFactory!.address;
  let body:Cell;
  if(kind==='buy'||kind==='fund') {
    const payload=beginCell().storeUint(kind==='buy'?0x4f564259:0x4f564644,32).storeUint(BigInt(queryId),64).storeUint(BigInt(seriesId),64);
    if(kind==='buy') payload.storeCoins(100n);
    body=beginCell().storeUint(0x0f8a7ea5,32).storeUint(BigInt(queryId),64).storeCoins(10n).storeAddress(Address.parse(vault)).storeAddress(Address.parse(owner))
      .storeBit(false).storeCoins(1n).storeBit(true).storeRef(payload.endCell()).endCell();
  } else if(kind==='withdraw') body=beginCell().storeUint(0x4f535757,32).storeUint(BigInt(queryId),64).storeUint(BigInt(seriesId),64).storeCoins(10n).endCell();
  else if(kind==='owed') body=beginCell().storeUint(0x434c4d4a,32).storeUint(BigInt(queryId),64).storeUint(0,8).storeAddress(Address.parse(owner)).endCell();
  else body=beginCell().storeUint(0x46455843,32).storeUint(BigInt(seriesId),64).storeUint(BigInt(tokenId),64).endCell();
  const request:CurrentOptionsEvidenceRequest={network:'testnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,kind,owner,factory,vault,series:null,
    seriesId:kind==='owed'?'0':seriesId,queryId,amountRaw:kind==='payout'?'0':'10',notionalRaw:kind==='buy'?'100':null,tokenId:kind==='payout'?tokenId:null,
    sourceWallet:kind==='buy'||kind==='fund'?sourceWallet:null,bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:'1000000000',
    createdAt:1800000000000,dispatch:{lt:'1000000',hash:'1'.repeat(64),valueNano:'999000000'}};
  return {manifest,request,body};
}
export function faucetRequestFixture() {
  const {manifest}=optionsRequestFixture(),body=beginCell().storeUint(0x46434c4d,32).storeUint(BigInt(queryId),64).storeUint(0,8).endCell();
  const request:CurrentFaucetEvidenceRequest={network:'testnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,kind:'claim',owner,
    faucet:manifest.contracts.TestnetFaucet!.address,asset:0,queryId,bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),
    valueNano:'1000000000',createdAt:1800000000000,dispatch:{lt:'1000000',hash:'1'.repeat(64),valueNano:'999000000'}};
  return {manifest,request,body};
}
async function main() {
  for(const kind of ['buy','fund','withdraw','payout','owed'] as const) {
    const {request,manifest}=optionsRequestFixture(kind);assert.equal(readOptionsOperationRequest(request,manifest).request.kind,kind);
    for(const change of [{extra:true},{bodyHash:'0'.repeat(64)},{owner:'-1:'+'1'.repeat(64)},{dispatch:{...request.dispatch,lt:'0'}},
      {dispatch:{...request.dispatch,valueNano:'1000000001'}},{kind:'legacy'},{createdAt:0},{seriesId:'01'}])
      assert.throws(()=>readOptionsOperationRequest({...request,...change},manifest),ProductEvidenceError);
    assert.throws(()=>readOptionsOperationRequest({...request,manifestHash:'f'.repeat(64)},manifest),(e:any)=>e.code==='release_mismatch');
  }
  const payout=optionsRequestFixture('payout'),ex=beginCell().storeUint(0x4f464558,32).storeUint(999n,64).storeUint(1n,64).storeUint(7n,64).storeCoins(3n).endCell();
  assert.equal(readOptionsOperationRequest({...payout.request,amountRaw:'3',bodyBoc:ex.toBoc().toString('base64'),bodyHash:ex.hash().toString('hex')},payout.manifest).request.queryId,'42');
  const faucet=faucetRequestFixture();readFaucetOperationRequest(faucet.request,faucet.manifest);
  for(const change of [{asset:3},{asset:1},{queryId:'43'},{extra:true},{bodyBoc:faucet.request.bodyBoc+'AA'},{dispatch:null}])
    assert.throws(()=>readFaucetOperationRequest({...faucet.request,...change},faucet.manifest),ProductEvidenceError);
  const manifest=faucet.manifest,bundle=buildRuntimeManifestBundle(manifest);let count=0,unavailable=false;
  const collect=async({request}:any,signal?:AbortSignal)=>{count++;assert(signal);if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');
    return {schema:request.kind==='claim'?'tonswap-faucet-operation-evidence-v1':'tonswap-options-operation-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,
      asOf:{masterchainSeqno:1,unixTime:1800000000,blockRootHash:'1'.repeat(64)},request:{kind:request.kind,owner:request.owner,bodyHash:request.bodyHash},coverage:{complete:false,gaps:[{code:'original_request_unobserved',account:request.owner}]},transactions:[]};};
  const app=Fastify();registerRoutes(app,{network:'testnet'},{getAdmissionStatus(){return {configured:false,ready:false};}} as IndexerService,
    undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,{source:{} as any,orders:{page:async()=>{throw Error();},optionsOperationEvidence:collect as any,faucetOperationEvidence:collect as any,optionsWalletClaimEvidence:collect as any,faucetRecoveryEvidence:collect as any}});
  try {
    for(const [product,request] of [['options/operation-evidence',optionsRequestFixture().request],['faucet/operation-evidence',faucet.request],['options/wallet-claim-evidence',optionsRequestFixture().request],['faucet/recovery-evidence',faucet.request]] as const) {
      const url=`/api/indexer/v1/${product}`;
      for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload:request});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
      assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:request})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url,payload:{...request,extra:true}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url,headers:{'x-tonswap-release':'f'.repeat(64)},payload:request})).statusCode,409);
      assert.equal((await app.inject({method:'POST',url,payload:{...request,bodyBoc:'a'.repeat(192*1024)}})).statusCode,413);
      unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,503);unavailable=false;
      assert((buildOpenApi({ network: 'testnet' } as any) as any).paths[url]);
    }
    assert.equal(count,12,'completed evidence is not cached, rejected requests never enter collector');
    const service=(await app.inject('/api/indexer/v1/service-info')).json();assert(service.endpoints.optionsOperationEvidence&&service.endpoints.faucetOperationEvidence&&service.endpoints.optionsWalletClaimEvidence&&service.endpoints.faucetRecoveryEvidence);
  } finally {await app.close();}
  const path=process.argv[2];if(path){
    assert(isAbsolute(path));const capture=JSON.parse(readFileSync(path,'utf8')),c=capture.cases[2],rows=c.transactions as OrderTransactionEvidence[];
    const originalNow=Date.now;Date.now=()=>c.now*1000;
    try {
      const manifest=scopedSpotEvidenceManifest(c.pool.address,c.pool.dataBoc,c.tokens),a=spotEvidenceFixtureAdapter(manifest,c.currentAccounts,rows,c.now,c.getters),body=Cell.fromBase64(c.funding.bodyBoc);
      const dispatch=rows.find(row=>row.account===c.owner&&[...verifyOrderTransaction(row).outgoing.values()].some(raw=>{const m=loadMessage(raw.beginParse());return m.info.type==='internal'&&m.info.dest.toRawString()===c.funding.sourceWallet&&m.body.equals(body);}));assert(dispatch);
      const t=verifyOrderTransaction(dispatch),wire=[...t.outgoing.values()].map(raw=>loadMessage(raw.beginParse())).find(m=>m.info.type==='internal'&&m.info.dest.toRawString()===c.funding.sourceWallet&&m.body.equals(body))!;assert(wire.info.type==='internal');
      const input={owner:c.owner,target:c.funding.sourceWallet,body,dispatch:{lt:String(t.tx.lt),hash:t.hash,valueNano:String(wire.info.value.coins)},pins:new Map<string,string>(),completeAccounts:[c.funding.sourceWallet]};
      const causal:OrderTransactionEvidence[]=[];
      const graph=await collectProductPhysicalGraph(a.source,a.store,a.head,{...input,onCausal:row=>causal.push(row.evidence)});assert(graph.coverage.complete,JSON.stringify(graph.coverage));assert(graph.transactions.length>=3);graph.transactions.forEach(verifyOrderTransaction);
      assert(causal.length>0&&causal.length<graph.transactions.length,'seed history is not causal request authority');
      assert(!causal.some(row=>row.transactionBoc===dispatch.transactionBoc),'owner dispatch precedes target causal graph');
      const wrong=await collectProductPhysicalGraph(a.source,a.store,a.head,{...input,dispatch:{...input.dispatch,hash:'0'.repeat(64)}});assert(!wrong.coverage.complete);
      const mismatched=await collectProductPhysicalGraph(a.source,a.store,a.head,{...input,body:Cell.EMPTY});assert(!mismatched.coverage.complete);
      a.control.missingAccount=input.target;const missing=await collectProductPhysicalGraph(a.source,a.store,a.head,input);assert(!missing.coverage.complete);a.control.missingAccount='';
      const abort=new AbortController();abort.abort();await assert.rejects(collectProductPhysicalGraph(a.source,a.store,a.head,input,abort.signal));
      const bounded=boundProductResponse({coverage:{complete:true,gaps:[]},transactions:[{...dispatch,transactionBoc:'a'.repeat(PRODUCT_EVIDENCE_LIMITS.bytes)}]},input.target);assert(!bounded.coverage.complete&&bounded.transactions.length===0);
      console.log('Original continuous native graph, exact owner dispatch, full message links, missing-history/wrong-dispatch and abort refusals passed.');
    }finally{Date.now=originalNow;}
  }
  console.log('Current Options/faucet parser and API release/body/value fences, no cache, bounds and typed failures passed.');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
