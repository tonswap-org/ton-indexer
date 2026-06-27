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

  await app.close();
  process.stdout.write('service-info ok\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
