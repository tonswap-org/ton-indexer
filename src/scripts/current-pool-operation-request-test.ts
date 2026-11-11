import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
import { Address, Cell, beginCell } from '@ton/core';
import { runtimeManifestFixture, runtimeAddress } from './fixtures/runtimeManifest';
import { readPoolOperationRequest, type CurrentPoolEvidenceRequest } from '../runtime/poolOperationEvidence';
import { readPoolWalletClaimRequest } from '../runtime/poolWalletClaimEvidence';
import { ProductEvidenceError } from '../runtime/productEvidence';
const owner=runtimeAddress(900),sourceWallet=runtimeAddress(901),queryId='42';
export function poolRequestFixture(kind:CurrentPoolEvidenceRequest['kind']='add',side:0|1=0,overrides:{payload?:Cell;rows?:Array<{id:number;shares:bigint}>;action?:number;duration?:number;inline?:boolean}={}) {
  const manifest=runtimeManifestFixture(),pool=manifest.spotMarkets[0].pool,amount=kind==='add'||kind==='farm-create'||kind==='owed'?10n:0n;
  let body:Cell;
  if(kind==='add'||kind==='farm-create'){
    const payload=overrides.payload??(kind==='add'?beginCell().storeUint(0x4c514133,32).storeAddress(Address.parse(owner)).storeBit(true).storeUint(1,3)
      .storeRef(beginCell().storeInt(0,32).storeCoins(amount).storeUint((1n<<255n)+1n,256).storeBit(false).endCell()).endCell()
      :beginCell().storeUint(0x464d4333,32).storeInt(0,32).storeUint(overrides.duration??3600,32).endCell());
    const outer=beginCell().storeUint(0x0f8a7ea5,32).storeUint(BigInt(queryId),64).storeCoins(amount).storeAddress(Address.parse(pool)).storeAddress(Address.parse(owner)).storeBit(false).storeCoins(1n);
    body=(overrides.inline?outer.storeBit(false).storeSlice(payload.beginParse()):outer.storeBit(true).storeRef(payload)).endCell();
  }else if(kind==='farm-action')body=beginCell().storeUint(0x464d4133,32).storeUint(BigInt(queryId),64).storeUint(overrides.action??3,8).storeUint(1n,64).storeAddress(Address.parse(owner)).endCell();
  else if(kind==='owed')body=beginCell().storeUint(0x434c4d4a,32).storeUint(BigInt(queryId),64).storeUint(side,8).storeAddress(Address.parse(owner)).endCell();
  else{
    const rows=overrides.rows??[{id:-1,shares:1n},{id:1,shares:(1n<<255n)+1n}];let tail:Cell|null=null;
    for(const r of [...rows].reverse())tail=beginCell().storeInt(r.id,32).storeUint(r.shares,256).storeMaybeRef(tail).endCell();
    body=beginCell().storeUint(0x4c515233,32).storeUint(BigInt(queryId),64).storeAddress(Address.parse(owner)).storeUint(1800000001,32).storeCoins(0).storeCoins(0).storeUint(rows.length,3).storeRef(tail??Cell.EMPTY).endCell();
  }
  const request:CurrentPoolEvidenceRequest={network:'testnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,kind,owner,pool,side,queryId,amountRaw:amount.toString(),
    binId:kind==='add'||kind==='farm-create'||kind==='farm-action'?0:null,farmId:kind==='farm-action'?'1':null,action:kind==='farm-action'?(overrides.action??3):null,
    sourceWallet:kind==='add'||kind==='farm-create'?sourceWallet:null,bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:'1000000000',createdAt:1800000000000,
    dispatch:{lt:'1000000',hash:'1'.repeat(64),valueNano:'999000000'}};
  return{manifest,request,body};
}
async function run(){
  let count=0;
  for(const kind of ['add','farm-create','farm-action','remove','owed'] as const)for(const side of [0,1] as const){
    const {request,manifest}=poolRequestFixture(kind,side);assert.equal(readPoolOperationRequest(request,manifest).request.kind,kind);assert.equal(readPoolWalletClaimRequest(request,manifest).request.side,side);count+=2;
    for(const change of [{extra:1},{bodyHash:'0'.repeat(64)},{owner:runtimeAddress(902)},{side:2},{queryId:'43'},{kind:'legacy'},{network:'mainnet'},
      {manifestHash:'f'.repeat(64)},{releaseId:'other'},{createdAt:0},{dispatch:null},{dispatch:{...request.dispatch,lt:'0'}},{dispatch:{...request.dispatch,valueNano:'1000000001'}},
      {bodyBoc:request.bodyBoc+'AA'},{amountRaw:'-1'},{queryId:'01'},{owner:'-1:'+'1'.repeat(64)}]){
      assert.throws(()=>readPoolOperationRequest({...request,...change},manifest),ProductEvidenceError);count++;
    }
    const appended=beginCell().storeSlice(Cell.fromBase64(request.bodyBoc).beginParse()).storeBit(false).endCell();
    assert.throws(()=>readPoolOperationRequest({...request,bodyBoc:appended.toBoc().toString('base64'),bodyHash:appended.hash().toString('hex')},manifest),ProductEvidenceError);count++;
    if(kind==='add'||kind==='farm-create')for(const change of [{sourceWallet:null},{binId:1},{amountRaw:'11'},{farmId:'1'},{action:1}]){assert.throws(()=>readPoolOperationRequest({...request,...change},manifest),ProductEvidenceError);count++;}
    else {assert.throws(()=>readPoolOperationRequest({...request,sourceWallet},manifest),ProductEvidenceError);count++;}
  }
  for(const action of [1,2,3,4,5]){const f=poolRequestFixture('farm-action',0,{action});readPoolOperationRequest(f.request,f.manifest);count++;}
  for(const duration of [3600,7776000]){const f=poolRequestFixture('farm-create',0,{duration,inline:true});readPoolOperationRequest(f.request,f.manifest);count++;}
  for(const duration of [3599,7776001]){const f=poolRequestFixture('farm-create',0,{duration});assert.throws(()=>readPoolOperationRequest(f.request,f.manifest),ProductEvidenceError);count++;}
  for(const action of [0,6]){const f=poolRequestFixture('farm-action',0,{action});assert.throws(()=>readPoolOperationRequest(f.request,f.manifest),ProductEvidenceError);count++;}
  for(const rows of [[],[{id:0,shares:0n}],[{id:1,shares:1n},{id:1,shares:1n}],[{id:0,shares:1n},{id:1,shares:1n},{id:2,shares:1n}]]){const f=poolRequestFixture('remove',0,{rows});assert.throws(()=>readPoolOperationRequest(f.request,f.manifest),ProductEvidenceError);count++;}
  const farm=poolRequestFixture('farm-action');for(const change of [{amountRaw:'1'},{farmId:'0'},{binId:null},{action:null}]){assert.throws(()=>readPoolOperationRequest({...farm.request,...change},farm.manifest),ProductEvidenceError);count++;}
  const owed=poolRequestFixture('owed');for(const change of [{amountRaw:'0'},{farmId:'1'},{binId:0},{action:1}]){assert.throws(()=>readPoolOperationRequest({...owed.request,...change},owed.manifest),ProductEvidenceError);count++;}
  for(const notify of [false]){const payload=beginCell().storeUint(0x4c514133,32).storeAddress(Address.parse(owner)).storeBit(notify).storeUint(1,3).storeRef(beginCell().storeInt(0,32).storeCoins(10).storeUint(1,256).storeBit(false).endCell()).endCell(),f=poolRequestFixture('add',0,{payload});assert.throws(()=>readPoolOperationRequest(f.request,f.manifest),ProductEvidenceError);count++;}
  const publicPool=poolRequestFixture('farm-action');assert.equal(readPoolOperationRequest({...publicPool.request,pool:runtimeAddress(903)},publicPool.manifest).market,null);count++;
  const remove=poolRequestFixture('remove',0,{rows:[{id:0,shares:1n}]});readPoolOperationRequest(remove.request,remove.manifest);count++;
  const legacy=beginCell().storeUint(0x464d4333,32).storeUint(42n,64).storeInt(0,32).storeUint(3600,32).endCell(),bad=poolRequestFixture('farm-create',0,{payload:legacy});assert.throws(()=>readPoolOperationRequest(bad.request,bad.manifest),ProductEvidenceError);count++;
  const {manifest,request}=poolRequestFixture(),bundle=buildRuntimeManifestBundle(manifest);let calls=0,unavailable=false;
  const collect=async({request}:any,signal?:AbortSignal)=>{calls++;assert(signal);if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');return{schema:'tonswap-pool-operation-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:1,unixTime:1800000000,blockRootHash:'1'.repeat(64)},request:{kind:request.kind,owner:request.owner,bodyHash:request.bodyHash},coverage:{complete:false,gaps:[{code:'original_request_unobserved',account:request.owner}]},transactions:[]};};
  const app=Fastify();registerRoutes(app,{network:'testnet'},{} as IndexerService,undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,{source:{} as any,orders:{page:async()=>{throw Error();},poolOperationEvidence:collect as any,poolWalletClaimEvidence:collect as any}});
  try{for(const name of ['operation-evidence','wallet-claim-evidence']){const url=`/api/indexer/v1/pools/${name}`;
    for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload:request});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
    assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:request})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,payload:{...request,extra:true}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers:{'x-tonswap-release':'f'.repeat(64)},payload:request})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url,payload:{...request,bodyBoc:'a'.repeat(192*1024)}})).statusCode,413);
    unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,503);unavailable=false;
    assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
  }assert.equal(calls,6);const info=(await app.inject('/api/indexer/v1/service-info')).json();assert(info.endpoints.poolOperationEvidence&&info.endpoints.poolWalletClaimEvidence);}finally{await app.close();}
  console.log('Current Pool API exact release/body fences, no-store/noncached reads, service discovery, bounds and typed refusals passed.');
  console.log(`${count} current Pool operation/wallet request assertions passed: five operations, both sides, exact wires, original owner dispatch, release/null/row/duration bounds.`);
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
