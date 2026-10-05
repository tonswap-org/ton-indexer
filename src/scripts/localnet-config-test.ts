import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { LiteClientDataSource } from '../data/liteClientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';
import { createLogger } from '../utils/logger';

const envKeys = [
  'TON_NETWORK',
  'LITESERVER_POOL_LOCALNET',
  'INDEXER_RELEASE_MANIFEST',
  'INDEXER_MAX_WATCHED_ACCOUNTS',
  'INDEXER_MAX_PAGES_PER_SYNC',
  'INDEXER_MAX_RELATED_ACCOUNTS',
  'INDEXER_SERVICE_ID',
  'INDEXER_PUBLIC_BASE_URL',
] as const;
const before = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

async function main() {
  try {
    process.env.TON_NETWORK = 'localnet';
    process.env.LITESERVER_POOL_LOCALNET = '/tmp/my-local-ton-global.config.json';
    process.env.INDEXER_RELEASE_MANIFEST = '/tmp/local-release.json';
    process.env.INDEXER_SERVICE_ID = 'tonswap-local-indexer';
    process.env.INDEXER_PUBLIC_BASE_URL = 'http://127.0.0.1:8787';

    const config = loadConfig();
    assert.equal(config.network, 'localnet');
    assert.equal(config.liteserverPool, '/tmp/my-local-ton-global.config.json');
    assert.equal(config.releaseManifestSource, '/tmp/local-release.json');
    assert.equal(config.serviceId, 'tonswap-local-indexer');
    assert.equal(config.publicBaseUrl, 'http://127.0.0.1:8787');

    process.env.INDEXER_RELEASE_MANIFEST = 'https://release.example/tonswap-release-v1.json';
    assert.equal(loadConfig().releaseManifestSource, process.env.INDEXER_RELEASE_MANIFEST);
    delete process.env.INDEXER_RELEASE_MANIFEST;
    assert.equal(loadConfig().releaseManifestSource, undefined, 'Startup, rather than in-memory service fixtures, requires a manifest source');
    for (const [key, field, max] of [
      ['INDEXER_MAX_WATCHED_ACCOUNTS', 'ledgerMaxWatchedAccounts', 100000],
      ['INDEXER_MAX_PAGES_PER_SYNC', 'ledgerMaxPagesPerSync', 100],
      ['INDEXER_MAX_RELATED_ACCOUNTS', 'ledgerMaxRelatedAccounts', 1024],
    ] as const) {
      process.env[key] = String(max);
      assert.equal(loadConfig()[field], max);
      for (const invalid of ['0', '-1', '1.5', '01', String(max + 1)]) {
        process.env[key] = invalid;
        assert.throws(() => loadConfig(), new RegExp(`${key} must be a canonical integer`));
      }
      delete process.env[key];
    }

    process.env.TON_NETWORK = 'unsupported';
    assert.throws(() => loadConfig(), /TON_NETWORK must be one of mainnet, testnet, localnet/);

    await assert.rejects(
      () => LiteClientDataSource.create('localnet', undefined, createLogger('silent')),
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
