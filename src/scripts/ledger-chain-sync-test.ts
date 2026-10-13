import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import type { ChainHead, RawTransaction } from '../data/dataSource';
import { createRefreshDependency, syncOwnerChain, type ChainSyncDeps } from '../ledger/chainSync';
import { normalizeLedgerEvent } from '../ledger/normalize';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { loadOpcodes } from '../utils/opcodes';
import { fakeChainSource } from './support/fakeChainSource';

const owner = `0:${'1'.repeat(64)}`, hash = (n: number) => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex').toString('base64');
const head = (seqno: number): ChainHead => ({ seqno, utime: 1700000000 + seqno,
  workchain: -1, shard: '-9223372036854775808', rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) });
const tx = (n: number): RawTransaction => ({ lt: String(n), hash: hash(n), prevTransactionLt: String(n - 1), prevTransactionHash: hash(n - 1),
  utime: 1700000000 + n, success: true, status: 'success', totalFeesRaw: '0', outMessages: [] });
const opcodes = loadOpcodes();
async function main() {
  const db = new PGlite(), lockKeys: string[] = [], warnings: string[] = [];
  let lockBusy = false, reads = 0, pages = 0, failSource = false;
  const targets = new Map<string, number>();
  const pool: LedgerSqlPool = {
    query: async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) { lockKeys.push(params![0]); if (lockBusy) return { rows: [{ locked: false }] }; }
      return !params && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params);
    }, connect: async () => pool, end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool);
  const deps: ChainSyncDeps = { network: 'testnet', store, opcodes, maxPagesPerAccount: 20,
    resolveIdentity: async () => null,
    logger: { info() {}, debug() {}, error() {}, warn(_message, details) { warnings.push(String(details?.code)); } },
    source: fakeChainSource({
      getAccountState: async (account, options) => {
        reads++; assert(options?.at); assert.deepEqual(options.at, head(options.at.seqno));
        if (failSource) throw new Error('offline');
        const n = targets.get(account) ?? 2;
        return n ? { balance: '0', accountState: 'active', lastTxLt: String(n), lastTxHash: hash(n) }
          : { balance: '0', accountState: 'uninitialized' };
      },
      getTransactions: async (_account, limit, lt, h) => { pages++; assert.equal(limit, 100); assert.equal(h, hash(Number(lt))); return [tx(Number(lt))]; },
    }),
  };
  const refresh = createRefreshDependency(deps), cycle = { boundary: head(10) };
  async function seed(account: string, n: number, complete = true) {
    const generation = randomUUID();
    await store.begin('testnet', account, generation, { lt: String(n), hash: hash(n) });
    if (complete) {
      const raw = Array.from({ length: n }, (_, i) => tx(i + 1));
      await store.append(generation, await Promise.all(raw.map(t => normalizeLedgerEvent('testnet', account, t, opcodes))), raw);
      await store.complete('testnet', account, generation);
    }
    return generation;
  }
  try {
    await store.initialize();
    const stored = await seed(owner, 2);
    const first = await refresh(owner, cycle);
    assert.deepEqual(first, { account: owner, generation: stored, head: { lt: '2', hash: hash(2) }, complete: true, atBoundary: true, errorCode: null });
    assert.equal(pages, 0, 'same head performs no transaction queries');
    assert.equal(lockKeys[0], `ledger:public:testnet:${owner}`);

    const resumed = `0:${'2'.repeat(64)}`, old = await seed(resumed, 2, false);
    targets.set(resumed, 3);
    const limited = createRefreshDependency({ ...deps, maxPagesPerAccount: 2 });
    const partial = await limited(resumed, cycle);
    assert.equal(partial.generation, old); assert.equal(partial.head?.lt, '2');
    assert.equal(partial.complete, true); assert.equal(partial.atBoundary, false); assert.equal(partial.errorCode, 'page_allowance');
    const recovered = await limited(resumed, cycle);
    assert.equal(recovered.head?.lt, '3'); assert.equal(recovered.atBoundary, true); assert.equal(recovered.errorCode, null);
    assert.deepEqual((await store.rawHistory(recovered.generation!)).map(row => row.raw.lt), ['1', '2', '3']);

    const beforePages = pages;
    for (let i = 100; i < 125; i++) {
      const account = `0:${i.toString(16).padStart(64, '0')}`;
      const result = await refresh(account, cycle);
      assert.equal(result.atBoundary, true, `account ${i} owns its full allowance`);
    }
    assert.equal(pages - beforePages, 50, '25 independent accounts each read two pages');
    failSource = true;
    const failure = await refresh(owner, cycle);
    assert.equal(failure.generation, stored); assert.equal(failure.complete, true); assert.equal(failure.atBoundary, false); assert.equal(failure.errorCode, 'source_unavailable');
    const warningCount = warnings.length;
    await refresh(owner, cycle); assert.equal(warnings.length, warningCount, 'unchanged failure is not logged repeatedly');
    failSource = false;
    await refresh(owner, cycle);
    failSource = true; await refresh(owner, cycle); assert.equal(warnings.length, warningCount + 1, 'a new failure after recovery is logged'); failSource = false;

    const beforeReads = reads;
    const otherFactory = createRefreshDependency(deps);
    const [a, b] = await Promise.all([refresh(owner, cycle), otherFactory(owner, cycle)]);
    assert.deepEqual(a, b); assert.equal(reads - beforeReads, 1, 'same-store factories share account singleflight');
    lockBusy = true;
    const locked = await refresh(owner, cycle);
    assert.equal(locked.generation, stored); assert.equal(locked.atBoundary, false); assert.equal(locked.errorCode, 'lock_busy');
    assert.equal(reads - beforeReads, 1, 'foreign lock never triggers a source read');
    lockBusy = false;

    // Owner history completion must never publish before the caller projects.
    const projectedOwner = `0:${'3'.repeat(64)}`, prior = await seed(projectedOwner, 1);
    await seed(projectedOwner, 2, false); targets.set(projectedOwner, 3);
    const ownerResult = await syncOwnerChain(deps, projectedOwner, cycle);
    assert('generation' in ownerResult); assert.equal(ownerResult.head?.lt, '3');
    assert.equal((await store.account('testnet', projectedOwner)).current_generation, prior);
    assert.equal((await pool.query('SELECT complete,source_complete FROM ledger_runs WHERE generation=$1', [ownerResult.generation])).rows[0].complete, false);
    assert.equal((await pool.query('SELECT complete,source_complete FROM ledger_runs WHERE generation=$1', [ownerResult.generation])).rows[0].source_complete, true);
    assert.deepEqual((await store.rawHistory(ownerResult.generation)).map(row => row.raw.lt), ['1', '2', '3']);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_projection_coverage WHERE generation=$1', [ownerResult.generation])).rows[0].count, 0);
    const alien = await seed(`0:${'4'.repeat(64)}`, 1, false);
    assert.equal(await store.copySourceTail(alien, ownerResult.generation, '1', hash(1)), false, 'unpublished tail cannot cross physical account scope');

    // Different boundaries wait on the existing work, then make their own read.
    const boundaryAccount = `0:${'5'.repeat(64)}`;
    let unblock!: () => void;
    const barrier = new Promise<void>(resolve => { unblock = resolve; });
    let boundaryReads = 0;
    const atSource = fakeChainSource({ ...deps.source, getAccountState: async (_account, options) => {
      boundaryReads++; if (boundaryReads === 1) await barrier;
      const n = options!.at!.seqno;
      return { balance: '0', accountState: 'active', lastTxLt: String(n), lastTxHash: hash(n) };
    } });
    const perBoundary = createRefreshDependency({ ...deps, source: atSource });
    const h1 = perBoundary(boundaryAccount, { boundary: head(1) }), h2 = perBoundary(boundaryAccount, { boundary: head(2) });
    unblock();
    const [at1, at2] = await Promise.all([h1, h2]);
    assert.equal(boundaryReads, 2); assert.equal(at1.head?.lt, '1'); assert.equal(at2.head?.lt, '2'); assert(at1.atBoundary && at2.atBoundary);
    const stale = await perBoundary(boundaryAccount, { boundary: head(1) });
    assert.equal(stale.atBoundary, false); assert.equal(stale.errorCode, 'boundary_behind'); assert.equal(stale.head?.lt, '2');

    const empty = `0:${'6'.repeat(64)}`; targets.set(empty, 0);
    const beforeEmpty = pages;
    const emptyResult = await refresh(empty, cycle);
    assert.equal(emptyResult.head, null); assert(emptyResult.complete && emptyResult.atBoundary); assert.equal(pages, beforeEmpty);
    // A crash after begin() on an empty chain still resumes as a verified empty run.
    const emptyResume = `0:${'7'.repeat(64)}`, emptyGeneration = randomUUID();
    targets.set(emptyResume, 0); await store.begin('testnet', emptyResume, emptyGeneration);
    assert.equal((await refresh(emptyResume, cycle)).generation, emptyGeneration);
    const badChain = `0:${'8'.repeat(64)}`;
    const unlinked = createRefreshDependency({ ...deps, source: fakeChainSource({ ...deps.source,
      getTransactions: async () => [{ ...tx(2), prevTransactionHash: hash(0) }],
    }) });
    const invalid = await unlinked(badChain, cycle);
    assert.equal(invalid.atBoundary, false); assert.equal(invalid.errorCode, 'history_chain_unverified');
    assert.equal(invalid.generation, null, 'unlinked chain never publishes');
    const aborted = new AbortController(); aborted.abort();
    const cancelled = await refresh(owner, { ...cycle, signal: aborted.signal });
    assert.equal(cancelled.atBoundary, false); assert.equal(cancelled.generation, stored);
    console.log('chain refresh: exact boundary, deferred old head, 25 independent allowances, source failure, shared flights, foreign locks, schema key, open owner and monotonic heads passed');
  } finally { await db.close(); }
  if (process.env.INDEXER_TEST_DATABASE_URL) await nativeLocks(process.env.INDEXER_TEST_DATABASE_URL);
}

async function nativeLocks(connectionString: string) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname), 'native tests require an isolated loopback database');
  const names = [0, 1].map(() => `chainsync_${randomUUID().replace(/-/g, '')}`);
  const admin = new Pool({ connectionString, max: 1 }), pools: Pool[] = [];
  try {
    for (const name of names) {
      await admin.query(`CREATE SCHEMA ${name}`);
      pools.push(new Pool({ connectionString, options: `-c search_path=${name}`, max: 5 }));
    }
    const stores = pools.map(pool => new PostgresLedgerStore(pool));
    for (const store of stores) await store.initialize();
    const generation = randomUUID();
    await stores[0].begin('testnet', owner, generation);
    await stores[0].complete('testnet', owner, generation);
    const blocker = await pools[0].connect(), key = `ledger:${names[0]}:testnet:${owner}`;
    try {
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      const refresh = createRefreshDependency({ network: 'testnet', store: stores[0], source: fakeChainSource(), opcodes,
        resolveIdentity: async () => null, maxPagesPerAccount: 20, logger: { info() {}, warn() {}, error() {}, debug() {} } });
      const result = await refresh(owner, { boundary: head(1) });
      assert.equal(result.errorCode, 'lock_busy'); assert.equal(result.generation, generation); assert.equal(result.atBoundary, false);
      let ran = false;
      assert(await stores[1].withAccountLock('testnet', owner, async () => { ran = true; }));
      assert(ran, 'another release schema never waits for the first release lock');
    } finally { await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); blocker.release(); }
    assert(await stores[0].withAccountLock('testnet', owner, async () => {}));
    console.log('native PostgreSQL: foreign-session lock preserves stored facts; two release schemas do not block one another');
  } finally {
    for (const pool of pools) await pool.end();
    for (const name of names) await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await admin.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
