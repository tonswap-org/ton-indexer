import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresLedgerStore, projectionFingerprint } from '../ledger/store';
import type { LedgerEvent, LedgerProjection, LedgerProjectionScope } from '../ledger/types';

/** Native-driver transaction checks. Every run owns one random, disposable schema. */
async function main() {
  const connectionString = process.env.LEDGER_SCOPE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('Set LEDGER_SCOPE_TEST_DATABASE_URL to an isolated PostgreSQL test database.');
  const schema = 'scope_' + randomUUID().replace(/-/g, '');
  const admin = new Pool({ connectionString, max: 1 });
  let pool: Pool | undefined;
  let created = false;
  const checks: string[] = [];
  const account = '0:' + '1'.repeat(64), custody = '0:' + '2'.repeat(64), quiet = '0:' + '3'.repeat(64);
  const hash = (lt: number) => Buffer.alloc(32, lt).toString('base64');
  const scope = (physicalAccounts = [account, custody]): LedgerProjectionScope => ({ kind: 'owner', owner: account, physicalAccounts });
  const event = (lt: number, fee: string, physical: string): LedgerEvent => ({
    id: `scope-fee-${lt}`, account, network: 'testnet', lt: String(lt), hash: hash(lt), txId: `${lt}:${hash(lt)}`,
    utime: 1_735_689_600 + lt, status: 'success', kind: 'transfer', totalFeesRaw: fee, actions: [], issues: [],
    movements: [{ id: `physical-${physical}-${lt}:fee`, direction: 'fee', amountRaw: fee, source: physical,
      asset: { kind: 'native', id: 'testnet:native', symbol: 'TON', decimals: 9 },
      evidence: { kind: 'transaction_fee', transactionStatus: 'success', transactions: [{ account: physical, lt: String(lt), hash: hash(lt), utime: 1_735_689_600 + lt }] } }],
  });
  const projection: LedgerProjection = { events: [event(10, '10', account), event(12, '5', custody)], projectionScope: scope() };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 });
    const store = new PostgresLedgerStore(pool);
    await store.initialize();
    const column = (await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='ledger_projection_coverage' AND column_name='projection_scope'", [schema])).rows[0];
    assert.equal(column?.is_nullable, 'NO');
    const empty = await store.page('testnet', account);
    assert.equal(empty.coverage.projectionScope, null);
    assert.equal(empty.coverage.snapshotComplete, false);
    assert.deepEqual(empty.events, []);
    checks.push('canonical fresh schema and explicit unavailable scope');

    const first = randomUUID();
    await store.begin('testnet', account, first, { lt: '12', hash: hash(12) }, '2026-01-01T00:00:00Z');
    await store.project(first, projection, [], []);
    await store.complete('testnet', account, first, '2026-01-02T00:00:00Z');
    const page = await store.page('testnet', account, { limit: 1 });
    assert.deepEqual(page.coverage.projectionScope, projection.projectionScope);
    assert.equal(page.coverage.generation, first);
    assert.equal(page.events[0].movements[0].amountRaw, '5');
    assert(page.nextCursor);
    const tail = await store.page('testnet', account, { limit: 1, cursor: page.nextCursor });
    const fees = [...page.events, ...tail.events].flatMap(row => row.movements).reduce((sum, row) => sum + BigInt(row.amountRaw), 0n);
    assert.equal(fees, 15n);
    assert.deepEqual(tail.coverage.projectionScope, projection.projectionScope);
    checks.push('exact physical fees and scope survive native cursor retrieval');

    const expanded: LedgerProjection = { events: structuredClone(projection.events), projectionScope: scope([account, custody, quiet]) };
    assert.notEqual(projectionFingerprint(projection, [], []), projectionFingerprint(expanded, [], []));
    const second = randomUUID();
    await store.begin('testnet', account, second, { lt: '12', hash: hash(12) }, '2026-02-01T00:00:00Z');
    await store.project(second, expanded, [], []);
    await store.complete('testnet', account, second, '2026-02-02T00:00:00Z');
    const current = await store.page('testnet', account);
    assert.deepEqual(current.coverage.projectionScope, expanded.projectionScope);
    assert.equal(current.coverage.generation, second);
    const retired = await store.page('testnet', account, { limit: 1, cursor: page.nextCursor });
    assert.equal(retired.coverage.generation, first);
    assert.deepEqual(retired.coverage.projectionScope, projection.projectionScope);
    assert.equal(retired.coverage.checkedAt, '2026-01-02T00:00:00.000Z');
    checks.push('scope-only change fingerprints distinctly; retired cursor keeps its own scope');

    await assert.rejects(store.project(second, projection, [], []), /not writable/);
    const third = randomUUID();
    await store.begin('testnet', account, third, { lt: '12', hash: hash(12) });
    await store.project(third, projection, [], []);
    const persisted = async () => ({
      coverage: (await pool!.query('SELECT projection_scope,fingerprint FROM ledger_projection_coverage WHERE generation=$1', [third])).rows,
      events: (await pool!.query('SELECT event FROM ledger_projection_events WHERE generation=$1 ORDER BY event_id', [third])).rows,
    });
    const beforeFailure = await persisted();
    await assert.rejects(store.project(third, { ...projection, events: [projection.events[0], projection.events[0]] }, [], []), /duplicate key/);
    assert.deepEqual(await persisted(), beforeFailure);
    await assert.rejects(store.project(third, { ...projection, projectionScope: { ...scope(), owner: custody } }, [], []), /scope/);
    await assert.rejects(store.project(third, { ...projection, events: projection.events.map(row => ({ ...row, network: 'mainnet' })) }, [], []), /network/);
    await assert.rejects(store.complete('mainnet', account, third), /identity|network|owner/i);
    assert.deepEqual(await persisted(), beforeFailure);
    checks.push('native rollback preserves the previous projection after partial insert; owner/network and immutability enforced');

    await store.project(third, projection, [{ account: custody, role: 'owned_jetton_wallet', generation: null, historyComplete: false }], ['related_account_history_incomplete']);
    await store.complete('testnet', account, third);
    const partial = await store.page('testnet', account);
    assert.equal(partial.coverage.snapshotComplete, true);
    assert.equal(partial.coverage.historyComplete, false);
    assert.deepEqual(partial.coverage.projectionScope, scope());
    assert.equal(partial.events.length, 2);
    checks.push('valid partial graph records retain their explicit physical scope');

    for (const malformed of [null, {}, { ...scope(), owner: custody }, { ...scope(), physicalAccounts: [account, account] }]) {
      await pool.query('UPDATE ledger_projection_coverage SET projection_scope=$2::jsonb WHERE generation=$1', [third, JSON.stringify(malformed)]);
      const rejected = await store.page('testnet', account);
      assert.equal(rejected.coverage.projectionScope, null);
      assert.equal(rejected.coverage.snapshotComplete, false);
      assert.equal(rejected.coverage.historyComplete, false);
      assert.equal(rejected.coverage.decodingComplete, false);
      assert.equal(rejected.nextCursor, null);
      assert.deepEqual(rejected.events, []);
      assert(rejected.coverage.issues.includes('owner_projection_metadata_invalid'));
    }
    await pool.query('DELETE FROM ledger_projection_coverage WHERE generation=$1', [third]);
    assert.deepEqual((await store.page('testnet', account)).events, []);
    assert.equal((await store.page('testnet', account)).coverage.projectionScope, null);
    checks.push('published missing or corrupted metadata never exposes unscoped records');

    const raw = randomUUID();
    await store.begin('testnet', custody, raw);
    await store.complete('testnet', custody, raw);
    const unprojected = await store.page('testnet', custody);
    assert.equal(unprojected.coverage.projectionScope, null);
    assert.deepEqual(unprojected.events, []);
    assert.equal(unprojected.coverage.snapshotComplete, false);
    checks.push('internal completed raw chains remain unavailable until owner projection');

    await pool.query('ALTER TABLE ledger_projection_coverage DROP COLUMN projection_scope');
    await assert.rejects(store.initialize(), /projection_scope/);
    const missing = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='ledger_projection_coverage' AND column_name='projection_scope'", [schema]);
    assert.equal(missing.rows.length, 0, 'initialization must not invent a scope for an obsolete schema');
    checks.push('obsolete schema is rejected without an inferred scope or compatibility migration');
    console.log(JSON.stringify({ passed: checks.length, checks, engine: 'native PostgreSQL via node-postgres', scope: 'isolated random test schema; synthetic projection persistence, no live chain reads' }, null, 2));
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
