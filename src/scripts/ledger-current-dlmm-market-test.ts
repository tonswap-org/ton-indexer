import { freshMasterchainBlock } from '../data/freshRead';
import { proofBlock, proofMasterchain } from './support/fakeLiteEngine';
import { validateCurrentMarketHead } from '../ledger/currentDlmmMarketPrecision';
import assert from 'node:assert/strict';
import { currentDlmmSpotOriginals,currentDlmmMarketOriginals } from './support/currentDlmmFixture';
import { currentDlmmMarketFixture } from './support/currentDlmmMarketFixture';
import { projectCurrentDlmmMarket,validateCurrentDlmmMarketProjection,validateCurrentDlmmMarketObservation, CURRENT_MARKET_PROOF_BYTES, CURRENT_MARKET_GRAPH_BYTES } from '../ledger/currentDlmmMarketProjection';
import { decodeSwapEvent } from '../ledger/currentDlmmState';
import { verifyCurrentT3Transaction } from '../ledger/currentDlmmPhysical';
let cases=0,observations=0;
for(const c of currentDlmmMarketOriginals()){
 const f=currentDlmmMarketFixture(c),p=f.projection;console.log(c.file,JSON.stringify({candidates:p.candidates.map(x=>({status:x.status,issues:x.issues})),precision:p.observations.map(x=>[x.assetPrecision.input.status,x.assetPrecision.output.status,x.assetPrecision.input.issues,x.assetPrecision.output.issues])}));
 assert.equal(p.candidates.filter(x=>x.status==='unresolved').length,0,c.file);const successful=f.evidence.map(verifyCurrentT3Transaction).filter((t:any)=>t.account===f.binding.pool).flatMap((t:any)=>t.tx.outMessages.values().flatMap((m:any)=>{const e=m.info.type==='external-out'?decodeSwapEvent(m.body):null;return e&&e.status===0?[e]:[];}));assert.equal(p.observations.length,successful.length,c.file);validateCurrentDlmmMarketProjection(p);
 for(const o of p.observations){assert.equal(o.assetPrecision.input.status,'resolved');assert.equal(o.assetPrecision.output.status,'resolved');assert.equal(o.finalizedUtime,o.deliveredUtime);assert.equal(BigInt(o.fees.grossT3Raw),BigInt(o.fees.protocolT3Raw)+BigInt(o.fees.lpT3Raw));
  for(const hash of [o.input.request.hash,o.input.debit.hash,o.input.credit.hash,o.output.credit.hash]){const missing=projectCurrentDlmmMarket(f.binding,f.evidence.filter((e:any)=>verifyCurrentT3Transaction(e).hash!==hash),f.wallets,f.dependencies,f.seqnos,f.archives,f.anchors);assert(!missing.observations.some(x=>x.id===o.id));}
  const forged=structuredClone(o);forged.outputRaw=String(BigInt(forged.outputRaw)+1n);assert.throws(()=>validateCurrentDlmmMarketObservation(forged,f.binding));const absent=projectCurrentDlmmMarket(f.binding,f.evidence,f.wallets,f.dependencies,f.seqnos,new Map(),f.anchors);assert.equal(absent.observations.find(x=>x.id===o.id)!.assetPrecision.input.status,'unresolved');assert.equal(absent.historyComplete,false);observations++;
 }cases++;
}
assert.equal(cases,20);assert(observations>=20);console.log(`Current DLMM market ${cases} native worlds, ${observations} physical trades passed with original request/debit/credit, exact fee allocation, precision and missing-evidence refusals. Mock archive brackets are explicitly synthetic.`);

const offchain=currentDlmmMarketFixture(currentDlmmSpotOriginals()[0]).projection;assert(offchain.observations.length>0);assert(offchain.observations.some(o=>o.assetPrecision.input.status==='unresolved'||o.assetPrecision.output.status==='unresolved'));assert.equal(offchain.historyComplete,false);console.log('Original off-chain-only T3 metadata remains explicitly unresolved.');

const final=currentDlmmMarketFixture(currentDlmmMarketOriginals().find(c=>c.file==='order-0-filled-default.json')),original=final.projection.observations[0];
const reject=(edit:(o:typeof original)=>void)=>{const o=structuredClone(original);edit(o);assert.throws(()=>validateCurrentDlmmMarketObservation(o,final.binding));};
reject(o=>{o.proof.executionSeqno++;for(const p of Object.values(o.assetPrecision)){p.archive!.executionSeqno++;p.archive!.before.seqno++;p.archive!.after.seqno++;}});
reject(o=>{o.proof.executionAnchor!.masterchain.rootHashHex='e'.repeat(64);});
reject(o=>{o.proof.executionAnchor!.afterShardAccountBoc=o.proof.transactions[0].beforeShardAccountBoc;});
reject(o=>{o.proof.executionAnchor!.shard.genUtime=o.acceptance.utime-1;});
reject(o=>{o.proof.executionAnchor!.shard.genUtime=o.proof.executionAnchor!.masterchain.utime+1;});
reject(o=>{o.assetPrecision.input.archive!.after.state.sourceMasterchain!.fileHashHex='e'.repeat(64);});
reject(o=>{o.assetPrecision.input.archive!.before.state.sourceMasterchain!.seqno--;});
reject(o=>{o.assetPrecision.input.archive!.before.state.sourceMasterchain!.utime=o.proof.executionAnchor!.masterchain.utime+1;});
reject(o=>{o.assetPrecision.input.archive!.after.state.anchor!.shardBlock.shard='invalid';});
reject(o=>{o.proof.executionAnchor!.shard.shardBlock.shard=BigInt('0x'+o.pool.slice(2,18))<(1n<<63n)?'-4611686018427387904':'4611686018427387904';});
reject(o=>{o.assetPrecision.input.archive!.before.state.codeBoc='!'.repeat(8*1024*1024+1);});
reject(o=>{o.proof.transactions[0].transactionBoc='!'.repeat(CURRENT_MARKET_PROOF_BYTES+1);});
assert.throws(()=>projectCurrentDlmmMarket(final.binding,[{...final.evidence[0],transactionBoc:'!'.repeat(CURRENT_MARKET_GRAPH_BYTES+1)}],final.wallets,final.dependencies,final.seqnos,final.archives,final.anchors),/byte bound/);
assert.throws(()=>projectCurrentDlmmMarket(final.binding,new Array(10001).fill(null),final.wallets,final.dependencies,final.seqnos,final.archives,final.anchors),/graph bound/);
const unanchored=projectCurrentDlmmMarket(final.binding,final.evidence,final.wallets,final.dependencies,final.seqnos,final.archives);assert(unanchored.observations.length>0);assert(unanchored.observations.every(o=>o.assetPrecision.input.status==='unresolved'));assert.equal(unanchored.historyComplete,false);
console.log('Configured-source execution anchors, independent shard/masterchain identities, foreign/malformed/time/size negatives and missing-context precision refusals passed.');

const formatShard=proofBlock(80,1700000000),formatMaster=proofMasterchain(100,1700000001,formatShard);const sourceFormat={...freshMasterchainBlock(formatMaster.id),utime:1700000001};assert.equal(sourceFormat.shard,'-9223372036854775808');validateCurrentMarketHead(sourceFormat);assert.throws(()=>validateCurrentMarketHead({...sourceFormat,shard:'8000000000000000'}));console.log('Actual freshMasterchainBlock source format accepted; invented hexadecimal shard context refused.');
