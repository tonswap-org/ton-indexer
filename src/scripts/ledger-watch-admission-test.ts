import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { LedgerService } from '../ledger/service';
import { fakeChainSource } from './support/fakeChainSource';
import { loadOpcodes } from '../utils/opcodes';

const owner = `0:${'1'.repeat(64)}`, other = `0:${'2'.repeat(64)}`;
const logger = { info() {}, warn() {}, error() {}, debug() {} };
async function suite(pool: LedgerSqlPool, native: boolean) {
  const store = new PostgresLedgerStore(pool); await store.initialize();
  const service = new LedgerService('localnet', store, fakeChainSource(), loadOpcodes(), logger, 2, {maxWatchedAccounts: 1});
  let enqueued = 0;
  (service as any).enqueue = () => { enqueued++; };
  try {
    const pages = await Promise.all([service.page(owner), service.page(owner)]);
    assert(pages.every(page => !page.coverage.issues.includes('watch_capacity_reached')));
    assert.equal(enqueued, 1, 'concurrent first reads coalesce one admission/enqueue');
    assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM ledger_watch_accounts')).rows[0].count), 1);
    const old = new Date(Date.now() - 60_000).toISOString();
    await pool.query('UPDATE ledger_watch_accounts SET requested_at=$1', [old]);
    await service.discoveries(owner, {since: old});
    assert(Date.parse((await pool.query('SELECT requested_at FROM ledger_watch_accounts')).rows[0].requested_at) > Date.parse(old));
    assert((await service.page(other)).coverage.issues.includes('watch_capacity_reached'));
    if (native) {
      const client = await pool.connect();
      const schema = (await client.query('SELECT current_schema() AS schema')).rows[0].schema;
      const key = `ledger:${schema}:localnet:watch-admission`;
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      let completed = false;
      const waiting = service.page(owner).then(page => {completed = true; return page;});
      await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(completed, false, 'busy admission waits instead of reporting capacity');
      await client.query('COMMIT'); client.release?.();
      assert(!(await waiting).coverage.issues.includes('watch_capacity_reached'));
      assert.equal(enqueued, 3, 'the lock waiter still enqueues');
      await pool.query('DELETE FROM ledger_watch_accounts');
      const second = new PostgresLedgerStore(pool);
      assert.deepEqual(await Promise.all([store.admitWatch('localnet', owner, 1), second.admitWatch('localnet', owner, 1)]), [true,true]);
      assert.equal(await store.admitWatch('localnet', other, 1), false);
    }
  } finally { await service.stop(); }
}
async function main() {
  const db = new PGlite(); let tail = Promise.resolve();
  const acquire = async () => {const prior = tail; let release!: () => void; tail = new Promise<void>(resolve => {release = resolve;}); await prior; return release;};
  const query = async (sql: string, params?: any[]) => !params && sql.includes(';') ? {rows: (await db.exec(sql)).at(-1)?.rows ?? []} : db.query(sql, params);
  const pool: LedgerSqlPool = { query: async (sql, params) => {const unlock = await acquire(); try{return await query(sql,params);} finally{unlock();}},
    connect: async () => {const unlock = await acquire(); return {query, release: unlock};}, end: () => db.close() };
  try {await suite(pool, false);} finally{await pool.end();}
  const connectionString = process.env.INDEXER_TEST_DATABASE_URL;
  if (connectionString) {
    if (!['127.0.0.1','localhost','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Watch native tests require loopback PostgreSQL');
    const schema = `watch_${randomUUID().replace(/-/g, '')}`, admin = new Pool({connectionString, max: 1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
    const native = new Pool({connectionString: url.toString(), max: 6});
    try{await suite(native, true);} finally{await native.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  }
  console.log('Watch admission coalescing, requested time and capacity passed; native blocking lock runs only with INDEXER_TEST_DATABASE_URL.');
}
main().catch(error => {console.error(error);process.exitCode=1;});
