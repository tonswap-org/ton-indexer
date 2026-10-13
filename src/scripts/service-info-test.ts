import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { IndexerService } from '../indexerService';
import { runtimeManifestFixture, runtimeMetadataFixture } from './fixtures/runtimeManifest';
import type { Network } from '../config';

const service = {
  getAdmissionStatus() { return { configured: false, ready: false }; },
  getHealth() { return { chain: { peersConfigured: 1, peersReady: 1, headSeqno: 123, headAgeSec: 0 }, ledger: 'disabled', disk: 'ok' }; },
} as IndexerService;
const capabilityRoutes = {
  'account-balances': ['GET', '/api/indexer/v1/accounts/:addr/balances'],
  'account-transactions': ['GET', '/api/indexer/v1/accounts/:addr/txs'],
  'account-state': ['GET', '/api/indexer/v1/accounts/:addr/state'],
  'run-get-method': ['POST', '/api/indexer/v1/runGetMethod'],
  'fresh-read': ['POST', '/api/indexer/v1/readFresh'],
  'market-candles': ['GET', '/api/indexer/v1/markets/:market/candles'],
} as const;

async function main() {
  for (const network of ['mainnet', 'testnet', 'localnet'] as Network[]) {
    const metadata = runtimeMetadataFixture(network), runtime = metadata.runtime!, app = Fastify();
    registerRoutes(app, { network, enableWriteRpc: false }, service, undefined, undefined, undefined, undefined,
      { T3Root: runtime.contracts.T3Root!.address }, metadata);
    try {
      const healthResponse = await app.inject('/api/indexer/v1/health'); assert.equal(healthResponse.statusCode, 200);
      const health = healthResponse.json();
      const info = (await app.inject('/api/indexer/v1/service-info')).json();
      assert.equal(info.schemaVersion, 1); assert.equal(info.serviceId, 'indexer.example/api/indexer');
      assert.equal(info.publicBaseUrl, runtime.services.indexer); assert.equal(info.ecosystem, 'ton');
      assert.equal(info.chainId, `ton:${network}`); assert.equal(info.network, network); assert.equal(info.readOnly, true);
      assert.equal(health.serviceId, info.serviceId); assert.equal(health.chainId, info.chainId); assert.equal(health.network, network);
      assert.equal(health.chain.headSeqno, 123);
      assert.deepEqual(info.release, { releaseId: runtime.releaseId, manifestHash: runtime.manifestHash });
      for (const [name, path] of Object.entries(info.endpoints) as [string, string][]) {
        const method = ['runGetMethod', 'readFresh'].includes(name) ? 'POST' : 'GET';
        const url = path.replace(/\{([^}]+)\}/g, ':$1');
        assert(app.hasRoute({ method, url }), `${name} must name a registered ${method} route`);
      }
      assert.deepEqual([...info.capabilities].sort(), Object.keys(capabilityRoutes).sort());
      for (const capability of info.capabilities as (keyof typeof capabilityRoutes)[]) {
        const [method, url] = capabilityRoutes[capability];
        assert(app.hasRoute({ method, url }), `${capability} must have a route`);
      }
      const contracts = (await app.inject('/api/indexer/v1/contracts')).json();
      assert.equal(contracts.network, network); assert.deepEqual(contracts.release, info.release);
      assert.equal('registry_hash' in contracts, false); assert.equal('release_manifest_hash' in contracts, false);
      const spec = (await app.inject('/api/indexer/v1/openapi.json')).json();
      for (const name of ['HealthStatus', 'ServiceInfoResponse']) {
        assert.equal(spec.components.schemas[name].properties.serviceId.type, 'string');
        assert.deepEqual(spec.components.schemas[name].properties.serviceId.enum, [info.serviceId]);
      }
      assert.equal(spec.components.schemas.ServiceInfoResponse.properties.publicBaseUrl.type, 'string');
      assert.ok(spec.paths[info.endpoints.readFresh]);
    } finally { await app.close(); }
  }

  const runtime = runtimeManifestFixture(), metadata = runtimeMetadataFixture();
  for (const mismatch of [undefined, { ...metadata, releaseId: 'different-release' },
    { ...metadata, manifestHash: 'f'.repeat(64) }, { ...metadata, runtime: { ...runtime, network: 'ton:mainnet' as const } },
    { ...metadata, runtime: { ...runtime, globalId: -239 } }]) {
    const app = Fastify();
    // Removed JS object properties cannot restore a standalone or conflicting identity.
    const poisoned = { network: 'testnet' as const, serviceId: 'unrelated', publicBaseUrl: 'https://unrelated.invalid' };
    registerRoutes(app, poisoned, service, undefined, undefined, undefined, undefined, {}, mismatch);
    try {
      const info = (await app.inject('/api/indexer/v1/service-info')).json();
      const health = (await app.inject('/api/indexer/v1/health')).json();
      assert.equal(info.serviceId, null); assert.equal(health.serviceId, null); assert.equal(info.publicBaseUrl, null);
      assert.equal(info.capabilities.includes('fresh-read'), false); assert.equal('readFresh' in info.endpoints, false);
      const spec = (await app.inject('/api/indexer/v1/openapi.json')).json();
      for (const name of ['HealthStatus', 'ServiceInfoResponse']) {
        assert.equal(spec.components.schemas[name].properties.serviceId.type, 'null');
        assert.deepEqual(spec.components.schemas[name].properties.serviceId.enum, [null]);
      }
      assert.equal(spec.components.schemas.ServiceInfoResponse.properties.publicBaseUrl.type, 'null');
      const unavailable = await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh',
        payload: { calls: [{ kind: 'account', address: runtime.contracts.T3Root!.address }] } });
      assert.equal(unavailable.statusCode, 503, 'Unbound or mismatched metadata must never serve fresh reads');
    } finally { await app.close(); }
  }
  console.log('Manifest service identity, advertised routes, exact bound schemas and unavailable identity passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
