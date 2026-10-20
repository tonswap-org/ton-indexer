import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { serializeTuple } from '@ton/core';
import { startWorker } from '../runtime/worker';
import { loadConfig } from '../config';
import { parseCanonicalReleaseManifest } from '../config/releaseManifest';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';
import { releaseDatabaseSchema } from '../releaseState';
import { assertLedgerDatabaseReady, readLedgerCatalog, RELEASE_IDENTITY_DDL } from '../ledger/schemaReadiness';
import type { LedgerSqlPool } from '../ledger/store';

const currentTime = Math.floor(Date.now() / 1_000);
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
  // Registered current Perps starts without the retired OPEN/CLOSE worker.
  // Qualified ledger decoders still require available canonical storage.
  const manifest = parseCanonicalReleaseManifest(base, 'testnet');
  const { pool, catalog } = await database(manifest.runtime.manifestHash);
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1', databaseUrl: 'postgres://offline.invalid/indexer',
    snapshotPath: undefined, snapshotOnExit: false, snapshotAutosaveEnabled: false, diskGuardPath: directory,
    liteserverPool: poolPath, blockPollMs: 100, rateLimitEnabled: false };
  const head = proofBlock(100, currentTime, -1);
  const peer = new FakeLiteEngine(async req => {
    if (req.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(head);
    if (req.kind === 'liteServer.runSmcMethod') return { id: req.id, shardblk: head.id, exitCode: 0,
      result: serializeTuple([{ type: 'int', value: 42n }]).toBoc() };
    throw new Error(`Unexpected offline-startup query ${req.kind}`);
  });
  peer.ready = false;
  let listened = false, databaseAttempts = 0, orderDatabaseAttempts = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('External discovery forbidden'); };
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const before = performance.now();
    worker = await startWorker(manifest, { config, logger,
      onReady() { listened = true; assert.equal(databaseAttempts, 0); assert.equal(fetchCalls, 0); },
      engineFactory() { assert(listened, 'chain socket creation occurs after listen'); return peer; },
      ledger: { catalog, poolFactory: async () => {
        assert(listened); databaseAttempts++;
        throw new Error('Synthetic ledger database connection refused');
      } },
      orders: { catalog, poolFactory: async () => {
        assert(listened); orderDatabaseAttempts++;
        throw new Error('Synthetic order database connection refused');
      } },
    });
    assert(performance.now() - before < 3_000); assert(worker.api.app.server.listening);
    assert.equal((await worker.api.app.inject('/api/indexer/v1/service-info')).statusCode, 200);
    const health = await worker.api.app.inject('/api/indexer/v1/health');
    assert.equal(health.statusCode, 503); assert(!('admission' in health.json()));
    assert.equal(worker.registry.PerpsEngine, base.contracts.PerpsEngine!.address);
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
    assert(databaseAttempts > 1, 'qualified ledger startup retries its unavailable database');
    assert(orderDatabaseAttempts > 0, 'independent order evidence retries its unavailable database');
    peer.ready = true;
    const getter = await worker.api.app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod',
      payload: { address: base.tokens[0].root, method: 'current_value', stack: [] } });
    assert.equal(getter.statusCode, 200); assert.equal(getter.json().exit_code, 0);
    await until(() => worker!.ledger.status() === 'unavailable');
    assert.equal(worker.bindings.currentLedgerDecodersQualified, true);
    assert.equal(worker.ledger.ledger(), undefined); assert(databaseAttempts > 1);
    const stillFenced = await worker.api.app.inject(`/api/indexer/v1/accounts/${base.tokens[0].root}/ledger`);
    assert.equal(stillFenced.statusCode, 503); assert.equal(stillFenced.json().code, 'ledger_unavailable');
    assert.equal((await worker.api.app.inject('/api/indexer/v1/health')).statusCode, 200, 'current chain health does not depend on the retired worker');
    const readiness = await worker.api.app.inject('/api/indexer/v1/ledger/readiness');
    assert.equal(readiness.statusCode, 503, 'chain health cannot manufacture ledger readiness');
    await worker.close();

    await assertLedgerDatabaseReady(pool, manifest.runtime.manifestHash, catalog);
    const bad = await database(manifest.runtime.manifestHash);
    try {
      await bad.db.exec('ALTER TABLE ledger_accounts ADD COLUMN unexpected_schema_column text');
      await assert.rejects(assertLedgerDatabaseReady(bad.pool, manifest.runtime.manifestHash, bad.catalog),
        /Durable ledger catalog differs from the canonical SQL schema/);
    } finally { await bad.pool.end(); }
    console.log('Current Perps starts without retired artifacts, listens before chain/DB, recovers chain while retaining ledger readiness fences, and rejects incompatible PGlite catalogs');
  } finally {
    globalThis.fetch = originalFetch;
    await worker?.close();
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
