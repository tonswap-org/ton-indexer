import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from '../api/validation';
import { loadConfig } from '../config';
import {
  REQUIRED_MAINNET_REGISTRY_KEYS,
  collectMainnetRegistryIssues,
  validateMainnetRegistry
} from '../config/registry';

assert.equal(parsePositiveInt('10'), 10);
assert.equal(parsePositiveInt('0'), null);
assert.equal(parsePositiveInt('-1'), null);
assert.equal(parsePositiveInt('foo'), null);

assert.equal(isValidLt('123'), true);
assert.equal(isValidLt('12a'), false);

// 32-byte hash base64 (all zero)
const hash = Buffer.alloc(32, 0).toString('base64');
assert.equal(isValidHashBase64(hash), true);
assert.equal(isValidHashBase64('not-base64'), false);

// Valid TON address (raw format)
assert.equal(isValidAddress(`0:${'1'.repeat(64)}`), true);
assert.equal(isValidAddress('bad-address'), false);

const originalPageSize = process.env.PAGE_SIZE;
const originalBackfillConcurrency = process.env.BACKFILL_CONCURRENCY;
const originalTrustProxy = process.env.TRUST_PROXY;
const originalHost = process.env.HOST;
const originalCorsAllowOrigins = process.env.CORS_ALLOW_ORIGINS;
const originalMode = process.env.INDEXER_MODE;
const originalNetwork = process.env.TON_NETWORK;
const originalDataSource = process.env.TON_DATASOURCE;
process.env.PAGE_SIZE = '0';
process.env.BACKFILL_CONCURRENCY = '-10';
process.env.TRUST_PROXY = 'true';
delete process.env.HOST;
process.env.CORS_ALLOW_ORIGINS = 'https://app.example, https://wallet.example';
const config = loadConfig();
assert.equal(config.pageSize, 10);
assert.equal(config.backfillConcurrency, 2);
assert.equal(config.trustProxy, true);
assert.equal(config.host, '127.0.0.1');
assert.deepEqual(config.corsAllowOrigins, ['https://app.example', 'https://wallet.example']);

process.env.INDEXER_MODE = 'prod';
assert.throws(() => loadConfig(), /INDEXER_MODE must be one of dev, production/);
process.env.INDEXER_MODE = 'production';
process.env.TON_NETWORK = 'main_net';
assert.throws(() => loadConfig(), /TON_NETWORK must be one of mainnet, testnet/);
process.env.TON_NETWORK = 'mainnet';
process.env.TON_DATASOURCE = 'archive';
assert.throws(() => loadConfig(), /TON_DATASOURCE must be one of http, lite/);
process.env.TON_DATASOURCE = 'LITE';
assert.equal(loadConfig().dataSource, 'lite');

const mainnetAddress = Address.parseRaw(`0:${'1'.repeat(64)}`).toString({ testOnly: false });
const testnetOnlyAddress = Address.parseRaw(`0:${'2'.repeat(64)}`).toString({ testOnly: true });
const completeMainnetRegistry = Object.fromEntries(
  REQUIRED_MAINNET_REGISTRY_KEYS.map((key) => [key, mainnetAddress])
) as Record<string, string>;
assert.doesNotThrow(() => validateMainnetRegistry(completeMainnetRegistry));
assert.deepEqual(collectMainnetRegistryIssues(completeMainnetRegistry), []);
assert.throws(
  () =>
    validateMainnetRegistry({
      ...completeMainnetRegistry,
      FeeRouter: 'REPLACE_WITH_MAINNET_FEE_ROUTER',
      Treasury: 'not-a-ton-address',
      T3Root: testnetOnlyAddress,
    }),
  /missing\/placeholder keys: FeeRouter \| invalid address keys: Treasury \| testnet-only address keys: T3Root/
);
if (originalPageSize === undefined) delete process.env.PAGE_SIZE;
else process.env.PAGE_SIZE = originalPageSize;
if (originalBackfillConcurrency === undefined) delete process.env.BACKFILL_CONCURRENCY;
else process.env.BACKFILL_CONCURRENCY = originalBackfillConcurrency;
if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
else process.env.TRUST_PROXY = originalTrustProxy;
if (originalHost === undefined) delete process.env.HOST;
else process.env.HOST = originalHost;
if (originalCorsAllowOrigins === undefined) delete process.env.CORS_ALLOW_ORIGINS;
else process.env.CORS_ALLOW_ORIGINS = originalCorsAllowOrigins;
if (originalMode === undefined) delete process.env.INDEXER_MODE;
else process.env.INDEXER_MODE = originalMode;
if (originalNetwork === undefined) delete process.env.TON_NETWORK;
else process.env.TON_NETWORK = originalNetwork;
if (originalDataSource === undefined) delete process.env.TON_DATASOURCE;
else process.env.TON_DATASOURCE = originalDataSource;

console.log('validation ok');
