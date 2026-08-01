import assert from 'node:assert/strict';
import fastify from 'fastify';
import { loadConfig } from '../config';
import { selectListenPort } from '../config/listenPort';

const controlledKeys = [
  'INDEXER_MODE',
  'TON_NETWORK',
  'TON_DATASOURCE',
  'PORT',
  'TRUST_PROXY',
  'FASTIFY_TRUST_PROXY',
  'TRUSTED_PROXY_CIDRS',
  'CORS_ENABLED',
  'SNAPSHOT_ON_EXIT',
  'SNAPSHOT_AUTOSAVE_ENABLED',
  'RATE_LIMIT_ENABLED',
  'RESPONSE_CACHE_ENABLED',
  'INDEXER_ENABLE_WRITE_RPC',
  'RATE_LIMIT_BUCKETS_JSON',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_MAX_KEYS',
  'RATE_LIMIT_GLOBAL_WINDOW_MS',
  'RATE_LIMIT_GLOBAL_MAX',
  'HEALTH_CACHE_TTL_MS',
  'PAGE_SIZE',
  'BACKFILL_CONCURRENCY',
  'INDEXER_RPC_PROXY_RETRY_DELAY_MS',
  'SORA_TON_TRUSTED_CHECKPOINT_SEQNO',
] as const;

function withCleanConfigEnv<T>(overrides: Record<string, string>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of controlledKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    return callback();
  } finally {
    for (const key of controlledKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function expectConfigFailure(overrides: Record<string, string>, expected: RegExp) {
  assert.throws(() => withCleanConfigEnv(overrides, loadConfig), expected);
}

async function main() {
  const defaults = withCleanConfigEnv({}, loadConfig);
  assert.equal(defaults.mode, 'dev');
  assert.equal(defaults.network, 'testnet');
  assert.equal(defaults.dataSource, 'http');
  assert.equal(defaults.port, 8787);

  const valid = withCleanConfigEnv(
    {
      INDEXER_MODE: ' Production ',
      TON_NETWORK: ' MAINNET ',
      TON_DATASOURCE: ' LITE ',
      PORT: '8787',
      TRUST_PROXY: ' yes ',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32',
      CORS_ENABLED: '0',
      RATE_LIMIT_BUCKETS_JSON: JSON.stringify({ accounts: { windowMs: 12_345, max: 77 } }),
      SORA_TON_TRUSTED_CHECKPOINT_SEQNO: '123',
    },
    loadConfig,
  );
  assert.equal(valid.mode, 'production');
  assert.equal(valid.network, 'mainnet');
  assert.equal(valid.dataSource, 'lite');
  assert.deepEqual(valid.trustProxy, ['10.0.0.0/8', '2001:db8::/32']);
  assert.equal(valid.corsEnabled, false);
  assert.deepEqual(valid.rateLimitBuckets.accounts, { windowMs: 12_345, max: 77 });
  assert.equal(valid.soraTonTrustedCheckpointSeqno, 123);

  const untrustedProxyApp = fastify({ trustProxy: defaults.trustProxy });
  untrustedProxyApp.get('/ip', async (request) => ({ ip: request.ip }));
  const spoofed = await untrustedProxyApp.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: '203.0.113.10',
    headers: { 'x-forwarded-for': '198.51.100.25' },
  });
  assert.equal(spoofed.json().ip, '203.0.113.10');
  await untrustedProxyApp.close();

  const trustedProxyApp = fastify({ trustProxy: valid.trustProxy });
  trustedProxyApp.get('/ip', async (request) => ({ ip: request.ip }));
  const forwarded = await trustedProxyApp.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: '10.1.2.3',
    headers: { 'x-forwarded-for': '198.51.100.25' },
  });
  assert.equal(forwarded.json().ip, '198.51.100.25');
  const forwardedFromUntrustedPeer = await trustedProxyApp.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: '203.0.113.10',
    headers: { 'x-forwarded-for': '198.51.100.25' },
  });
  assert.equal(forwardedFromUntrustedPeer.json().ip, '203.0.113.10');
  await trustedProxyApp.close();

  expectConfigFailure({ INDEXER_MODE: 'prod' }, /INDEXER_MODE must be dev or production/);
  expectConfigFailure({ INDEXER_MODE: '' }, /INDEXER_MODE must be dev or production/);
  expectConfigFailure({ TON_NETWORK: 'main' }, /TON_NETWORK must be mainnet or testnet/);
  expectConfigFailure({ TON_NETWORK: '   ' }, /TON_NETWORK must be mainnet or testnet/);
  expectConfigFailure({ TON_DATASOURCE: 'graphql' }, /TON_DATASOURCE must be http or lite/);
  expectConfigFailure({ TON_DATASOURCE: '' }, /TON_DATASOURCE must be http or lite/);
  expectConfigFailure(
    { INDEXER_MODE: 'production' },
    /TON_NETWORK is required when INDEXER_MODE=production/,
  );
  expectConfigFailure(
    { INDEXER_MODE: 'production', TON_NETWORK: 'testnet', TON_DATASOURCE: 'lite' },
    /TON_NETWORK must be mainnet when INDEXER_MODE=production/,
  );
  expectConfigFailure(
    { INDEXER_MODE: 'production', TON_NETWORK: 'mainnet' },
    /TON_DATASOURCE is required when INDEXER_MODE=production/,
  );
  expectConfigFailure(
    { INDEXER_MODE: 'production', TON_NETWORK: 'mainnet', TON_DATASOURCE: 'http' },
    /TON_DATASOURCE must be lite when INDEXER_MODE=production/,
  );
  expectConfigFailure(
    { INDEXER_MODE: 'production', TON_NETWORK: 'mainnet', TON_DATASOURCE: 'lite', TRUST_PROXY: 'true' },
    /TRUSTED_PROXY_CIDRS is required when proxy trust is enabled in production/,
  );
  for (const disabled of ['false', '0', 'no']) {
    expectConfigFailure(
      {
        INDEXER_MODE: 'production',
        TON_NETWORK: 'mainnet',
        TON_DATASOURCE: 'lite',
        RATE_LIMIT_ENABLED: disabled,
      },
      /RATE_LIMIT_ENABLED must be true when INDEXER_MODE=production/,
    );
  }
  assert.equal(withCleanConfigEnv({ RATE_LIMIT_ENABLED: 'false' }, loadConfig).rateLimitEnabled, false);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: 'not-an-ip' }, /contains invalid IP or CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '10.0.0.1\/33' }, /contains invalid IP or CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '2001:db8::\/129' }, /contains invalid IP or CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '0.0.0.0\/0' }, /contains an overbroad CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '::\/0' }, /contains an overbroad CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '' }, /must be a non-empty list/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '2001:DB8::\/32' }, /contains non-canonical IP or CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '2001:0db8::\/32' }, /contains non-canonical IP or CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '::ffff:c000:201' }, /contains non-canonical IP or CIDR/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '10.1.2.3\/8' }, /contains CIDR host bits/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '10.0.0.0\/8,10.0.0.0\/8' }, /contains duplicate entry/);
  expectConfigFailure({ TRUSTED_PROXY_CIDRS: '10.0.0.0\/8,10.1.0.0\/16' }, /contains overlapping entries/);

  for (const key of [
    'TRUST_PROXY',
    'FASTIFY_TRUST_PROXY',
    'CORS_ENABLED',
    'SNAPSHOT_ON_EXIT',
    'SNAPSHOT_AUTOSAVE_ENABLED',
    'RATE_LIMIT_ENABLED',
    'RESPONSE_CACHE_ENABLED',
    'INDEXER_ENABLE_WRITE_RPC',
  ]) {
    expectConfigFailure({ [key]: 'sometimes' }, new RegExp(`${key} must be one of`));
    expectConfigFailure({ [key]: '' }, new RegExp(`${key} must be one of`));
  }

  for (const [overrides, expected] of [
    [{ PORT: 'abc' }, /PORT must be an integer/],
    [{ PORT: '-1' }, /PORT must be an integer/],
    [{ PORT: '65536' }, /PORT must be an integer/],
    [{ PORT: '8787.5' }, /PORT must be an integer/],
    [{ PORT: '0x2253' }, /PORT must be an integer/],
    [{ PORT: '8e3' }, /PORT must be an integer/],
    [{ PORT: '08787' }, /PORT must be an integer/],
    [{ PORT: '-0' }, /PORT must be an integer/],
    [{ PORT: '9007199254740992' }, /PORT must be an integer/],
    [{ PORT: '' }, /PORT must be an integer/],
    [
      { INDEXER_MODE: 'production', TON_NETWORK: 'mainnet', TON_DATASOURCE: 'lite', PORT: '0' },
      /PORT must be a fixed non-zero port in production/,
    ],
    [{ RATE_LIMIT_WINDOW_MS: '0' }, /RATE_LIMIT_WINDOW_MS must be an integer/],
    [{ RATE_LIMIT_MAX: '1.5' }, /RATE_LIMIT_MAX must be an integer/],
    [{ RATE_LIMIT_MAX_KEYS: '0' }, /RATE_LIMIT_MAX_KEYS must be an integer/],
    [{ RATE_LIMIT_GLOBAL_WINDOW_MS: '0' }, /RATE_LIMIT_GLOBAL_WINDOW_MS must be an integer/],
    [{ RATE_LIMIT_GLOBAL_MAX: '0' }, /RATE_LIMIT_GLOBAL_MAX must be an integer/],
    [{ HEALTH_CACHE_TTL_MS: '5001' }, /HEALTH_CACHE_TTL_MS must be an integer/],
    [{ HEALTH_CACHE_TTL_MS: '-1' }, /HEALTH_CACHE_TTL_MS must be an integer/],
    [{ PAGE_SIZE: '0' }, /PAGE_SIZE must be an integer/],
    [{ BACKFILL_CONCURRENCY: '-1' }, /BACKFILL_CONCURRENCY must be an integer/],
    [{ INDEXER_RPC_PROXY_RETRY_DELAY_MS: '-1' }, /INDEXER_RPC_PROXY_RETRY_DELAY_MS must be an integer/],
    [{ SORA_TON_TRUSTED_CHECKPOINT_SEQNO: 'NaN' }, /SORA_TON_TRUSTED_CHECKPOINT_SEQNO must be an integer/],
    [{ SORA_TON_TRUSTED_CHECKPOINT_SEQNO: '-1' }, /SORA_TON_TRUSTED_CHECKPOINT_SEQNO must be an integer/],
    [{ SORA_TON_TRUSTED_CHECKPOINT_SEQNO: '1.5' }, /SORA_TON_TRUSTED_CHECKPOINT_SEQNO must be an integer/],
  ] as Array<[Record<string, string>, RegExp]>) {
    expectConfigFailure(overrides, expected);
  }

  for (const [value, expected] of [
    ['', /RATE_LIMIT_BUCKETS_JSON must be a non-empty JSON object/],
    ['{', /RATE_LIMIT_BUCKETS_JSON must be valid JSON/],
    ['[]', /RATE_LIMIT_BUCKETS_JSON must be an object/],
    ['null', /RATE_LIMIT_BUCKETS_JSON must be an object/],
    [JSON.stringify({ typo: { max: 1 } }), /contains unsupported bucket/],
    [JSON.stringify({ accounts: null }), /accounts must be an object/],
    [JSON.stringify({ accounts: { typo: 1 } }), /accounts contains unsupported field/],
    [JSON.stringify({ accounts: { max: 0 } }), /accounts.max must be a positive integer/],
    [JSON.stringify({ accounts: { max: 1.5 } }), /accounts.max must be a positive integer/],
    [JSON.stringify({ accounts: { windowMs: '1000' } }), /accounts.windowMs must be a positive integer/],
  ] as Array<[string, RegExp]>) {
    expectConfigFailure({ RATE_LIMIT_BUCKETS_JSON: value }, expected);
  }

  await assert.rejects(
    () => selectListenPort('0.0.0.0', 8787, 'production', 20, async () => false),
    /PORT 8787 is unavailable on 0\.0\.0\.0; production will not select a different port/,
  );
  assert.equal(await selectListenPort('127.0.0.1', 8787, 'production', 20, async () => true), 8787);

  const probed: number[] = [];
  const selected = await selectListenPort('127.0.0.1', 8787, 'dev', 3, async (_host, port) => {
    probed.push(port);
    return port === 8789;
  });
  assert.equal(selected, 8789);
  assert.deepEqual(probed, [8787, 8788, 8789]);
  await assert.rejects(
    () => selectListenPort('127.0.0.1', 65_535, 'dev', 3, async () => false),
    /No available port found starting at 65535/,
  );

  process.stdout.write('config fail-closed tests passed\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
