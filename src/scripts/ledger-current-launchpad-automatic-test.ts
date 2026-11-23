import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verifyLaunchpadTransaction, currentLaunchpadBindingFromManifest, launchpadChild } from '../ledger/currentLaunchpadProof';
import { decodeCurrentLaunchpadOperations } from '../ledger/currentLaunchpad';
import { LP_SEED_REPLY, readSeedPreview } from '../ledger/currentLaunchpadSeed';
import { decodeLaunchLp } from '../ledger/currentLaunchpadState';
import { readCurrentDlmmPool } from '../ledger/currentDlmmState';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { OrderTransactionEvidence } from '../orders/evidence';

const original=brotliDecompressSync(readFileSync(join(__dirname,'fixtures/current-launchpad-lp-v2/ordinary.json.br')));
assert.equal(createHash('sha256').update(original).digest('hex'),'f916777f0acb4f3904d03c6e215fc77190305f383d1b338410f7330e927dbb39');
const snapshot=JSON.parse(original.toString()) as {schema:string;accounts:Record<string,string>;records:OrderTransactionEvidence[]};
assert.equal(snapshot.schema,'tonswap.native-lp-seed.v1');
const a=snapshot.accounts,ev=snapshot.records,txs=ev.map(verifyLaunchpadTransaction);
const state=(address:string)=>{
 for(const tx of txs)if(tx.account===address&&tx.after.account?.storage.state.type==='active'){const s=tx.after.account.storage.state.state;return{code:s.code!,data:s.data!};}
 throw Error('Missing original account '+address);
};
const code=(address:string)=>state(address).code.hash().toString('hex');
const pool=readCurrentDlmmPool(state(a.pool).data,a.pool);
const pins=JSON.parse(readFileSync(join(__dirname,'fixtures/current-launchpad-lp-v2/build.json'),'utf8')) as {buildHash:string;templates:Record<string,string>};
const release={schema:'tonswap-release-v2',contracts:Object.fromEntries(Object.entries({SaleFactory:a.saleFactory,T3Hub:a.t3,Governance:a.governance,FeeRouter:a.relay,GasVault:a.vault,Treasury:a.treasury,DlmmPoolFactory:pool.factory}).map(([role,address])=>[role,{address,codeHash:code(address)}])),
 templates:pins.templates,tokens:[{symbol:'T3',root:a.t3,decimals:9,masterCodeHash:code(a.t3),walletCodeHash:pins.templates.T3Wallet},{symbol:'project',root:a.project,decimals:9,masterCodeHash:code(a.project),walletCodeHash:pins.templates.JettonV21Wallet}],spotMarkets:[]} as unknown as RuntimeReleaseManifest;
const b=currentLaunchpadBindingFromManifest(release);
const ops=decodeCurrentLaunchpadOperations(a.beneficiary,b,ev).map(r=>r.economics).filter(row=>row.kind==='lp-seed-automatic');
console.log('Observed canonical automatic operations',ops.map(o=>[o.outcome,o.lpSeed?.side,o.issues,o.lpShares.length]));
assert.equal(ops.length,2);assert(ops.every(o=>o.outcome==='delivered'&&o.lpShares.length===1&&o.lpShares[0].owner===a.lp&&o.lpSeed?.beneficiary===a.beneficiary&&o.lpSeed.unlockAt>0));
assert.deepEqual(ops.map(o=>o.lpSeed!.side).sort(),[0,1]);
assert.equal(ops.flatMap(o=>o.lpShares).reduce((sum,p)=>sum+BigInt(p.deltaRaw),0n),182849633221857936052411147034n);
assert(ops.every(o=>Object.keys(o.paidIn).length===0&&Object.keys(o.paidOut).length===0&&o.cash.every(c=>c.from===a.lp&&c.to===a.pool)));
const withoutAck=ev.filter((_,i)=>{const msg=txs[i].tx.inMessage;return !(txs[i].account===a.lp&&msg&&msg.body.bits.length>=32&&msg.body.beginParse().preloadUint(32)===0x4c514f33);});
const partial=decodeCurrentLaunchpadOperations(a.beneficiary,b,withoutAck).map(r=>r.economics).filter(row=>row.kind==='lp-seed-automatic');
assert.equal(partial.length,2);assert(partial.every(o=>o.outcome!=='delivered'));
const unrelated=decodeCurrentLaunchpadOperations(a.treasury,b,ev).filter(o=>o.economics.kind==='lp-seed-automatic');assert.equal(unrelated.length,0);

const refused=txs.filter(t=>{
  const m=t.tx.inMessage;return t.account===a.lp&&t.succeeded&&m&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===LP_SEED_REPLY&&!readSeedPreview(m.body,LP_SEED_REPLY).allowed;
});
assert.equal(refused.length,1);
const at=refused[0];
assert.equal(decodeLaunchLp(launchpadChild(at,b)).automation!.fund,decodeLaunchLp(launchpadChild(at,b,true)).automation!.fund);
assert(!at.tx.outMessages.values().some(m=>m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===0x0f8a7ea5));
const lostRelay=ev.filter((_,i)=>txs[i].account!==a.relay);
const unlinked=decodeCurrentLaunchpadOperations(a.beneficiary,b,lostRelay).map(r=>r.economics).filter(row=>row.kind==='lp-seed-automatic');
assert.equal(unlinked.length,2);assert(unlinked.every(row=>row.outcome==='unresolved'&&row.lpShares.length===0));
const withdrawal=txs.find(t=>{const m=t.tx.inMessage;return t.account===a.lp&&t.succeeded&&m&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===0x4c56524c;});
assert(withdrawal?.tx.inMessage?.info.type==='internal');
const sponsor=withdrawal.tx.inMessage.info.src.toRawString();assert.notEqual(sponsor,a.beneficiary);
const releaseOp=decodeCurrentLaunchpadOperations(sponsor,b,ev).map(r=>r.economics).find(row=>row.kind==='lp-release'&&row.outcome==='delivered');
assert(releaseOp);assert(releaseOp.lpShares.every(s=>s.owner===a.lp&&s.afterRaw==='0'));
assert(releaseOp.cash.length>0&&releaseOp.cash.every(c=>c.to===a.beneficiary));assert.deepEqual(releaseOp.paidOut,{});
console.log('Authenticated two ordinary seed receipts, a refused preview, both missing-acknowledgement cases and fixed-beneficiary withdrawal.');
