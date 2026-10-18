import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCurrentDlmmOrders,readCurrentDlmmOrderCreations } from '../ledger/currentDlmmOrderProof';
import { verifyCurrentT3Transaction } from '../ledger/currentDlmmPhysical';
import { currentDlmmFixtureBinding,currentDlmmOrderOriginals } from './support/currentDlmmFixture';
const folder=process.argv[2],cases=folder?readdirSync(folder).filter(f=>f.endsWith('.json')).map(file=>({file,...JSON.parse(readFileSync(join(folder,file),'utf8'))})):currentDlmmOrderOriginals();let count=0;
for(const c of cases){
 const file=c.file,b=currentDlmmFixtureBinding(c),original=c.completeTransactions,select=(rows:typeof original)=>decodeCurrentDlmmOrders(c.original.wallet,b,rows).find(o=>o.economics.order?.address===c.original.order);
 const selected=select(original);assert(selected,file);const e=selected.economics;console.log(file,JSON.stringify({outcome:e.outcome,...e.order,fees:e.grossFeeT3Raw,cash:e.cash.length}));
 assert.equal(e.outcome,c.mode==='filled'?'delivered':'refunded',file);assert.equal(e.order!.fundedInRaw,c.expected.funded);assert.equal(e.order!.consumedInRaw,c.expected.consumed);assert.equal(e.order!.receivedOutRaw,c.expected.received);assert.equal(e.order!.refundedInRaw,c.expected.refunded);assert.equal(e.order!.executedSlices,c.expected.slices);assert.equal(e.grossFeeT3Raw,c.expected.grossFeeT3);assert.equal(e.protocolFeeT3Raw,c.expected.protocolFeeT3);assert.equal(e.paidInRaw,c.expected.funded);assert.equal(e.pendingOutT3Raw,'0');assert.equal(e.pendingOutXRaw,'0');
 assert.equal(e.cash.filter(l=>l.direction==='out').length,1);assert.equal(e.cash.filter(l=>l.direction==='in').length,c.expected.slices+(c.mode==='filled'?0:1));
 const creator=c.actions.find((a:any)=>a.kind==='create'),funder=c.actions.find((a:any)=>a.kind==='fund');
 assert.equal(select(original.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==creator.ownerDispatch.hash)),undefined,'Missing original owner creation cannot infer an order');
 const noFunding=select(original.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==funder.ownerDispatch.hash));assert.equal(noFunding?.economics.outcome,'unresolved','Missing original funding owner dispatch');
 const incoming=e.cash.find(l=>l.direction==='in')!;assert.equal(select(original.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==incoming.creditTransaction))?.economics.outcome,'unresolved','Missing physical output/refund');
 const creation=readCurrentDlmmOrderCreations(c.original.wallet,b,original).find(p=>p.order===c.original.order)!;assert(creation);
 assert.equal(select(original.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==creation.childHash)),undefined,'Original child genesis required');count++;
}
assert.equal(count,12);console.log('Current DLMM Order/TWAP: 12 production-Hub native cases with original dispatch, history and physical-credit negatives passed.');
