// This uses the same native Hub cells and explicit synthetic reserve transport as
// runtime-t3-binding-test.ts. It is not public chain/deployment qualification.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Address, beginCell, Cell, type TupleItem } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../config';
import { parseCanonicalReleaseManifest } from '../config/releaseManifest';
import { deriveRuntimeManifestBindings } from '../config/runtimeManifestBindings';
import { createLedgerRuntime } from '../runtime/ledgerRuntime';
import type { RuntimeDeps } from '../runtime/worker';
import { createRuntimeMetrics } from '../runtimeMetrics';
import { loadOpcodes } from '../utils/opcodes';
import { releaseDatabaseSchema } from '../releaseState';
import { readLedgerCatalog, RELEASE_IDENTITY_DDL } from '../ledger/schemaReadiness';
import type { LedgerSqlClient, LedgerSqlPool } from '../ledger/store';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { currentT3Fixture } from './support/currentT3Fixture';
import { fixtureHead } from './support/chainFixture';
import { fakeChainSource } from './support/fakeChainSource';

const log: Array<{ level: string; message: string; details?: unknown }> = [];
const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level,
  (message: string, details?: unknown) => { log.push({ level, message, details }); },
])) as Record<'info' | 'warn' | 'error' | 'debug', (message: string, details?: unknown) => void>;
const addressItem = (value: string): TupleItem => ({
  type: 'slice', cell: beginCell().storeAddress(Address.parse(value)).endCell(),
});
const fixtureCell = (file: string) => Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/current-t3', file)))[0];
const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    assert(performance.now() < deadline, 'current runtime bootstrap did not complete');
    await delay(5);
  }
};

function currentT3BootstrapFixture() {
  const native = currentT3Fixture(), base = runtimeManifestFixture();
  const latest = native.hubRows.at(-1)!;
  const walletCodes = [fixtureCell('stablecoin/JettonWallet.code.boc'),
    fixtureCell('stablecoin/JettonWallet.code.boc'), fixtureCell('hub/compiler/JettonV21Wallet.boc')];
  const masterCodes = [fixtureCell('stablecoin/JettonMinter.code.boc'),
    fixtureCell('stablecoin/JettonMinter.code.boc'), fixtureCell('hub/compiler/JettonV21Minter.boc')];
  const symbols = ['USDT', 'USDC', 'KUSD'] as const;
  const reserves = native.binding.reserveRoutes.map((route, index) => ({
    symbol: symbols[index], root: route.root, decimals: route.decimals,
    masterCodeHash: masterCodes[index].hash().toString('hex'),
    walletCodeHash: walletCodes[index].hash().toString('hex'),
  }));
  const contracts = { ...base.contracts,
    T3Hub: { address: native.hub, codeHash: native.binding.hubCodeHash },
    Governance: { ...base.contracts.Governance!, address: native.state.governance },
  };
  for (const token of reserves) contracts[token.symbol] = { address: token.root, codeHash: token.masterCodeHash };
  const runtime = runtimeManifestFixture({
    network: 'ton:localnet', globalId: -3, releaseId: `localnet-runtime-bootstrap-${'b'.repeat(12)}`,
    contracts,
    templates: { ...base.templates, T3Wallet: native.state.walletCodeHash,
      T3RecoveryProof: native.state.proofCodeHash, JettonV21Wallet: walletCodes[2].hash().toString('hex'),
      JettonV21Minter: masterCodes[2].hash().toString('hex') },
    vendor: { stablecoin: { ...base.vendor.stablecoin,
      minter: { ...base.vendor.stablecoin.minter, codeHash: masterCodes[0].hash().toString('hex') },
      wallet: { ...base.vendor.stablecoin.wallet, codeHash: walletCodes[0].hash().toString('hex') },
    } },
    tokens: base.tokens.map(token => token.symbol === 'T3'
      ? { ...token, root: native.hub, masterCodeHash: native.binding.hubCodeHash, walletCodeHash: native.state.walletCodeHash }
      : reserves.find(reserve => reserve.symbol === token.symbol) ?? token),
  });
  const manifest = parseCanonicalReleaseManifest(runtime, 'localnet');
  const head = fixtureHead(123, Math.floor(Date.now() / 1000));
  const reads: Array<{ account: string; method: string }> = [];
  const source = fakeChainSource({ network: 'localnet', head: async () => head,
    getAccountState: async (account, options) => {
      assert.equal(options?.at, head, 'bootstrap account reads share one head');
      reads.push({ account, method: 'account' });
      if (account === native.hub) return { accountState: 'active', balance: '0',
        codeBoc: latest.row.codeBoc, dataBoc: latest.row.afterDataBoc };
      const root = reserves.findIndex(token => token.root === account);
      if (root >= 0) return { accountState: 'active', balance: '0', codeBoc: masterCodes[root].toBoc().toString('base64') };
      const wallet = native.binding.reserveRoutes.findIndex(route => route.vault === account);
      if (wallet >= 0) return wallet === 2 ? { accountState: 'uninitialized', balance: '0' }
        : { accountState: 'active', balance: '0', codeBoc: walletCodes[wallet].toBoc().toString('base64'),
          lastTxLt: '1', lastTxHash: '1'.repeat(64) };
      // No fabricated empty state or histories for background product work.
      throw Error('Bootstrap fixture has no current account for this dependency');
    },
    runGetMethod: async (account, method, _args, options) => {
      assert.equal(options?.at, head, 'bootstrap getters share one head');
      reads.push({ account, method });
      const root = reserves.findIndex(token => token.root === account);
      const wallet = native.binding.reserveRoutes.findIndex(route => route.vault === account);
      if (root >= 0 && method === 'get_jetton_data') return { exitCode: 0, stack: [
        { type: 'int', value: 0n }, { type: 'int', value: -1n }, { type: 'null' },
        { type: 'cell', cell: Cell.EMPTY }, { type: 'cell', cell: walletCodes[root] },
      ] };
      if (root >= 0 && method === 'get_wallet_address') return { exitCode: 0,
        stack: [addressItem(native.binding.reserveRoutes[root].vault)] };
      if (wallet >= 0 && method === 'get_wallet_data') return { exitCode: 0, stack: [
        { type: 'int', value: 0n }, addressItem(native.hub), addressItem(reserves[wallet].root),
        { type: 'cell', cell: walletCodes[wallet] },
      ] };
      throw Error('Bootstrap fixture has no getter observation for this dependency');
    },
  });
  return { manifest, source, reads, native, reserves };
}

async function database(manifestHash: string) {
  const db = new PGlite(), schema = releaseDatabaseSchema(manifestHash);
  await db.exec(`CREATE SCHEMA ${schema}; SET search_path=${schema}; ${RELEASE_IDENTITY_DDL}; ${readFileSync(resolve(__dirname, '../../sql/ledger.sql'), 'utf8')}`);
  await db.query('INSERT INTO release_identity (manifest_hash) VALUES ($1)', [manifestHash]);
  const catalog = await readLedgerCatalog(db, schema);
  // PGlite has one SQL session. Serialize complete SQL transactions,
  // while retaining two distinct runtime pool handles and their real roles.
  // Actual multi-connection isolation belongs to the separately owned PG gate.
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous; return release;
  };
  const queries: Array<{ role: string; sql: string }> = [], ended: string[] = [];
  const pool = (role: 'worker' | 'read'): LedgerSqlPool => {
    let closed = false;
    const direct = async (sql: string, args?: any[]) => {
      assert(!closed, `${role} pool queried after shutdown`); queries.push({ role, sql });
      return !args && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, args);
    };
    return {
      async query(sql, args) { const release = await acquire(); try { return await direct(sql, args); } finally { release(); } },
      async connect(): Promise<LedgerSqlClient> {
        assert(!closed); let released = false, transactionUnlock: (() => void) | undefined;
        return {
          async query(sql, args) {
            assert(!released, 'released client queried');
            const command = sql.trim().split(/\s+/)[0].toUpperCase();
            if (command === 'BEGIN') {
              assert(!transactionUnlock, 'nested transaction'); transactionUnlock = await acquire();
              try { return await direct(sql, args); }
              catch (error) { transactionUnlock(); transactionUnlock = undefined; throw error; }
            }
            if (transactionUnlock) {
              try { return await direct(sql, args); }
              finally { if (command === 'COMMIT' || command === 'ROLLBACK') {
                transactionUnlock(); transactionUnlock = undefined;
              } }
            }
            const unlock = await acquire(); try { return await direct(sql, args); } finally { unlock(); }
          },
          release() { assert(!transactionUnlock, 'client released with an open transaction'); released = true; },
        };
      },
      async end() { assert(!closed, `${role} pool ended twice`); closed = true; ended.push(role); },
    };
  };
  return { db, schema, catalog, queries, ended, worker: pool('worker'), read: pool('read') };
}

async function main() {
  const fixture = currentT3BootstrapFixture();
  const bindings = deriveRuntimeManifestBindings(fixture.manifest.runtime);
  // Positive startup must use the actual derived binding, without a test override.
  assert.equal(bindings.currentLedgerDecodersQualified, true,
    'positive bootstrap requires the deliberately qualified current runtime');
  const metrics = createRuntimeMetrics(), config = { ...loadConfig(), network: 'localnet' as const,
    databaseUrl: 'postgres://127.0.0.1/runtime-bootstrap-owned-fixture', ledgerWorkers: 2,
    ledgerMaxWatchedAccounts: 4, ledgerMaxPagesPerSync: 1, ledgerMaxRelatedAccounts: 16 };
  // RuntimeDeps' source type is its concrete production adapter. This source
  // implements that existing ChainSource seam without replacing runtime classes.
  const deps = { config, manifest: fixture.manifest, registry: fixture.manifest.contracts,
    bindings, source: fixture.source, opcodes: loadOpcodes(), logger, metrics } as unknown as RuntimeDeps;

  let refusedAllocations = 0;
  const refused = createLedgerRuntime({ ...deps, bindings: { ...bindings, currentLedgerDecodersQualified: false } }, {
    poolFactory: async () => { refusedAllocations++; throw Error('False qualification must refuse before DB work'); },
  });
  try {
    refused.start(); await until(() => refused.status() === 'unavailable');
    assert.equal(refusedAllocations, 0); assert.equal(fixture.reads.length, 0);
    assert.equal(refused.ledger(), undefined); assert.equal(refused.market(), undefined); assert.equal(refused.readPool(), undefined);
  } finally { await refused.stop(); }

  const sql = await database(fixture.manifest.manifestHash);
  const allocations: Array<{ role?: string; size?: number; hash: string }> = [];
  const runtime = createLedgerRuntime(deps, { catalog: sql.catalog,
    poolFactory: async (url, hash, options) => {
      assert.equal(url, config.databaseUrl); assert.equal(hash, fixture.manifest.manifestHash);
      assert.equal(options?.metrics, metrics);
      allocations.push({ role: options?.role, size: options?.size, hash });
      assert(allocations.length <= 2, 'successful startup does not reconnect');
      return options?.role === 'worker' ? sql.worker : sql.read;
    },
  });
  try {
    runtime.start(); await until(() => runtime.status() === 'ready' || runtime.status() === 'unavailable');
    assert.equal(runtime.status(), 'ready', JSON.stringify(log));
    assert.deepEqual(allocations, [
      { role: 'worker', size: 2 * 5 + 4, hash: fixture.manifest.manifestHash },
      { role: 'read', size: 10, hash: fixture.manifest.manifestHash },
    ]);
    assert(runtime.ledger()); assert(runtime.market()); assert.equal(runtime.readPool(), sql.read);
    assert.equal(runtime.market()!.store.pool, sql.worker);
    assert.equal(runtime.market()!.store.schema, 'dlmm-market-ledger-v2');
    for (const market of bindings.currentMarketBindings) assert(runtime.market()!.configured(market.pool));
    assert(bindings.currentMarketBindings.length > 0, 'positive setup must include a current market');
    assert(fixture.reads.some(r => r.account === fixture.native.hub && r.method === 'account'));
    for (const reserve of fixture.reserves) for (const method of ['account', 'get_jetton_data', 'get_wallet_address'])
      assert(fixture.reads.some(r => r.account === reserve.root && r.method === method), `${reserve.symbol}:${method}`);
    for (const reserve of fixture.native.binding.reserveRoutes.slice(0, 2))
      assert(fixture.reads.some(r => r.account === reserve.vault && r.method === 'get_wallet_data'));
    assert(sql.queries.some(q => q.role === 'worker' && q.sql.includes('FROM release_identity')),
      'runtime validates the actual namespace/catalog before construction');
    // Stop scheduling with the real service method, then exercise its actual
    // current-schema read-store route independently of background fixture gaps.
    await runtime.market()!.stop();
    const before = sql.queries.length;
    const page = await runtime.market()!.page(bindings.currentMarketBindings[0].pool, {});
    assert.equal(page.coverage, null); assert('observations' in page); assert.equal(page.observations.length, 0);
    assert(sql.queries.slice(before).some(q => q.role === 'read' && q.sql.includes('market_heads')),
      'actual market page uses the separately constructed read pool');
    await runtime.stop();
    assert.deepEqual([...sql.ended].sort(), ['read', 'worker']);
    assert.equal(runtime.ledger(), undefined); assert.equal(runtime.market(), undefined); assert.equal(runtime.readPool(), undefined);
    const afterStop = sql.queries.length; await delay(20);
    assert.equal(sql.queries.length, afterStop, 'real shutdown drains scheduling and database work');
    await runtime.stop(); assert.equal(sql.ended.length, 2, 'runtime shutdown is idempotent');
  } finally { await runtime.stop(); await sql.db.close(); }
  console.log(JSON.stringify({ status: 'passed', poolRoles: allocations, ended: sql.ended, currentMarkets: bindings.currentMarketBindings.length, chainReads: fixture.reads.length, sqlQueries: sql.queries.length, falseBindingAllocations: refusedAllocations }));
  console.log('Current runtime bootstrap passed: explicit false gate refusal, canonical SQL/catalog, native T3 binding, worker/read roles, current v2 market and real shutdown. Synthetic fixture transport is not deployment qualification.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
