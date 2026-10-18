import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Address, beginCell, Cell } from '@ton/core';
import { runtimeManifestFixture, runtimeAddress } from './fixtures/runtimeManifest';
import { readOwedRequest, readOwedOperationRequest } from '../runtime/owedEvidence';
import { OWED_ROLES } from '../runtime/currentOwedState';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
async function run(){
  const manifest=runtimeManifestFixture(),owner=runtimeAddress(900);let count=0;
  const base={network:manifest.network.slice(4),releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,owner,holder:manifest.contracts.SwapCoordinator!.address,slot:0};
  for(const holder of [...OWED_ROLES.flatMap(role=>manifest.contracts[role]?[manifest.contracts[role]!.address]:[]),...manifest.spotMarkets.map(m=>m.pool)]){assert.equal(readOwedRequest({...base,holder},manifest).holder,holder);count++;}
  for(const change of [{extra:1},{owner:'-1:'+'1'.repeat(64)},{owner:runtimeAddress(0)},{slot:-1},{slot:256},{slot:0.5},{slot:'0'},{holder:'0:'+'0'.repeat(64)},{manifestHash:'ff'.repeat(32)},{releaseId:'other'},{network:'mainnet'}]){assert.throws(()=>readOwedRequest({...base,...change},manifest),ProductEvidenceError);count++;}
  assert.equal(readOwedRequest({...base,holder:runtimeAddress(999)},manifest).holder,runtimeAddress(999),'Unknown pool is only a bounded candidate until canonical factory proof');count++;
  const fixture=(kind:'direct'|'archive')=>{let proof:Cell|null=null;for(let i=0;i<64;i++)proof=beginCell().storeUint(i,256).storeMaybeRef(proof).endCell();const q=beginCell().storeUint(kind==='direct'?0x434c4d4a:0x434c4d41,32).storeUint(1,64).storeUint(0,8);if(kind==='archive')q.storeUint(0,64);q.storeAddress(Address.parse(owner));if(kind==='archive')q.storeCoins(17n).storeRef(proof!);const body=q.endCell();return{...base,kind,queryId:'1',amountRaw:'17',bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:'1000',dispatch:{lt:'1',hash:'01'.repeat(32),valueNano:'1000'}};};
  for(const kind of ['direct','archive'] as const){const p=fixture(kind);assert.equal(readOwedOperationRequest(p,manifest).request.kind,kind);count++;
    for(const change of [{extra:true},{queryId:'2'},{owner:runtimeAddress(901)},{slot:1},{bodyHash:'ff'.repeat(32)},{bodyBoc:p.bodyBoc+'AA'},{amountRaw:'0'},{valueNano:'0'},{dispatch:null},{dispatch:{...p.dispatch,lt:'0'}},{dispatch:{...p.dispatch,valueNano:'1001'}}]){assert.throws(()=>readOwedOperationRequest({...p,...change},manifest),ProductEvidenceError);count++;}
    if(kind==='archive'){assert.throws(()=>readOwedOperationRequest({...p,amountRaw:'18'},manifest),ProductEvidenceError);count++;}
    const body=beginCell().storeSlice(Cell.fromBase64(p.bodyBoc).beginParse()).storeBit(false).endCell();assert.throws(()=>readOwedOperationRequest({...p,bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex')},manifest),ProductEvidenceError);count++;
  }
  const bundle=buildRuntimeManifestBundle(manifest),app=Fastify();let calls=0,unavailable=false;
  const collect=async(_p:any,signal?:AbortSignal)=>{calls++;assert(signal);if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');return{coverage:{complete:false,gaps:[]}} as any;};
  registerRoutes(app,{network:'testnet'},{getAdmissionStatus(){return{configured:false,ready:false};}} as IndexerService,undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,{source:{} as any,orders:{page:async()=>{throw Error();},owedEvidence:collect,owedOperationEvidence:collect,owedWalletClaimEvidence:collect}});
  try{for(const[name,payload]of [['evidence',base],['operation-evidence',fixture('archive')],['wallet-claim-evidence',fixture('direct')]] as const){const url=`/api/indexer/v1/owed/${name}`;
    for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
    assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,payload:{...payload,extra:true}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,payload,headers:{'x-tonswap-release':'ff'.repeat(32)}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url,payload:{...payload,extra:'a'.repeat(192*1024)}})).statusCode,413);
    unavailable=true;assert.equal((await app.inject({method:'POST',url,payload})).statusCode,503);unavailable=false;
    assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
  }assert.equal(calls,9);const info=(await app.inject('/api/indexer/v1/service-info')).json();assert(info.endpoints.owedEvidence&&info.endpoints.owedOperationEvidence&&info.endpoints.owedWalletClaimEvidence);
  }finally{await app.close();}
  console.log(`${count} exact current owed request assertions, API release/size/no-store/deadline/service-discovery gates passed.`);
}
run().catch(error=>{console.error(error);process.exitCode=1;});
