import assert from 'node:assert/strict';
import { currentPerpsCaptures } from './support/currentPerpsCaptures';
import { perpsCaptureBinding } from './ledger-current-perps-test';
import { currentPerpsProjectionFixture } from './support/currentPerpsFixture';
import { perpsOriginalAdapter } from './current-perps-native-evidence-test';
import { collectCurrentPerpsRange } from '../ledger/currentPerpsRange';
import { capturePerpsRangeChain } from '../ledger/perpsRange';
import { canonicalLedgerHash } from '../ledger/normalize';
import type { ChainSource } from '../data/dataSource';
async function main(){
 let checks=0;
 for(const {file,capture:c}of currentPerpsCaptures()){
  if(!['open-default.json','profit-settleRetry-close-default.json','profit-riskRetry-paid-x6.json'].includes(file))continue;
  const binding=perpsCaptureBinding(c),input=currentPerpsProjectionFixture({...c,binding}),adapter=perpsOriginalAdapter(c);
  const source:ChainSource={...adapter.source,
   getAccountState:async(account,options)=>{if(account===adapter.control.missingAccount)throw Error('fixture account unavailable');return adapter.source.getAccountState(account,options);},
   getTransactions:async(account,limit,lt,hash)=>{const rows=[...(input.chains.get(account)?.transactions??[])].reverse(),index=rows.findIndex(row=>row.lt===lt&&canonicalLedgerHash(row.hash)===canonicalLedgerHash(hash!));assert(index>=0,'native inclusive transaction cursor');return rows.slice(index,index+limit);},
  };
  // This is explicitly a sandbox publication clock, one second after the
  // original native execution. The original transaction clocks stay unchanged.
  adapter.head.utime++;const bounds={fromUtime:Math.floor(c.request.createdAt/1000)-1,toUtime:adapter.head.utime};
  const collect=()=>{const budget={pages:128,deadline:Date.now()+120000};return collectCurrentPerpsRange({network:'localnet',owner:c.request.owner,generation:'native-test',source,head:adapter.head,binding,bounds,opcodes:input.opcodes,stateAt:input.stateAt,capture:(a,s,b)=>capturePerpsRangeChain(source,a,s,b,budget)});};
  const result=await collect(),event=result.projection.events.find(e=>e.settlement?.currentPerps?.dispatch.hash===c.request.dispatch.hash);
  assert(event,`${file}: bounded current Perps request`);assert.equal(event.settlement!.status,file.includes('settleRetry-close')?'incomplete':'confirmed');assert(result.chains.every(c=>!c.historyComplete&&c.verifiedRange?.fromUtime===bounds.fromUtime));assert.deepEqual(result.oraclePools,[...binding.perps.markets.values()].map(a=>a.toRawString()));assert(result.protocolPeers.includes(c.request.riskVault));checks++;
  adapter.control.missingAccount=c.request.riskVault;await assert.rejects(collect());checks++;
  console.log('Current Perps range',file,event.settlement!.status);
 }
 assert.equal(checks,6);console.log('Current Perps bounded range: native default/x6 original identity, physical payout, frozen history and unavailable-account checks passed.');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
