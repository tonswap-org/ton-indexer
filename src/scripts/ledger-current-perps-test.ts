import { currentPerpsCaptures } from './support/currentPerpsCaptures';
import assert from 'node:assert/strict';
import { currentPerpsProjectionFixture,currentPerpsGraphFixture } from './support/currentPerpsFixture';
import { projectOwnerLedger } from '../ledger/project';
import { verifyOrderTransaction } from '../orders/evidence';
import { Address } from '@ton/core';
import type { NativePerpsProofBinding } from '../ledger/currentPerpsProof';
import { decodeCurrentPerpsOperations } from '../ledger/currentPerps';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
export function perpsCaptureBinding(c: any): NativePerpsProofBinding {
 const a=(v:any)=>typeof v==='string'?Address.parse(v):new Address(v.workChain,Buffer.from(v.hash.data));
 const b={...c.binding};for(const key of ['engine','governance','feeSink','treasury','riskVault','t3Root'])b[key]=a(b[key]);
 b.markets=new Map(b.markets.map(([id,v]:[number,unknown])=>[id,a(v)]));
 const m=runtimeManifestFixture();return{perps:b,network:c.request.network,releaseId:c.request.releaseId,manifestHash:c.request.manifestHash,riskVaultHash:m.contracts.RiskVault!.codeHash,proofCodeHash:m.templates.T3RecoveryProof};
}
async function main(){
 const dir=process.argv[2];let checks=0;
 const projectedCases=new Set(['open','close','funding','refund','refusal','addMargin','increase','removeMargin','owed-before-claim','owed-paid','retry-paid','profit-riskOwed-paid','profit-riskRetry-paid','profit-settleRetry-close']);
 for(const {file,capture:c} of currentPerpsCaptures(dir)){
  const b=perpsCaptureBinding(c),name=file.replace(/-(default|x6)\.json$/,'');
  const select=(rows=c.transactions,binding=b)=>decodeCurrentPerpsOperations(c.request.owner,binding,rows).find(o=>o.request.dispatch.hash===c.request.dispatch.hash&&o.request.bodyHash===c.request.bodyHash);
  const op=select();assert(op,file);const e=op.economics;
  const expected=name.startsWith('incoming-')&&!['incoming-open','incoming-refunded'].includes(name)?'unresolved':name==='refusal'?'rejected':['refund','incoming-refunded'].includes(name)?'refunded':/before-claim|before-mark|marked/.test(name)||['profit-riskOwed-close','profit-riskRetry-close','profit-settleRetry-close'].includes(name)?'accepted':'confirmed';
  assert.equal(e.outcome,expected,`${file}: ${e.issue}`);
  if(e.kind==='open'&&e.outcome==='confirmed'){assert.equal(e.paidInRaw,'6000000000');assert.equal(e.feeRaw,'15000000');assert.equal(e.positionAfter!.entryNotionalRaw,'5000000000');assert.equal(e.positionAfter!.reservedRaw,'10000000000');assert.equal(e.positionAfter!.remainingEntitlementRaw,'5000000000');assert.equal(e.positionAfter!.marginRaw,'5985000000');}
  if(name==='addMargin'){assert.equal(e.paidInRaw,'1000000000');assert.equal(e.entryNotionalDeltaRaw,'0');assert.equal(e.positionBefore!.remainingEntitlementRaw,e.positionAfter!.remainingEntitlementRaw);}
  if(name==='increase'){assert.equal(e.paidInRaw,'2000000000');assert.equal(e.entryNotionalDeltaRaw,'1000000000');assert.equal(e.feeRaw,'3000000');}
  if(name==='close'){assert.equal(e.positionAfter,null);assert.equal(e.paidOutRaw,'8464000000');assert.equal(e.feeRaw,'18000000');}
  if(['removeMargin','owed-paid','retry-paid'].includes(name)){assert.equal(e.paidOutRaw,'500000000');assert.equal(e.positionBefore!.entryNotionalRaw,e.positionAfter!.entryNotionalRaw);}
  if(e.outcome==='refunded'){assert.equal(e.paidInRaw,'6000000000');assert.equal(e.paidOutRaw,e.paidInRaw);assert.equal(e.feeRaw,'0');}
  if(name==='refusal'){assert.equal(e.cash.length,0);assert.equal(e.paidOutRaw,'0');}
  if(name.startsWith('profit-')&&!name.endsWith('-open')){assert.equal(e.lpPayoutRaw,'126415670');assert.equal(e.localPayoutRaw,'5969620753');assert.equal(e.feeRaw,'15379247');assert.equal(BigInt(e.paidOutRaw)+BigInt(e.pendingOutRaw),6096036423n);}
  assert.equal(new Set(e.cash.map(l=>l.ownerTransaction+':'+l.direction)).size,e.cash.length,'Retry cannot count cash twice');checks++;
  if(file.endsWith('-default.json')&&projectedCases.has(name)){
   const input=currentPerpsProjectionFixture({...c,binding:b}),projected=await projectOwnerLedger(input),event=projected.events.find(e=>e.settlement?.currentPerps?.requestBodyHash===c.request.bodyHash&&e.settlement?.currentPerps?.dispatch.hash===c.request.dispatch.hash);
   assert(event,`${file}: current inferred operation`);const financial=event.movements.filter(m=>m.asset.master===b.perps.t3Root.toRawString());
   const total=(direction:string)=>financial.filter(m=>m.direction===direction).reduce((n,m)=>n+BigInt(m.amountRaw??'0'),0n).toString();
   assert.equal(total('in'),e.paidOutRaw,`${file}: physical payout exactly once`);assert.equal(total('out'),e.paidInRaw,`${file}: physical collateral exactly once`);
   assert.equal(event.settlement!.status,e.pendingOutRaw==='0'&&e.outcome!=='unresolved'?'confirmed':'incomplete',`${file}: ${event.issues}`);
   assert(!event.issues.includes('multiple_protocol_operations_grouped'),`${file}: grouped operations`);assert(!event.movements.some(m=>m.asset.kind==='perps_balance'),'Position accounting is not another owner asset');checks++;
   if(['open','profit-settleRetry-close'].includes(name)){
    const graph=await currentPerpsGraphFixture(input);assert(graph.currentPerpsBinding,`${file}: ${graph.issues}`);assert.equal(graph.bindings[`current-perps:${c.request.engine}`],true);checks++;
    const unavailable=await currentPerpsGraphFixture(input,{missingAccount:c.request.riskVault});assert(!unavailable.currentPerpsBinding);assert(unavailable.issues.includes('perps_current_discovery_unavailable'));checks++;
   }
   if(name==='open'){
    const missing=await projectOwnerLedger({...input,stateAt:async()=>null});assert(!missing.events.some(e=>e.settlement?.currentPerps&&e.settlement.status==='confirmed'));checks++;
    const noT3=await projectOwnerLedger({...input,t3Hubs:new Map()});assert(!noT3.events.some(e=>e.settlement?.currentPerps&&e.settlement.status==='confirmed'));checks++;
    const bounded=await currentPerpsGraphFixture(input,{maxAccounts:1});assert(bounded.issues.includes('related_account_limit_reached'));checks++;
   }
  }
  if(file.endsWith('-default.json')&&['open','refund','retry-paid','owed-paid','profit-riskRetry-paid','profit-riskOwed-paid','profit-settleRetry-paid'].includes(name)){
   const wrong=select(c.transactions,{...b,perps:{...b.perps,engineHash:'00'.repeat(32)}});assert(!wrong||wrong.economics.outcome==='unresolved');checks++;
   assert(!decodeCurrentPerpsOperations(b.perps.governance.toRawString(),b,c.transactions).some(o=>o.request.dispatch.hash===c.request.dispatch.hash));checks++;
   for(const leg of e.cash){const missing=select(c.transactions.filter((row:any)=>verifyOrderTransaction(row).hash!==(leg.direction==='in'?leg.creditTransaction:leg.debitTransaction)));assert(!missing||missing.economics.outcome==='unresolved'||missing.economics.pendingOutRaw!=='0',`${file}: missing physical original remains incomplete`);if(missing)assert(!missing.economics.cash.some(l=>l.ownerTransaction===leg.ownerTransaction));checks++;}
   const noOwner=select(c.transactions.filter((row:any)=>verifyOrderTransaction(row).hash!==c.request.dispatch.hash));assert(!noOwner);checks++;
  }
  console.log(file,e.outcome);
 }
 console.log(`Current Perps: ${checks} original owner, independent economics, physical cash, graph and missing-evidence checks passed.`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
