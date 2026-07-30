import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { LiteClientDataSource } from '../data/liteClientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';

const envKeys = [
  'TON_NETWORK',
  'LITESERVER_POOL_LOCALNET',
  'INDEXER_RELEASE_MANIFEST_PATH',
  'TONSWAP_RELEASE_MANIFEST_PATH',
  'INDEXER_SERVICE_ID',
  'INDEXER_PUBLIC_BASE_URL',
] as const;
const before = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

async function main() {
  try {
    process.env.TON_NETWORK = 'localnet';
    process.env.LITESERVER_POOL_LOCALNET = '/tmp/my-local-ton-global.config.json';
    process.env.INDEXER_RELEASE_MANIFEST_PATH = '/tmp/local-release.json';
    process.env.INDEXER_SERVICE_ID = 'tonswap-local-indexer';
    process.env.INDEXER_PUBLIC_BASE_URL = 'http://127.0.0.1:8787';

    const config = loadConfig();
    assert.equal(config.network, 'localnet');
    assert.match(config.registryPath, /registry\/localnet\.json$/);
    assert.equal(config.liteserverPool, '/tmp/my-local-ton-global.config.json');
    assert.equal(config.releaseManifestPath, '/tmp/local-release.json');
    assert.equal(config.serviceId, 'tonswap-local-indexer');
    assert.equal(config.publicBaseUrl, 'http://127.0.0.1:8787');

    process.env.TON_NETWORK = 'unsupported';
    assert.throws(() => loadConfig(), /TON_NETWORK must be one of mainnet, testnet, localnet/);

    await assert.rejects(
      () => LiteClientDataSource.create('localnet'),
      /LITESERVER_POOL_LOCALNET is required/
    );
    if (TonClient4DataSource.isAvailable()) {
      await assert.rejects(
        () => TonClient4DataSource.create('localnet'),
        /TON_HTTP_ENDPOINT is required/
      );
    }

    process.stdout.write('localnet config ok\n');
  } finally {
    for (const key of envKeys) {
      const value = before[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
