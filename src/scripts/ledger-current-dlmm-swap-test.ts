import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { decodeCurrentDlmmOperations } from '../ledger/currentDlmmEconomics';
import { verifyCurrentT3Transaction, type CurrentDlmmProofBinding } from '../ledger/currentDlmmPhysical';
import { currentDlmmSpotOriginals,currentDlmmFixtureBinding } from './support/currentDlmmFixture';
let checks=0;
for(const c of currentDlmmSpotOriginals()){
 const b=currentDlmmFixtureBinding(c),p=c.request,select=(rows:any[])=>decodeCurrentDlmmOperations(p.owner,b,rows).find(o=>o.request.bodyHash===p.bodyHash&&o.request.dispatch.hash===p.dispatch.hash);
 const selected=select(c.completeTransactions);assert(selected,c.file);const e=selected.economics;
 console.log(c.file,JSON.stringify({proof:selected.proof,economics:e}));assert.equal(e.outcome,c.refund?'refunded':'delivered');assert.equal(e.paidInRaw,p.amountRaw);
 const root=c.refund?b.pools[0][p.side===0?'t3':'x'].root:b.pools[0][p.side===0?'x':'t3'].root;
 assert.equal(root===b.pools[0].t3.root?e.paidOutT3Raw:e.paidOutXRaw,c.refund?p.amountRaw:c.expectedOutput);assert.equal(e.cash.length,2);assert.equal(e.shares.length,0);
 assert.equal(e.grossFeeT3Raw,c.expectedGrossFeeT3);assert.equal(e.protocolFeeT3Raw,c.expectedProtocolFeeT3);assert.equal(BigInt(e.grossFeeT3Raw),BigInt(e.protocolFeeT3Raw)+BigInt(e.lpFeeT3Raw));
 const incoming=e.cash.find(c=>c.direction==='in')!,missing=select(c.completeTransactions.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==incoming.creditTransaction))!;assert.equal(missing.economics.outcome,'unresolved');assert.equal(missing.economics.cash.filter(c=>c.direction==='in').length,0);
 assert.equal(select(c.completeTransactions.filter((r:any)=>verifyCurrentT3Transaction(r).hash!==p.dispatch.hash)),undefined);checks++;
}
assert.equal(checks,8);
// The retained older transport fixture deliberately lacks the original owner
// transaction. Never manufacture it from the source wallet incoming message.
const archive=JSON.parse(gunzipSync(readFileSync(join(__dirname,'fixtures/current-dlmm-native/spot-transport.json.gz'))).toString());let missingDispatch=0;
for(const c of archive.cases){if(c.request.kind!=='direct'||!c.manifest)continue;const m=c.manifest,market=m.spotMarkets.find((x:any)=>x.pool===c.request.pool),t3=m.tokens.find((t:any)=>t.symbol==='T3'),x=m.tokens.find((t:any)=>t.root!==t3.root&&(t.root===c.request.payRoot||t.root===c.request.receiveRoot));assert(market&&t3&&x);
 const wallets=Object.entries(c.response.wallets).map(([role,address])=>({address:address as string,owner:role.startsWith('pool')?c.request.pool:c.request.owner,root:/Pay$|^pay$/.test(role)?c.request.payRoot:c.request.receiveRoot,codeHash:(/Pay$|^pay$/.test(role)?c.request.payRoot:c.request.receiveRoot)===t3.root?t3.walletCodeHash:x.walletCodeHash}));
 const b:CurrentDlmmProofBinding={release:m,pools:[{pool:c.request.pool,market,t3,x,wallets}]};assert.equal(decodeCurrentDlmmOperations(c.request.owner,b,c.response.transactions).find(o=>o.request.bodyHash===c.request.bodyHash),undefined);missingDispatch++;
}
assert(missingDispatch>=8);console.log(`Current DLMM ${checks} production native Spot cases and ${missingDispatch} historical missing-owner negatives passed, with missing-credit refusals. Sandbox heads remain explicitly synthetic.`);
