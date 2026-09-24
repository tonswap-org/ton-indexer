import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { PostgresMarketStore, MarketCursorError, MarketPublicationConflict, marketProjectionFingerprint, validateMarketProjection } from '../ledger/marketStore';
import { projectDlmmMarket } from '../ledger/marketProjection';
import type { MarketProjection, MarketNode, DlmmMarketBinding, MarketDependency } from '../ledger/marketTypes';
import type { LedgerSqlPool, LedgerSqlClient } from '../ledger/store';

function actualProjection(): MarketProjection {
  const f=JSON.parse(readFileSync(resolve(__dirname,'fixtures/dlmm-referral-market-current/dlmm-market-settlements.json'),'utf8'));
  const binding:DlmmMarketBinding={ router: null, routerCodeHash: null,network:'localnet',pool:f.accounts.pool,tokenT:f.accounts.tokenT,tokenX:f.accounts.tokenX, tokenTCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash, tokenXCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash,
    poolCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
    walletCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash};
  const nodes:MarketNode[]=f.transactions.map((t:{account:string;raw:MarketNode['raw']})=>{
    const b=f.boundaries.find((b:{account:string;transactionLt:string;transactionHash:string})=>b.account===t.account && b.transactionLt===t.raw.lt && b.transactionHash===t.raw.hash);
    return {account:t.account,raw:t.raw,before:{seqno:0,state:{...b.before,accountState:b.before.accountState==='uninit'?'uninitialized':b.before.accountState}},after:{seqno:0,state:b.after}};
  });
  const heads=new Map<string,MarketNode>(); for(const n of nodes) if(!heads.has(n.account)||BigInt(heads.get(n.account)!.raw.lt)<BigInt(n.raw.lt)) heads.set(n.account,n);
  const dependencies:MarketDependency[]=[...heads].map(([account,n])=>({account,generation:randomUUID(),historyComplete:true,headLt:n.raw.lt,headHash:n.raw.hash,checkedThrough:new Date((n.raw.utime+60)*1000).toISOString()}));
  return projectDlmmMarket(binding,nodes,dependencies);
}
function changed(p:MarketProjection, marker:string):MarketProjection { const q=structuredClone(p); q.issues.push(marker); q.historyComplete=false; return q; }
function mismatchReferencedHead(q:MarketProjection) {
      // A later independent fee finalizer need not appear in user trade evidence.
      // Place the adversarial head at the latest referenced pool boundary so
      // this specifically tests equal-LT hash binding, not unrelated later state.
      const refs:Array<{account:string;lt:string;hash:string}>=[];
      const visit=(value:any):void=>{if(!value||typeof value!=='object')return;if(value.account===q.binding.pool&&typeof value.lt==='string'&&typeof value.hash==='string')refs.push(value);Object.values(value).forEach(visit);};
      visit(q.observations);visit(q.candidates);
      const latest=refs.reduce((a,b)=>BigInt(a.lt)>BigInt(b.lt)?a:b);
      const dep=q.dependencies.find(d=>d.account===q.binding.pool)!;dep.headLt=latest.lt;dep.headHash='a'.repeat(64);
}
function badProjectionCases(p:MarketProjection) {
  const mutations:Array<[string,(q:MarketProjection)=>void]>=[
    ['schema',q=>{q.schema='old' as never;}],
    ['foreign binding',q=>{q.binding.network='mainnet';}],
    ['noncanonical account',q=>{q.binding.pool=q.binding.pool.toUpperCase();}],
    ['code hash',q=>{q.binding.poolCodeHash='bad';}],
    ['code binding mismatch',q=>{q.binding.poolCodeHash='a'.repeat(64);}],
    ['head hash mismatch at referenced boundary',mismatchReferencedHead],
    ['missing debit boundary',q=>{q.observations[0].input.boundaries=q.observations[0].input.boundaries.filter(b=>b.transaction.account!==q.observations[0].input.debit.account);}],
    ['uninitialized debit',q=>{const b=q.observations[0].input.boundaries.find(b=>b.transaction.account===q.observations[0].input.debit.account)!;b.beforeAccountState='uninitialized';b.beforeDataHash=null;}],
    ['same root',q=>{q.binding.tokenT=q.binding.tokenX;}],
    ['observation ID',q=>{q.observations[0].id='a'.repeat(64);}],
    ['candidate ID',q=>{q.candidates[0].id='b'.repeat(64);}],
    ['foreign token',q=>{q.observations[0].inputAsset='testnet:jetton:'+q.binding.tokenT;}],
    ['float time',q=>{q.observations[0].executionUtime+=0.5;}],
    ['negative time',q=>{q.observations[0].acceptance.utime=-1;}],
    ['future execution',q=>{q.observations[0].deliveredUtime=q.observations[0].executionUtime-1;}],
    ['exponent amount',q=>{q.observations[0].paidInputRaw='1e4';}],
    ['numeric amount',q=>{q.observations[0].paidInputRaw=10000 as never;}],
    ['input mismatch',q=>{q.observations[0].consumedInputRaw='9999';}],
    ['negative refund',q=>{q.observations[0].returnedInputRaw='-1';}],
    ['atomic overflow',q=>{q.observations[0].paidInputRaw=(1n<<120n).toString();}],
    ['zero denominator',q=>{q.observations[0].ratio.denominator='0';}],
    ['wrong ratio',q=>{q.observations[0].ratio.numerator='9996';}],
    ['unreduced ratio',q=>{const r=q.observations[0].ratio;r.numerator=(BigInt(r.numerator)*2n).toString();r.denominator=(BigInt(r.denominator)*2n).toString();}],
    ['base64 reference hash',q=>{q.observations[0].input.credit.hash=Buffer.from(q.observations[0].input.credit.hash,'hex').toString('base64');}],
    ['noncanonical LT',q=>{q.observations[0].input.credit.lt='01';}],
    ['settlement amount mismatch',q=>{q.observations[0].settlements[0].amountRaw='9996';}],
    ['request body mismatch',q=>{q.observations[0].settlements[0].requestBodyHash='0'.repeat(64);}],
    ['unknown settlement',q=>{q.observations[0].settlements[0].kind='income' as never;}],
    ['wrong recipient',q=>{q.observations[0].settlements[0].destinationOwner=q.binding.pool;}],
    ['missing dependency',q=>{q.dependencies=q.dependencies.filter(d=>d.account!==q.observations[0].input.debit.account);}],
    ['dependency generation',q=>{q.dependencies[0].generation='previous';}],
    ['duplicate dependency',q=>{q.dependencies.push(q.dependencies[0]);}],
    ['dependency coverage',q=>{q.dependencies.forEach(d=>{d.headLt='1';});}],
    ['dependency date',q=>{q.dependencies[0].checkedThrough='2025-02-30T00:00:00.000Z';}],
    ['old checked-through',q=>{q.dependencies.forEach(d=>{d.checkedThrough='2020-01-01T00:00:00.000Z';});}],
    ['incomplete dependency claimed complete',q=>{q.historyComplete=true;q.dependencies[0].historyComplete=false;}],
    ['duplicate observation',q=>{q.observations.push(q.observations[0]);}],
    ['duplicate candidate',q=>{q.candidates.push(q.candidates[0]);}],
    ['missing observation link',q=>{q.candidates=q.candidates.filter(c=>c.observationId!==q.observations[0].id);}],
    ['unresolved false link',q=>{q.candidates[0].status='unresolved';q.candidates[0].issues=['missing'];}],
    ['duplicate fee',q=>{q.observations[0].fees.push(q.observations[0].fees[0]);}],
    ['numeric fee',q=>{q.observations[0].fees[0].nativeAmountRaw=123 as never;}],
    ['sparse dependency',q=>{delete q.dependencies[0];}],
    ['sparse observation',q=>{delete q.observations[0];}],
    ['sparse candidate',q=>{delete q.candidates[0];}],
    ['null active boundary',q=>{q.observations[0].allocation.beforeDataHash=null;}],
  ];
  for(const [label,mutate] of mutations) { const q=structuredClone(p);mutate(q);assert.throws(()=>validateMarketProjection(q),/Invalid market projection/,label); }
  return mutations.length;
}
async function suite(pool:LedgerSqlPool,label:string) {
  const store=new PostgresMarketStore(pool);await store.initialize();await store.initialize();
  const p=actualProjection(),network=p.binding.network,account=p.binding.pool;
  assert.equal(p.observations.length,5,`actual projector executes full, partial and separately proven funded retry: ${JSON.stringify(p.candidates)}`);
  assert.equal(p.candidates.length,6); assert.equal(p.historyComplete,true); validateMarketProjection(p);
  const malformed=badProjectionCases(p), before=JSON.stringify(p);
  const reversed=structuredClone(p); reversed.observations.reverse();reversed.candidates.reverse();reversed.dependencies.reverse();
  assert.equal(marketProjectionFingerprint(reversed),marketProjectionFingerprint(p),'canonical array order does not create a new generation');
  const fingerprint=marketProjectionFingerprint(p);
  for(const mutate of [(q:MarketProjection)=>{q.dependencies[0].checkedThrough=new Date(Date.parse(q.dependencies[0].checkedThrough)+1000).toISOString();},(q:MarketProjection)=>{q.dependencies[0].generation=randomUUID();},(q:MarketProjection)=>{q.observations[0].fees[0].nativeAmountRaw='9007199254740993';}]) {
    const q=structuredClone(p);mutate(q);assert.notEqual(marketProjectionFingerprint(q),fingerprint,'all binding, source evidence and dependency freshness changes alter identity');
  }
  assert.equal((await store.page(network,account)).coverage,null);
  const first=await store.publish(p,null),same=await store.publish(reversed,null);
  assert.equal(same.generation,first.generation);assert.equal(same.reused,true);assert.equal(JSON.stringify(p),before,'publication preserves raw input');
  const firstPage=await store.page(network,account,{limit:2});assert.equal(firstPage.observations.length,2);assert(firstPage.nextCursor);
  assert.equal(firstPage.coverage!.generation,first.generation);assert.equal(firstPage.coverage!.totalObservations,5);
  assert.deepEqual(firstPage.coverage!.candidateCounts,{settled:5,refunded:1,unresolved:0});
  assert(!Object.hasOwn(firstPage.coverage!,'candidates'));assert(!Object.hasOwn(firstPage.coverage!,'observations'));
  const q=changed(p,'test-new-pinned-evidence'),second=await store.publish(q,first.generation);
  const all=[...firstPage.observations]; let cursor:string|null=firstPage.nextCursor;
  while(cursor) {const page=await store.page(network,account,{limit:2,cursor});assert.equal(page.coverage!.generation,first.generation);assert.equal(page.coverage!.historyComplete,true);all.push(...page.observations);cursor=page.nextCursor;}
  assert.equal(all.length,5);assert.equal(new Set(all.map(o=>o.id)).size,5);assert.deepEqual([...all].sort((a,b)=>a.id.localeCompare(b.id)),[...p.observations].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal((await store.current(network,account))!.generation,second.generation);
  assert.equal((await store.publish(p,first.generation)).generation,first.generation,'existing projection remains retrievable');
  assert.equal((await store.current(network,account))!.generation,second.generation,'idempotent old publication never rewinds latest pointer');
  const candidateFirst=await store.candidatesPage(network,account,{generation:first.generation,limit:2});assert(candidateFirst.nextCursor);const candidates=[...candidateFirst.candidates];cursor=candidateFirst.nextCursor;
  while(cursor) {const page=await store.candidatesPage(network,account,{generation:first.generation,limit:2,cursor});candidates.push(...page.candidates);cursor=page.nextCursor;}
  assert.equal(candidates.length,6);assert.deepEqual(new Set(candidates.map(c=>c.id)),new Set(p.candidates.map(c=>c.id)));
  const t=p.observations[0].executionUtime;
  assert.equal((await store.page(network,account,{generation:first.generation,from:t,to:t+1})).observations.length,1,'half-open window includes the exact first execution second only');
  assert.equal((await store.page(network,account,{generation:first.generation,from:t+1})).observations.length,4);
  const cursorCases:[string,()=>Promise<unknown>][]=[
    ['network',()=>store.page('testnet',account,{cursor:firstPage.nextCursor!})],
    ['pool',()=>store.page(network,`0:${'d'.repeat(64)}`,{cursor:firstPage.nextCursor!})],
    ['from',()=>store.page(network,account,{from:t,cursor:firstPage.nextCursor!})],
    ['to',()=>store.page(network,account,{to:t+1,cursor:firstPage.nextCursor!})],
    ['generation',()=>store.page(network,account,{generation:second.generation,cursor:firstPage.nextCursor!})],
    ['wrong list',()=>store.candidatesPage(network,account,{cursor:firstPage.nextCursor!})],
    ['unknown generation',()=>store.page(network,account,{generation:randomUUID()})],
    ['malformed encoding',()=>store.page(network,account,{cursor:'broken'})],
    ['unreal cursor position',()=>{const c=JSON.parse(Buffer.from(firstPage.nextCursor!,'base64url').toString());c.id='0'.repeat(64);return store.page(network,account,{cursor:Buffer.from(JSON.stringify(c)).toString('base64url')});}],
    ['fractional from',()=>store.page(network,account,{from:1.5})],
    ['negative from',()=>store.page(network,account,{from:-1})],
    ['reversed range',()=>store.page(network,account,{from:t,to:t})],
    ['unbounded limit',()=>store.page(network,account,{limit:501})],
  ];
  for(const [name,run] of cursorCases) await assert.rejects(run,MarketCursorError,name);
  const race=await Promise.allSettled([store.publish(changed(q,'race-a'),second.generation),store.publish(changed(q,'race-b'),second.generation)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected' && r.reason instanceof MarketPublicationConflict).length,1,'concurrent stale builder cannot replace another publication');
  const current=(await store.current(network,account))!;
  const identical=changed(q,'identical-race');const duplicate=await Promise.all([store.publish(identical,current.generation),store.publish(identical,current.generation)]);assert.equal(duplicate[0].generation,duplicate[1].generation);assert.equal(duplicate.filter(p=>p.reused).length,1);
  // A database write failure after the generation and candidates were inserted must roll them all back.
  let fail=true;const injected:LedgerSqlPool={query:pool.query.bind(pool),end:async()=>{},connect:async()=>{const c=await pool.connect();return {release:()=>c.release?.(),query:async(sql,params)=>{if(fail && sql.startsWith('INSERT INTO market_observations')) {fail=false;throw Error('injected observation failure');}return c.query(sql,params);}};}};
  const count=(await pool.query('SELECT count(*)::int AS n FROM market_generations')).rows[0].n;
  await assert.rejects(()=>new PostgresMarketStore(injected).publish(changed(q,'rollback'),duplicate[0].generation),/injected/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_generations')).rows[0].n,count);assert.equal((await store.current(network,account))!.generation,duplicate[0].generation);
  const precise=changed(q,'exact-large-fee-storage');precise.observations[0].fees[0].nativeAmountRaw='9007199254740993123';
  const preciseGeneration=await store.publish(precise,duplicate[0].generation);
  const precisePage=await store.page(network,account,{generation:preciseGeneration.generation});
  assert.equal(precisePage.observations.find(o=>o.id===precise.observations[0].id)!.fees[0].nativeAmountRaw,'9007199254740993123','scalar serialization test retains integer fee above Number precision');
  const incomplete=changed(p,'missing-settlement-evidence');incomplete.observations=[];
  for(const c of incomplete.candidates) if(c.status==='settled') {c.status='unresolved';c.issues=['missing-settlement-evidence'];c.observationId=null;}
  const incompleteGeneration=await store.publish(incomplete,preciseGeneration.generation);
  const empty=await store.page(network,account);assert.equal(empty.observations.length,0);assert.equal(empty.coverage!.generation,incompleteGeneration.generation);assert.equal(empty.coverage!.historyComplete,false);
  assert.deepEqual(empty.coverage!.candidateCounts,{settled:0,refunded:1,unresolved:5});
  assert.equal((await store.candidatesPage(network,account,{limit:2})).candidates.length,2,'unresolved candidates are independently paginated');
  const badHead=structuredClone(p);mismatchReferencedHead(badHead);
  await assert.rejects(()=>store.publish(badHead,incompleteGeneration.generation),/coverage/);
  assert.equal((await store.current(network,account))!.generation,incompleteGeneration.generation,'invalid publication does not modify current head');
  // Corruption injection is confined to this disposable database and restored immediately.
  const metadata=(await pool.query('SELECT metadata FROM market_generations WHERE generation=$1',[incompleteGeneration.generation])).rows[0].metadata;
  const corrupt=structuredClone(metadata);corrupt.dependencies[0].checkedThrough='not-a-date';
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[incompleteGeneration.generation,JSON.stringify(corrupt)]);
  await assert.rejects(()=>store.page(network,account),/Invalid market projection/,'empty pages cannot advertise malformed coverage');
  await pool.query('UPDATE market_generations SET metadata=$2::jsonb WHERE generation=$1',[incompleteGeneration.generation,JSON.stringify(metadata)]);
  const resumed=new PostgresMarketStore(pool);assert.equal((await resumed.page(network,account,{generation:first.generation})).observations.length,5,'new store instance reads historical generation independently');
  console.log(`${label}: actual5-observation/6-candidate persistence, ${malformed} malformed projections, ${cursorCases.length} scoped cursor negatives, concurrent publication fencing/idempotence, immutable history and transactional rollback passed`);
}
async function main() {
  const db=new PGlite();let tail:Promise<void>=Promise.resolve();
  const acquire=async()=>{const old=tail;let release!:()=>void;tail=new Promise<void>(r=>{release=r;});await old;return release;};
  const rawQuery=async(sql:string,params?:unknown[])=>!params && sql.includes(';')?{rows:(await db.exec(sql)).at(-1)?.rows??[]}:db.query(sql,params);
  const embedded:LedgerSqlPool={query:async(sql,params)=>{const unlock=await acquire();try{return await rawQuery(sql,params);}finally{unlock();}},connect:async()=>{const unlock=await acquire();return {query:rawQuery,release:unlock} as LedgerSqlClient;},end:()=>db.close()};
  try {await suite(embedded,'PGlite serialized PostgreSQL session');}finally{await embedded.end();}
  if(process.env.MARKET_STORE_TEST_SOCKET) {
    const native=new Pool({host:process.env.MARKET_STORE_TEST_SOCKET,port:Number(process.env.MARKET_STORE_TEST_PORT??5432),database:'postgres',user:process.env.MARKET_STORE_TEST_USER,max:8});
    try {await suite(native as unknown as LedgerSqlPool,'Native PostgreSQL independent connections');}finally{await native.end();}
  } else console.log('Native PostgreSQL concurrency not requested; embedded transaction cases do not claim independent connection locking.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
