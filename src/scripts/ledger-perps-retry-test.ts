import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { PerpsRangeService } from '../ledger/perpsRange';
import { loadOpcodes } from '../utils/opcodes';
import type { TonDataSource } from '../data/dataSource';

/** The optional native run uses an isolated schema on an explicitly selected
 * loopback database, proving independent-connection admission and worker locks. */
async function main() {
  const connectionString = process.env.LEDGER_PERPS_RETRY_TEST_DATABASE_URL;
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
  const source = { getMasterchainInfo: async () => { sourceCalls++; throw Error('temporary provider outage'); } } as unknown as TonDataSource;
  const options = { perpsEngine: `0:${'2'.repeat(64)}`, t3Root: `0:${'3'.repeat(64)}`, perpsEngineCodeHash: '4'.repeat(64) };
  const services: PerpsRangeService[] = [];
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
      const heldSource = { getMasterchainInfo: async () => { sourceCalls++; entered(); return new Promise((_resolve, reject) => { rejectRead = reject; }); } } as unknown as TonDataSource;
      const workers = [0, 1].map(() => new PerpsRangeService('localnet', store, heldSource, loadOpcodes(), options));
      services.push(...workers);
      const generation = page.coverage.generation!;
      const beforeReads = sourceCalls;
      const firstWorker = workers[0].collect(generation);
      await readEntered;
      const secondWorker = await workers[1].collect(generation);
      assert.equal(secondWorker, false);
      assert.equal(sourceCalls, beforeReads + 1);
      rejectRead(Error('held provider outage'));
      await assert.rejects(firstWorker, /held provider outage/);
      console.log('PASS native PostgreSQL independent-connection worker lock prevents duplicate source collection');
    }
  } finally {
    await Promise.all(services.map(value => value.stop()));
    await sql.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
