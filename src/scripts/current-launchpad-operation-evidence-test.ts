import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Address, beginCell, Cell } from '@ton/core';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { readLaunchpadOperationRequest,type CurrentLaunchpadEvidenceRequest } from '../runtime/launchpadOperationEvidence';
import { readLaunchpadWalletClaimRequest } from '../runtime/launchpadWalletClaimEvidence';
export function launchpadRequestFixture(kind:CurrentLaunchpadEvidenceRequest['kind']='create'){
  const manifest=runtimeManifestFixture(),owner=runtimeAddress(900),sale=runtimeAddress(901),lp=runtimeAddress(902),vesting=runtimeAddress(903),sourceWallet=runtimeAddress(904);
  const t3=manifest.tokens.find(t=>t.symbol==='T3')!,project=manifest.tokens.find(t=>t.symbol==='USDT')!;
  const terms=beginCell().storeAddress(Address.parse(project.root)).storeAddress(Address.parse(owner)).storeUint(6,8).storeUint(1800000000,32).storeUint(1800001000,32).storeInt(0,32)
    .storeRef(beginCell().storeCoins(1).storeCoins(2).storeCoins(1).storeCoins(2).storeCoins(100).endCell()).storeRef(beginCell().storeCoins(1).endCell()).storeMaybeRef(null).endCell();
  const target=kind==='create'?manifest.contracts.SaleFactory!.address:kind.startsWith('lp-')?lp:kind.startsWith('vest-')?vesting:sale;
  const transfer=['contribute','supply','vest-supply'].includes(kind),token=kind==='contribute'?t3:project;let body:Cell;
  if(['wallet-mark','wallet-retry','holder-claim','archive-claim'].includes(kind)){
    const makePath=(seed:number)=>{let next:Cell|null=null;for(let i=63;i>=0;i--)next=beginCell().storeUint(BigInt(seed+i),256).storeMaybeRef(next).endCell();return next!;},proof=makePath(0);
    if(kind==='wallet-mark'||kind==='wallet-retry'){
      const details=beginCell().storeUint(8,64).storeAddress(Address.parse(owner)).storeCoins(0).storeRef(beginCell().storeBit(false).endCell()).storeMaybeRef(null).endCell();
      const terms=beginCell().storeAddress(Address.parse(sale)).storeAddress(Address.parse(owner)).storeBit(false).storeCoins(100).storeRef(details).endCell();
      const attempt=beginCell().storeUint(0,64).storeUint(1,64).storeUint(0,64).storeRef(terms).endCell(),record=beginCell().storeBit(kind==='wallet-retry').storeBit(false).storeRef(attempt).endCell();
      const b=beginCell().storeUint(kind==='wallet-mark'?0x5433574b:0x54335759,32).storeRef(record).storeRef(proof);if(kind==='wallet-mark')b.storeUint(0,64).storeRef(makePath(100));else b.storeAddress(Address.parse(owner));body=b.endCell();
    }else if(kind==='holder-claim')body=beginCell().storeUint(0x4a52434d,32).storeRef(beginCell().storeUint(1,64).storeRef(beginCell().storeBit(false).storeUint(0,8).storeCoins(100).storeBit(false).storeRef(Cell.EMPTY)).endCell()).storeRef(proof).endCell();
    else body=beginCell().storeUint(0x434c4d41,32).storeUint(9,64).storeUint(0,8).storeUint(0,64).storeAddress(Address.parse(owner)).storeCoins(100).storeRef(proof).endCell();
  }else if(transfer){const payload=kind==='contribute'?beginCell().storeUint(0x53434f4e,32).storeCoins(2).endCell():Cell.EMPTY;
    body=beginCell().storeUint(0x0f8a7ea5,32).storeUint(9,64).storeCoins(100).storeAddress(Address.parse(target)).storeAddress(Address.parse(owner)).storeMaybeRef(null).storeCoins(1).storeBit(true).storeRef(payload).endCell();
  }else{const op={create:0x53464e57,claim:0x53434c4d,finalize:0x5346494e,cancel:0x5343414e,discover:0x44534357,'lp-seed':0x4c565344,'lp-release':0x4c56524c,'vest-claim':0x5656434c,'vest-return':0x56565254,owed:0x434c4d4a}[kind as 'create'];
    const b=beginCell().storeUint(op,32).storeUint(9,64);
    if(kind==='create')b.storeUint(1,64).storeUint(0,8).storeRef(terms);if(kind==='lp-seed'||kind==='lp-release'){b.storeCoins(10).storeCoins(20);if(kind==='lp-release')b.storeBit(true);}if(kind==='owed')b.storeUint(0,8).storeAddress(Address.parse(owner));body=b.endCell();
  }
  const request:CurrentLaunchpadEvidenceRequest={network:'testnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,kind,owner,factory:manifest.contracts.SaleFactory!.address,sale,target,creator:owner,nonce:'1',model:0,queryId:'9',
    tokenRoot:transfer?token.root:['wallet-mark','wallet-retry','holder-claim','archive-claim'].includes(kind)?t3.root:null,amountRaw:transfer||['wallet-mark','wallet-retry','holder-claim','archive-claim'].includes(kind)?'100':kind==='owed'?'1':'0',minTokensRaw:kind==='contribute'?'2':null,sourceWallet:transfer||kind==='wallet-mark'||kind==='wallet-retry'?sourceWallet:null,
    assets:transfer?[{root:token.root,masterCodeHash:token.masterCodeHash,walletCodeHash:token.walletCodeHash,amountRaw:'100',recipient:target}]:['wallet-mark','wallet-retry','holder-claim','archive-claim'].includes(kind)?[{root:t3.root,masterCodeHash:t3.masterCodeHash,walletCodeHash:t3.walletCodeHash,amountRaw:'100',recipient:owner}]:[],bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:'1000000000',createdAt:1800000000000,dispatch:{lt:'1000000',hash:'1'.repeat(64),valueNano:'999000000'}};
  return{manifest,request,body};
}
async function main(){
  for(const kind of ['create','contribute','supply','vest-supply','claim','finalize','cancel','discover','lp-seed','lp-release','vest-claim','vest-return','owed','wallet-mark','wallet-retry','holder-claim','archive-claim'] as const){
    const {manifest,request}=launchpadRequestFixture(kind);assert.equal(readLaunchpadOperationRequest(request,manifest).request.kind,kind);
    assert.equal(readLaunchpadWalletClaimRequest,readLaunchpadOperationRequest);
    assert.deepEqual(readLaunchpadWalletClaimRequest(request,manifest).request,readLaunchpadOperationRequest(request,manifest).request);
    for(const change of [{extra:1},{model:3},{nonce:'01'},{bodyHash:'0'.repeat(64)},{dispatch:{...request.dispatch,valueNano:'1000000001'}},{assets:[{root:request.owner}]}])assert.throws(()=>readLaunchpadOperationRequest({...request,...change},manifest),ProductEvidenceError);
    assert.throws(()=>readLaunchpadOperationRequest({...request,manifestHash:'f'.repeat(64)},manifest),(e:any)=>e.code==='release_mismatch');
  }
  const {manifest,request}=launchpadRequestFixture(),bundle=buildRuntimeManifestBundle(manifest),app=Fastify();let reads=0,unavailable=false;
  const response=(parsed:ReturnType<typeof readLaunchpadOperationRequest>,signal:AbortSignal|undefined)=>{
    assert(signal);reads++;if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');
    return{releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:1,unixTime:1800000000,blockRootHash:'1'.repeat(64)},
      request:{kind:parsed.request.kind,owner:parsed.request.owner,bodyHash:parsed.request.bodyHash},coverage:{complete:false,gaps:[]}};
  };
  registerRoutes(app,{network:'testnet'},{getAdmissionStatus(){return{configured:false,ready:false};}} as IndexerService,undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,
    {source:{} as any,orders:{page:async()=>{throw Error();},
      launchpadOperationEvidence:async(parsed,signal)=>({...response(parsed,signal),schema:'tonswap-launchpad-operation-evidence-v1',transactions:[]}),
      launchpadWalletClaimEvidence:async(parsed,signal)=>({...response(parsed,signal),schema:'tonswap-launchpad-wallet-claim-evidence-v1',wallets:[]})}});
  try{for(const [service,path] of [['launchpadOperationEvidence','operation-evidence'],['launchpadWalletClaimEvidence','wallet-claim-evidence']]){
    const url='/api/indexer/v1/launchpad/'+path;unavailable=false;const start=reads;
    for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload:request});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
    assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:request})).statusCode,400);assert.equal((await app.inject({method:'POST',url,payload:{...request,extra:1}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers:{'x-tonswap-release':'f'.repeat(64)},payload:request})).statusCode,409);assert.equal((await app.inject({method:'POST',url,payload:{...request,bodyBoc:'a'.repeat(192*1024)}})).statusCode,413);
    unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,503);assert.equal(reads-start,3);assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints[service],url);assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
  }}finally{await app.close();}console.log('All17 native Launchpad request shapes and both operation/wallet-claim release/cache/body/asset/API bounds passed.');
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
