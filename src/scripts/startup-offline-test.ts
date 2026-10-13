import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { serializeTuple } from '@ton/core';
import { startWorker } from '../runtime/worker';
import { createLedgerRuntime } from '../runtime/ledgerRuntime';
import { loadConfig } from '../config';
import { parseCanonicalReleaseManifest } from '../config/releaseManifest';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';
import { AdmissionError } from '../data/admission/protocol';
import { releaseDatabaseSchema } from '../releaseState';
import { readLedgerCatalog, RELEASE_IDENTITY_DDL } from '../ledger/schemaReadiness';
import type { LedgerSqlPool } from '../ledger/store';

async function database(manifestHash: string) {
  const db = new PGlite(), schema = releaseDatabaseSchema(manifestHash);
  await db.exec(`CREATE SCHEMA ${schema}; SET search_path=${schema}; ${RELEASE_IDENTITY_DDL}; ${readFileSync(resolve(__dirname, '../../sql/ledger.sql'), 'utf8')}`);
  await db.query('INSERT INTO release_identity (manifest_hash) VALUES ($1)', [manifestHash]);
  const catalog = await readLedgerCatalog(db, schema);
  const pool: LedgerSqlPool = {
    async query(sql, params) { return !params && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params); },
    connect: async () => pool, end: () => db.close(),
  };
  return { db, pool, catalog };
}
const until = async (condition: () => boolean, ms = 5_000) => {
  const end = performance.now() + ms;
  while (!condition()) { if (performance.now() >= end) throw new Error('Background recovery did not complete'); await delay(20); }
};
async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'indexer-offline-startup-'));
  const poolPath = join(directory, 'pool.json');
  writeFileSync(poolPath, JSON.stringify({ liteservers: [{ ip: 2130706433, port: 1, id: { type: 'pub.ed25519', key: Buffer.alloc(32, 1).toString('base64') } }] }));
  const base = runtimeManifestFixture();
  // A valid partial synthetic release: admission is configured, no T3 hub or
  // external token code pins qualify background settlement readers.
  const manifest = parseCanonicalReleaseManifest(runtimeManifestFixture({ contracts: {
    PerpsEngine: base.contracts.PerpsEngine, T3Root: base.contracts.T3Root }, perpsMarkets: [], options: [] }), 'testnet');
  const { pool, catalog } = await database(manifest.runtime.manifestHash);
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1', databaseUrl: 'postgres://offline.invalid/indexer',
    snapshotPath: undefined, snapshotOnExit: false, snapshotAutosaveEnabled: false, diskGuardPath: directory,
    liteserverPool: poolPath, blockPollMs: 100, rateLimitEnabled: false,
    perpsAdmissionArtifacts: { binaryPath: '/synthetic/pinned-binary', binarySha256: 'a'.repeat(64), configPath: '/synthetic/pinned-config', configSha256: 'b'.repeat(64) } };
  const head = proofBlock(100, 1_700_000_000, -1);
  const peer = new FakeLiteEngine(async req => {
    if (req.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(head);
    if (req.kind === 'liteServer.runSmcMethod') return { id: req.id, shardblk: head.id, exitCode: 0,
      result: serializeTuple([{ type: 'int', value: 42n }]).toBoc() };
    throw new Error(`Unexpected offline-startup query ${req.kind}`);
  });
  peer.ready = false;
  let listened = false, dbReady = false, databaseAttempts = 0, admissionStarted = false, admissionClosed = false;
  const poolSizes: number[] = [];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('External discovery forbidden'); };
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const before = performance.now();
    worker = await startWorker(manifest, { config, logger,
      onReady() { listened = true; assert.equal(databaseAttempts, 0); assert.equal(admissionStarted, false); assert.equal(fetchCalls, 0); },
      engineFactory() { assert(listened, 'chain socket creation occurs after listen'); return peer; },
      ledger: { catalog, poolFactory: async (_url, _hash, options) => {
        poolSizes.push(options!.size!);
        assert(listened); databaseAttempts++;
        if (!dbReady) throw new Error('Database connection refused');
        return pool;
      } },
      admission: { factory: options => ({ engine: options.engine, ready: false,
        async start() { assert(listened); admissionStarted = true; await new Promise<void>(() => {}); },
        async run() { throw new AdmissionError('admission_unavailable'); }, async close() { admissionClosed = true; } }) },
    });
    assert(performance.now() - before < 3_000); assert(worker.api.app.server.listening);
    assert.equal((await worker.api.app.inject('/api/indexer/v1/service-info')).statusCode, 200);
    const health = await worker.api.app.inject('/api/indexer/v1/health');
    assert.equal(health.statusCode, 503); assert.deepEqual(health.json().admission, { configured: true, ready: false });
    const unavailable = await worker.api.app.inject(`/api/indexer/v1/accounts/${base.tokens[0].root}/ledger`);
    assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.json().code, 'ledger_unavailable');
    assert(Number(unavailable.headers['retry-after']) >= 1);
    const offlineGetter = await worker.api.app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod', payload: { address: base.tokens[0].root, method: 'current_value', stack: [] } });
    assert.equal(offlineGetter.statusCode, 503); assert.equal(offlineGetter.json().code, 'upstream_unavailable'); assert(Number(offlineGetter.headers['retry-after']) >= 1);
    const offlineBalance = await worker.api.app.inject(`/api/indexer/v1/accounts/${base.tokens[0].root}/balances`);
    assert.equal(offlineBalance.statusCode, 503); assert.equal(offlineBalance.json().code, 'upstream_unavailable'); assert(Number(offlineBalance.headers['retry-after']) >= 1);
    await delay(5_050);
    assert(worker.api.app.server.listening, 'upstream failures do not terminate the listener');
    assert.equal(fetchCalls, 0); assert.equal(worker.ledger.ledger(), undefined);
    peer.ready = true; dbReady = true;
    const getter = await worker.api.app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod',
      payload: { address: base.tokens[0].root, method: 'current_value', stack: [] } });
    assert.equal(getter.statusCode, 200); assert.equal(getter.json().exit_code, 0);
    await until(() => worker!.ledger.status() === 'ready'); assert(worker.ledger.ledger());
    assert.deepEqual(poolSizes.slice(-2), [config.ledgerWorkers * 5 + 4, 10]);
    assert.equal((worker.ledger.ledger() as any).options.walletTemplateCodeHash, manifest.runtime.templates.JettonWallet);
    assert.deepEqual((worker.ledger.ledger() as any).options.dependencyPools, manifest.runtime.spotMarkets.map(market => market.pool));
    await worker.close(); assert(admissionClosed);

    const bad = await database(manifest.runtime.manifestHash);
    await bad.db.exec('ALTER TABLE ledger_accounts ADD COLUMN unexpected_schema_column text');
    let attempts = 0, reports = 0;
    const rejected = createLedgerRuntime({ ...worker, logger: { ...logger, warn() { reports++; } } }, {
      catalog: bad.catalog, poolFactory: async () => { attempts++; return bad.pool; },
    });
    rejected.start(); await until(() => rejected.status() === 'unavailable');
    await delay(2_100);
    assert.equal(attempts, 1, 'an incompatible catalog stays unavailable without a reconnect loop');
    assert.equal(reports, 1); assert.equal(rejected.ledger(), undefined); await rejected.stop();
    console.log('Offline startup listens before chain/DB/admission, survives outages, recovers chain and PGlite, and fences incompatible catalog');
  } finally {
    globalThis.fetch = originalFetch;
    await worker?.close();
    if (!dbReady) await pool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
