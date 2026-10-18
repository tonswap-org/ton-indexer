import assert from 'node:assert/strict';
import { currentDlmmOrderOriginals,currentDlmmFixtureBinding } from './support/currentDlmmFixture';
import { currentDlmmProjectionFixture } from './support/currentDlmmProjectionFixture';
import { projectOwnerLedger } from '../ledger/project';
async function main(){let count=0;
 for(const c of currentDlmmOrderOriginals()){
  const binding=currentDlmmFixtureBinding(c),input=currentDlmmProjectionFixture({binding,request:{owner:c.original.wallet},transactions:c.completeTransactions}),result=await projectOwnerLedger(input),event=result.events.find(e=>e.settlement?.currentDlmm?.order?.address===c.original.order);assert(event,c.file);
  assert.equal(event.settlement!.status,'confirmed',JSON.stringify(event.issues));const economics=event.settlement!.currentDlmm!;
  for(const root of [binding.pools[0].t3.root,binding.pools[0].x.root])for(const direction of ['in','out'] as const){const expected=economics.cash.filter(l=>l.root===root&&l.direction===direction).reduce((n,l)=>n+BigInt(l.amountRaw),0n),actual:bigint=event.movements.filter(m=>m.asset.master===root&&m.direction===direction&&(m.evidence.kind==='jetton_transfer'||m.evidence.kind==='jetton_internal_transfer')).reduce((n,m)=>n+BigInt(m.amountRaw),0n);assert.equal(actual,expected,`${c.file} ${root} ${direction}`);}
  const missing=await projectOwnerLedger({...input,stateAt:async()=>null});assert(!missing.events.some(e=>e.settlement?.currentDlmm?.order?.address===c.original.order&&e.settlement?.status==='confirmed'));console.log(c.file,event.settlement!.status,economics.order);count++;
 }
 assert.equal(count,12);console.log('Current Order/TWAP ordinary projection: 12 cases retain distinct custody, slice consumption, payout/refund and fee allocations without duplicate cash.');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
