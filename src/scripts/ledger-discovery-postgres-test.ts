import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresLedgerStore } from '../ledger/store';
import type { LedgerEvent } from '../ledger/types';

/** Real connection/lock behavior, restricted to an explicitly supplied local test database. */
async function main() {
  const connectionString = process.env.LEDGER_DISCOVERY_TEST_DATABASE_URL;
  if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname))
    throw new Error('Set LEDGER_DISCOVERY_TEST_DATABASE_URL to an isolated loopback PostgreSQL instance.');
  const schema = 'discovery_' + randomUUID().replace(/-/g, '');
  const admin = new Pool({ connectionString, max: 1 });
  let pool: Pool | undefined, created = false;
  const owner = '0:' + '1'.repeat(64), other = '0:' + '2'.repeat(64), hash = Buffer.alloc(32, 5).toString('base64');
  const event = (id: string, account = owner): LedgerEvent => ({ id, network: 'testnet', account, lt: '1', hash,
    txId: `1:${hash}`, utime: 1_735_689_600, status: 'success', kind: 'transfer', actions: [], issues: [], movements: [], totalFeesRaw: '0' });
  const checks: string[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, application_name: schema, max: 6 });
    const store = new PostgresLedgerStore(pool);
    await store.initialize();
    async function prepare(events: LedgerEvent[], account = owner) {
      const generation = randomUUID();
      await store.begin('testnet', account, generation);
      await store.project(generation, { events, projectionScope: { kind: 'owner', owner: account, physicalAccounts: [account] } }, [], []);
      return generation;
    }
    const base = event('base'), first = await prepare([base]);
    await store.complete('testnet', owner, first);
    const a = await prepare([base, event('a')]), b = await prepare([base, event('b')]);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM ledger_accounts WHERE network=$1 AND account=$2 FOR UPDATE', ['testnet', owner]);
    let completed = 0;
    const tasks = [a, b].map(generation => store.complete('testnet', owner, generation).then(() => { completed += 1; }));
    let blocked = false;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const count = Number((await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [schema])).rows[0].count);
        if (count >= 2) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(blocked, 'both generation publications reach the same native owner-row lock');
      assert.equal(completed, 0);
      const unrelated = await prepare([event('other-owner', other)], other);
      await store.complete('testnet', other, unrelated);
      assert.equal(completed, 0, 'independent wallet publication does not release the blocked owner');
      checks.push('two simultaneous generations serialize at the owner row while another wallet publishes independently');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await Promise.all(tasks);
    const rows = (await pool.query('SELECT revision::text,generation,discovered_at FROM ledger_discovery_events WHERE network=$1 AND account=$2 ORDER BY revision', ['testnet', owner])).rows;
    assert.deepEqual(rows.map(row => row.revision), ['1', '2', '3']);
    assert.equal(new Set(rows.map(row => row.generation)).size, 3);
    assert(rows.every((row, index) => !index || new Date(row.discovered_at).getTime() >= new Date(rows[index - 1].discovered_at).getTime()));
    const head = (await pool.query('SELECT revision::text,generation FROM ledger_discovery_heads WHERE network=$1 AND account=$2', ['testnet', owner])).rows[0];
    assert.equal(head.revision, '3'); assert.equal(head.generation, rows[2].generation);
    checks.push('native concurrent commits publish exact consecutive revisions, monotonic publication times and the matching head');

    await pool.query(`CREATE FUNCTION reject_discovery_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_id='zzz-rejected' THEN RAISE EXCEPTION 'forced-discovery-rollback'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_discovery_fixture BEFORE INSERT ON ledger_discovery_events FOR EACH ROW EXECUTE FUNCTION reject_discovery_fixture()');
    const failed = await prepare([base, event('new-before-failure'), event('zzz-rejected')]);
    await assert.rejects(store.complete('testnet', owner, failed), /forced-discovery-rollback/);
    assert.deepEqual((await pool.query('SELECT revision::text,generation FROM ledger_discovery_heads WHERE network=$1 AND account=$2', ['testnet', owner])).rows[0], head);
    assert.equal((await pool.query('SELECT count(*)::text AS count FROM ledger_discovery_events WHERE generation=$1', [failed])).rows[0].count, '0');
    assert.equal((await pool.query('SELECT complete FROM ledger_runs WHERE generation=$1', [failed])).rows[0].complete, false);
    await pool.query('DROP TRIGGER reject_discovery_fixture ON ledger_discovery_events');
    const recovered = await prepare([base, event('after-rollback')]);
    await store.complete('testnet', owner, recovered);
    assert.equal((await pool.query('SELECT revision::text FROM ledger_discovery_heads WHERE network=$1 AND account=$2', ['testnet', owner])).rows[0].revision, '4');
    checks.push('partial insertion failure rolls back revisions and owner publication, releases locks, and the next generation reuses the uncommitted revision');
    const page = await store.discoveries('testnet', owner, { since: '2025-01-01T00:00:00.000Z', afterRevision: '3' });
    assert.deepEqual(page.revisions.map(row => row.revision), ['4']);
    assert.equal(page.coverage.generation, recovered);
    checks.push('the public discovery store returns the recovered exact revision and matching native coverage');
    console.log(JSON.stringify({ passed: checks.length, checks, engine: 'native PostgreSQL via node-postgres',
      scope: 'isolated random schema on an explicitly supplied loopback test instance; synthetic publications, no chain traffic' }, null, 2));
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
