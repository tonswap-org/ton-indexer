import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { loadConfig } from '../config';
import { registerRoutes } from '../api/routes';
import { setCorsHeaders } from '../api/cors';
import { RateLimiter } from '../api/rateLimit';
import { MemoryStore } from '../store/memoryStore';
import { loadSnapshotFile } from '../snapshot';
import { IndexedTx } from '../models';
import { BlockFollower } from '../workers/blockFollower';
import { TonDataSource, RawTransaction } from '../data/dataSource';
import { createLogger } from '../utils/logger';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { IndexerService } from '../indexerService';

const validAddress = `0:${'1'.repeat(64)}`;
const validHash = Buffer.alloc(32, 0).toString('base64');
const testConfig = (overrides: Partial<ReturnType<typeof loadConfig>> = {}) => ({
  ...loadConfig(),
  ...overrides,
});

const registerTestRoutes = (
  app: any,
  config: ReturnType<typeof loadConfig>,
  service: any,
  metrics?: any,
  snapshots?: any,
  debug?: any,
  rateLimiter?: RateLimiter,
  registry?: Record<string, string>
) => {
  registerRoutes(app, config, service, metrics, snapshots, debug, rateLimiter, registry);
};

const makeIndexedTx = (lt: number, hash = `h${lt}`): IndexedTx => ({
  address: validAddress,
  lt: String(lt),
  hash,
  utime: lt,
  success: true,
  inMessage: undefined,
  outMessages: [],
  kind: 'transfer',
  actions: [],
  ui: {
    txId: `${lt}:${hash}`,
    utime: lt,
    status: 'success',
    txType: 'Transfer',
    outCount: 0,
    detail: { kind: 'transfer' },
    kind: 'transfer',
    actions: [],
  },
});

const makeRawTx = (lt: number, hash = `h${lt}`): RawTransaction => ({
  lt: String(lt),
  hash,
  utime: lt,
  success: true,
  status: 'success',
  inMessage: undefined,
  outMessages: [],
});

const makeSource = (overrides: Partial<TonDataSource> = {}): TonDataSource => ({
  network: 'testnet',
  async getMasterchainInfo() {
    return { seqno: 1 };
  },
  async getAccountState() {
    return { balance: '0', lastTxLt: '0', lastTxHash: 'h0' };
  },
  async getTransactions() {
    return [];
  },
  async runGetMethod() {
    return null;
  },
  async getJettonBalance() {
    return null;
  },
  async getJettonMetadata() {
    return null;
  },
  async close() {
    return;
  },
  ...overrides,
});

const testRateLimitIgnoresUntrustedForwardedFor = async () => {
  const config = {
    ...loadConfig(),
    rateLimitEnabled: true,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 1,
    rateLimitBuckets: {
      accounts: { windowMs: 60_000, max: 1 },
      stream: { windowMs: 60_000, max: 1 },
      snapshot: { windowMs: 60_000, max: 1 },
      rpc: { windowMs: 60_000, max: 1 },
      docs: { windowMs: 60_000, max: 1 },
      default: { windowMs: 60_000, max: 1 },
    },
  };
  const app = fastify({ logger: false, trustProxy: false });
  const service = {
    getHealth() {
      return { lastMasterSeqno: 1 };
    },
  };
  registerRoutes(app, config, service as any, undefined, undefined, undefined, new RateLimiter(config));
  await app.ready();

  const first = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/health',
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/health',
    headers: { 'x-forwarded-for': '203.0.113.11' },
  });
  assert.equal(second.statusCode, 429);
  await app.close();
};

const testRateLimitUsesForwardedForOnlyWithTrustedProxy = async () => {
  const config = {
    ...loadConfig(),
    trustProxy: true,
    rateLimitEnabled: true,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 1,
    rateLimitBuckets: {
      accounts: { windowMs: 60_000, max: 1 },
      stream: { windowMs: 60_000, max: 1 },
      snapshot: { windowMs: 60_000, max: 1 },
      rpc: { windowMs: 60_000, max: 1 },
      docs: { windowMs: 60_000, max: 1 },
      default: { windowMs: 60_000, max: 1 },
    },
  };
  const app = fastify({ logger: false, trustProxy: true });
  const service = {
    getHealth() {
      return { lastMasterSeqno: 1 };
    },
  };
  registerRoutes(app, config, service as any, undefined, undefined, undefined, new RateLimiter(config));
  await app.ready();

  const first = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/health',
    headers: { 'x-forwarded-for': '203.0.113.20' },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/health',
    headers: { 'x-forwarded-for': '203.0.113.21' },
  });
  assert.equal(second.statusCode, 200);
  await app.close();
};

const testRateLimitBucketsAreIsolated = async () => {
  const config = {
    ...loadConfig(),
    rateLimitEnabled: true,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 1,
    rateLimitBuckets: {
      accounts: { windowMs: 60_000, max: 1 },
      stream: { windowMs: 60_000, max: 1 },
      snapshot: { windowMs: 60_000, max: 1 },
      rpc: { windowMs: 60_000, max: 1 },
      docs: { windowMs: 60_000, max: 1 },
      default: { windowMs: 60_000, max: 1 },
    },
  };
  const service = {
    getHealth() {
      return { lastMasterSeqno: 1 };
    },
    async getTransactions() {
      return {
        page: 1,
        page_size: 10,
        total_txs: 0,
        total_pages: null,
        total_pages_min: 0,
        history_complete: false,
        txs: [],
        network: 'testnet',
      };
    },
  };
  const app = fastify({ logger: false, trustProxy: false });
  registerRoutes(app, config, service as any, undefined, undefined, undefined, new RateLimiter(config));
  await app.ready();

  assert.equal((await app.inject({ method: 'GET', url: '/api/indexer/v1/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/indexer/v1/health' })).statusCode, 429);
  assert.equal((await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${validAddress}/txs` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${validAddress}/txs` })).statusCode, 429);
  await app.close();
};

const testRateLimiterResetsExpiredWindowsAndDisabledLimiterAllowsAll = () => {
  const config = {
    ...loadConfig(),
    rateLimitEnabled: true,
    rateLimitWindowMs: 100,
    rateLimitMax: 1,
    rateLimitBuckets: {
      accounts: { windowMs: 100, max: 1 },
      stream: { windowMs: 100, max: 1 },
      snapshot: { windowMs: 100, max: 1 },
      rpc: { windowMs: 100, max: 1 },
      docs: { windowMs: 100, max: 1 },
      default: { windowMs: 100, max: 1 },
    },
  };
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const limiter = new RateLimiter(config);
    assert.equal(limiter.check('client', 'default').allowed, true);
    assert.equal(limiter.check('client', 'default').allowed, false);
    now = 1_100;
    const afterReset = limiter.check('client', 'default');
    assert.equal(afterReset.allowed, true);
    assert.equal(afterReset.remaining, 0);

    const disabled = new RateLimiter({ ...config, rateLimitEnabled: false });
    assert.equal(disabled.check('client', 'default').allowed, true);
    assert.equal(disabled.check('client', 'default').allowed, true);
  } finally {
    Date.now = originalNow;
  }
};

const testJsonRpcGetTransactionsFillsLimitAcrossPages = async () => {
  const config = testConfig({ pageSize: 10 });
  const pages = new Map<number, IndexedTx[]>();
  pages.set(1, Array.from({ length: 10 }, (_value, index) => makeIndexedTx(20 - index)));
  pages.set(2, Array.from({ length: 10 }, (_value, index) => makeIndexedTx(10 - index)));
  const requestedPages: number[] = [];
  const service = {
    async getTransactions(_address: string, page: number) {
      requestedPages.push(page);
      return {
        page,
        page_size: 10,
        total_txs: 20,
        total_pages: 2,
        total_pages_min: 2,
        history_complete: true,
        txs: pages.get(page) ?? [],
        network: 'testnet',
      };
    },
    async getTransactionsByCursor() {
      throw new Error('cursor path should not be used');
    },
  };
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 99,
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: validAddress, limit: 15 },
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.id, 99);
  assert.equal(body.ok, true);
  assert.equal(body.result.length, 15);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(body.result[0].transaction_id.lt, '20');
  assert.equal(body.result[14].transaction_id.lt, '6');
  await app.close();
};

const testJsonRpcGetTransactionsCapsLimitAndDedupesPages = async () => {
  const config = testConfig({ pageSize: 10 });
  const requestedPages: number[] = [];
  const service = {
    async getTransactions(_address: string, page: number) {
      requestedPages.push(page);
      const start = 1_000 - (page - 1) * 10;
      return {
        page,
        page_size: 10,
        total_txs: 100,
        total_pages: null,
        total_pages_min: 10,
        history_complete: false,
        txs: Array.from({ length: 10 }, (_value, index) => makeIndexedTx(start - index)),
        network: 'testnet',
      };
    },
    async getTransactionsByCursor() {
      throw new Error('cursor path should not be used');
    },
  };
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const capped = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'cap',
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: validAddress, limit: 999 },
    },
  });
  assert.equal(capped.statusCode, 200);
  assert.equal(capped.json().ok, true);
  assert.equal(capped.json().result.length, 50);
  assert.deepEqual(requestedPages, [1, 2, 3, 4, 5]);
  await app.close();

  const dedupeCalls: number[] = [];
  const dedupeService = {
    async getTransactions(_address: string, page: number) {
      dedupeCalls.push(page);
      const pages = new Map<number, IndexedTx[]>([
        [1, [makeIndexedTx(60), makeIndexedTx(59), makeIndexedTx(59)]],
        [2, [makeIndexedTx(59), makeIndexedTx(58), makeIndexedTx(57)]],
        [3, []],
      ]);
      return {
        page,
        page_size: 3,
        total_txs: 5,
        total_pages: null,
        total_pages_min: 2,
        history_complete: false,
        txs: pages.get(page) ?? [],
        network: 'testnet',
      };
    },
    async getTransactionsByCursor() {
      throw new Error('cursor path should not be used');
    },
  };
  const dedupeApp = fastify({ logger: false });
  registerTestRoutes(dedupeApp, { ...config, pageSize: 3 }, dedupeService as any);
  await dedupeApp.ready();

  const deduped = await dedupeApp.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'dedupe',
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: validAddress, limit: 10 },
    },
  });
  assert.equal(deduped.statusCode, 200);
  assert.equal(deduped.json().ok, true);
  assert.deepEqual(
    deduped.json().result.map((entry: { transaction_id: { lt: string } }) => entry.transaction_id.lt),
    ['60', '59', '58', '57']
  );
  assert.deepEqual(dedupeCalls, [1, 2, 3]);
  await dedupeApp.close();
};

const testRestTxEndpointRejectsMalformedCursorsBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getTransactions() {
      calls += 1;
      return {};
    },
    async getTransactionsByCursor() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const mismatch = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/accounts/${validAddress}/txs?cursor_lt=1`,
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().code, 'cursor_mismatch');

  const invalid = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/accounts/${validAddress}/txs?cursor_lt=bad&cursor_hash=${encodeURIComponent(validHash)}`,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'FST_ERR_VALIDATION');

  const invalidHash = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/accounts/${validAddress}/txs?cursor_lt=1&cursor_hash=not-a-hash`,
  });
  assert.equal(invalidHash.statusCode, 400);
  assert.equal(invalidHash.json().code, 'invalid_cursor');
  assert.equal(calls, 0);
  await app.close();
};

const testRestAddressAndPayloadRoutesRejectInvalidPathsBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getBalance() {
      calls += 1;
      return {};
    },
    async getBalances() {
      calls += 1;
      return {};
    },
    async getTransactions() {
      calls += 1;
      return {};
    },
    async getState() {
      calls += 1;
      return {};
    },
    async getJettonTransferPayload() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const invalidBalance = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/accounts/not-an-address/balance',
  });
  assert.equal(invalidBalance.statusCode, 400);
  assert.equal(invalidBalance.json().code, 'invalid_address');

  const invalidBalances = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/accounts/not-an-address/balances',
  });
  assert.equal(invalidBalances.statusCode, 400);
  assert.equal(invalidBalances.json().code, 'invalid_address');

  const invalidAssets = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/accounts/not-an-address/assets',
  });
  assert.equal(invalidAssets.statusCode, 400);
  assert.equal(invalidAssets.json().code, 'invalid_address');

  const invalidTxs = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/accounts/not-an-address/txs',
  });
  assert.equal(invalidTxs.statusCode, 400);
  assert.equal(invalidTxs.json().code, 'invalid_address');

  const invalidState = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/accounts/not-an-address/state',
  });
  assert.equal(invalidState.statusCode, 400);
  assert.equal(invalidState.json().code, 'invalid_address');

  const invalidJetton = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/jettons/not-an-address/transfer/${validAddress}/payload`,
  });
  assert.equal(invalidJetton.statusCode, 400);
  assert.equal(invalidJetton.json().code, 'invalid_address');

  const invalidOwner = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/jettons/${validAddress}/transfer/not-an-address/payload`,
  });
  assert.equal(invalidOwner.statusCode, 400);
  assert.equal(invalidOwner.json().code, 'invalid_address');
  assert.equal(calls, 0);
  await app.close();
};

const testStreamRejectsMissingOrInvalidAddresses = async () => {
  let subscribed = false;
  const service = {
    subscribeBalanceChanges() {
      subscribed = true;
      return () => undefined;
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const missing = await app.inject({ method: 'GET', url: '/api/indexer/v1/stream/balances' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'invalid_address');

  const invalid = await app.inject({ method: 'GET', url: '/api/indexer/v1/stream?addresses=bad,also-bad' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'invalid_address');
  assert.equal(subscribed, false);
  await app.close();
};

const testJsonRpcRejectsMalformedTransactionCursors = async () => {
  const config = testConfig();
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, {} as any);
  await app.ready();

  const missingHash = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 1,
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: validAddress, lt: '1' },
    },
  });
  assert.equal(missingHash.statusCode, 200);
  assert.equal(missingHash.json().ok, false);
  assert.equal(missingHash.json().code, 400);

  const invalidHash = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 2,
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: validAddress, lt: '1', hash: 'not-a-hash' },
    },
  });
  assert.equal(invalidHash.statusCode, 200);
  assert.equal(invalidHash.json().ok, false);
  assert.equal(invalidHash.json().code, 400);
  await app.close();
};

const testJsonRpcRejectsMissingMethodAndInvalidTransactionAddressBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getTransactions() {
      calls += 1;
      return {};
    },
    async getTransactionsByCursor() {
      calls += 1;
      return {};
    },
  };
  const config = testConfig();
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const missingMethod = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: { id: 'missing', jsonrpc: '2.0', params: {} },
  });
  assert.equal(missingMethod.statusCode, 200);
  assert.equal(missingMethod.json().ok, false);
  assert.equal(missingMethod.json().code, 400);
  assert.equal(missingMethod.json().error, 'missing method');

  const invalidAddress = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'bad-address',
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: 'not-an-address', limit: 5 },
    },
  });
  assert.equal(invalidAddress.statusCode, 200);
  assert.equal(invalidAddress.json().ok, false);
  assert.equal(invalidAddress.json().code, 400);

  const nonObjectParams = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'bad-params',
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: [],
    },
  });
  assert.equal(nonObjectParams.statusCode, 200);
  assert.equal(nonObjectParams.json().ok, false);
  assert.equal(nonObjectParams.json().code, 400);
  assert.equal(calls, 0);
  await app.close();
};

const testJsonRpcRejectsMalformedAccountAndGetterInputsBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getBalances() {
      calls += 1;
      return { ton_raw: '0' };
    },
    async getState() {
      calls += 1;
      return {};
    },
    async runGetMethod() {
      calls += 1;
      return { stack: [], exit_code: 0, gas_used: 0 };
    },
  };
  const config = testConfig();
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const invalidBalance = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: { id: 'balance', jsonrpc: '2.0', method: 'getAddressBalance', params: { address: 'bad' } },
  });
  assert.equal(invalidBalance.statusCode, 200);
  assert.equal(invalidBalance.json().ok, false);
  assert.equal(invalidBalance.json().code, 400);

  const invalidInformation = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: { id: 'info', jsonrpc: '2.0', method: 'getAddressInformation', params: { address: 'bad' } },
  });
  assert.equal(invalidInformation.statusCode, 200);
  assert.equal(invalidInformation.json().ok, false);
  assert.equal(invalidInformation.json().code, 400);

  const invalidGetterAddress = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'getter-address',
      jsonrpc: '2.0',
      method: 'runGetMethod',
      params: { address: 'bad', method: 'seqno' },
    },
  });
  assert.equal(invalidGetterAddress.statusCode, 200);
  assert.equal(invalidGetterAddress.json().ok, false);
  assert.equal(invalidGetterAddress.json().code, 400);

  const invalidGetterName = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'getter-name',
      jsonrpc: '2.0',
      method: 'runGetMethod',
      params: { address: validAddress, method: 'bad-method!' },
    },
  });
  assert.equal(invalidGetterName.statusCode, 200);
  assert.equal(invalidGetterName.json().ok, false);
  assert.equal(invalidGetterName.json().code, 400);

  const invalidStack = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'getter-stack',
      jsonrpc: '2.0',
      method: 'runGetMethod',
      params: { address: validAddress, method: 'seqno', stack: [['int', 'not-an-int']] },
    },
  });
  assert.equal(invalidStack.statusCode, 200);
  assert.equal(invalidStack.json().ok, false);
  assert.equal(invalidStack.json().code, 400);
  assert.equal(calls, 0);
  await app.close();
};

const testJsonRpcAddressInformationNormalizesMissingStateFields = async () => {
  let stateCalls = 0;
  let balanceCalls = 0;
  const service = {
    async getState(address: string) {
      stateCalls += 1;
      assert.equal(address, validAddress);
      return {
        account_state: 'unexpected',
        code_boc: 123,
        data_boc: null,
        last_tx_lt: ' ',
        last_tx_hash: '',
        last_confirmed_seqno: -10,
        last_seen_utime: Number.NaN,
      };
    },
    async getBalances(address: string) {
      balanceCalls += 1;
      assert.equal(address, validAddress);
      return { ton_raw: '123' };
    },
  };
  const config = testConfig();
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 'info-normalize',
      jsonrpc: '2.0',
      method: 'getAddressInformation',
      params: { address: validAddress },
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.state, 'uninitialized');
  assert.equal(body.result.balance, '123');
  assert.equal(body.result.code, '');
  assert.equal(body.result.data, '');
  assert.equal(body.result.last_transaction_id.lt, '0');
  assert.equal(body.result.last_transaction_id.hash, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  assert.equal(body.result.block_id.seqno, 0);
  assert.equal(typeof body.result.sync_utime, 'number');
  assert.equal(stateCalls, 1);
  assert.equal(balanceCalls, 1);
  await app.close();
};

const testJsonRpcRejectsUnsupportedAndDisabledWriteMethods = async () => {
  const config = testConfig({
    enableWriteRpc: false,
    rpcProxyEndpoint: 'https://example.invalid/jsonRPC',
    rpcProxyEndpoints: ['https://example.invalid/jsonRPC'],
  });
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, {} as any);
  await app.ready();

  const disabledWrite = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: { id: 'write', jsonrpc: '2.0', method: 'sendBoc', params: { boc: 'bad' } },
  });
  assert.equal(disabledWrite.statusCode, 200);
  assert.equal(disabledWrite.json().ok, false);
  assert.equal(disabledWrite.json().code, 403);
  assert.match(disabledWrite.json().error, /method disabled/);

  const unsupported = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: { id: 'unknown', jsonrpc: '2.0', method: 'unknownMethod', params: {} },
  });
  assert.equal(unsupported.statusCode, 200);
  assert.equal(unsupported.json().ok, false);
  assert.equal(unsupported.json().code, 404);
  await app.close();
};

const testJsonRpcProxySurfacesInvalidUpstreamJson = async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls += 1;
    return new Response('not-json', { status: 200 });
  };
  const app = fastify({ logger: false });
  try {
    const config = testConfig({
      rpcProxyEndpoint: 'https://example.invalid/jsonRPC',
      rpcProxyEndpoints: ['https://example.invalid/jsonRPC'],
      rpcProxyRetryAttempts: 1,
      rpcProxyRetryDelayMs: 0,
    });
    registerTestRoutes(app, config, {} as any);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/jsonRPC',
      payload: { id: 'proxy-json', jsonrpc: '2.0', method: 'getMasterchainInfo', params: {} },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, false);
    assert.equal(response.json().code, 502);
    assert.match(response.json().error, /Invalid upstream RPC JSON/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
};

const testRunGetMethodRejectsMalformedStackBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async runGetMethod() {
      calls += 1;
      return { stack: [], exit_code: 0, gas_used: 0 };
    },
  };
  const app = fastify({ logger: false });
  const config = testConfig();
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethod',
    payload: { address: validAddress, method: 'seqno', stack: [['cell', 'not-valid-base64!']] },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'invalid_stack');
  assert.equal(calls, 0);
  await app.close();
};

const testRunGetMethodRejectsOversizedStackBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async runGetMethod() {
      calls += 1;
      return { stack: [], exit_code: 0, gas_used: 0 };
    },
  };
  const app = fastify({ logger: false });
  const config = testConfig();
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethod',
    payload: {
      address: validAddress,
      method: 'seqno',
      stack: Array.from({ length: 17 }, () => ['num', '1']),
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'invalid_stack');
  assert.equal(calls, 0);
  await app.close();
};

const testJsonRpcCursorPaginationStopsOnDuplicateCursor = async () => {
  const config = testConfig({ pageSize: 10 });
  let cursorCalls = 0;
  const service = {
    async getTransactions() {
      throw new Error('page path should not be used');
    },
    async getTransactionsByCursor(_address: string, lt: string, hash: string) {
      cursorCalls += 1;
      return {
        page: 1,
        page_size: 1,
        total_txs: 1,
        total_pages: null,
        total_pages_min: 1,
        history_complete: false,
        txs: [makeIndexedTx(Number(lt), hash)],
        network: 'testnet',
      };
    },
  };
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: {
      id: 3,
      jsonrpc: '2.0',
      method: 'getTransactions',
      params: { address: validAddress, limit: 3, lt: '100', hash: validHash },
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.length, 1);
  assert.equal(cursorCalls, 1);
  await app.close();
};

const testDefiSnapshotRejectsInvalidInputsBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getDefiSnapshot() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const missingContracts = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/defi/snapshot',
    payload: {},
  });
  assert.equal(missingContracts.statusCode, 400);
  assert.equal(missingContracts.json().code, 'FST_ERR_VALIDATION');

  const invalidOwner = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/defi/snapshot',
    payload: { owner: 'bad-owner', contracts: {} },
  });
  assert.equal(invalidOwner.statusCode, 400);
  assert.equal(invalidOwner.json().code, 'invalid_address');

  const invalidContract = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/defi/snapshot',
    payload: { contracts: { feeRouter: 'bad-contract' } },
  });
  assert.equal(invalidContract.statusCode, 400);
  assert.equal(invalidContract.json().code, 'invalid_address');

  const tooManyModules = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/defi/snapshot',
    payload: {
      contracts: {},
      modules: Array.from({ length: 65 }, (_value, index) => ({ key: `m${index}`, address: validAddress })),
    },
  });
  assert.equal(tooManyModules.statusCode, 400);
  assert.equal(tooManyModules.json().code, 'bad_request');

  const invalidModule = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/defi/snapshot',
    payload: { contracts: {}, modules: [{ key: 'bad', address: 'bad-address' }] },
  });
  assert.equal(invalidModule.statusCode, 400);
  assert.equal(invalidModule.json().code, 'invalid_address');
  assert.equal(calls, 0);
  await app.close();
};

const testDlmmPoolsSnapshotRejectsInvalidInputsBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getDlmmPoolsSnapshot() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const missingTokens = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/dlmm/pools/snapshot',
    payload: { t3Root: validAddress, tokens: [] },
  });
  assert.equal(missingTokens.statusCode, 400);
  assert.equal(missingTokens.json().code, 'bad_request');

  const invalidRegistry = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/dlmm/pools/snapshot',
    payload: { t3Root: validAddress, dlmmRegistry: 'bad-registry', tokens: [validAddress] },
  });
  assert.equal(invalidRegistry.statusCode, 400);
  assert.equal(invalidRegistry.json().code, 'invalid_address');

  const invalidToken = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/dlmm/pools/snapshot',
    payload: { t3Root: validAddress, tokens: [validAddress, 'bad-token'] },
  });
  assert.equal(invalidToken.statusCode, 400);
  assert.equal(invalidToken.json().code, 'invalid_address');

  const tooManyTokens = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/dlmm/pools/snapshot',
    payload: { t3Root: validAddress, tokens: Array.from({ length: 65 }, () => validAddress) },
  });
  assert.equal(tooManyTokens.statusCode, 400);
  assert.equal(tooManyTokens.json().code, 'bad_request');
  assert.equal(calls, 0);
  await app.close();
};

const testSnapshotGetRoutesRejectInvalidAddressesBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getPerpsSnapshot() {
      calls += 1;
      return {};
    },
    async getVolIndexSnapshot() {
      calls += 1;
      return {};
    },
    async getGovernanceSnapshot() {
      calls += 1;
      return {};
    },
    async getFarmSnapshot() {
      calls += 1;
      return {};
    },
    async getOptionsSnapshot() {
      calls += 1;
      return {};
    },
    async getCoverSnapshot() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const invalidPerpsEngine = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/perps/not-an-address/snapshot',
  });
  assert.equal(invalidPerpsEngine.statusCode, 400);
  assert.equal(invalidPerpsEngine.json().code, 'invalid_address');

  const invalidVolIndexPool = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/vol-index/${validAddress}/snapshot?pool=not-an-address`,
  });
  assert.equal(invalidVolIndexPool.statusCode, 400);
  assert.equal(invalidVolIndexPool.json().code, 'invalid_address');

  const invalidGovernanceOwner = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/governance/${validAddress}/snapshot?owner=not-an-address`,
  });
  assert.equal(invalidGovernanceOwner.statusCode, 400);
  assert.equal(invalidGovernanceOwner.json().code, 'invalid_address');

  const invalidFarmFactory = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/farms/not-an-address/snapshot',
  });
  assert.equal(invalidFarmFactory.statusCode, 400);
  assert.equal(invalidFarmFactory.json().code, 'invalid_address');

  const invalidOptionsFactory = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/options/not-an-address/snapshot',
  });
  assert.equal(invalidOptionsFactory.statusCode, 400);
  assert.equal(invalidOptionsFactory.json().code, 'invalid_address');

  const invalidCoverOwner = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/cover/${validAddress}/snapshot?owner=not-an-address`,
  });
  assert.equal(invalidCoverOwner.statusCode, 400);
  assert.equal(invalidCoverOwner.json().code, 'invalid_address');
  assert.equal(calls, 0);
  await app.close();
};

const testSnapshotEndpointsSurfaceLoadErrors = async () => {
  const config = testConfig();
  const app = fastify({ logger: false });
  const snapshots = {
    load() {
      throw new Error('Snapshot not found or invalid');
    },
    save() {
      return { path: '/tmp/snapshot.json', entries: 0 };
    },
  };
  registerTestRoutes(app, config, {} as any, undefined, snapshots as any);
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/snapshot/load',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'bad_request');
  assert.equal(response.json().error, 'snapshot load failed');
  await app.close();
};

const testJsonRpcBatchGetMethodRejectsOversizedAndMalformedCalls = async () => {
  const app = fastify({ logger: false });
  const service = {
    async runGetMethod() {
      throw new Error('invalid calls should not execute');
    },
  };
  const config = testConfig();
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const oversized = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethods',
    payload: { calls: Array.from({ length: 65 }, () => ({ address: validAddress, method: 'seqno' })) },
  });
  assert.equal(oversized.statusCode, 400);
  assert.equal(oversized.json().code, 'bad_request');

  const malformed = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethods',
    payload: {
      calls: [
        { address: 'bad-address', method: 'seqno' },
        { address: validAddress, method: 'bad-method!' },
        { address: validAddress, method: 'seqno', stack: [['unsupported', 'x']] },
      ],
    },
  });
  assert.equal(malformed.statusCode, 200);
  assert.deepEqual(
    malformed.json().results.map((entry: { code: string }) => entry.code),
    ['invalid_address', 'invalid_method', 'invalid_stack']
  );
  await app.close();
};

const testJsonRpcBatchGetMethodRejectsMissingCallsAndIsolatesFailures = async () => {
  let serviceCalls = 0;
  const app = fastify({ logger: false });
  const service = {
    async runGetMethod(address: string, method: string) {
      serviceCalls += 1;
      assert.equal(address, validAddress);
      assert.equal(method, 'seqno');
      return { stack: [['num', '7']], exit_code: 0, gas_used: 12 };
    },
  };
  const config = testConfig();
  registerTestRoutes(app, config, service as any);
  await app.ready();

  const missing = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethods',
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'bad_request');

  const nonArray = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethods',
    payload: { calls: null },
  });
  assert.equal(nonArray.statusCode, 400);
  assert.equal(nonArray.json().code, 'bad_request');

  const mixed = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethods',
    payload: {
      calls: [
        { address: validAddress, method: 'seqno' },
        { address: validAddress, method: 'bad-method!' },
        { address: 'bad-address', method: 'seqno' },
      ],
    },
  });
  assert.equal(mixed.statusCode, 200);
  assert.deepEqual(
    mixed.json().results.map((entry: { ok: boolean; code?: string }) => (entry.ok ? 'ok' : entry.code)),
    ['ok', 'invalid_method', 'invalid_address']
  );
  assert.equal(mixed.json().results[0].gas_used, 12);
  assert.equal(serviceCalls, 1);
  await app.close();
};

const testDebugEndpointReturnsDisabledWithoutService = async () => {
  const config = testConfig();
  const app = fastify({ logger: false });
  registerTestRoutes(app, config, {} as any);
  await app.ready();

  const response = await app.inject({
    method: 'GET',
    url: '/api/indexer/v1/debug',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'debug_disabled');
  await app.close();
};

const testOperationalRoutesDoNotRequireAdminAndPublicReadsStayOpen = async () => {
  const app = fastify({ logger: false });
  const service = {
    async runGetMethod() {
      return { stack: [['num', '7']], exit_code: 0, gas_used: 12 };
    },
  };
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const metrics = await app.inject({ method: 'GET', url: '/api/indexer/v1/metrics' });
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.json().code, 'metrics_disabled');

  const snapshot = await app.inject({ method: 'POST', url: '/api/indexer/v1/snapshot/load' });
  assert.equal(snapshot.statusCode, 400);
  assert.equal(snapshot.json().code, 'snapshot_disabled');

  const getter = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/runGetMethod',
    payload: { address: validAddress, method: 'seqno' },
  });
  assert.equal(getter.statusCode, 200);
  assert.equal(getter.json().exit_code, 0);

  const rpcGetter = await app.inject({
    method: 'POST',
    url: '/jsonRPC',
    payload: { id: 'public-getter', jsonrpc: '2.0', method: 'runGetMethod', params: { address: validAddress, method: 'seqno' } },
  });
  assert.equal(rpcGetter.statusCode, 200);
  assert.equal(rpcGetter.json().ok, true);
  await app.close();
};

const testWriteRpcRelayIsPublicWhenExplicitlyEnabled = async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, result: 'hash' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const app = fastify({ logger: false });
  try {
    const config = testConfig({
      enableWriteRpc: true,
      rpcProxyEndpoint: 'https://example.invalid/jsonRPC',
      rpcProxyEndpoints: ['https://example.invalid/jsonRPC'],
    });
    registerTestRoutes(app, config, {} as any);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/jsonRPC',
      payload: { id: 'write', jsonrpc: '2.0', method: 'sendBoc', params: { boc: 'te6ccgEBAQEAAgAAAA==' } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
};

const testCorsExactOriginAllowlistAndWildcardFallback = () => {
  const collect = (config: ReturnType<typeof loadConfig>, origin?: string) => {
    const headers: Record<string, string> = {};
    setCorsHeaders(
      { headers: origin ? { origin } : {} },
      { header(name: string, value: string | number) {
        headers[name] = String(value);
      } },
      config
    );
    return headers;
  };

  const allowlist = testConfig({
    corsAllowOrigin: '*',
    corsAllowOrigins: ['https://app.example'],
  });
  const allowed = collect(allowlist, 'https://app.example');
  assert.equal(allowed['access-control-allow-origin'], 'https://app.example');
  assert.equal(allowed['access-control-allow-credentials'], 'true');
  assert.equal(allowed.vary, 'origin');

  const denied = collect(allowlist, 'https://evil.example');
  assert.equal(denied['access-control-allow-origin'], undefined);
  assert.equal(denied['access-control-allow-methods'], allowlist.corsAllowMethods);

  const wildcard = collect(testConfig({ corsAllowOrigin: 'reflect', corsAllowOrigins: [] }), 'https://evil.example');
  assert.equal(wildcard['access-control-allow-origin'], '*');
  assert.equal(wildcard['access-control-allow-credentials'], undefined);
};

const testDocsRouteSetsNonceCspAndSecurityHeaders = async () => {
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, {} as any);
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/api/indexer/v1/docs' });
  assert.equal(response.statusCode, 200);
  const nonce = /<script nonce="([^"]+)">/.exec(response.body)?.[1];
  assert.ok(nonce);
  assert.ok((response.headers['content-security-policy'] as string).includes(`script-src 'nonce-${nonce}'`));
  assert.ok((response.headers['content-security-policy'] as string).includes(`style-src 'nonce-${nonce}'`));
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  await app.close();
};

const testDangerousEnvValuesFallBack = () => {
  const original = {
    port: process.env.PORT,
    pageSize: process.env.PAGE_SIZE,
    interval: process.env.SNAPSHOT_AUTOSAVE_INTERVAL_MS,
    retry: process.env.INDEXER_RPC_PROXY_RETRY_ATTEMPTS,
    rateLimit: process.env.RATE_LIMIT_MAX,
  };
  process.env.PORT = '99999';
  process.env.PAGE_SIZE = '-20';
  process.env.SNAPSHOT_AUTOSAVE_INTERVAL_MS = '0';
  process.env.INDEXER_RPC_PROXY_RETRY_ATTEMPTS = '0';
  process.env.RATE_LIMIT_MAX = '-1';
  const config = loadConfig();
  assert.equal(config.port, 8787);
  assert.equal(config.pageSize, 10);
  assert.equal(config.snapshotAutosaveIntervalMs, 30_000);
  assert.equal(config.rpcProxyRetryAttempts, 4);
  assert.equal(config.rateLimitMax, 10_000);
  if (original.port === undefined) delete process.env.PORT;
  else process.env.PORT = original.port;
  if (original.pageSize === undefined) delete process.env.PAGE_SIZE;
  else process.env.PAGE_SIZE = original.pageSize;
  if (original.interval === undefined) delete process.env.SNAPSHOT_AUTOSAVE_INTERVAL_MS;
  else process.env.SNAPSHOT_AUTOSAVE_INTERVAL_MS = original.interval;
  if (original.retry === undefined) delete process.env.INDEXER_RPC_PROXY_RETRY_ATTEMPTS;
  else process.env.INDEXER_RPC_PROXY_RETRY_ATTEMPTS = original.retry;
  if (original.rateLimit === undefined) delete process.env.RATE_LIMIT_MAX;
  else process.env.RATE_LIMIT_MAX = original.rateLimit;
};

const testRateLimitBucketEnvRejectsMalformedAndDangerousOverrides = () => {
  const original = {
    buckets: process.env.RATE_LIMIT_BUCKETS_JSON,
    window: process.env.RATE_LIMIT_WINDOW_MS,
    max: process.env.RATE_LIMIT_MAX,
  };
  try {
    process.env.RATE_LIMIT_WINDOW_MS = '1000';
    process.env.RATE_LIMIT_MAX = '5';
    process.env.RATE_LIMIT_BUCKETS_JSON = JSON.stringify({
      accounts: { windowMs: -1, max: 0 },
      docs: { windowMs: 1234.8, max: 2.9 },
      unknown: { windowMs: 1, max: 1 },
    });
    const merged = loadConfig();
    assert.equal(merged.rateLimitBuckets.accounts.windowMs, 1000);
    assert.equal(merged.rateLimitBuckets.accounts.max, 5);
    assert.equal(merged.rateLimitBuckets.docs.windowMs, 1234);
    assert.equal(merged.rateLimitBuckets.docs.max, 2);
    assert.equal((merged.rateLimitBuckets as any).unknown, undefined);

    process.env.RATE_LIMIT_BUCKETS_JSON = '{not-json';
    const fallback = loadConfig();
    assert.equal(fallback.rateLimitBuckets.accounts.windowMs, 1000);
    assert.equal(fallback.rateLimitBuckets.accounts.max, 5);
    assert.equal(fallback.rateLimitBuckets.docs.max, 2_000);
  } finally {
    if (original.buckets === undefined) delete process.env.RATE_LIMIT_BUCKETS_JSON;
    else process.env.RATE_LIMIT_BUCKETS_JSON = original.buckets;
    if (original.window === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
    else process.env.RATE_LIMIT_WINDOW_MS = original.window;
    if (original.max === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = original.max;
  }
};

const testSnapshotFileLoaderRejectsMalformedFiles = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ton-indexer-snapshot-test-'));
  try {
    assert.equal(loadSnapshotFile(join(dir, 'missing.json')), null);

    const invalidJson = join(dir, 'invalid-json.json');
    writeFileSync(invalidJson, '{not-json', 'utf8');
    assert.equal(loadSnapshotFile(invalidJson), null);

    const wrongVersion = join(dir, 'wrong-version.json');
    writeFileSync(wrongVersion, JSON.stringify({ version: 2, entries: [] }), 'utf8');
    assert.equal(loadSnapshotFile(wrongVersion), null);

    const wrongEntries = join(dir, 'wrong-entries.json');
    writeFileSync(wrongEntries, JSON.stringify({ version: 1, entries: {} }), 'utf8');
    assert.equal(loadSnapshotFile(wrongEntries), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const testClassifierIgnoresMalformedBodies = () => {
  const indexed = classifyTransaction(
    validAddress,
    {
      lt: '777',
      hash: 'malformed-body',
      utime: 777,
      success: true,
      status: 'success',
      inMessage: {
        source: `0:${'2'.repeat(64)}`,
        destination: validAddress,
        value: '1',
        op: 0x53574150,
        body: 'not-valid-base64!',
      },
      outMessages: [
        {
          source: validAddress,
          destination: `0:${'3'.repeat(64)}`,
          op: 0x0f8a7ea5,
          body: 'also-not-boc',
        },
      ],
    },
    loadOpcodes(undefined)
  );
  assert.equal(indexed.kind, 'swap');
  assert.equal(indexed.ui.kind, 'swap');
  assert.equal(indexed.actions.length, 1);
  assert.equal(indexed.ui.txId, '777:malformed-body');
};

const testMemoryOverflowMarksHistoryIncomplete = () => {
  const config = { ...loadConfig(), pageSize: 2, maxPagesPerAddress: 1, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  store.markHistoryComplete(validAddress);
  store.addTransactions(validAddress, [makeIndexedTx(3), makeIndexedTx(2), makeIndexedTx(1)]);
  const entry = store.get(validAddress);
  assert.equal(entry?.txs.length, 2);
  assert.equal(entry?.stats.historyComplete, false);
};

const testMemoryStoreDeduplicatesTransactions = () => {
  const config = { ...loadConfig(), pageSize: 10, maxPagesPerAddress: 10, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  store.addTransactions(validAddress, [makeIndexedTx(3), makeIndexedTx(3), makeIndexedTx(2)]);
  store.addTransactions(validAddress, [makeIndexedTx(3), makeIndexedTx(1)]);
  const entry = store.get(validAddress);
  assert.equal(entry?.txs.length, 3);
  assert.equal(entry?.stats.txCount, 3);
  assert.equal(store.getTotalTxs(), 3);
  assert.deepEqual(entry?.txs.map((tx) => tx.lt), ['3', '2', '1']);
};

const testMemoryStoreImportNormalizesStatsAndSortOrder = () => {
  const config = { ...loadConfig(), pageSize: 2, maxPagesPerAddress: 10, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  store.importSnapshot({
    version: 1,
    createdAt: Date.now(),
    entries: [
      {
        address: validAddress,
        txs: [makeIndexedTx(1), makeIndexedTx(3), makeIndexedTx(2)],
        stats: {
          txCount: 999,
          historyComplete: true,
          totalPagesMin: 999,
          lastRequestAt: 1,
        },
      },
    ],
  });
  const entry = store.get(validAddress);
  assert.deepEqual(entry?.txs.map((tx) => tx.lt), ['3', '2', '1']);
  assert.equal(entry?.stats.txCount, 3);
  assert.equal(entry?.stats.totalPagesMin, 2);
  assert.equal(store.getTotalTxs(), 3);
};

const testMemoryStoreGlobalLimitEvictsColdAddresses = () => {
  const config = { ...loadConfig(), pageSize: 2, maxPagesPerAddress: 10, globalMaxPages: 1, maxAddresses: 10 };
  const store = new MemoryStore(config);
  const firstAddress = `0:${'2'.repeat(64)}`;
  const secondAddress = `0:${'3'.repeat(64)}`;
  store.addTransactions(firstAddress, [makeIndexedTx(4), makeIndexedTx(3)]);
  store.addTransactions(secondAddress, [makeIndexedTx(2), makeIndexedTx(1)]);
  assert.equal(store.getTotalTxs(), 2);
  assert.equal(store.getAddressCount(), 1);
  assert.equal(store.get(secondAddress)?.txs.length, 2);
};

const testMemoryStoreMaxAddressEvictionAdjustsTotal = () => {
  const config = { ...loadConfig(), pageSize: 10, maxPagesPerAddress: 10, globalMaxPages: 100, maxAddresses: 1 };
  const store = new MemoryStore(config);
  const firstAddress = `0:${'4'.repeat(64)}`;
  const secondAddress = `0:${'5'.repeat(64)}`;
  store.addTransactions(firstAddress, [makeIndexedTx(10), makeIndexedTx(9)]);
  assert.equal(store.getTotalTxs(), 2);
  store.addTransactions(secondAddress, [makeIndexedTx(8), makeIndexedTx(7), makeIndexedTx(6)]);
  assert.equal(store.getAddressCount(), 1);
  assert.equal(store.get(firstAddress), undefined);
  assert.equal(store.get(secondAddress)?.txs.length, 3);
  assert.equal(store.getTotalTxs(), 3);
};

const testAccountSwapQueryRejectsInvalidTimeWindow = async () => {
  let calls = 0;
  const service = {
    async getSwapExecutions() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const invalidNumber = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/accounts/${validAddress}/swaps?from_utime=0`,
  });
  assert.equal(invalidNumber.statusCode, 400);
  assert.equal(invalidNumber.json().code, 'FST_ERR_VALIDATION');

  const inverted = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/accounts/${validAddress}/swaps?from_utime=20&to_utime=10`,
  });
  assert.equal(inverted.statusCode, 400);
  assert.equal(inverted.json().code, 'bad_request');
  assert.equal(calls, 0);
  await app.close();
};

const testSccpProofRejectsPartialTrustedCheckpoint = async () => {
  let calls = 0;
  const service = {
    async getTonSccpBurnProofMaterial() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const response = await app.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/sccp/ton/burn-proof-material?jetton_master=${validAddress}` +
      `&message_id=0x${'a'.repeat(64)}&trusted_checkpoint_seqno=123`,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'bad_request');
  assert.equal(calls, 0);
  await app.close();
};

const testSccpProofRejectsMalformedRequiredFieldsBeforeServiceCall = async () => {
  let calls = 0;
  const service = {
    async getTonSccpBurnProofMaterial() {
      calls += 1;
      return {};
    },
  };
  const app = fastify({ logger: false });
  registerRoutes(app, { ...loadConfig() }, service as any);
  await app.ready();

  const invalidJetton = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/sccp/ton/burn-proof-material?jetton_master=bad&message_id=0x${'a'.repeat(64)}`,
  });
  assert.equal(invalidJetton.statusCode, 400);
  assert.equal(invalidJetton.json().code, 'invalid_address');

  const invalidMessageId = await app.inject({
    method: 'GET',
    url: `/api/indexer/v1/sccp/ton/burn-proof-material?jetton_master=${validAddress}&message_id=0xabc`,
  });
  assert.equal(invalidMessageId.statusCode, 400);
  assert.equal(invalidMessageId.json().code, 'FST_ERR_VALIDATION');

  const invalidTarget = await app.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/sccp/ton/burn-proof-material?jetton_master=${validAddress}` +
      `&message_id=0x${'a'.repeat(64)}&target_seqno=0`,
  });
  assert.equal(invalidTarget.statusCode, 400);
  assert.equal(invalidTarget.json().code, 'FST_ERR_VALIDATION');
  assert.equal(calls, 0);
  await app.close();
};

const testBlockFollowerCatchesUpAcrossMultipleBatches = async () => {
  const config = {
    ...loadConfig(),
    pageSize: 2,
    backfillPageBatch: 2,
    backfillMaxPagesPerAddress: 4,
    maxPagesPerAddress: 20,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  store.addTransactions(validAddress, [makeIndexedTx(90, 'old')]);
  store.markHistoryComplete(validAddress);

  const calls: Array<{ lt?: string; hash?: string; limit: number }> = [];
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '100', lastTxHash: 'h100' };
    },
    async getTransactions(_address: string, limit: number, lt?: string, hash?: string) {
      calls.push({ lt, hash, limit });
      if (lt === '100') return [makeRawTx(100), makeRawTx(99), makeRawTx(98), makeRawTx(97)];
      if (lt === '97') return [makeRawTx(96), makeRawTx(95), makeRawTx(90, 'old')];
      return [];
    },
  });
  const opcodes = loadOpcodes(undefined);
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(config, store, source, opcodes, createLogger('fatal'), service);

  await (follower as any).refreshAddress(validAddress, 123);
  const entry = store.get(validAddress);
  assert.equal(calls.length, 2);
  assert.equal(entry?.txs[0]?.lt, '100');
  assert.equal(entry?.stats.historyComplete, true);
  assert.equal(entry?.stats.lastUpdateSeqno, 123);
};

const testBlockFollowerMarksHistoryIncompleteWhenCatchupIsCapped = async () => {
  const config = {
    ...loadConfig(),
    pageSize: 2,
    backfillPageBatch: 2,
    backfillMaxPagesPerAddress: 1,
    maxPagesPerAddress: 20,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  store.addTransactions(validAddress, [makeIndexedTx(50, 'old')]);
  store.markHistoryComplete(validAddress);

  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '100', lastTxHash: 'h100' };
    },
    async getTransactions() {
      return [makeRawTx(100), makeRawTx(99), makeRawTx(98), makeRawTx(97)];
    },
  });
  const opcodes = loadOpcodes(undefined);
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(config, store, source, opcodes, createLogger('fatal'), service);

  await (follower as any).refreshAddress(validAddress, 124);
  const entry = store.get(validAddress);
  assert.equal(entry?.stats.historyComplete, false);
  assert.equal(entry?.stats.lastUpdateSeqno, 124);
};

const testBlockFollowerStopsOnDuplicateCursorPage = async () => {
  const config = {
    ...loadConfig(),
    pageSize: 2,
    backfillPageBatch: 2,
    backfillMaxPagesPerAddress: 4,
    maxPagesPerAddress: 20,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  store.addTransactions(validAddress, [makeIndexedTx(90, 'old')]);
  store.markHistoryComplete(validAddress);
  let calls = 0;
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '100', lastTxHash: 'h100' };
    },
    async getTransactions() {
      calls += 1;
      return [makeRawTx(100, 'h100')];
    },
  });
  const opcodes = loadOpcodes(undefined);
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(config, store, source, opcodes, createLogger('fatal'), service);

  await (follower as any).refreshAddress(validAddress, 125);
  const entry = store.get(validAddress);
  assert.equal(calls, 1);
  assert.equal(entry?.stats.historyComplete, false);
  assert.equal(entry?.stats.lastUpdateSeqno, 125);
};

const testBlockFollowerSkipsFetchWhenLatestTransactionIsUnchanged = async () => {
  const config = {
    ...loadConfig(),
    pageSize: 2,
    backfillPageBatch: 2,
    backfillMaxPagesPerAddress: 4,
    maxPagesPerAddress: 20,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  store.addTransactions(validAddress, [makeIndexedTx(100, 'h100')]);
  store.markHistoryComplete(validAddress);
  let fetchCalls = 0;
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '100', lastTxHash: 'h100' };
    },
    async getTransactions() {
      fetchCalls += 1;
      return [makeRawTx(100, 'h100')];
    },
  });
  const opcodes = loadOpcodes(undefined);
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(config, store, source, opcodes, createLogger('fatal'), service);

  await (follower as any).refreshAddress(validAddress, 126);
  const entry = store.get(validAddress);
  assert.equal(fetchCalls, 0);
  assert.equal(entry?.txs.length, 1);
  assert.equal(entry?.stats.historyComplete, true);
  assert.equal(entry?.stats.lastUpdateSeqno, 126);
};

const run = async () => {
  await testRateLimitIgnoresUntrustedForwardedFor();
  await testRateLimitUsesForwardedForOnlyWithTrustedProxy();
  await testRateLimitBucketsAreIsolated();
  testRateLimiterResetsExpiredWindowsAndDisabledLimiterAllowsAll();
  await testJsonRpcGetTransactionsFillsLimitAcrossPages();
  await testJsonRpcGetTransactionsCapsLimitAndDedupesPages();
  await testRestTxEndpointRejectsMalformedCursorsBeforeServiceCall();
  await testRestAddressAndPayloadRoutesRejectInvalidPathsBeforeServiceCall();
  await testStreamRejectsMissingOrInvalidAddresses();
  await testJsonRpcRejectsMalformedTransactionCursors();
  await testJsonRpcRejectsMissingMethodAndInvalidTransactionAddressBeforeServiceCall();
  await testJsonRpcRejectsMalformedAccountAndGetterInputsBeforeServiceCall();
  await testJsonRpcAddressInformationNormalizesMissingStateFields();
  await testJsonRpcRejectsUnsupportedAndDisabledWriteMethods();
  await testJsonRpcProxySurfacesInvalidUpstreamJson();
  await testRunGetMethodRejectsMalformedStackBeforeServiceCall();
  await testRunGetMethodRejectsOversizedStackBeforeServiceCall();
  await testJsonRpcCursorPaginationStopsOnDuplicateCursor();
  await testDefiSnapshotRejectsInvalidInputsBeforeServiceCall();
  await testDlmmPoolsSnapshotRejectsInvalidInputsBeforeServiceCall();
  await testSnapshotGetRoutesRejectInvalidAddressesBeforeServiceCall();
  await testSnapshotEndpointsSurfaceLoadErrors();
  await testJsonRpcBatchGetMethodRejectsOversizedAndMalformedCalls();
  await testJsonRpcBatchGetMethodRejectsMissingCallsAndIsolatesFailures();
  await testDebugEndpointReturnsDisabledWithoutService();
  await testOperationalRoutesDoNotRequireAdminAndPublicReadsStayOpen();
  await testWriteRpcRelayIsPublicWhenExplicitlyEnabled();
  testCorsExactOriginAllowlistAndWildcardFallback();
  await testDocsRouteSetsNonceCspAndSecurityHeaders();
  testDangerousEnvValuesFallBack();
  testRateLimitBucketEnvRejectsMalformedAndDangerousOverrides();
  testSnapshotFileLoaderRejectsMalformedFiles();
  testClassifierIgnoresMalformedBodies();
  testMemoryOverflowMarksHistoryIncomplete();
  testMemoryStoreDeduplicatesTransactions();
  testMemoryStoreImportNormalizesStatsAndSortOrder();
  testMemoryStoreGlobalLimitEvictsColdAddresses();
  testMemoryStoreMaxAddressEvictionAdjustsTotal();
  await testAccountSwapQueryRejectsInvalidTimeWindow();
  await testSccpProofRejectsPartialTrustedCheckpoint();
  await testSccpProofRejectsMalformedRequiredFieldsBeforeServiceCall();
  await testBlockFollowerCatchesUpAcrossMultipleBatches();
  await testBlockFollowerMarksHistoryIncompleteWhenCatchupIsCapped();
  await testBlockFollowerStopsOnDuplicateCursorPage();
  await testBlockFollowerSkipsFetchWhenLatestTransactionIsUnchanged();
  console.log('adversarial ok');
};

run().catch((error) => {
  console.error('adversarial test failed', error);
  process.exit(1);
});
