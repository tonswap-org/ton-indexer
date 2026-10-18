import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Config } from '../config';
import { buildRuntimeManifestBundle, parseCanonicalReleaseManifest } from '../config/releaseManifest';
import { deriveRuntimeManifestBindings } from '../config/runtimeManifestBindings';
import { registerRoutes } from '../api/routes';
import { setCorsHeaders } from '../api/cors';
import { registerLedgerReadinessRoute } from '../ledger/readiness';
import { createLedgerRuntime } from '../runtime/ledgerRuntime';
import { createAdmissionRuntime } from '../runtime/admissionRuntime';
import type { RuntimeDeps } from '../runtime/worker';
import type { IndexerService } from '../indexerService';
import { nativeLocalnetManifestText, runtimeManifestFixture } from './fixtures/runtimeManifest';

const service = {
  getAdmissionStatus() { return { configured: false, ready: false }; },
  getHealth() { return { chain: { peersConfigured: 0, peersReady: 0, headSeqno: null, headAgeSec: null }, ledger: 'unavailable', disk: 'ok' }; },
} as IndexerService;
const header = 'x-tonswap-release';
const cors = { corsAllowOrigin: 'https://test.tonswap.org', corsAllowOrigins: [], corsAllowMethods: 'GET,POST,OPTIONS',
  corsAllowHeaders: 'content-type', corsExposeHeaders: 'content-length', corsMaxAge: 60 };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function main() {
  // Exact retained producer bytes remain localnet sandbox evidence, never a deployment claim.
  const native = parseCanonicalReleaseManifest(nativeLocalnetManifestText, 'localnet');
  const synthetic = parseCanonicalReleaseManifest(runtimeManifestFixture(), 'testnet');
  for (const parsed of [native, synthetic]) {
    const bundle = buildRuntimeManifestBundle(parsed.runtime);
    const bindings = deriveRuntimeManifestBindings(parsed.runtime), perps = bindings.currentPerpsBinding;
    assert.equal(bindings.currentLedgerDecodersQualified, false, 'one product binding does not remove the global qualification fence');
    assert.equal(perps.network, parsed.runtime.network.slice(4));
    assert.equal(perps.releaseId, parsed.runtime.releaseId); assert.equal(perps.manifestHash, parsed.manifestHash);
    for (const [key, role] of [['engine', 'PerpsEngine'], ['riskVault', 'RiskVault'], ['governance', 'Governance'],
      ['feeSink', 'FeeRouter'], ['treasury', 'Treasury'], ['t3Root', 'T3Hub']] as const)
      assert.equal(perps.perps[key].toRawString(), parsed.runtime.contracts[role]!.address);
    assert.equal(perps.perps.engineHash, parsed.runtime.contracts.PerpsEngine!.codeHash);
    assert.equal(perps.riskVaultHash, parsed.runtime.contracts.RiskVault!.codeHash);
    assert.equal(perps.perps.t3MasterHash, parsed.runtime.contracts.T3Hub!.codeHash);
    assert.equal(perps.perps.t3WalletHash, parsed.runtime.templates.T3Wallet);
    assert.equal(perps.proofCodeHash, parsed.runtime.templates.T3RecoveryProof);
    assert.equal(perps.perps.poolHash, parsed.runtime.templates.DlmmPool);
    assert.deepEqual([...perps.perps.markets].map(([id, pool]) => [id, pool.toRawString()]),
      parsed.runtime.perpsMarkets.map(market => [market.marketId, market.pool]));
    assert.deepEqual(bindings.currentLaunchpadBinding.manifest, parsed.runtime);
    assert.deepEqual(bindings.currentDlmmBinding.release, parsed.runtime);
    assert.deepEqual(bindings.currentDlmmBinding.pools, parsed.runtime.spotMarkets.map(market => ({ pool: market.pool, market,
      t3: parsed.runtime.tokens.find(token => token.symbol === 'T3'), x: parsed.runtime.tokens.find(token => token.symbol === market.symbol) })));
    assert.deepEqual(bindings.currentMarketBindings, bindings.currentDlmmBinding.pools.map(pool => ({ ...pool,
      schema: 'current-dlmm-market-binding-v1', network: parsed.runtime.network.slice(4), release: parsed.runtime })));
    const network = parsed.runtime.network.slice(4) as Config['network'];
    const app = Fastify(); let work = 0;
    // Match the API runtime's early preflight hook order.
    app.addHook('onRequest', async (request, reply) => {
      setCorsHeaders(request as any, reply, cors);
      if (request.method === 'OPTIONS') return reply.code(204).send();
    });
    registerRoutes(app, { network }, service, undefined, undefined, undefined, undefined, bundle.contracts, bundle.metadata);
    registerLedgerReadinessRoute(app, { config: { network }, metadata: bundle.metadata });
    app.get('/api/indexer/v1/owned-work', async () => { work++; return { ok: true }; });
    app.get('/api/indexer/v1/owned-error', async () => { work++; throw new Error('private internal detail'); });
    app.post('/api/indexer/v1/owned-json', async () => { work++; return { ok: true }; });
    try {
      for (const route of ['/health', '/service-info', '/contracts', '/ledger/readiness', '/missing', '/owned-error']) {
        const result = await app.inject(`/api/indexer/v1${route}`);
        assert.equal(result.headers[header], parsed.manifestHash, `identity on ${route}`);
      }
      const discovery = (await app.inject('/api/indexer/v1/contracts')).json();
      assert.deepEqual(discovery.tokens, parsed.runtime.tokens);
      assert.deepEqual(discovery.templates, parsed.runtime.templates);
      assert.deepEqual(discovery.spotMarkets, parsed.runtime.spotMarkets);
      assert.deepEqual(discovery.perpsMarkets, parsed.runtime.perpsMarkets);
      assert.deepEqual(discovery.options, parsed.runtime.options);
      assert.equal(discovery.contracts.T3Hub, parsed.runtime.contracts.T3Hub!.address);
      assert(!('T3Root' in discovery.contracts)); assert(!('JettonWallet' in discovery.templates));
      assert.equal(new Set(discovery.tokens.map((t: any) => t.walletCodeHash)).size, 3);
      const info = (await app.inject('/api/indexer/v1/service-info')).json();
      assert.equal(info.publicBaseUrl, parsed.runtime.services.indexer);
      assert(Object.values(info.endpoints).every(path => typeof path === 'string' && path.startsWith('/api/indexer/v1/')));
      const notReady = await app.inject('/api/indexer/v1/ledger/readiness');
      assert.equal(notReady.statusCode, 503); assert.equal(notReady.headers['cache-control'], 'no-store');
      assert.equal(notReady.json().code, 'ledger_not_ready');
      const before = work;
      for (const expected of ['f'.repeat(64), `${parsed.manifestHash}, ${parsed.manifestHash}`, '']) {
        const rejected = await app.inject({ url: '/api/indexer/v1/owned-work', headers: { [header]: expected } });
        assert.equal(rejected.statusCode, 409); assert.equal(rejected.headers['cache-control'], 'no-store');
        assert.equal(rejected.headers[header], parsed.manifestHash); assert.equal(rejected.json().code, 'release_mismatch');
        assert.equal(work, before, 'mismatch must stop before route work');
      }
      const accepted = await app.inject({ url: '/api/indexer/v1/owned-work', headers: { [header]: parsed.manifestHash } });
      assert.equal(accepted.statusCode, 200); assert.equal(work, before + 1);
      const malformed = await app.inject({ method: 'POST', url: '/api/indexer/v1/owned-json', payload: '{',
        headers: { 'content-type': 'application/json', [header]: parsed.manifestHash } });
      assert.equal(malformed.statusCode, 400); assert.equal(malformed.headers[header], parsed.manifestHash);
      const preflight = await app.inject({ method: 'OPTIONS', url: '/api/indexer/v1/owned-work', headers: {
        origin: 'https://test.tonswap.org', 'access-control-request-headers': header, [header]: 'stale' } });
      assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers[header], parsed.manifestHash);
      for (const key of ['access-control-allow-headers', 'access-control-expose-headers'])
        assert(String(preflight.headers[key]).toLowerCase().split(',').includes(header));
    } finally { await app.close(); }
  }
  const bundle = buildRuntimeManifestBundle(synthetic.runtime), app = Fastify();
  registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, bundle.contracts,
    { ...bundle.metadata, manifestHash: 'f'.repeat(64) });
  try {
    const reply = await app.inject({ url: '/api/indexer/v1/contracts', headers: { [header]: synthetic.manifestHash } });
    assert.equal(reply.statusCode, 503); assert.equal(reply.headers[header], undefined);
    assert.equal(reply.headers['cache-control'], 'no-store');
    const unbound = (await app.inject('/api/indexer/v1/contracts')).json();
    assert.equal(unbound.tokens, undefined); assert.deepEqual(unbound.release, { releaseId: null, manifestHash: null });
  } finally { await app.close(); }

  let allocated = 0;
  const deps = { config: { network: 'testnet', databaseUrl: 'postgres://localhost/owned-test-only' },
    manifest: { ...bundle.metadata, runtime: synthetic.runtime }, registry: bundle.contracts,
    bindings: deriveRuntimeManifestBindings(synthetic.runtime), logger } as unknown as RuntimeDeps;
  const ledger = createLedgerRuntime(deps, { poolFactory: async () => { allocated++; throw Error('not expected'); } });
  ledger.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(allocated, 0, 'unqualified old ledger decoders cannot allocate a release database');
  assert.equal(ledger.status(), 'unavailable'); assert.equal(ledger.readPool(), undefined); await ledger.stop();
  assert.throws(() => createAdmissionRuntime(deps), /qualified testnet admission runtime and exact artifact pins/,
    'the current engine still requires native admission artifacts');
  console.log('Current release header, stale request fence, CORS, instrument discovery, stable mount, readiness and admission boundaries passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
