import assert from 'node:assert/strict';
import { currentDlmmRecoveryOriginals,currentDlmmFixtureBinding } from './support/currentDlmmFixture';
import { currentDlmmProjectionFixture } from './support/currentDlmmProjectionFixture';
import { decodeCurrentDlmmOperations } from '../ledger/currentDlmmEconomics';
import { projectOwnerLedger } from '../ledger/project';
async function main(){let count=0;
 for(const sample of currentDlmmRecoveryOriginals()){
  const c=sample.capture??sample,binding=currentDlmmFixtureBinding(c),input=currentDlmmProjectionFixture({binding,request:c.request,transactions:c.completeTransactions}),operation=decodeCurrentDlmmOperations(c.request.owner,binding,c.completeTransactions).find(o=>o.request.dispatch.hash===c.request.dispatch.hash);assert(operation);
  const result=await projectOwnerLedger(input),event=result.events.find(e=>e.settlement?.currentDlmm?.dispatch.hash===c.request.dispatch.hash);assert(event,JSON.stringify(result.events.map(e=>({kind:e.kind,issues:e.issues}))));
  const e=operation.economics,total=(root:string,direction:string)=>event.movements.filter(m=>m.asset.master===root&&m.direction===direction&&(m.evidence.kind==='jetton_internal_transfer'||m.evidence.kind==='jetton_transfer')).reduce((n,m)=>n+BigInt(m.amountRaw??0),0n).toString();
  assert.equal(total(binding.pools[0].t3.root,'in'),e.paidOutT3Raw);assert.equal(total(binding.pools[0].x.root,'in'),e.paidOutXRaw);assert.equal(event.settlement!.status,e.pendingOutT3Raw==='0'&&e.pendingOutXRaw==='0'?'confirmed':'incomplete',JSON.stringify(event.issues));assert(!event.issues.includes('multiple_protocol_operations_grouped'));
  const noArchive=await projectOwnerLedger({...input,stateAt:async()=>null});assert(!noArchive.events.some(e=>e.settlement?.currentDlmm&&e.settlement.status==='confirmed'));count++;console.log(sample.file??c.request.kind,event.settlement!.status);
 }
 assert.equal(count,6);console.log('Current DLMM ordinary projection: six native default/x6 production-Hub retry stages preserve physical T3/X cash and explicit missing-archive gaps.');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
