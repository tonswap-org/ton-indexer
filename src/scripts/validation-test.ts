import assert from 'node:assert/strict';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from '../api/validation';
import { loadConfig } from '../config';

assert.equal(parsePositiveInt('10'), 10);
assert.equal(parsePositiveInt('0'), null);
assert.equal(parsePositiveInt('-1'), null);
assert.equal(parsePositiveInt('foo'), null);

assert.equal(isValidLt('123'), true);
assert.equal(isValidLt('12a'), false);

// 32-byte hash base64 (all zero)
const hash = Buffer.alloc(32, 0).toString('base64');
assert.equal(isValidHashBase64(hash), true);
const urlSafeHash = Buffer.alloc(32, 0xff).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
assert.equal(isValidHashBase64(urlSafeHash), true);
assert.equal(isValidHashBase64('not-base64'), false);
assert.equal(isValidHashBase64(`${hash}!`), false);
assert.equal(isValidHashBase64(`!${hash}`), false);
assert.equal(isValidHashBase64(`${hash}=`), false);

// Valid TON address (raw format)
assert.equal(isValidAddress(`0:${'1'.repeat(64)}`), true);
assert.equal(isValidAddress('bad-address'), false);

const originalPageSize = process.env.PAGE_SIZE;
const originalBackfillConcurrency = process.env.BACKFILL_CONCURRENCY;
const originalHost = process.env.HOST;
const originalCorsAllowOrigins = process.env.CORS_ALLOW_ORIGINS;
const originalMode = process.env.INDEXER_MODE;
const originalNetwork = process.env.TON_NETWORK;
process.env.PAGE_SIZE = '0';
process.env.BACKFILL_CONCURRENCY = '-10';
delete process.env.HOST;
process.env.CORS_ALLOW_ORIGINS = 'https://app.example, https://wallet.example';
const config = loadConfig();
assert.equal(config.pageSize, 10);
assert.equal(config.backfillConcurrency, 2);
assert.equal(config.host, '127.0.0.1');
assert.deepEqual(config.corsAllowOrigins, ['https://app.example', 'https://wallet.example']);

process.env.INDEXER_MODE = 'prod';
assert.throws(() => loadConfig(), /INDEXER_MODE must be one of dev, production/);
process.env.INDEXER_MODE = 'production';
process.env.TON_NETWORK = 'main_net';
assert.throws(() => loadConfig(), /TON_NETWORK must be one of mainnet, testnet/);
process.env.TON_NETWORK = 'mainnet';

if (originalPageSize === undefined) delete process.env.PAGE_SIZE;
else process.env.PAGE_SIZE = originalPageSize;
if (originalBackfillConcurrency === undefined) delete process.env.BACKFILL_CONCURRENCY;
else process.env.BACKFILL_CONCURRENCY = originalBackfillConcurrency;
if (originalHost === undefined) delete process.env.HOST;
else process.env.HOST = originalHost;
if (originalCorsAllowOrigins === undefined) delete process.env.CORS_ALLOW_ORIGINS;
else process.env.CORS_ALLOW_ORIGINS = originalCorsAllowOrigins;
if (originalMode === undefined) delete process.env.INDEXER_MODE;
else process.env.INDEXER_MODE = originalMode;
if (originalNetwork === undefined) delete process.env.TON_NETWORK;
else process.env.TON_NETWORK = originalNetwork;

console.log('validation ok');
