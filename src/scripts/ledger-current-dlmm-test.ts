import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCurrentDlmmOperations } from '../ledger/currentDlmmEconomics';
import { verifyCurrentT3Transaction } from '../ledger/currentDlmmPhysical';
import { currentDlmmFixtures,currentDlmmFixtureBinding } from './support/currentDlmmFixture';
const fixtures=currentDlmmFixtures();let checks=0;
assert.equal(fixtures.length,28);
assert.equal(createHash('sha256').update(readFileSync(join(__dirname,'fixtures/current-dlmm-native/pool-operations.json.gz'))).digest('hex'),'e4591bb5d2fbd98087a2568a652a48144b59d4164b88f88ca841e3c3b8d79c40');
for(const c of fixtures){
 const b=currentDlmmFixtureBinding(c),rows=c.response.transactions;
 const select=(input:typeof rows)=>decodeCurrentDlmmOperations(c.request.owner,b,input).find(o=>o.request.dispatch.hash===c.request.dispatch.hash&&o.request.bodyHash===c.request.bodyHash);
 const op=select(rows);assert(op,`${c.file}: original dispatch inference`);const e=op.economics;
 assert.notEqual(op.proof.status,'unavailable',c.file);
 assert.equal(new Set(e.cash.map(c=>`${c.direction}:${c.originTransaction}`)).size,e.cash.length,`${c.file}: no duplicate initial debit`);
 if(c.request.kind==='add'){
  assert.equal(e.paidInRaw,c.request.amountRaw);
  if(c.file.includes('refused')){assert.equal(e.outcome,'refunded');assert.equal(e.shares.length,0);assert.equal(c.request.side===0?e.paidOutT3Raw:e.paidOutXRaw,c.request.amountRaw);}
  else{assert.equal(e.outcome,'accepted');assert.equal(e.shares.length,1);assert(BigInt(e.shares[0].deltaRaw)>0n);}
 }else if(c.request.kind==='farm-create'){assert.equal(e.paidInRaw,c.request.amountRaw);assert(e.farmId);assert.equal(e.shares.length,0);}
 else if(c.request.kind==='farm-action'){assert.equal(e.paidInRaw,'0');assert.equal(e.paidOutT3Raw,c.request.action===3?'4999999999':'5000000001');}
 else{
  assert.equal(e.paidInRaw,'0');assert(e.shares.every(s=>BigInt(s.deltaRaw)<0n));assert(BigInt(e.paidOutXRaw)>0n);
  if(/before-mark|marked/.test(c.file)){assert.equal(e.paidOutT3Raw,'0');assert(BigInt(e.pendingOutT3Raw)>0n);assert.equal(e.outcome,'unresolved');}
  else{assert.equal(e.outcome,'delivered');assert(BigInt(e.paidOutT3Raw)>0n);assert.equal(e.pendingOutT3Raw,'0');}
 }
 // Removing the final recipient credit never upgrades a bookkeeping receipt to cash.
 const incoming=e.cash.find(x=>x.direction==='in');if(incoming){const reduced=select(rows.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==incoming.creditTransaction));assert(reduced);assert(!reduced.economics.cash.some(l=>l.creditTransaction===incoming.creditTransaction));assert.notEqual(reduced.economics.outcome,'delivered');}
 // Exact original account commitments and unique boundaries remain mandatory.
 assert.throws(()=>select([...rows,rows[0]]));
 const ownerless=rows.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==c.request.dispatch.hash);assert.equal(select(ownerless),undefined);
 console.log(c.file,JSON.stringify({outcome:e.outcome,paidIn:e.paidInRaw,paidT3:e.paidOutT3Raw,paidX:e.paidOutXRaw,pendingT3:e.pendingOutT3Raw,shares:e.shares.length,cash:e.cash.length}));checks++;
}
console.log(`Current DLMM ${checks} original Pool economics cases plus missing-credit/origin/duplicate negatives passed. Sandbox source/head authority remains separate.`);
