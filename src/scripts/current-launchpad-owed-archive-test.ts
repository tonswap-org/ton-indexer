import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Address, beginCell, Cell } from '@ton/core';
import { ArchiveReconstructionPending, CurrentOwedArchiveTree, owedArchiveLeaf, readLaunchpadOwedArchiveRequest } from '../runtime/launchpadOwedArchiveEvidence';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import type { IndexerService } from '../indexerService';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
const digest = (c: Cell) => BigInt('0x' + c.hash().toString('hex'));
const pair = (left: bigint, right: bigint) => digest(beginCell().storeUint(3,8).storeUint(left,256).storeUint(right,256).endCell());
const empty = digest(beginCell().storeUint(0,8).endCell());
function root(leaves: ReadonlyMap<bigint,bigint>) {
  let level = new Map(leaves), zero = empty;
  for(let height=0;height<64;height++) { const next=new Map<bigint,bigint>(); for(const key of level.keys()) {const parent=key>>1n;next.set(parent,pair(level.get(parent<<1n)??zero,level.get((parent<<1n)|1n)??zero));}level=next;zero=pair(zero,zero); }
  return level.get(0n)??zero;
}
function proofRoot(leaf: bigint, id: bigint, proof: Cell) {
  let current=proof,value=leaf;
  for(let i=0;i<64;i++,id>>=1n){assert(!current.isExotic);const s=current.beginParse();assert.equal(s.remainingBits,257);const sibling=s.loadUintBig(256),tail=s.loadMaybeRef();s.endParse();assert.equal(tail===null,i===63);value=id&1n?pair(sibling,value):pair(value,sibling);if(tail)current=tail;}
  return value;
}
async function main(){
  const holder=runtimeAddress(910),owner=runtimeAddress(911),other=runtimeAddress(912),slot=1,tree=new CurrentOwedArchiveTree(holder,slot),leaves=new Map<bigint,bigint>();
  assert.equal(tree.root,root(leaves));let checks=1;
  for(let i=0;i<33;i++){
    const id=BigInt(i),recipient=i%2?other:owner,amount=BigInt(i+1),live=owedArchiveLeaf(holder,slot,id,recipient,amount);
    const independent=digest(beginCell().storeUint(1,8).storeAddress(Address.parse(holder)).storeUint(slot,8).storeUint(id,64).storeAddress(Address.parse(recipient)).storeUint(amount,120).endCell());assert.equal(live,independent);
    tree.append(id,recipient,amount);leaves.set(id,independent);assert.equal(tree.root,root(leaves));assert.equal(proofRoot(live,id,tree.proof(id)),tree.root);checks+=3;
    if(i===2||i===7||i===16||i===31){const consume=id-1n,who=Number(consume)%2?other:owner,value=consume+1n,proof=tree.proof(consume),prior=tree.root;
      assert.throws(()=>tree.consume(consume,who,value+1n,proof),ProductEvidenceError);assert.equal(tree.root,prior);
      assert.throws(()=>tree.consume(consume,who,value,Cell.EMPTY),ProductEvidenceError);assert.equal(tree.root,prior);
      tree.consume(consume,who,value,proof);leaves.set(consume,digest(beginCell().storeUint(2,8).storeAddress(Address.parse(holder)).storeUint(slot,8).storeUint(consume,64).endCell()));assert.equal(tree.root,root(leaves));
      assert.throws(()=>tree.consume(consume,who,value,proof),ProductEvidenceError);checks+=6;}
  }
  assert.throws(()=>tree.append(0n,owner,1n),ProductEvidenceError);assert.throws(()=>tree.append(tree.count,owner,0n),ProductEvidenceError);
  const manifest=runtimeManifestFixture(),request={network:'testnet',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,owner,factory:manifest.contracts.SaleFactory!.address,sale:holder,target:holder,creator:other,nonce:'1',model:0,slot:1};
  assert.deepEqual(readLaunchpadOwedArchiveRequest(request,manifest),request);
  for(const change of [{target:other},{slot:2},{nonce:'01'},{extra:1},{model:3},{owner:'-1:'+ '1'.repeat(64)}])assert.throws(()=>readLaunchpadOwedArchiveRequest({...request,...change},manifest),ProductEvidenceError);
  assert.throws(()=>readLaunchpadOwedArchiveRequest({...request,manifestHash:'f'.repeat(64)},manifest),(error:any)=>error.status===409);
  const bundle=buildRuntimeManifestBundle(manifest),app=Fastify(),url='/api/indexer/v1/launchpad/owed-archive-evidence';let reads=0,unavailable=false,pending=false;
  registerRoutes(app,{network:'testnet'},{getAdmissionStatus(){return{configured:false,ready:false};}} as IndexerService,undefined,undefined,undefined,undefined,bundle.contracts,bundle.metadata,
    {source:{} as any,orders:{page:async()=>{throw Error();},launchpadOwedArchiveEvidence:async(parsed,signal)=>{assert(signal);reads++;if(pending)throw new ArchiveReconstructionPending(64,64);if(unavailable)throw new ProductEvidenceError(503,'upstream_unavailable');const{network,releaseId,manifestHash,...identity}=parsed;
      return{schema:'tonswap-launchpad-owed-archive-evidence-v1',releaseId,manifestHash,asOf:{masterchainSeqno:1,unixTime:1800000000,blockRootHash:'1'.repeat(64)},request:identity,coverage:{complete:false,gaps:[]},holder:null,archive:null};}}});
  try{
    for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url,payload:request});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-tonswap-release'],manifest.manifestHash);}
    assert.equal((await app.inject({method:'POST',url:url+'?extra=1',payload:request})).statusCode,400);assert.equal((await app.inject({method:'POST',url,payload:{...request,target:other}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers:{'x-tonswap-release':'f'.repeat(64)},payload:request})).statusCode,409);assert.equal((await app.inject({method:'POST',url,payload:{...request,padding:'a'.repeat(192*1024)}})).statusCode,413);
    unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:request})).statusCode,503);assert.equal(reads,3);assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints.launchpadOwedArchiveEvidence,url);assert((buildOpenApi({network:'testnet'} as any) as any).paths[url]);
    pending=true;const progress=await app.inject({method:'POST',url,payload:request});assert.equal(progress.statusCode,503);assert.equal(progress.headers['cache-control'],'no-store');assert(progress.headers['retry-after']);assert.deepEqual(Object.keys(progress.json()).sort(),['code','error']);assert.equal(reads,4);
  }finally{await app.close();}
  console.log(`${checks} independent sparse root/witness/consume/append checks plus exact Sale request and transport fences passed. Synthetic vectors do not qualify native archive history.`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
