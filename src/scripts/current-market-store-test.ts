import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { PostgresMarketStore, MarketCursorError, MarketPublicationConflict, marketProjectionFingerprint, validateMarketProjection } from '../ledger/marketStore';
import type { CurrentDlmmMarketProjection } from '../ledger/currentDlmmMarketTypes';
import type { LedgerSqlClient, LedgerSqlPool } from '../ledger/store';
import { currentDlmmOrderOriginals, currentDlmmMarketOriginals } from './support/currentDlmmFixture';
import { currentDlmmMarketFixture } from './support/currentDlmmMarketFixture';

type Projection = CurrentDlmmMarketProjection;
function changed(p:Projection, issue:string) { const q=structuredClone(p); q.issues.push(issue);q.historyComplete=false;return q; }
/** The optional callback is supplied only by the owned native lifecycle runner.
 * Its delegating pool must reconnect after the authenticated postmaster restart. */
export async function runCurrentMarketStoreSuite(pool:LedgerSqlPool,label:string,restart?:()=>Promise<void>) {
  const historicalNative=currentDlmmOrderOriginals().find(c=>c.file==='order-0-filled-default.json');
  const unresolved=currentDlmmMarketFixture(historicalNative).projection;
  assert.equal(unresolved.observations.length,3,'off-chain-only metadata does not erase original physical trades');
  assert.equal(unresolved.historyComplete,false);assert(unresolved.observations.some(o=>o.assetPrecision.input.status==='unresolved'||o.assetPrecision.output.status==='unresolved'));
  validateMarketProjection(unresolved);
  const native=currentDlmmMarketOriginals().find(c=>c.file==='order-0-filled-default.json');
  assert(native,'retained default filled Order world');
  const p=currentDlmmMarketFixture(native).projection;
  assert.equal(p.schema,'dlmm-market-ledger-v2');assert.equal(p.observations.length,3);assert.equal(p.candidates.length,3);
  assert.equal(p.historyComplete,true);validateMarketProjection(p);
  const malformed:Array<[string,(q:Projection)=>void]>=[
    ['unknown schema',q=>{q.schema='invalid' as never;}],
    ['foreign network',q=>{q.binding.network='mainnet';}],
    ['foreign pool',q=>{q.binding.pool=`0:${'b'.repeat(64)}`;}],
    ['legacy field',q=>{Object.assign(q.binding,{walletCodeHash:'a'.repeat(64)});}],
    ['missing original',q=>{q.observations[0].proof.transactions.pop();}],
    ['forged output',q=>{q.observations[0].outputRaw=String(BigInt(q.observations[0].outputRaw)+1n);}],
    ['forged finality',q=>{q.observations[0].finalizedUtime++;}],
    ['numeric input',q=>{q.observations[0].paidInputRaw=1 as never;}],
    ['forged fee',q=>{q.observations[0].fees.lpT3Raw='9007199254740993123';}],
    ['ratio',q=>{q.observations[0].ratio.denominator='0';}],
    ['missing source dependency',q=>{q.dependencies=q.dependencies.filter(d=>d.account!==q.observations[0].input.debit.account);}],
    ['duplicate dependency',q=>{q.dependencies.push(q.dependencies[0]);}],
    ['malformed generation',q=>{q.dependencies[0].generation='-'.repeat(36);}],
    ['overflow LT',q=>{q.dependencies[0].headLt=(1n<<64n).toString();}],
    ['zero head with hash',q=>{q.dependencies[0].headLt='0';q.dependencies[0].headHash='a'.repeat(64);}],
    ['wrong equal-LT head',q=>{const r=q.observations[0].acceptance,d=q.dependencies.find(d=>d.account===r.account)!;d.headLt=r.lt;d.headHash='a'.repeat(64);}],
    ['old checked-through',q=>{q.dependencies.forEach(d=>{d.checkedThrough='2020-01-01T00:00:00.000Z';});}],
    ['false history complete',q=>{q.dependencies[0].historyComplete=false;}],
    ['duplicate observation',q=>{q.observations.push(q.observations[0]);}],
    ['duplicate candidate',q=>{q.candidates.push(q.candidates[0]);}],
    ['missing candidate',q=>{q.candidates.pop();}],
    ['forged refund',q=>{q.candidates[0].status='refunded';q.candidates[0].observationId=null;}],
    ['absent candidate proof',q=>{q.candidates[0].proof=null;}],
    ['candidate issue',q=>{q.candidates[0].issues=['false-settled'];}],
    ['sparse dependencies',q=>{delete q.dependencies[0];}],
    ['sparse observations',q=>{delete q.observations[0];}],
    ['sparse candidates',q=>{delete q.candidates[0];}],
  ];
  for(const [name,mutate] of malformed){const q=structuredClone(p);mutate(q);assert.throws(()=>validateMarketProjection(q),Error,name);}
  const store=new PostgresMarketStore<Projection>(pool, 'dlmm-market-ledger-v2');await store.initialize();await store.initialize();
  const {network,pool:address}=p.binding,before=JSON.stringify(p),reversed=structuredClone(p);
  reversed.dependencies.reverse();reversed.observations.reverse();reversed.candidates.reverse();
  assert.equal(marketProjectionFingerprint(p),marketProjectionFingerprint(reversed));
  assert.equal((await store.page(network,address)).coverage,null);
  const first=await store.publish(p,null),same=await store.publish(reversed,null);assert.equal(first.generation,same.generation);assert(same.reused);assert.equal(JSON.stringify(p),before);
  await assert.rejects(()=>store.publish({schema:'dlmm-market-ledger-v1'} as never,first.generation),/admitted schema/,'current publication rejects v1 before archived validation');
  const admittedMetadata=(await pool.query('SELECT metadata FROM market_generations WHERE generation=$1',[first.generation])).rows[0].metadata;
  const oldSchema={...admittedMetadata,schema:'dlmm-market-ledger-v1',binding:null};
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[first.generation,JSON.stringify(oldSchema)]);
  await assert.rejects(()=>store.current(network,address),/admitted schema/);
  await assert.rejects(()=>store.page(network,address,{generation:first.generation}),/admitted schema/,'explicit generation cannot bypass schema admission');
  await assert.rejects(()=>store.candidatesPage(network,address,{generation:first.generation}),/admitted schema/);
  await assert.rejects(()=>store.publish(changed(p,'refuse-namespace-migration'),first.generation),/admitted schema/,'locked prior head prevents migration into a current namespace');
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[first.generation,JSON.stringify(admittedMetadata)]);
  await assert.rejects(()=>new PostgresMarketStore(pool,'dlmm-market-ledger-v1').page(network,address),/admitted schema/,'explicit historical store also cannot reinterpret a current namespace');
  const firstPage=await store.page(network,address,{limit:1});assert(firstPage.nextCursor);assert.equal(firstPage.coverage!.schema,'dlmm-market-ledger-v2');assert.deepEqual(firstPage.coverage!.candidateCounts,{settled:3,refunded:0,unresolved:0});
  const q=changed(p,'new-original-check'),second=await store.publish(q,first.generation);
  const all=[...firstPage.observations];let cursor:string|null=firstPage.nextCursor;
  while(cursor){const page=await store.page(network,address,{limit:1,cursor});assert.equal(page.coverage!.generation,first.generation);assert.equal(page.coverage!.historyComplete,true);all.push(...page.observations);cursor=page.nextCursor;}
  assert.deepEqual(all.sort((a,b)=>a.id.localeCompare(b.id)),[...p.observations].sort((a,b)=>a.id.localeCompare(b.id)));
  const cp=await store.candidatesPage(network,address,{generation:first.generation,limit:1});assert(cp.nextCursor);const candidates=[...cp.candidates];cursor=cp.nextCursor;
  while(cursor){const page=await store.candidatesPage(network,address,{limit:1,cursor});candidates.push(...page.candidates);cursor=page.nextCursor;}
  assert.deepEqual(candidates.sort((a,b)=>a.id.localeCompare(b.id)),[...p.candidates].sort((a,b)=>a.id.localeCompare(b.id)));
  await store.publish(p,first.generation);assert.equal((await store.current(network,address))!.generation,second.generation,'old idempotent publication never rewinds latest');
  const t=Math.min(...p.observations.map(o=>o.executionUtime));
  assert.equal((await store.page(network,address,{generation:first.generation,from:t,to:t+1})).observations.length,p.observations.filter(o=>o.executionUtime===t).length);
  const cursorCases:Array<[string,()=>Promise<unknown>]>=[
    ['network',()=>store.page('testnet',address,{cursor:firstPage.nextCursor!})],
    ['pool',()=>store.page(network,`0:${'d'.repeat(64)}`,{cursor:firstPage.nextCursor!})],
    ['from',()=>store.page(network,address,{from:t,cursor:firstPage.nextCursor!})],
    ['to',()=>store.page(network,address,{to:t+1,cursor:firstPage.nextCursor!})],
    ['generation',()=>store.page(network,address,{generation:second.generation,cursor:firstPage.nextCursor!})],
    ['list',()=>store.candidatesPage(network,address,{cursor:firstPage.nextCursor!})],
    ['missing generation',()=>store.page(network,address,{generation:randomUUID()})],
    ['malformed cursor',()=>store.page(network,address,{cursor:'broken'})],
    ['missing cursor position',()=>{const c=JSON.parse(Buffer.from(firstPage.nextCursor!,'base64url').toString());c.id='0'.repeat(64);return store.page(network,address,{cursor:Buffer.from(JSON.stringify(c)).toString('base64url')});}],
    ['fractional time',()=>store.page(network,address,{from:1.5})],
    ['negative time',()=>store.page(network,address,{from:-1})],
    ['reversed range',()=>store.page(network,address,{from:t,to:t})],
    ['unbounded limit',()=>store.page(network,address,{limit:501})],
  ];for(const [name,run] of cursorCases)await assert.rejects(run,MarketCursorError,name);
  const race=await Promise.allSettled([store.publish(changed(q,'race-a'),second.generation),store.publish(changed(q,'race-b'),second.generation)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected'&&r.reason instanceof MarketPublicationConflict).length,1);
  const head=(await store.current(network,address))!,identical=changed(q,'same-race'),dupes=await Promise.all([store.publish(identical,head.generation),store.publish(identical,head.generation)]);
  assert.equal(dupes[0].generation,dupes[1].generation);assert.equal(dupes.filter(x=>x.reused).length,1);
  let fail=true;const injected:LedgerSqlPool={query:pool.query.bind(pool),end:async()=>{},connect:async()=>{const c=await pool.connect();return{release:()=>c.release?.(),query:async(sql,params)=>{if(fail&&sql.startsWith('INSERT INTO market_observations')){fail=false;throw Error('injected observation failure');}return c.query(sql,params);}};}};
  const count=(await pool.query('SELECT count(*)::int AS n FROM market_generations')).rows[0].n;
  await assert.rejects(()=>new PostgresMarketStore<Projection>(injected, 'dlmm-market-ledger-v2').publish(changed(q,'rollback'),dupes[0].generation),/injected/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_generations')).rows[0].n,count);assert.equal((await store.current(network,address))!.generation,dupes[0].generation);
  const incomplete=changed(p,'missing-original');incomplete.observations=[];for(const c of incomplete.candidates){c.status='unresolved';c.observationId=null;c.proof=null;c.issues=['missing-original'];}
  const inc=await store.publish(incomplete,dupes[0].generation),empty=await store.page(network,address);assert.equal(empty.observations.length,0);assert.equal(empty.coverage!.historyComplete,false);assert.deepEqual(empty.coverage!.candidateCounts,{settled:0,refunded:0,unresolved:3});
  const metadata=(await pool.query('SELECT metadata FROM market_generations WHERE generation=$1',[inc.generation])).rows[0].metadata;
  const corrupt=structuredClone(metadata);corrupt.dependencies[0].checkedThrough='not-a-date';
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[inc.generation,JSON.stringify(corrupt)]);
  await assert.rejects(()=>store.page(network,address),/Invalid market projection/);
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[inc.generation,JSON.stringify(metadata)]);
  const o=p.observations[0],bad=structuredClone(o);bad.outputRaw='1';
  await pool.query('UPDATE market_observations SET observation=$3::jsonb WHERE generation=$1 AND observation_id=$2',[first.generation,o.id,JSON.stringify(bad)]);
  await assert.rejects(()=>store.page(network,address,{generation:first.generation}),/Current market/);
  await pool.query('UPDATE market_observations SET observation=$3::jsonb WHERE generation=$1 AND observation_id=$2',[first.generation,o.id,JSON.stringify(o)]);
  const oldMetadata=(await pool.query('SELECT metadata FROM market_generations WHERE generation=$1',[first.generation])).rows[0].metadata,uncovered=structuredClone(oldMetadata);
  uncovered.dependencies=uncovered.dependencies.filter((d:{account:string})=>d.account!==o.input.debit.account);
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[first.generation,JSON.stringify(uncovered)]);
  await assert.rejects(()=>store.page(network,address,{generation:first.generation}),/stored evidence outside dependency coverage/);
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[first.generation,JSON.stringify(oldMetadata)]);
  const refundNative=currentDlmmMarketOriginals().find(c=>c.file==='spot-0-refund-default.json'),refund=currentDlmmMarketFixture(refundNative).projection;
  assert.equal(refund.observations.length,1,'original successful trade preceding the refund remains a separate observation');assert.equal(refund.candidates.filter(c=>c.status==='refunded').length,1);
  const prior=await store.current(refund.binding.network,refund.binding.pool),r=await store.publish(refund,prior?.generation??null),rp=await store.candidatesPage(refund.binding.network,refund.binding.pool,{generation:r.generation});
  assert.deepEqual(rp.candidates.sort((a,b)=>a.id.localeCompare(b.id)),[...refund.candidates].sort((a,b)=>a.id.localeCompare(b.id)));const originalRefund=refund.candidates.find(c=>c.status==='refunded')!,rc=structuredClone(originalRefund);rc.proof=null;
  await pool.query('UPDATE market_candidates SET candidate=$3::jsonb WHERE generation=$1 AND candidate_id=$2',[r.generation,rc.id,JSON.stringify(rc)]);
  await assert.rejects(()=>store.candidatesPage(refund.binding.network,refund.binding.pool,{generation:r.generation}),/Current market/);
  await pool.query('UPDATE market_candidates SET candidate=$3::jsonb WHERE generation=$1 AND candidate_id=$2',[r.generation,originalRefund.id,JSON.stringify(originalRefund)]);
  const saved={
    cursorPage:await store.page(network,address,{limit:1,cursor:firstPage.nextCursor!}),
    latestHead:await store.current(network,address),
    refundPage:await store.candidatesPage(refund.binding.network,refund.binding.pool,{generation:r.generation}),
  };
  if(restart)await restart();
  const resumed=new PostgresMarketStore<Projection>(pool,'dlmm-market-ledger-v2');
  assert.deepEqual(await resumed.page(network,address,{limit:1,cursor:firstPage.nextCursor!}),saved.cursorPage,'exact original generation cursor page survives');
  assert.deepEqual(await resumed.current(network,address),saved.latestHead,'latest head identity and timestamp survive');
  assert.deepEqual(await resumed.candidatesPage(refund.binding.network,refund.binding.pool,{generation:r.generation}),saved.refundPage,'exact proved refund page survives');
  assert.equal((await resumed.page(network,address,{generation:first.generation})).observations.length,3);
  console.log(`${label}: current v2 market store: 3 original trades plus proved refund; ${malformed.length} admission negatives; ${cursorCases.length} cursor negatives; immutable pagination, original revalidation, missing coverage, concurrency, rollback and ${restart?'owned postmaster restart':'store re-instantiation'} passed.`);
}
async function main(){
  const db=new PGlite();let tail:Promise<void>=Promise.resolve();
  const acquire=async()=>{const old=tail;let unlock!:()=>void;tail=new Promise<void>(resolve=>{unlock=resolve;});await old;return unlock;};
  const query=async(sql:string,params?:unknown[])=>!params&&sql.includes(';')?{rows:(await db.exec(sql)).at(-1)?.rows??[]}:db.query(sql,params);
  const pool:LedgerSqlPool={query:async(sql,params)=>{const unlock=await acquire();try{return await query(sql,params);}finally{unlock();}},connect:async()=>{const unlock=await acquire();return{query,release:unlock} as LedgerSqlClient;},end:()=>db.close()};
  try{await runCurrentMarketStoreSuite(pool,'Embedded PostgreSQL serialized session');}finally{await pool.end();}
  const connectionString=process.env.INDEXER_TEST_DATABASE_URL;
  if(connectionString){
    if(!['127.0.0.1','localhost','[::1]'].includes(new URL(connectionString).hostname))throw Error('Current market native tests require loopback PostgreSQL');
    const schema='current_market_store_'+randomUUID().replace(/-/g,''),admin=new Pool({connectionString,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(connectionString);url.searchParams.set('options',`-c search_path=${schema}`);
    const native=new Pool({connectionString:url.toString(),max:8});
    try{await runCurrentMarketStoreSuite(native as unknown as LedgerSqlPool,'Native PostgreSQL independent connections');}
    finally{await native.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  }else console.log('Native PostgreSQL not requested; embedded serialization does not qualify independent connection locking. Synthetic fixture archive/head brackets do not qualify public consensus.');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
