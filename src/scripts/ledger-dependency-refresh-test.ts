import { createRefreshDependency } from '../ledger/chainSync';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ChainHead } from '../data/dataSource';
import { LedgerService } from '../ledger/service';
import { LedgerGraphBuilder } from '../ledger/graph';
import type { LedgerChain } from '../ledger/project';
import type { OwnerCycle, RefreshDependency } from '../ledger/cycle';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { decodeBindings } from '../ledger/publication';
import { loadOpcodes } from '../utils/opcodes';
import { createLogger } from '../utils/logger';
import { fixtureChainSource, fixtureHead } from './support/chainFixture';
import { installFixtureIdentities } from './support/ledgerGraphFixture';
import { currentT3MintFixture as mint } from './support/currentT3Fixture';

/** SQL/chain/publication integration uses the existing exact mint proof graph.
 * Only product discovery is injected: qualification is separately exercised by
 * ledger-identities/graph-load/owner-graph, while projectOwnerLedger is real here. */
export async function cycleHarness(nativeUrl?: string) {
  const f = mint(), owner = f.input.owner, hub = f.config.address, vault = f.config.vaults[0];
  const db = nativeUrl ? null : new PGlite();
  const native = nativeUrl ? new Pool({ connectionString: nativeUrl, max: 8 }) : null;
  const schema = `test_publish_${randomUUID().replaceAll('-', '')}`;
  if (native) await native.query(`CREATE SCHEMA ${schema}`);
  const controls = { failed: '', busy: '', bindingFailed: '', rawFailed: '', archiveProofs: false, archiveFailed: false, skipMint: false, checkpointFailure: false, pages: 0, getters: 0, projects: 0,
    heads: 0, batches: 0, graphBuilds: 0, seqno: 100, utime: Math.floor(Date.now() / 1000), pageSize: 100 };
  const pins: ChainHead[] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes('pg_try_advisory_lock') && controls.busy && String(params?.[0]).endsWith(`:${controls.busy}`)) return { rows: [{ locked: false }] };
    if (sql.includes('SELECT snapshot FROM ledger_account_states') && controls.archiveFailed) throw new Error('archive row unavailable');
    if (sql.includes('INSERT INTO ledger_owner_checks') && controls.checkpointFailure) throw new Error('injected checkpoint failure');
    if (native) {
      const client = await native.connect();
      try { await client.query(`SET search_path TO ${schema},public`); return await client.query(sql, params); }
      finally { client.release(); }
    }
    return !params && sql.includes(';') ? { rows: (await db!.exec(sql)).at(-1)?.rows ?? [] } : db!.query(sql, params);
  };
  const pool: LedgerSqlPool = { query, connect: async () => {
    if (!native) return pool;
    const client = await native.connect(); await client.query(`SET search_path TO ${schema},public`);
    return { query: async (sql, params) => {
      if (sql.includes('INSERT INTO ledger_owner_checks') && controls.checkpointFailure) throw new Error('injected checkpoint failure');
      return client.query(sql, params);
    }, release: () => client.release() };
  }, end: async () => { if (native) { await native.query(`DROP SCHEMA ${schema} CASCADE`); await native.end(); } else await db!.close(); } };
  const source = fixtureChainSource({ physicalCurrentReads: true, network: 'localnet', head: async () => { controls.heads++; return { seqno: controls.seqno, utime: controls.utime }; },
    getAccountState: async (account, options) => {
      assert(options?.at, 'every current account read names the cycle boundary'); pins.push(options.at);
      if (controls.failed === account) throw new Error('source offline');
      const latest = f.input.chains.get(account)?.transactions.at(-1);
      return { balance: '0', accountState: latest ? 'active' : 'uninitialized', lastTxLt: latest?.lt, lastTxHash: latest?.hash };
    },
    getTransactions: async (account, limit, lt) => {
      controls.pages++;
      return (f.input.chains.get(account)?.transactions ?? []).filter(tx => BigInt(tx.lt) <= BigInt(lt)).slice().reverse().slice(0, Math.min(limit, controls.pageSize));
    },
    walletBalance: async (party, root) => { const asset = [...f.input.wallets.values()].find(row => row.owner === party && row.master === root);
      return asset?.wallet ? { wallet: asset.wallet, balance: '0' } : null; },
    runGetMethod: async (_account, _method, _args, options) => { controls.getters++; assert(options?.at); pins.push(options.at); return { exitCode: 0, stack: [] }; },
  });
  const read = source.read.bind(source);
  source.read = async (...args) => { controls.batches++; return read(...args); };
  const store = new PostgresLedgerStore(pool); await store.initialize();
  const rawHistory = store.rawHistory.bind(store);
  store.rawHistory = async generation => {
    if (controls.rawFailed) {
      const row = (await pool.query('SELECT account FROM ledger_runs WHERE generation=$1', [generation])).rows[0];
      if (row?.account === controls.rawFailed) throw new Error('database row unavailable');
    }
    return rawHistory(generation);
  };
  const project = store.project.bind(store);
  store.project = async (...args) => { controls.projects++; return project(...args); };
  const originalBuild = LedgerGraphBuilder.prototype.build;
  LedgerGraphBuilder.prototype.build = async function (account, generation, cycle) {
    controls.graphBuilds++;
    const chains = new Map<string, LedgerChain>(), pendingAccounts: string[] = [];
    const refresh = (this as unknown as { refresh: RefreshDependency }).refresh;
    for (const [address, template] of f.input.chains) {
      if (address === account) {
        const row = (await pool.query('SELECT head_lt::text,head_hash FROM ledger_runs WHERE generation=$1', [generation])).rows[0];
        chains.set(address, { ...template, generation, headLt: row.head_lt, headHash: row.head_hash, atBoundary: true, historyComplete: true,
          transactions: (await store.rawHistory(generation)).map(row => row.raw) });
      } else {
        const current = await refresh(address, cycle);
        if (!current.atBoundary) pendingAccounts.push(address);
        chains.set(address, { ...template, generation: current.generation, headLt: current.head?.lt ?? null, headHash: current.head?.hash ?? null,
          historyComplete: current.complete, atBoundary: current.atBoundary,
          transactions: current.generation ? (await store.rawHistory(current.generation)).map(row => row.raw) : [] });
      }
    }
    const bindings: Record<string, boolean> = { [`t3:${hub}`]: controls.bindingFailed !== 'hub', wallet: controls.bindingFailed !== 'wallet', engine: controls.bindingFailed !== 'engine' };
    let stateAt = f.input.stateAt;
    let publicationBindings = bindings;
    if (controls.archiveProofs) {
      // Use the production graph's archive accessor against actual SQL, while
      // the domain fixture supplies the already-qualified immutable snapshots.
      const archiveStore = { pool, rawHistory: async () => [] } as unknown as PostgresLedgerStore;
      const archiveBuilder = new LedgerGraphBuilder('localnet', source, archiveStore, [], undefined,
        {} as import('../ledger/identities').WalletIdentityStore, async () => { throw new Error('unexpected archive graph dependency'); });
      const archiveGraph = await originalBuild.call(archiveBuilder, account, generation, cycle);
      publicationBindings = Object.assign(archiveGraph.bindings, bindings);
      stateAt = async (address, lt, hash) => {
        if (!controls.archiveFailed) {
          const snapshot = await f.input.stateAt(address, lt, hash);
          if (snapshot) await pool.query(`INSERT INTO ledger_account_states(network,account,lt,hash,snapshot)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, ['localnet', address, lt, hash, JSON.stringify(snapshot)]);
        }
        return archiveGraph.stateAt(address, lt, hash);
      };
    }
    return { ...f.input, chains, t3Hubs: controls.bindingFailed === 'hub' || controls.skipMint ? new Map() : f.input.t3Hubs, stateAt,
      optionFactories: new Map(), launchpadSales: new Map(), launchpadControllers: [], optionControllers: [], perpsEngines: new Map(), marketBindings: new Map(),
      checkedAt: new Date().toISOString(), boundary: cycle.boundary, pendingAccounts,
      bindings: publicationBindings, issues: pendingAccounts.length ? ['related_account_refresh_pending'] : [] } as Awaited<ReturnType<typeof originalBuild>>;
  };
  const service = new LedgerService('localnet', store, source, loadOpcodes(), createLogger('silent'), 2, { maxPagesPerSync: 20 });
  installFixtureIdentities(service, source, f.input.wallets);
  return { f, owner, hub, vault, controls, pins, source, pool, store, service, schema, native,
    due: async () => { await pool.query('UPDATE ledger_owner_checks SET unresolved=true WHERE account=$1', [owner]); },
    page: () => store.page('localnet', owner),
    runs: async () => (await pool.query('SELECT count(*)::int AS count FROM ledger_runs WHERE account=$1', [owner])).rows[0].count as number,
    close: async () => { LedgerGraphBuilder.prototype.build = originalBuild; await service.stop(); await pool.end(); } };
}
const confirmed = (page: Awaited<ReturnType<PostgresLedgerStore['page']>>) => page.events.find(event => event.kind === 't3_mint' && event.settlement?.status === 'confirmed');
async function main() {
  const h = await cycleHarness();
  try {
    assert.equal((await h.service.runOwnerCycle(h.owner)).status, 'published');
    const first = await h.page(); assert(confirmed(first), JSON.stringify(first.events));
    const frozen = (await h.pool.query('SELECT * FROM ledger_projection_coverage WHERE generation=$1', [first.coverage.generation])).rows;
    const runs = await h.runs();
    for (const failure of ['source', 'busy', 'row', 'wallet', 'hub', 'engine']) {
      await h.due();
      if (failure === 'source') h.controls.failed = h.vault;
      if (failure === 'busy') h.controls.busy = h.vault;
      if (failure === 'row') h.controls.rawFailed = h.vault;
      if (['wallet', 'hub', 'engine'].includes(failure)) h.controls.bindingFailed = failure;
      await h.service.runOwnerCycle(h.owner);
      const page = await h.page();
      assert.equal(page.coverage.generation, first.coverage.generation, failure); assert(confirmed(page), failure);
      assert(page.coverage.refreshPending!.length > 0, failure); assert(page.coverage.issues.includes('related_account_refresh_pending'));
      assert.equal(page.coverage.historyComplete, first.coverage.historyComplete);
      assert.equal(await h.runs(), runs, 'failed unchanged-owner checks allocate no generation');
      assert.deepEqual((await h.pool.query('SELECT * FROM ledger_projection_coverage WHERE generation=$1', [first.coverage.generation])).rows, frozen);
      const checkpoint = decodeBindings((await h.store.ownerCheck('localnet', h.owner))!.bindings)!;
      assert.equal(checkpoint.published!.generation, first.coverage.generation);
      assert.equal(checkpoint.published!.bindings[`t3:${h.hub}`], true);
      h.controls.failed = ''; h.controls.busy = ''; h.controls.rawFailed = ''; h.controls.bindingFailed = '';
    }
    // Repeated false diagnostics never replace true published authority.
    h.controls.bindingFailed = 'hub';
    for (let i = 0; i < 3; i++) {
      await h.service.runOwnerCycle(h.owner); assert.equal((await h.page()).coverage.generation, first.coverage.generation);
    }
    h.controls.bindingFailed = '';
    await h.service.runOwnerCycle(h.owner);
    h.f.tx(h.hub); await h.service.runOwnerCycle(h.owner);
    assert.equal((await h.page()).coverage.generation, first.coverage.generation, 'keeper-only hub head never republishes owner economics');
    // Fifty deterministic pseudo-random outages across different check stages.
    let random = 0x17b;
    for (let i = 0; i < 50; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      await h.due(); h.controls.failed = random % 2 ? h.vault : ''; h.controls.bindingFailed = random % 3 ? '' : 'hub';
      await h.service.runOwnerCycle(h.owner); assert(confirmed(await h.page()));
    }
    h.controls.bindingFailed = ''; h.controls.failed = h.vault;
    h.f.tx(h.owner); // Owner progress must not wait for a stale but intact old dependency.
    const newResult = await h.service.runOwnerCycle(h.owner), next = await h.page();
    assert.equal(newResult.status, 'published'); assert(confirmed(next)); assert(next.coverage.refreshPending!.length > 0);
    assert(next.events.length > first.events.length); assert.equal(newResult.confirmedRegressions, 0);
    for (const event of first.events) assert(next.events.some(row => row.id === event.id), 'no old operation disappears');
    h.controls.failed = ''; await h.service.runOwnerCycle(h.owner);
    const beforeAtomic = await h.page(), checkpoint = await h.store.ownerCheck('localnet', h.owner);
    h.f.tx(h.owner); h.controls.checkpointFailure = true;
    assert.equal((await h.service.runOwnerCycle(h.owner)).status, 'kept');
    assert.equal((await h.page()).coverage.generation, beforeAtomic.coverage.generation);
    assert.deepEqual(await h.store.ownerCheck('localnet', h.owner), checkpoint, 'checkpoint failure rolls publication back');
    const latest = await h.store.account('localnet', h.owner);
    assert.equal((await h.pool.query('SELECT complete FROM ledger_runs WHERE generation=$1', [latest.latest_generation])).rows[0].complete, false);
    h.controls.checkpointFailure = false;
    assert.equal((await h.service.runOwnerCycle(h.owner)).status, 'published', 'atomic failure resumes without losing the transaction');
    const recovered = await h.page();
    assert.equal(decodeBindings((await h.store.ownerCheck('localnet', h.owner))!.bindings)!.published!.generation, recovered.coverage.generation);
    const ownerBeforeDependency = await h.page();
    const ownerCheckpoint = await h.store.ownerCheck('localnet', h.owner);
    const discoveryHead = (await h.pool.query('SELECT * FROM ledger_discovery_heads WHERE account=$1', [h.owner])).rows;
    h.f.tx(h.owner);
    const refreshOwnerAsDependency = createRefreshDependency({ network: 'localnet', store: h.store, source: h.source,
      opcodes: loadOpcodes(), logger: createLogger('silent'), resolveIdentity: async wallet => h.f.input.wallets.get(wallet) ?? null, maxPagesPerAccount: 20 });
    const dependencyResult = await refreshOwnerAsDependency(h.owner, { boundary: fixtureHead(h.controls.seqno, h.controls.utime) });
    assert(dependencyResult.complete && dependencyResult.atBoundary);
    assert.notEqual(dependencyResult.generation, ownerBeforeDependency.coverage.generation, 'new physical head is available to the depending graph');
    assert.equal((await h.page()).coverage.generation, ownerBeforeDependency.coverage.generation, 'dependency collection preserves owner publication');
    assert.deepEqual(await h.store.ownerCheck('localnet', h.owner), ownerCheckpoint);
    assert.deepEqual((await h.pool.query('SELECT * FROM ledger_discovery_heads WHERE account=$1', [h.owner])).rows, discoveryHead);
    const pagesBeforeRepeat = h.controls.pages;
    assert.equal((await refreshOwnerAsDependency(h.owner, { boundary: fixtureHead(h.controls.seqno, h.controls.utime) })).generation, dependencyResult.generation);
    assert.equal(h.controls.pages, pagesBeforeRepeat, 'repeated dependency check reuses the physical head');
    assert.equal((await h.service.runOwnerCycle(h.owner)).status, 'published');
    assert(confirmed(await h.page()));

  } finally { await h.close(); }

  const pending = await cycleHarness();
  try {
    // Keep an authenticated pre-mint hub chain; then reveal the full mint while
    // that dependency is unavailable. The decoder receives stored raw history.
    const full = pending.f.input.chains.get(pending.hub)!.transactions;
    pending.f.input.chains.get(pending.hub)!.transactions = full.slice(0, 1);
    await pending.service.runOwnerCycle(pending.owner);
    pending.f.input.chains.get(pending.hub)!.transactions = full;
    pending.controls.failed = pending.hub; await pending.due();
    await pending.service.runOwnerCycle(pending.owner);
    const page = await pending.page();
    assert(!confirmed(page)); assert(page.coverage.refreshPending!.length > 0);
    assert(!page.events.some(event => event.issues.includes('t3_mint_settlement_unconfirmed')), 'stale absence cannot become a terminal negative');
    assert((await pending.store.rawHistory((await pending.store.account('localnet', pending.hub)).current_generation)).length > 0);
    pending.controls.failed = '';
    await pending.service.runOwnerCycle(pending.owner); assert(confirmed(await pending.page()), 'next scheduled cycle confirms without a client request');
    // Many changed dependencies each retain their own 20-page allowance.
    pending.controls.pageSize = 1;
    for (let i = 1000; i < 1025; i++) {
      const account = `0:${i.toString(16).padStart(64, '0')}`;
      pending.f.input.chains.set(account, { account, generation: null, role: 'counterparty', historyComplete: false, transactions: [] });
      for (let j = 0; j < 20; j++) pending.f.tx(account);
    }
    pending.f.tx(pending.hub); await pending.due();
    await pending.service.runOwnerCycle(pending.owner);
    assert(confirmed(await pending.page()));
    assert.deepEqual((await pending.store.ownerCheck('localnet', pending.owner))!.pendingAccounts, []);
  } finally { await pending.close(); }
  const archive = await cycleHarness();
  try {
    archive.controls.archiveProofs = true;
    await archive.service.runOwnerCycle(archive.owner);
    const first = await archive.page(); assert(confirmed(first));
    const published = decodeBindings((await archive.store.ownerCheck('localnet', archive.owner))!.bindings)!.published!;
    const keys = Object.keys(published.bindings).filter(key => key.startsWith('archive:'));
    assert(keys.length > 0 && keys.every(key => published.bindings[key]), 'project-time stateAt proof bindings are captured atomically');
    archive.controls.archiveFailed = true;
    await archive.due();
    await archive.service.runOwnerCycle(archive.owner);
    assert.equal((await archive.page()).coverage.generation, first.coverage.generation);
    assert(confirmed(await archive.page()), 'decoder-caught project-time SQL failures retain the confirmed mint');
    archive.controls.skipMint = true;
    archive.f.tx(archive.owner);
    await archive.service.runOwnerCycle(archive.owner);
    const current = decodeBindings((await archive.store.ownerCheck('localnet', archive.owner))!.bindings)!;
    assert(keys.every(key => current.current[key] === false), 'skipped prior archives are reevaluated before the input rule');
    assert.equal((await archive.page()).coverage.generation, first.coverage.generation);
    assert(confirmed(await archive.page()));
    assert.deepEqual(current.published, published);
    archive.controls.archiveFailed = false; archive.controls.skipMint = false;
    assert.equal((await archive.service.runOwnerCycle(archive.owner)).status, 'published');
    assert(confirmed(await archive.page()));
  } finally { await archive.close(); }

  const resumed = await cycleHarness();
  try {
    // The retained native owner has 33 transactions. Establish its original
    // publication first so this vector isolates the dependency's page allowance.
    await resumed.service.runOwnerCycle(resumed.owner);
    assert(confirmed(await resumed.page()));
    resumed.controls.pageSize = 1;
    for (let index = 0; index < 25; index++) resumed.f.tx(resumed.hub);
    await resumed.due();
    await resumed.service.runOwnerCycle(resumed.owner);
    assert((await resumed.page()).coverage.refreshPending!.length > 0);
    const h1 = (await resumed.store.account('localnet', resumed.hub)).latest_generation;
    assert.equal((await resumed.pool.query('SELECT complete FROM ledger_runs WHERE generation=$1', [h1])).rows[0].complete, false);
    resumed.f.tx(resumed.hub); // H2 arrives while H1 is still a deferred backfill.
    await resumed.service.runOwnerCycle(resumed.owner);
    const page = await resumed.page();
    assert(confirmed(page));
    const actual = resumed.f.input.chains.get(resumed.hub)!.transactions.at(-1)!;
    assert.equal((await resumed.store.account('localnet', resumed.hub)).head_lt, actual.lt);
    assert(!page.events.some(event => event.issues.includes('t3_mint_settlement_unconfirmed')));
  } finally { await resumed.close(); }
  if (process.env.INDEXER_TEST_DATABASE_URL) await nativeLocks(process.env.INDEXER_TEST_DATABASE_URL);
  console.log('dependency refresh: preserved mint, locks/storage/bindings, 50 failures, owner progress, keeper, recovery, 25 allowances and atomic checkpoint passed');
}
async function nativeLocks(url: string) {
  const parsed = new URL(url); assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
  const h = await cycleHarness(url);
  try {
    await h.service.runOwnerCycle(h.owner); const before = await h.page();
    const second = await h.native!.connect(), key = `ledger:${h.schema}:localnet:${h.vault}`;
    try {
      await second.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      await h.due(); await h.service.runOwnerCycle(h.owner);
      assert.equal((await h.page()).coverage.generation, before.coverage.generation); assert((await h.page()).coverage.refreshPending!.length > 0);
    } finally { await second.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); second.release(); }
    await h.pool.query("UPDATE ledger_accounts SET error_code='source_unavailable' WHERE account=$1", [h.vault]);
    h.controls.failed = h.vault; await h.due(); await h.service.runOwnerCycle(h.owner);
    assert(confirmed(await h.page())); assert((await h.page()).coverage.refreshPending!.length > 0);
  } finally { await h.close(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
