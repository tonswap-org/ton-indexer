import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { IndexerService } from '../indexerService';

async function main() {
  const app = Fastify();
  registerRoutes(
    app,
    {
      network: 'mainnet',
      enableWriteRpc: false
    },
    {
      getHealth() {
        return { lastMasterSeqno: 123 };
      }
    } as IndexerService
  );

  const healthResponse = await app.inject({ method: 'GET', url: '/api/indexer/v1/health' });
  assert.equal(healthResponse.statusCode, 200);
  const health = healthResponse.json();
  assert.equal(health.serviceId, 'ti.soramitsu.io');
  assert.equal(health.ecosystem, 'ton');
  assert.equal(health.chainId, 'ton:mainnet');
  assert.equal(health.network, 'mainnet');
  assert.equal(health.lastMasterSeqno, 123);

  const response = await app.inject({ method: 'GET', url: '/api/indexer/v1/service-info' });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.serviceId, 'ti.soramitsu.io');
  assert.equal(body.ecosystem, 'ton');
  assert.equal(body.chainId, 'ton:mainnet');
  assert.equal(body.publicBaseUrl, 'https://ti.soramitsu.io');
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
      releaseManifestHash: 'b'.repeat(64),
    }
  );
  const localHealth = (await localApp.inject({ method: 'GET', url: '/api/indexer/v1/health' })).json();
  assert.equal(localHealth.serviceId, 'tonswap-local-indexer');
  assert.equal(localHealth.chainId, 'ton:localnet');
  assert.equal(localHealth.network, 'localnet');

  const localInfo = (await localApp.inject({ method: 'GET', url: '/api/indexer/v1/service-info' })).json();
  assert.equal(localInfo.publicBaseUrl, 'http://127.0.0.1:8787');
  assert.equal(localInfo.release.releaseId, 'local-run-1');
  assert.equal(localInfo.release.registryHash, 'a'.repeat(64));

  const contracts = (await localApp.inject({ method: 'GET', url: '/api/indexer/v1/contracts' })).json();
  assert.equal(contracts.network, 'localnet');
  assert.equal(contracts.release_id, 'local-run-1');
  assert.equal(contracts.registry_hash, 'a'.repeat(64));
  await localApp.close();

  process.stdout.write('service-info ok\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
