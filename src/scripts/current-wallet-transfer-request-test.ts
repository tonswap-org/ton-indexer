import assert from 'node:assert/strict';
import { Address, beginCell } from '@ton/core';
import Fastify from 'fastify';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
import { readWalletTransferEvidenceRequest } from '../runtime/walletTransferEvidence';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
async function main(){
 const manifest=runtimeManifestFixture(),owner=runtimeAddress(981),recipient=runtimeAddress(982),root=manifest.contracts.T3Hub!.address;
 const body=beginCell().storeUint(0x0f8a7ea5,32).storeUint(7,64).storeCoins(1234).storeAddress(Address.parse(recipient)).storeAddress(Address.parse(owner)).storeBit(false).storeCoins(0).storeBit(false).endCell();
 const request={network:manifest.network.slice(4),releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,owner,recipient,root,senderWallet:runtimeAddress(983),recipientWallet:runtimeAddress(984),queryId:'7',amountRaw:'1234',bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:'1000000000',createdAt:1800000000000,dispatch:{lt:'1',hash:'a'.repeat(64),valueNano:'1000000000'}};
 assert.deepEqual(readWalletTransferEvidenceRequest(request,manifest).request,request);
 for(const change of [{extra:true},{amountRaw:'0'},{amountRaw:'1235'},{queryId:'8'},{queryId:'0'},{owner:recipient},{recipient:owner},{root:runtimeAddress(987)},{createdAt:0},{bodyHash:'0'.repeat(64)},{bodyBoc:request.bodyBoc+'\n'},{dispatch:{...request.dispatch,valueNano:'1000000001'}},{senderWallet:request.recipientWallet}])assert.throws(()=>readWalletTransferEvidenceRequest({...request,...change},manifest),ProductEvidenceError);
 for(const key of ['network','manifestHash','releaseId'])assert.throws(()=>readWalletTransferEvidenceRequest({...request,[key]:'wrong'},manifest),(e:any)=>e.status===409);
 const bundle=buildRuntimeManifestBundle(manifest),app=Fastify(),url='/api/indexer/v1/wallet/transfers/evidence';let reads=0,unavailable=false;
 registerRoutes(app,{network:'testnet'},{} as IndexerService,undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,{source:{} as any,orders:{page:async()=>{throw Error();},walletTransferEvidence:async(parsed,signal)=>{assert(signal);reads++;if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');const p=parsed.request;return{schema:'tonswap-wallet-transfer-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:1,unixTime:1800000000,blockRootHash:'a'.repeat(64)},request:{owner:p.owner,recipient:p.recipient,root:p.root,senderWallet:p.senderWallet,recipientWallet:p.recipientWallet,bodyHash:p.bodyHash},coverage:{complete:false,gaps:[{code:'original_unavailable',account:p.senderWallet}]},transactions:[]};}}});
 try{for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload:request});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
  assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:request})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url,payload:{...request,amountRaw:'1235'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url,payload:request,headers:{'x-tonswap-release':'f'.repeat(64)}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url,payload:{...request,bodyBoc:'a'.repeat(192*1024)}})).statusCode,413);
  unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,503);assert.equal(reads,3);
  assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints.walletTransferEvidence,url);assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
 }finally{await app.close();}
 console.log('Current transfer exact body/parser and API release, no-store, size, query and unavailable fences passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
