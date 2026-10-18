import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { loadLiteserverPool } from '../data/liteserverPool';

// Build the retired names as test inputs; production deletion scans must remain empty.
const retiredVariables = [
  ...['INDEXER_WRITE_RPC', 'TON_WRITE_RPC', 'TONSWAP_WRITE_RPC', 'BLUEPRINT_WRITE', 'TON_RPC', 'BLUEPRINT']
    .flatMap(prefix => ['ENDPOINT', 'ENDPOINTS', 'API_KEY'].map(suffix => `${prefix}_${suffix}`)),
  ...[['INDEXER', 'SERVICE_ID'], ['INDEXER', 'PUBLIC_BASE_URL'], ['INDEXER', 'ADMIN_API_KEY'],
    ['TON', 'DATASOURCE'], ['TON', 'HTTP_ENDPOINT'], ['TRUST', 'PROXY'], ['FASTIFY_TRUST', 'PROXY'],
    ['JETTON_BALANCE', 'TIMEOUT_MS'], ['BALANCE_CACHE', 'TTL_MS'], ['STATE_CACHE', 'TTL_MS'], ['JETTON_METADATA', 'TTL_MS'],
    ...['TIMEOUT_MS', 'RETRY_ATTEMPTS', 'RETRY_DELAY_MS'].map(suffix => ['INDEXER_RPC', `PROXY_${suffix}`])]
    .map(parts => parts.join('_')),
];
const retiredFields = ['serviceId', 'publicBaseUrl', 'dataSource', 'httpEndpoint', 'balanceCacheTtlMs',
  'jettonBalanceTimeoutMs', 'stateCacheTtlMs', 'jettonMetadataTtlMs', 'rpcProxyEndpoint', 'rpcProxyEndpoints',
  'rpcProxyApiKey', 'rpcProxyTimeoutMs', 'rpcProxyRetryAttempts', 'rpcProxyRetryDelayMs'];
const envKeys = [
  ...retiredVariables,
  'INDEXER_ADMIN_TOKEN',

  'TON_NETWORK',
  'LITESERVER_POOL_LOCALNET',
  'INDEXER_RELEASE_MANIFEST',
  'INDEXER_MAX_WATCHED_ACCOUNTS',
  'INDEXER_MAX_PAGES_PER_SYNC',
  'INDEXER_MAX_RELATED_ACCOUNTS',
  'INDEXER_EDGE_KEY', 'INDEXER_LEDGER_WORKERS', 'INDEXER_DISK_SOFT_FLOOR_BYTES', 'INDEXER_DISK_HARD_FLOOR_BYTES',
] as const;
const before = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

async function main() {
  try {
    process.env.TON_NETWORK = 'localnet';
    process.env.LITESERVER_POOL_LOCALNET = '/tmp/my-local-ton-global.config.json';
    process.env.INDEXER_RELEASE_MANIFEST = '/tmp/local-release.json';
    for (const key of retiredVariables) delete process.env[key];
    delete process.env.INDEXER_ADMIN_TOKEN;

    const config = loadConfig();
    assert.equal(config.network, 'localnet');
    assert.equal(config.liteserverPool, '/tmp/my-local-ton-global.config.json');
    assert.equal(config.releaseManifestSource, '/tmp/local-release.json');
    for (const field of retiredFields) assert.equal(field in config, false, `${field} must be absent`);
    for (const key of retiredVariables) {
      process.env[key] = 'invalid-retired-value';
      assert.deepEqual(loadConfig(), config, `${key} must have no effect`);
    }
    process.env.INDEXER_ADMIN_TOKEN = 'current-admin-token';
    assert.equal(loadConfig().adminToken, 'current-admin-token');
    delete process.env.INDEXER_ADMIN_TOKEN;

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

    assert.throws(() => loadLiteserverPool(undefined), /LITESERVER_POOL_LOCALNET/);
    process.env.TON_NETWORK = 'localnet';
    delete process.env.LITESERVER_POOL_LOCALNET;
    assert.equal(loadConfig().liteserverPool, undefined, 'pure config parsing does not require a pool');
    assert.throws(() => loadLiteserverPool('https://ton.org/global.config.json'), /LITESERVER_POOL/);
    assert.equal(loadConfig().ledgerWorkers, 3);
    assert(loadConfig().corsExposeHeaders.includes('retry-after'));
    process.env.INDEXER_EDGE_KEY = 'short'; assert.throws(() => loadConfig(), /at least 32/);
    process.env.INDEXER_EDGE_KEY = 'k'.repeat(32); assert.equal(loadConfig().edgeKey, 'k'.repeat(32));
    process.env.INDEXER_LEDGER_WORKERS = '9'; assert.throws(() => loadConfig(), /INDEXER_LEDGER_WORKERS/);
    delete process.env.INDEXER_LEDGER_WORKERS;
    process.env.INDEXER_DISK_SOFT_FLOOR_BYTES = '100'; process.env.INDEXER_DISK_HARD_FLOOR_BYTES = '101';
    assert.throws(() => loadConfig(), /must not exceed/);

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
