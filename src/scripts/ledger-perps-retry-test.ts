import { fixtureChainSource } from './support/chainFixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { PerpsRangeService } from '../ledger/perpsRange';
import { loadOpcodes } from '../utils/opcodes';
import { exitGuard } from './support/exitGuard';

const guard = exitGuard('ledger-perps-retry-test');

/** The optional native run uses an isolated schema on an explicitly selected
 * loopback database, proving independent-connection admission and worker locks. */
async function main() {
  const connectionString = process.env.INDEXER_TEST_DATABASE_URL;
  if (connectionString && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname))
    throw Error('Perps retry integration requires an isolated loopback PostgreSQL instance.');
  const schema = 'perps_retry_' + randomUUID().replace(/-/g, '');
  const db = connectionString ? null : new PGlite();
  const admin = connectionString ? new Pool({ connectionString, max: 1 }) : null;
  if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
  const native = connectionString ? new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 }) : null;
  const sql: LedgerSqlPool = native ?? {
    query: async (q, p) => !p && q.includes(';') ? { rows: (await db!.exec(q)).at(-1)?.rows ?? [] } : db!.query(q, p),
    connect: async () => sql, end: async () => db!.close(),
  };
  const store = new PostgresLedgerStore(sql);
  const owner = `0:${'1'.repeat(64)}`, bounds = { scope: 'perps' as const, fromUtime: 100, toUtime: 200 };
  let sourceCalls = 0;
  const source = fixtureChainSource({ head: async () => { sourceCalls++; throw Error('temporary provider outage'); } });
  const options = { perpsEngine: `0:${'2'.repeat(64)}`, t3Root: `0:${'3'.repeat(64)}`, perpsEngineCodeHash: '4'.repeat(64) };
  const services: PerpsRangeService[] = [];
  // Collectors that a check holds open, and direct collections the services do
  // not track. Cleanup stops the services, releases the held work and waits for
  // it before closing the pool, so a failed check reaches the catch instead of
  // an event loop that drains with exit code 0.
  const blocked: Array<() => void> = [], direct: Promise<unknown>[] = [];
  const service = async () => {
    const value = new PerpsRangeService('localnet', store, source, loadOpcodes(), options);
    // Admit deterministically; invoke the public collector explicitly below.
    await value.stop(); services.push(value); return value;
  };
  try {
    await store.initialize();
    const first = await service();
    const binding = (first as any).binding as string;
    let page = await first.page(owner, bounds);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const generation = page.coverage.generation!;
      await assert.rejects(first.collect(generation), /temporary provider outage/);
      const failed = (await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [generation])).rows[0];
      delays.push(failed.backoff_seconds);
      assert.equal(failed.status, 'failed');
      assert(new Date(failed.retry_after).getTime() > new Date(failed.attempted_at).getTime());
      const reads = sourceCalls;
      const restarted = await service();
      const waiting = await Promise.all(Array.from({ length: 12 }, () => restarted.page(owner, bounds)));
      assert(waiting.every(value => value.coverage.generation === generation && value.coverage.range?.retryAfter));
      await restarted.collect(generation);
      assert.equal(sourceCalls, reads, 'polling and restart cannot bypass the persisted backoff');
      assert.deepEqual((await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [generation])).rows[0], failed);
      // Advance only this isolated database clock fixture, without sleeping.
      await sql.query("UPDATE ledger_perps_ranges SET retry_after=now()-interval '1 second' WHERE generation=$1", [generation]);
      const expired = (await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [generation])).rows[0];
      const raced = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : restarted).page(owner, bounds)));
      page = await restarted.page(owner, bounds);
      assert.notEqual(page.coverage.generation, generation);
      assert(raced.every(value => [generation, page.coverage.generation].includes(value.coverage.generation)),
        'contending readers may retain the old failed response, but cannot create competing retries');
      const active = (await sql.query("SELECT generation FROM ledger_perps_ranges WHERE network='localnet' AND account=$1 AND status IN ('pending','running')", [owner])).rows;
      assert.deepEqual(active.map(row => row.generation), [page.coverage.generation]);
      assert.equal(sourceCalls, reads);
      assert.deepEqual((await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [generation])).rows[0], expired,
        'retry admission never mutates the prior failed generation');
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
    console.log('PASS persisted 5–300 second backoff, process restart, deterministic failures and concurrent exact-bound retry admission');

    const cursorOwner = `0:${'5'.repeat(64)}`, published = randomUUID();
    const accounts = [cursorOwner, ...['6', '7', '8'].map(value => `0:${value.repeat(64)}`)];
    const snapshot = { schema: 'perps-range-v3', masterSeqno: 10, masterTimestamp: 200, observedAt: '2025-01-01T00:00:00.000Z', oraclePools: [], protocolPeers: [],
      projection: { projectionScope: { kind: 'owner', owner: cursorOwner, physicalAccounts: accounts }, events: [1, 2].map(index => ({
        id: String(index), network: 'localnet', account: cursorOwner, lt: String(index), hash: '9'.repeat(64), txId: String(index), utime: 150,
        status: 'success', kind: 'perps_operation', totalFeesRaw: '0', movements: [], actions: [], issues: ['perps_exact_state_unavailable'],
        settlement: { status: 'incomplete', protocol: 'perps', operation: 'perps_operation', evidence: [] },
      })) },
      chains: accounts.map((account, index) => ({ account, generation: published, role: index ? 'counterparty' : 'owner', historyComplete: false,
        verifiedRange: { fromUtime: 100, toUtime: 200 }, transactions: [], headTransactions: [], boundary: null, headLt: null, headHash: null })) };
    await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,snapshot,published_at,retry_after)
      VALUES($1,'localnet',$2,100,200,$3,'complete',$4::jsonb,now(),now()-interval '1 second')`, [published, cursorOwner, binding, JSON.stringify(snapshot)]);
    const pinnedCursor = Buffer.from(JSON.stringify({ generation: published, offset: 0, binding, account: cursorOwner, from: 100, to: 200 })).toString('base64url');
    const pinned = await first.page(cursorOwner, { ...bounds, cursor: pinnedCursor, limit: 1 });
    assert(pinned.nextCursor);
    const nextBefore = await first.page(cursorOwner, { ...bounds, cursor: pinned.nextCursor! });
    const replacement = await first.page(cursorOwner, bounds);
    assert.notEqual(replacement.coverage.generation, published);
    await assert.rejects(first.collect(replacement.coverage.generation!), /temporary provider outage/);
    assert.deepEqual(await first.page(cursorOwner, { ...bounds, cursor: pinnedCursor, limit: 1 }), pinned);
    assert.deepEqual(await first.page(cursorOwner, { ...bounds, cursor: pinned.nextCursor! }), nextBefore);
    assert.deepEqual((await sql.query('SELECT snapshot FROM ledger_perps_ranges WHERE generation=$1', [published])).rows[0].snapshot, snapshot);
    console.log('PASS published incomplete snapshot can refresh while existing cursor pages remain byte-for-byte unchanged');

    const activeCount = Number((await sql.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE network='localnet' AND status IN ('pending','running')")).rows[0].count);
    for (let index = activeCount; index < 128; index++) await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status)
      VALUES($1,'localnet',$2,100,200,$3,'pending')`, [randomUUID(), `capacity-${index}`, binding]);
    await assert.rejects(first.page('capacity-overflow', bounds), /admission_capacity/);
    assert.equal((await sql.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE network='localnet' AND status IN ('pending','running')")).rows[0].count, 128);
    console.log('PASS retry admission retains the shared 128-job capacity bound');

    if (native) {
      // Actual session advisory locks must prevent two service processes from
      // collecting the same recovered generation simultaneously.
      await sql.query("DELETE FROM ledger_perps_ranges WHERE account LIKE 'capacity-%'");
      let rejectRead!: (error: Error) => void;
      let entered!: () => void;
      const readEntered = new Promise<void>(resolve => { entered = resolve; });
      const heldSource = fixtureChainSource({ head: async () => { sourceCalls++; entered(); return new Promise((_resolve, reject) => {
        rejectRead = reject; blocked.push(() => reject(Error('released by cleanup'))); }); } });
      const workers = [0, 1].map(() => new PerpsRangeService('localnet', store, heldSource, loadOpcodes(), options));
      services.push(...workers);
      const generation = page.coverage.generation!;
      const beforeReads = sourceCalls;
      const firstWorker = workers[0].collect(generation);
      direct.push(firstWorker);
      await readEntered;
      const secondWorker = await workers[1].collect(generation);
      assert.equal(secondWorker, false);
      assert.equal(sourceCalls, beforeReads + 1);
      rejectRead(Error('held provider outage'));
      await assert.rejects(firstWorker, /held provider outage/);
      console.log('PASS native PostgreSQL independent-connection worker lock prevents duplicate source collection');
    }
    // Scheduler/admission tests below use this isolated database only. The
    // successful collector is a queue-control stub returning an empty snapshot;
    // real settlement qualification remains in the unchanged range/wallet tests.
    await sql.query('DELETE FROM ledger_perps_ranges');
    const settle = async (value: PerpsRangeService) => {
      while ((value as any).running.size) await Promise.allSettled((value as any).running.values());
      assert.equal((value as any).pending.size + (value as any).foreground.size, 0);
    };
    const live = async () => { const value = await service(); (value as any).stopped = false; return value; };
    const latest = async (account: string) => (await sql.query('SELECT * FROM ledger_perps_ranges WHERE account=$1 ORDER BY generation_order DESC LIMIT 1', [account])).rows[0];
    const due = async (generation: string) => sql.query("UPDATE ledger_perps_ranges SET retry_after=now()-interval '1 second' WHERE generation=$1", [generation]);
    const sweep = await service();
    const failedPage = await sweep.page(cursorOwner, bounds), failedGeneration = failedPage.coverage.generation!;
    await assert.rejects(sweep.collect(failedGeneration), /temporary provider outage/);
    await due(failedGeneration);
    const failedBefore = (await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [failedGeneration])).rows[0];
    const successSnapshot = {...snapshot, projection: {...snapshot.projection, events: []}};
    sweep.collect = async generation => {
      await sql.query("UPDATE ledger_perps_ranges SET status='complete',snapshot=$2::jsonb,published_at=now(),retry_after=NULL WHERE generation=$1 AND status='pending'", [generation, JSON.stringify(successSnapshot)]);
      return true;
    };
    (sweep as any).stopped = false;
    await sweep.resume(); await settle(sweep);
    const successor = await latest(cursorOwner);
    assert.notEqual(successor.generation, failedGeneration); assert.equal(successor.status, 'complete'); assert.equal(successor.backoff_seconds, 10);
    assert.deepEqual((await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [failedGeneration])).rows[0], failedBefore);
    const completeBefore = structuredClone(successor);
    await sweep.resume(); await settle(sweep);
    assert.deepEqual(await latest(cursorOwner), completeBefore, 'complete snapshots without retry_after are final and immutable');
    const publishedIncomplete = randomUUID();
    await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,snapshot,published_at,retry_after)
      VALUES($1,'localnet',$2,100,200,$3,'complete',$4::jsonb,now(),now()-interval '1 second')`, [publishedIncomplete,cursorOwner,binding,JSON.stringify(snapshot)]);
    const cursor = Buffer.from(JSON.stringify({generation:publishedIncomplete,offset:0,binding,account:cursorOwner,from:100,to:200})).toString('base64url');
    const cursorBefore = await sweep.page(cursorOwner,{...bounds,cursor,limit:1});
    const publishedBefore = (await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1',[publishedIncomplete])).rows[0];
    await sweep.resume();await settle(sweep);
    assert.notEqual((await latest(cursorOwner)).generation,publishedIncomplete,'a due published incomplete snapshot also admits a successor');
    assert.deepEqual((await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1',[publishedIncomplete])).rows[0],publishedBefore);
    assert.deepEqual(await sweep.page(cursorOwner,{...bounds,cursor,limit:1}),cursorBefore,'sweep retries retain byte-identical published cursor responses');
    await sweep.stop();
    console.log('PASS a due failed range is replaced and collected by the sweep without another page request; retained failed and complete rows do not change');

    await sql.query('DELETE FROM ledger_perps_ranges');
    const capped = await service();
    const initial = await capped.page(owner, bounds); await assert.rejects(capped.collect(initial.coverage.generation!), /temporary provider outage/);
    (capped as any).stopped = false;
    for (const backoff of [10,20,40,80,160,300]) {
      const previous = await latest(owner); await due(previous.generation);
      const retained = (await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [previous.generation])).rows[0];
      await capped.resume(); await settle(capped);
      const next = await latest(owner); assert.notEqual(next.generation, previous.generation); assert.equal(next.backoff_seconds, backoff); assert.equal(next.status,'failed');
      assert.deepEqual((await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [previous.generation])).rows[0], retained);
    }
    const sixth = await latest(owner); await due(sixth.generation);
    await capped.resume(); await settle(capped); assert.equal((await latest(owner)).generation, sixth.generation, 'six automatic failures stop at the capped backoff');
    const polled = await capped.page(owner,bounds); await settle(capped);
    assert.notEqual(polled.coverage.generation,sixth.generation); assert.equal((await latest(owner)).backoff_seconds,300,'a client may still retry after the automatic cap');
    await capped.stop();
    console.log('PASS exactly six sweep-admitted retries, immutable superseded rows, and a client retry after the automatic cap');

    await sql.query('DELETE FROM ledger_perps_ranges');
    const batch = await live(); const collected: string[]=[];
    batch.collect = async generation => {collected.push(generation); await sql.query("UPDATE ledger_perps_ranges SET status='failed',retry_after=NULL,error_code='scheduler_fixture' WHERE generation=$1",[generation]);return true;};
    for(let index=0;index<16;index++)await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,retry_after)
      VALUES($1,'localnet',$2,100,200,$3,'failed',now()-interval '1 second')`,[randomUUID(),`auto-${index}`,binding]);
    await batch.resume();await settle(batch);assert.equal(collected.length,8,'one sweep admits at most eight due keys');
    assert.equal((await sql.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE error_code='scheduler_fixture'")).rows[0].count,8);
    await batch.stop();
    await sql.query('DELETE FROM ledger_perps_ranges');
    const full = await live();
    full.collect = async () => {throw new Error('future jobs cannot be collected');};
    for(let index=0;index<128;index++)await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,retry_after)
      VALUES($1,'localnet',$2,100,200,$3,'pending',now()+interval '1 hour')`,[randomUUID(),`full-${index}`,binding]);
    await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,retry_after)
      VALUES($1,'localnet','overflow',100,200,$2,'failed',now()-interval '1 second')`,[randomUUID(),binding]);
    await full.resume();await settle(full);
    assert.equal((await sql.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE status IN ('pending','running')")).rows[0].count,128);
    assert.equal((await sql.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE account='overflow'")).rows[0].count,1);
    await full.stop();
    console.log('PASS sweep eight-key limit and shared128-job admission bound');

    await sql.query('DELETE FROM ledger_perps_ranges');
    const priority = await service(), queued: string[]=[], releases:Array<()=>void>=[];
    const pages=[];for(let index=0;index<4;index++)pages.push(await priority.page(`queue-${index}`,bounds));
    priority.collect = async generation => {queued.push(generation);await new Promise<void>(resolve=>{releases.push(resolve);blocked.push(resolve);});return true;};
    (priority as any).stopped=false;
    (priority as any).schedule(pages[0].coverage.generation);(priority as any).schedule(pages[1].coverage.generation);
    (priority as any).schedule(pages[2].coverage.generation);
    await priority.page('queue-3',bounds);
    assert.equal(queued.length,2);
    releases.shift()!();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(queued[2],pages[3].coverage.generation,'a client generation precedes queued background retries');
    assert.equal((priority as any).pending.size + (priority as any).foreground.size,1);
    const stopping=priority.stop();for(const release of releases.splice(0))release();await stopping;
    console.log('PASS foreground range collection precedes waiting background work');

    const exhausted: LedgerSqlPool={query:async()=>{throw Error('worker pool exhausted');},connect:async()=>{throw Error('worker pool exhausted');},end:async()=>{}};
    const isolated=new PerpsRangeService('localnet',new PostgresLedgerStore(exhausted),source,loadOpcodes(),{...options,readStore:store});
    await isolated.stop();services.push(isolated);
    assert((await isolated.page('isolated-reader',bounds)).coverage.generation,'range page/admission use read pool while worker pool is exhausted');
    console.log('PASS bounded-range API read/admission pool isolation');
  } finally {
    const stopping = Promise.all(services.map(value => value.stop()));
    for (const release of blocked.splice(0)) release();
    await stopping;
    await Promise.allSettled(direct);
    await sql.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  }
}
main().then(() => guard.done(), error => { console.error(error); process.exitCode = 1; });
