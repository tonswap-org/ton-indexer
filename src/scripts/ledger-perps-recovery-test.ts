import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { PerpsRangeService } from '../ledger/perpsRange';
import { LedgerService } from '../ledger/service';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { loadOpcodes } from '../utils/opcodes';
import type { Logger } from '../utils/logger';
import type { TonDataSource } from '../data/dataSource';

async function settle(service: PerpsRangeService) {
  while ((service as any).running.size) await Promise.allSettled((service as any).running.values());
  assert.equal((service as any).pending.size, 0);
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (!await check()) {
    assert(Date.now() < deadline, 'durable recovery did not make progress');
    await delay(20);
  }
}

/** Native runs use only a new isolated schema on an explicitly selected loopback
 * server. PGlite covers durable state; native PostgreSQL covers session locks. */
async function main() {
  const connectionString = process.env.LEDGER_PERPS_RETRY_TEST_DATABASE_URL;
  if (connectionString && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname))
    throw Error('Perps recovery integration requires isolated loopback PostgreSQL.');
  const schema = 'perps_recovery_' + randomUUID().replace(/-/g, '');
  const db = connectionString ? null : new PGlite();
  const admin = connectionString ? new Pool({ connectionString, max: 1 }) : null;
  if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
  const native = connectionString ? new Pool({ connectionString, options: `-c search_path=${schema}`, max: 16 }) : null;
  const sql: LedgerSqlPool = native ?? {
    query: async (q, p) => !p && q.includes(';') ? { rows: (await db!.exec(q)).at(-1)?.rows ?? [] } : db!.query(q, p),
    connect: async () => sql, end: async () => db!.close(),
  };
  const store = new PostgresLedgerStore(sql), opcodes = loadOpcodes();
  const options = { perpsEngine: `0:${'2'.repeat(64)}`, t3Root: `0:${'3'.repeat(64)}`, perpsEngineCodeHash: '4'.repeat(64) };
  const now = Math.floor(Date.now() / 1000), bounds = { scope: 'perps' as const, fromUtime: now - 60, toUtime: now };
  const owner = (index: number) => `0:${BigInt(index).toString(16).padStart(64, '0')}`;
  let head = now - 1, reads = 0, inFlight = 0, peak = 0;
  const source = { getMasterchainInfo: async () => {
    reads++; peak = Math.max(peak, ++inFlight);
    await nextTurn(); inFlight--;
    return { seqno: 100, timestamp: head };
  } } as unknown as TonDataSource;
  const workers: PerpsRangeService[] = [];
  const worker = (dataSource = source) => {
    const value = new PerpsRangeService('localnet', store, dataSource, opcodes, options);
    workers.push(value); return value;
  };
  let ledger: LedgerService | undefined;
  const row = async (generation: string) => (await sql.query('SELECT * FROM ledger_perps_ranges WHERE generation=$1', [generation])).rows[0];
  const activeCount = async () => Number((await sql.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE status IN ('pending','running')")).rows[0].count);
  try {
    await store.initialize();
    const original = worker();
    for (let index = 1; index <= 128; index++) {
      await original.page(owner(index), bounds);
      await settle(original);
    }
    assert.equal(reads, 128);
    assert.equal(await activeCount(), 128);
    await assert.rejects(original.page(owner(129), bounds), /admission_capacity/);
    await original.stop();
    // Only the isolated database clock/state is advanced. Every admitted range
    // above executed the real collector and persisted its own head-wait outcome.
    await sql.query("UPDATE ledger_perps_ranges SET retry_after=now()-interval '1 second'");
    await sql.query("UPDATE ledger_perps_ranges SET status='running' WHERE generation_order=1");
    head = now + 10; peak = 0;
    const warnings: string[] = [];
    const logger: Logger = { warn: (message: string) => { warnings.push(message); }, info() {}, error() {}, debug() {} };
    ledger = new LedgerService('localnet', store, source, opcodes, logger, 2, options);
    ledger.start(); // No owner polls or explicit collector calls after restart.
    await until(async () => await activeCount() === 0);
    assert.equal(reads, 256, 'all 128 original requests resumed, including the crashed running row');
    assert(peak > 0 && peak <= 2, 'startup and timer share the two-worker bound');
    assert.deepEqual(warnings, []);
    const outcomes = (await sql.query('SELECT status,error_code,count(*)::int AS count FROM ledger_perps_ranges GROUP BY status,error_code')).rows;
    assert.deepEqual(outcomes, [{ status: 'failed', error_code: 'perps_range_archive_unavailable', count: 128 }]);
    const admitted = await ledger.page(owner(129), bounds);
    assert(admitted.coverage.generation);
    const stoppedRanges = (ledger as any).ranges as PerpsRangeService;
    await ledger.stop(); ledger = undefined;
    const readsAtStop = reads;
    await stoppedRanges.resume();
    assert.equal(reads, readsAtStop);
    assert.equal((stoppedRanges as any).timer, undefined);
    assert.equal((stoppedRanges as any).pending.size, 0);
    assert.equal((stoppedRanges as any).running.size, 0);
    console.log('PASS 128 real head-wait requests recover through LedgerService startup and timer without owner polling; new owner admitted; no archive evidence fabricated');

    await sql.query('DELETE FROM ledger_perps_ranges');
    head = now - 1;
    const backoffWorker = worker();
    const backoffPage = await backoffWorker.page(owner(200), bounds);
    const generation = backoffPage.coverage.generation!;
    await settle(backoffWorker);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const stored = await row(generation);
      delays.push(Math.round((new Date(stored.retry_after).getTime() - new Date(stored.attempted_at).getTime()) / 1000));
      const before: number = reads;
      await Promise.all(Array.from({ length: 8 }, () => backoffWorker.resume()));
      await backoffWorker.page(owner(200), bounds);
      await settle(backoffWorker);
      assert.equal(reads, before, 'sweeps and polls respect persisted head-wait backoff');
      assert.deepEqual(await row(generation), stored);
      if (attempt < 8) {
        await sql.query("UPDATE ledger_perps_ranges SET retry_after=now()-interval '1 second' WHERE generation=$1", [generation]);
        await backoffWorker.resume(); await settle(backoffWorker);
      }
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
    const beforeExpiry = reads;
    await sql.query("UPDATE ledger_perps_ranges SET created_at=now()-interval '16 minutes' WHERE generation=$1", [generation]);
    await backoffWorker.resume(); await settle(backoffWorker);
    assert.equal(reads, beforeExpiry, 'expiry retires a never-ready range even during its backoff');
    const expired = await row(generation);
    assert.equal(expired.status, 'failed'); assert.equal(expired.error_code, 'perps_range_expired');
    assert.equal(expired.snapshot, null); assert.equal(expired.published_at, null);
    assert(expired.retry_after, 'a client may request a fresh generation after the terminal failure backoff');
    console.log('PASS head-wait retries persist exponential 5–300 second backoff and retire after 15 minutes without consuming further source calls');

    const binding = (backoffWorker as any).binding;
    const foreign = randomUUID();
    const returning = new PerpsRangeService('localnet', store, source, opcodes, { ...options, perpsEngineCodeHash: '6'.repeat(64) });
    workers.push(returning); await returning.stop();
    const foreignBinding = (returning as any).binding;
    await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status)
      VALUES($1,'localnet',$2,$3,$4,$5,'pending')`, [foreign, owner(201), bounds.fromUtime, bounds.toUtime, foreignBinding]);
    await backoffWorker.resume(); await settle(backoffWorker);
    assert.equal((await row(foreign)).status, 'pending', 'one live binding cannot invalidate another worker binding before expiry');
    await sql.query("UPDATE ledger_perps_ranges SET created_at=now()-interval '16 minutes' WHERE generation=$1", [foreign]);
    await backoffWorker.resume(); await settle(backoffWorker);
    const retired = await row(foreign);
    assert.equal(retired.status, 'failed'); assert.equal(retired.error_code, 'perps_range_expired');
    assert(retired.retry_after, 'expiry retains backoff even when another binding performs the retirement');
    await backoffWorker.resume(); await settle(backoffWorker);
    assert.deepEqual(await row(generation), expired, 'failed generations remain immutable across recovery');
    assert.deepEqual(await row(foreign), retired);
    assert.equal(await activeCount(), 0);
    const earlyReturn = await returning.page(owner(201), bounds);
    assert.equal(earlyReturn.coverage.generation, foreign);
    await sql.query("UPDATE ledger_perps_ranges SET retry_after=now()-interval '1 second' WHERE generation=$1", [foreign]);
    const retry = await returning.page(owner(201), bounds);
    assert.notEqual(retry.coverage.generation, foreign, 'the original binding can admit a fresh generation after its worker returns');
    assert.equal(retry.coverage.range?.status, 'pending');
    await backoffWorker.stop();
    console.log('PASS orphaned binding expiry releases admission without decoding other bindings or mutating terminal generations');

    if (native) {
      await sql.query('DELETE FROM ledger_perps_ranges');
      head = now + 10;
      const admission = worker(); await admission.stop();
      for (let index = 0; index < 24; index++) await admission.page(owner(300 + index), bounds);
      const beforeRace = reads, left = worker(), right = worker();
      await Promise.all([left.start(), right.start()]);
      await Promise.all([settle(left), settle(right)]);
      assert.equal(await activeCount(), 0);
      assert.equal(reads, beforeRace + 24, 'independent startup sweeps collect each generation exactly once');
      await Promise.all([left.stop(), right.stop()]);

      let entered!: () => void, release!: () => void;
      const readEntered = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const held = worker({ getMasterchainInfo: async () => { entered(); await released; throw Error('held source unavailable'); } } as unknown as TonDataSource);
      const locked = randomUUID();
      await sql.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status)
        VALUES($1,'localnet',$2,$3,$4,$5,'pending')`, [locked, owner(400), bounds.fromUtime, bounds.toUtime, binding]);
      const collecting = held.collect(locked);
      await readEntered;
      await sql.query("UPDATE ledger_perps_ranges SET created_at=now()-interval '16 minutes' WHERE generation=$1", [locked]);
      const sweeper = worker();
      await sweeper.resume(); await settle(sweeper);
      assert.equal((await row(locked)).status, 'running', 'expiry cannot take over an active generation lock');
      release(); await assert.rejects(collecting, /held source unavailable/);
      assert.equal((await row(locked)).error_code, 'history_source_unavailable');
      console.log('PASS native independent-connection sweeps share generation locks; expiry cannot overwrite a live collector');
    }
  } finally {
    await ledger?.stop();
    await Promise.all(workers.map(value => value.stop()));
    await sql.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
