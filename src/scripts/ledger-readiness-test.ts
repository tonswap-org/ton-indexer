import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { authenticateLedgerBuild, fingerprintLedgerBuild, type AuthenticatedLedgerBuild } from '../ledger/buildIdentity';
import { registerLedgerReadinessRoute } from '../ledger/readiness';
import { assertLedgerDatabaseReady, RELEASE_IDENTITY_DDL } from '../ledger/schemaReadiness';
import type { LedgerSqlPool } from '../ledger/store';
import type { RegistryMetadata } from '../config/releaseManifest';
import { releaseDatabaseSchema } from '../releaseState';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

const root = resolve(__dirname, '../..');
const sql = readFileSync(join(root, 'sql/ledger.sql'), 'utf8');
const runtime = runtimeManifestFixture({ services: { indexer: 'https://test.tonswap.org/api/indexer',
  tonRpc: 'https://testnet.toncenter.com/api/v2/jsonRPC', platform: 'https://test.tonswap.org/api/platform' } });
const metadata: RegistryMetadata = { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' };
const schema = releaseDatabaseSchema(runtime.manifestHash);
const route = '/api/indexer/v1/ledger/readiness';

async function main() {
  // This is an explicitly disposable, newly owned unit-test fixture. No release
  // candidates, running service, credentials or operational journals are copied.
  const fixture = mkdtempSync(join(tmpdir(), 'ton-indexer-readiness-unit-'));
  const db = new PGlite();
  try {
    cpSync(join(root, 'dist'), join(fixture, 'dist'), { recursive: true });
    mkdirSync(join(fixture, 'sql'));
    writeFileSync(join(fixture, 'sql/ledger.sql'), sql);
    const rewriteId = () => writeFileSync(join(fixture, 'dist/build-id.json'), JSON.stringify(fingerprintLedgerBuild(fixture)) + '\n');
    const build = authenticateLedgerBuild(fixture);
    const independentlySorted = Object.fromEntries(Object.keys(build.identity.files).sort().map(path =>
      [path, createHash('sha256').update(readFileSync(join(fixture, path))).digest('hex')]));
    assert.equal(build.identity.sha256, createHash('sha256').update(JSON.stringify(independentlySorted)).digest('hex'));
    assert.ok(Object.keys(build.identity.files).some(path => path.startsWith('dist/scripts/')));
    assert.ok(build.identity.files['dist/ledger/canonicalSchema.generated.js']);
    assert.equal('dist/build-id.json' in build.identity.files, false);
    assert.ok(Object.isFrozen(build.catalog.columns[0]));

    const queries: string[] = [];
    const query = async (statement: string, params?: any[]) => { queries.push(statement); return db.query(statement, params); };
    const pool: LedgerSqlPool = { query, connect: async () => ({ query }), end: async () => undefined };
    await db.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; ${RELEASE_IDENTITY_DDL}; ${sql}`);
    await db.query('INSERT INTO release_identity(singleton,manifest_hash) VALUES(true,$1)', [runtime.manifestHash]);
    assert.deepEqual(await assertLedgerDatabaseReady(pool, runtime.manifestHash, build.catalog),
      { schema, manifestHash: runtime.manifestHash });
    assert.ok(queries[0].endsWith('READ ONLY'));
    assert.ok(queries.every(statement => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(statement)));
    const tableCounts = async () => (await db.query(`SELECT
      (SELECT count(*) FROM ledger_accounts) AS accounts,(SELECT count(*) FROM ledger_runs) AS runs,
      (SELECT count(*) FROM ledger_watch_accounts) AS watched,(SELECT count(*) FROM ledger_perps_ranges) AS ranges`)).rows;
    const before = await tableCounts();

    const response = async (overrides: { pool?: LedgerSqlPool; metadata?: RegistryMetadata; build?: AuthenticatedLedgerBuild; network?: 'testnet' | 'mainnet' } = {}) => {
      const app = Fastify();
      registerLedgerReadinessRoute(app, { config: { network: overrides.network ?? 'testnet',
        serviceId: 'wrong-config', publicBaseUrl: 'https://wrong-config.invalid' }, metadata: overrides.metadata ?? metadata,
        pool, build, ...overrides });
      try { return await app.inject({ method: 'GET', url: route }); } finally { await app.close(); }
    };
    const ok = await response();
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    const body = ok.json();
    assert.deepEqual({ ...body, checkedAt: undefined }, {
      schema: 'tonswap-native-ledger-readiness-v1', ecosystem: 'ton', network: 'testnet', chainId: 'ton:testnet',
      serviceId: 'test.tonswap.org/api/indexer', publicBaseUrl: runtime.services.indexer,
      release: { releaseId: runtime.releaseId, manifestHash: runtime.manifestHash },
      build: { sha256: build.identity.sha256, sqlSha256: build.identity.sqlSha256 },
      database: { schema, manifestHash: runtime.manifestHash }, checkedAt: undefined,
    });
    assert.equal(new Date(body.checkedAt).toISOString(), body.checkedAt);
    assert.deepEqual(await tableCounts(), before, 'Readiness must not enroll accounts or create history');
    const unavailable = async (overrides: Parameters<typeof response>[0] = {}) => {
      const result = await response(overrides);
      assert.equal(result.statusCode, 503);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.deepEqual(result.json(), { code: 'ledger_not_ready', error: 'The current native durable ledger build or database is not ready.' });
    };
    await unavailable({ pool: undefined });
    await unavailable({ metadata: { ...metadata, releaseId: 'wrong-release' } });
    await unavailable({ metadata: { ...metadata, manifestHash: 'f'.repeat(64) } });
    await unavailable({ metadata: { ...metadata, runtime: { ...runtime, globalId: -239 } } });
    await unavailable({ network: 'mainnet' });
    await unavailable({ build: { ...build, assertCurrent() { throw Error('Changed compiled process'); } } });
    await unavailable({ pool: { ...pool, connect: async () => { throw Error('postgres://secret-password@private-db'); } } });

    await db.exec('SET search_path TO public');
    await unavailable();
    await db.exec(`SET search_path TO ${schema}, public`);
    await unavailable();
    await db.exec(`SET search_path TO ${schema}`);
    const collision = runtime.manifestHash.slice(0, 55) + (runtime.manifestHash.slice(55) === '0'.repeat(9) ? '1' : '0').repeat(9);
    assert.equal(releaseDatabaseSchema(collision), schema);
    await db.query('UPDATE release_identity SET manifest_hash=$1', [collision]);
    await unavailable();
    await db.query('UPDATE release_identity SET manifest_hash=$1', [runtime.manifestHash]);

    // Each concrete schema mutation is followed by a fresh canonical in-memory
    // fixture; no compatibility/defaulting path is permitted.
    const rejectsMutation = async (mutation: string) => {
      await db.exec('BEGIN'); await db.exec(mutation); await db.exec('COMMIT');
      await unavailable();
      await db.exec(`DROP SCHEMA ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}; ${RELEASE_IDENTITY_DDL}; ${sql}`);
      await db.query('INSERT INTO release_identity(singleton,manifest_hash) VALUES(true,$1)', [runtime.manifestHash]);
    };
    await rejectsMutation('ALTER TABLE ledger_projection_coverage DROP COLUMN projection_scope');
    await rejectsMutation('ALTER TABLE ledger_projection_coverage ALTER COLUMN projection_scope DROP NOT NULL');
    await rejectsMutation('ALTER TABLE ledger_accounts ALTER COLUMN network SET DEFAULT \'testnet\'');
    await rejectsMutation('ALTER TABLE ledger_membership DROP CONSTRAINT ledger_membership_generation_fkey');
    await rejectsMutation(`ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_network_check;
      ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_network_check CHECK (network='testnet')`);
    await rejectsMutation('ALTER TABLE ledger_perps_ranges DROP CONSTRAINT ledger_perps_ranges_generation_order_key');
    await rejectsMutation('ALTER TABLE ledger_membership DISABLE TRIGGER ALL');
    await rejectsMutation('DROP INDEX ledger_projection_page');
    await rejectsMutation(`DROP INDEX ledger_perps_ranges_active; CREATE UNIQUE INDEX ledger_perps_ranges_active
      ON ledger_perps_ranges(network,account,from_utime,to_utime,binding) WHERE status = 'pending'`);
    await rejectsMutation('ALTER SEQUENCE ledger_perps_ranges_generation_order_seq INCREMENT BY -1');
    await rejectsMutation('ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY');
    await rejectsMutation('CREATE POLICY unexpected_filter ON ledger_accounts USING (false)');
    await rejectsMutation(`CREATE FUNCTION unexpected_trigger() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RETURN NULL; END'; CREATE TRIGGER unexpected_trigger BEFORE INSERT ON ledger_accounts
      FOR EACH ROW EXECUTE FUNCTION unexpected_trigger()`);
    await rejectsMutation(`CREATE FUNCTION unexpected_constraint() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RETURN NULL; END'; CREATE CONSTRAINT TRIGGER unexpected_constraint AFTER INSERT ON ledger_accounts
      DEFERRABLE FOR EACH ROW EXECUTE FUNCTION unexpected_constraint()`);
    await rejectsMutation('CREATE TABLE unexpected_legacy_ledger(id integer)');
    await rejectsMutation('DELETE FROM release_identity');
    assert.equal((await response()).statusCode, 200);

    const executedFile = join(fixture, 'dist/index.js'), original = readFileSync(executedFile);
    writeFileSync(executedFile, Buffer.concat([original, Buffer.from('\n// changed after import\n')]));
    assert.throws(() => authenticateLedgerBuild(fixture), /does not match/);
    rewriteId();
    assert.throws(() => build.assertCurrent(), /changed after authentication/, 'A new mutable ID cannot replace the running pin');
    await unavailable();
    writeFileSync(executedFile, original); rewriteId(); build.assertCurrent();
    const extra = join(fixture, 'dist/extra.js');
    writeFileSync(extra, 'module.exports = 1;');
    assert.throws(() => build.assertCurrent(), /changed/);
    unlinkSync(extra); build.assertCurrent();
    symlinkSync(executedFile, extra);
    assert.throws(() => fingerprintLedgerBuild(fixture), /symbolic links/);
    unlinkSync(extra);
    const sqlFile = join(fixture, 'sql/ledger.sql');
    writeFileSync(sqlFile, sql + '\n-- changed SQL\n'); rewriteId();
    assert.throws(() => authenticateLedgerBuild(fixture), /detached from its SQL/);
    assert.throws(() => build.assertCurrent(), /changed/);
    writeFileSync(sqlFile, sql); rewriteId();
    build.assertCurrent();
    unlinkSync(join(fixture, 'dist/build-id.json'));
    assert.throws(() => authenticateLedgerBuild(fixture));
    console.log('Ledger readiness passed: compiled identity pin, JS/SQL mutations, native route identity, read-only catalog, namespace/full-hash collisions, schema drift, and no enrollment.');
  } finally {
    await db.close();
    rmSync(fixture, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
