import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PostgresLedgerStore, type LedgerSqlPool, type OwnerCheckRecord } from '../ledger/store';

async function main() {
  const db = new PGlite();
  const pool: LedgerSqlPool = {
    query: async (sql, params) => !params && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params),
    connect: async () => pool, end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool), owner = `0:${'1'.repeat(64)}`;
  try {
    await store.initialize();
    assert.equal(await store.ownerCheck('testnet', owner), null);
    const generation = randomUUID();
    await store.begin('testnet', owner, generation);
    await store.project(generation, { events: [], projectionScope: { kind: 'owner', owner, physicalAccounts: [owner] } }, [], []);
    await store.complete('testnet', owner, generation);
    const before = (await db.query('SELECT to_jsonb(a) AS account,to_jsonb(r) AS run,to_jsonb(c) AS coverage FROM ledger_accounts a JOIN ledger_runs r ON r.generation=a.current_generation JOIN ledger_projection_coverage c USING(generation)')).rows;
    const record: OwnerCheckRecord = { checkedAt: '2026-10-13T04:05:06.123Z', boundary: { seqno: 100, utime: 1791850000 },
      headVector: [{ account: owner, headLt: null, headHash: null }], pendingAccounts: [], bindings: { wallet: true }, unresolved: false, errorCode: null };
    await store.saveOwnerCheck('testnet', owner, record);
    assert.deepEqual(await store.ownerCheck('testnet', owner), record);
    const changed = { ...record, checkedAt: '2026-10-13T04:06:06.123Z', boundary: { seqno: 101, utime: 1791850001 },
      pendingAccounts: [owner], bindings: { wallet: false }, unresolved: true, errorCode: 'source_unavailable' };
    await store.saveOwnerCheck('testnet', owner, changed);
    assert.deepEqual(await store.ownerCheck('testnet', owner), changed);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM ledger_owner_checks')).rows[0].count, 1);
    assert.equal(await store.ownerCheck('mainnet', owner), null);
    assert.deepEqual((await db.query('SELECT to_jsonb(a) AS account,to_jsonb(r) AS run,to_jsonb(c) AS coverage FROM ledger_accounts a JOIN ledger_runs r ON r.generation=a.current_generation JOIN ledger_projection_coverage c USING(generation)')).rows, before,
      'owner rechecks never alter immutable publication or coverage');
    console.log('owner check insert/update round trip, network isolation and publication immutability passed');
  } finally { await db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
