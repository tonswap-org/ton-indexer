/** Native source-bound holders and exact original causal graph; synthetic
 * sandbox heads/transport do not constitute public consensus qualification. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell } from '@ton/core';
import { activeOrderAccount, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { readCurrentOwedState, owedHolderPin } from '../runtime/currentOwedState';
import { collectOwedEvidence, collectOwedOperationEvidence, readOwedOperationRequest, readOwedEvidenceContext } from '../runtime/owedEvidence';
import { collectProductPhysicalGraph } from '../runtime/productEvidence';
import { ArchiveReconstructionPending } from '../runtime/launchpadOwedArchiveEvidence';
import { archiveCheckpointTestStore } from './support/archiveCheckpointTestStore';
import { currentOwedFixture } from './support/currentOwedFixture';
import { currentOwedNativeAdapter } from './support/currentOwedNativeAdapter';

async function main(){
 const directory=process.argv[2];const order=['layouts','direct-refused','archive-refused','direct-delivered','archive-delivered','protected-failed','protected-marked','protected-delivered'];const rank=(file:string)=>order.indexOf(file.replace(/-(default|x6)\.json$/,''));const files=directory?readdirSync(directory).filter(f=>f.endsWith('.json')).sort((a,b)=>(a.endsWith('-x6.json')?1:0)-(b.endsWith('-x6.json')?1:0)||rank(a)-rank(b)):[];const fixtures=directory?(function*(){for(const file of files)yield{file,capture:JSON.parse(readFileSync(join(directory,file),'utf8'))};})():currentOwedFixture().cases();const now=Date.now;let cases=0,layouts=0;const checkpoints=new Map<string,ReturnType<typeof archiveCheckpointTestStore>>();
 try{for(const{file,capture:c}of fixtures){
  if(c.schema==='tonswap-current-owed-layout-native-v1'){
   assert.equal(c.holders.length,11);for(const h of c.holders){const row=c.currentAccounts.find((r:any)=>r.address===h.address);assert(row);const pin=owedHolderPin(c.manifest,h.address);assert.equal(pin.role,h.role);assert.equal(pin.codeHash,h.codeHash);const state=readCurrentOwedState(activeOrderAccount(orderShard(row.originalShardAccountBoc,h.address).shard,pin.codeHash).data,pin.role,c.manifest,h.address);assert(state.slots.size>0);assert(state.owed.size===0||[...state.owed.values()].every(v=>v.total===0n));layouts++;}continue;
  }
  if(!c.plan)continue;const p=c.plan,a=currentOwedNativeAdapter(c);Date.now=()=>a.head.utime*1000;const profile=String(c.config);if(!checkpoints.has(profile))checkpoints.set(profile,archiveCheckpointTestStore());Object.assign(a.store,checkpoints.get(profile));
  const request={...p.scope,kind:p.kind,queryId:p.queryId,amountRaw:p.amountRaw,bodyBoc:p.bodyBoc,bodyHash:p.bodyHash,valueNano:p.valueNano,dispatch:c.dispatch},parsed=readOwedOperationRequest(request,a.manifest);
  const result=await collectOwedOperationEvidence(a.manifest,a.source,a.store,parsed);assert(result.coverage.complete,`${file}: ${JSON.stringify(result.coverage)}`);assert(result.transactions.length<=256);
  const ids=new Set(result.transactions.map(r=>{const t=verifyOrderTransaction(r);return `${r.account}:${t.tx.lt}:${t.hash}`;}));
  // Independent permissionless MARK callers and their GRAM excess returns
  // are retained in the corpus, but are not authority for this original claim.
  // Require its exact owner dispatch and every holder/source/recipient token
  // boundary, including later retry and physical credit (never just a log).
  for(const row of c.transactions){const t=verifyOrderTransaction(row),originalOwner=row.account===p.scope.owner&&String(t.tx.lt)===c.dispatch.lt&&t.hash===c.dispatch.hash;if(originalOwner||[p.scope.holder,p.from.address,p.to.address].includes(row.account))assert(ids.has(`${row.account}:${t.tx.lt}:${t.hash}`),`${file}: original claim leg missing ${row.account}:${t.tx.lt}:${t.hash}`);}
  const original=c.transactions.find((r:any)=>r.account===p.scope.holder);assert(original);const originalTx=verifyOrderTransaction(original);a.control.missingBoundary=`${original.account}:${originalTx.tx.lt}:${originalTx.hash}`;const missing=await collectOwedOperationEvidence(a.manifest,a.source,a.store,parsed);assert.equal(missing.coverage.complete,false);a.control.missingBoundary='';
  // The direct/archive owner candidate is independently reconstructed from
  // original holder state/history. The response does not assert delivery.
  let discovery:Awaited<ReturnType<typeof collectOwedEvidence>>|undefined;for(let slice=0;slice<160&&!discovery;slice++){try{discovery=await collectOwedEvidence(a.manifest,a.source,a.store,p.scope);}catch(error){if(!(error instanceof ArchiveReconstructionPending))throw error;assert(error.verified>0,'Each bounded slice must preserve actual progress');console.log(file,'archive original checkpoint',error.traversed);}}assert(discovery,'Bounded complete native archive required');assert(discovery.coverage.complete);const context=await readOwedEvidenceContext(a.manifest,a.source,p.scope);const book=context.state.owed.get(p.scope.slot);assert.equal(discovery.directRaw,String(book?.entries.get(Address.parse(p.scope.owner))??0n));
  if(file.includes('refused')){
   const sourceRows=c.completeTransactions.filter((row:any)=>row.account===p.from.address).map((row:any)=>({row,t:verifyOrderTransaction(row)})).sort((x:any,y:any)=>x.t.tx.lt<y.t.tx.lt?-1:1);assert(sourceRows.length>256,'Real shared source history must exceed response bound');const old=sourceRows.find((r:any)=>r.t.tx.lt<BigInt(c.dispatch.lt));assert(old);a.control.missingBoundary=`${p.from.address}:${old.t.tx.lt}:${old.t.hash}`;const missingHistory=await collectOwedOperationEvidence(a.manifest,a.source,a.store,parsed);assert.equal(missingHistory.coverage.complete,false,'Missing pre-dispatch frozen provenance must refuse');a.control.missingBoundary='';
   const pins=new Map([[p.scope.holder,context.pin.codeHash],[p.from.address,context.token.walletCodeHash],[p.to.address,context.token.walletCodeHash]]);
   const complete=await collectProductPhysicalGraph(a.source,a.store,a.head,{owner:p.scope.owner,target:p.scope.holder,body:Cell.fromBase64(p.bodyBoc),dispatch:c.dispatch,pins,completeAccounts:[p.from.address],historyOnlyAccounts:[p.from.address],historyLimit:10000,includeAccounts:[p.scope.holder,p.to.address],allowFrozenPins:new Set([p.from.address])});
   assert.equal(complete.coverage.complete,false,'completeAccounts still returns full history and enforces response cap');assert(complete.coverage.gaps.some(g=>g.code==='returned_transaction_limit'));
  }
  cases++;console.log(file,result.transactions.length,'exact causal rows; missing originals/provenance refused');
 }}finally{Date.now=now;}
 assert.equal(cases,14);assert.equal(layouts,22);console.log(`${cases} native owed operation/discovery cases and ${layouts} native holder layouts passed.`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
