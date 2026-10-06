import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { IndexerService } from '../indexerService';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { loadConfig } from '../config';

async function main() {
  const app = Fastify();
  registerRoutes(
    app,
    {
      network: 'mainnet',
      enableWriteRpc: false
    },
    {
      getAdmissionStatus() { return { configured: false, ready: false }; },
      getHealth() {
        return { lastMasterSeqno: 123 };
      }
    } as IndexerService
  );

  const healthResponse = await app.inject({ method: 'GET', url: '/api/indexer/v1/health' });
  assert.equal(healthResponse.statusCode, 200);
  const health = healthResponse.json();
  assert.equal(health.serviceId, 'ton-indexer:mainnet');
  assert.equal(health.ecosystem, 'ton');
  assert.equal(health.chainId, 'ton:mainnet');
  assert.equal(health.network, 'mainnet');
  assert.equal(health.lastMasterSeqno, 123);

  const response = await app.inject({ method: 'GET', url: '/api/indexer/v1/service-info' });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.serviceId, 'ton-indexer:mainnet');
  assert.equal(body.ecosystem, 'ton');
  assert.equal(body.chainId, 'ton:mainnet');
  assert.equal(body.publicBaseUrl, null, 'An unconfigured standalone service cannot claim a public authority');
  assert.equal(body.capabilities.includes('fresh-read'), false);
  assert.equal('readFresh' in body.endpoints, false);
  assert.equal(body.readOnly, true);
  assert.ok(body.capabilities.includes('account-transactions'));
  assert.equal(body.endpoints.transactions, '/api/indexer/v1/accounts/{addr}/txs');
  assert.equal(body.endpoints.marketCandles, '/api/indexer/v1/markets/{market}/candles');
  assert.ok(body.capabilities.includes('market-candles'));

  await app.close();

  const localApp = Fastify();
  registerRoutes(
    localApp,
    {
      network: 'localnet',
      serviceId: 'tonswap-local-indexer',
      publicBaseUrl: 'http://127.0.0.1:8787',
      enableWriteRpc: false,
    },
    {
      getAdmissionStatus() { return { configured: false, ready: false }; },
      getHealth() {
        return { lastMasterSeqno: 7 };
      }
    } as IndexerService,
    undefined,
    undefined,
    undefined,
    undefined,
    { T3Root: `0:${'1'.repeat(64)}` },
    {
      releaseId: 'local-run-1',
      registryHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
    }
  );
  const localHealth = (await localApp.inject({ method: 'GET', url: '/api/indexer/v1/health' })).json();
  assert.equal(localHealth.serviceId, 'tonswap-local-indexer');
  assert.equal(localHealth.chainId, 'ton:localnet');
  assert.equal(localHealth.network, 'localnet');

  const localInfo = (await localApp.inject({ method: 'GET', url: '/api/indexer/v1/service-info' })).json();
  assert.equal(localInfo.publicBaseUrl, 'http://127.0.0.1:8787');
  assert.equal(localInfo.release.releaseId, 'local-run-1');
  assert.deepEqual(localInfo.release, { releaseId: 'local-run-1', manifestHash: 'b'.repeat(64) });

  const contracts = (await localApp.inject({ method: 'GET', url: '/api/indexer/v1/contracts' })).json();
  assert.equal(contracts.network, 'localnet');
  assert.deepEqual(contracts.release, localInfo.release);
  assert.equal('registry_hash' in contracts, false);
  assert.equal('release_manifest_hash' in contracts, false);
  await localApp.close();

  const runtime = runtimeManifestFixture({ services: {
    indexer: 'https://test.tonswap.org/api/indexer',
    tonRpc: 'https://testnet.toncenter.com/api/v2/jsonRPC', platform: 'https://test.tonswap.org/api/platform',
  } });
  const metadata = { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' };
  const service = { getAdmissionStatus() { return { configured: false, ready: false }; }, getHealth() { return { lastMasterSeqno: 42 }; } } as IndexerService;
  const nativeApp = Fastify();
  registerRoutes(nativeApp, { network: 'testnet', serviceId: 'misconfigured-service', publicBaseUrl: 'https://misconfigured.invalid' },
    service, undefined, undefined, undefined, undefined, {}, metadata);
  const native = (await nativeApp.inject({ method: 'GET', url: '/api/indexer/v1/service-info' })).json();
  assert.equal(native.publicBaseUrl, runtime.services.indexer, 'The native manifest is authoritative over unrelated config');
  assert.equal(native.serviceId, 'test.tonswap.org/api/indexer');
  assert.equal(native.capabilities.includes('fresh-read'), true);
  assert.equal(native.endpoints.readFresh, '/api/indexer/v1/readFresh');
  assert.deepEqual(native.release, { releaseId: runtime.releaseId, manifestHash: runtime.manifestHash });
  const nativeHealth = (await nativeApp.inject({ method: 'GET', url: '/api/indexer/v1/health' })).json();
  assert.equal(nativeHealth.serviceId, native.serviceId);
  const nativeApi = (await nativeApp.inject({ method: 'GET', url: '/api/indexer/v1/openapi.json' })).json();
  assert.equal(nativeApi.components.schemas.HealthStatus.properties.serviceId.enum[0], native.serviceId);
  assert.equal(nativeApi.components.schemas.ServiceInfoResponse.properties.serviceId.enum[0], native.serviceId);
  assert.ok(nativeApi.paths[native.endpoints.readFresh]);
  await nativeApp.close();

  for (const mismatch of [{ ...metadata, releaseId: 'different-release' }, { ...metadata, manifestHash: 'f'.repeat(64) },
    { ...metadata, runtime: { ...runtime, network: 'ton:mainnet' as const } }]) {
    const wrongApp = Fastify();
    registerRoutes(wrongApp, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, {}, mismatch);
    const wrong = (await wrongApp.inject({ method: 'GET', url: '/api/indexer/v1/service-info' })).json();
    assert.equal(wrong.capabilities.includes('fresh-read'), false, 'Wrong bindings cannot advertise fresh readiness');
    assert.equal('readFresh' in wrong.endpoints, false);
    assert.equal(wrong.publicBaseUrl, null, 'Wrong bindings cannot claim the native authority');
    await wrongApp.close();
  }
  const previousId = process.env.INDEXER_SERVICE_ID, previousUrl = process.env.INDEXER_PUBLIC_BASE_URL;
  try {
    delete process.env.INDEXER_SERVICE_ID; delete process.env.INDEXER_PUBLIC_BASE_URL;
    assert.equal(loadConfig().serviceId, undefined);
    assert.equal(loadConfig().publicBaseUrl, undefined, 'Config must not invent an unrelated public deployment');
  } finally {
    if (previousId === undefined) delete process.env.INDEXER_SERVICE_ID; else process.env.INDEXER_SERVICE_ID = previousId;
    if (previousUrl === undefined) delete process.env.INDEXER_PUBLIC_BASE_URL; else process.env.INDEXER_PUBLIC_BASE_URL = previousUrl;
  }

  process.stdout.write('service-info ok\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
