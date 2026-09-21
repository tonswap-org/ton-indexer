import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Address } from '@ton/core';
import fastify from 'fastify';
import { loadConfig } from '../config';
import { hashRegistry } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { setCorsHeaders } from '../api/cors';
import { RateLimiter } from '../api/rateLimit';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { TonDataSource } from '../data/dataSource';
import { loadOpcodes } from '../utils/opcodes';

const owner = `0:${'1'.repeat(64)}`, root = `0:${'2'.repeat(64)}`, wallet = `0:${'3'.repeat(64)}`;
const config = { ...loadConfig(), network: 'testnet' as const, adminToken: 'report-test-token' };
const source: TonDataSource = {
  network: 'testnet', async getMasterchainInfo() { return { seqno: 1 }; },
  async getAccountState() { return { balance: '2000000000', accountState: 'uninitialized' as const }; },
  async getTransactions() { return []; }, async runGetMethod() { return null; },
  async getJettonBalance() { return { wallet: Address.parse(wallet).toString(), balance: '1000000000000' }; },
  async getJettonMetadata() { return null; }, async close() {},
};

async function main() {
  const registry = JSON.parse(readFileSync('registry/testnet.json', 'utf8'));
  assert.equal(Object.keys(registry).length, 60);
  assert.equal(hashRegistry(registry), 'a8605dc38d0a88f49abc851b6d40784d08b13fa61aaa4335fb0c7aec74da9e6f');

  let walletReads = 0;
  const service = new IndexerService(config, new MemoryStore(config), {
    ...source, async getJettonBalance() { walletReads++; return source.getJettonBalance(owner, root); },
  }, loadOpcodes(undefined), [{ master: root, symbol: 'USDT' }, { master: Address.parse(root).toString(), symbol: 'USDT' }]);
  const reads = await Promise.all(Array.from({ length: 20 }, (_, index) => service.getBalances(index % 2 ? owner : Address.parse(owner).toString())));
  assert.equal(walletReads, 1);
  for (const read of reads) {
    assert.deepEqual(read, reads[0]);
    assert.equal(read.assets.length, 2);
    assert.equal(read.assets[1].address, root);
    assert.equal(read.assets[1].wallet, wallet);
    assert.equal(read.assets[1].balance_raw, '1000000000000');
    assert.equal(read.assets[1].balance, undefined, 'USDT symbol must not imply 6 decimals');
    assert.equal(read.assets[1].decimals, undefined);
  }
  const preciseService = new IndexerService(config, new MemoryStore(config), {
    ...source, async getJettonMetadata() { return { symbol: 'USDT', decimals: 9 }; },
  }, loadOpcodes(undefined), [{ master: root, symbol: 'USDT' }]);
  const precise = await preciseService.getBalances(owner);
  assert.equal(precise.assets[1].balance, '1000');
  assert.equal(precise.assets[1].decimals, 9);

  const app = fastify();
  registerRoutes(app, config, service, { getMetrics: () => ({ secret: 'operational' }), getPrometheus: () => 'metric 1\n' } as any);
  await app.ready();
  try {
    for (const path of ['/metrics', '/metrics/prometheus']) {
      const url = `/api/indexer/v1${path}`;
      for (const headers of [{}, { authorization: 'Bearer incorrect' }]) {
        const denied = await app.inject({ url, headers });
        assert.equal(denied.statusCode, 401);
        assert.ok(!denied.body.includes('operational'));
      }
      assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${config.adminToken}` } })).statusCode, 200);
    }
    for (const query of ['limit=0', 'limit=-1', 'limit=100000', 'limit=10', 'cursor=AAAA', 'page=0', 'cursor_hash=', 'cursor_lt=1&cursor_hash=', 'page=2&cursor_lt=1&cursor_hash=AAAA']) {
      assert.equal((await app.inject({ url: `/api/indexer/v1/accounts/${owner}/txs?${query}` })).statusCode, 400, query);
    }
    assert.equal((await app.inject({ url: `/api/indexer/v1/accounts/${owner}/balance` })).statusCode, 200);
  } finally { await app.close(); }

  for (const status of [400, 415, 429, 503]) {
    const limitedConfig = { ...config, rateLimitBuckets: { ...config.rateLimitBuckets, rpc: { windowMs: 60000, max: 1 } } };
    const corsApp = fastify();
    corsApp.addHook('onRequest', async (request, reply) => { setCorsHeaders(request, reply, limitedConfig); });
    registerRoutes(corsApp, limitedConfig, {
      async runGetMethod() { return { stack: [], exit_code: 0 }; },
      async getBalance() { throw new Error('private upstream details'); },
    } as any, undefined, undefined, undefined, new RateLimiter(limitedConfig));
    await corsApp.ready();
    try {
      const request = { method: 'POST' as const, url: '/jsonRPC', headers: { origin: 'https://test.tonswap.org' },
        payload: { id: 1, jsonrpc: '2.0', method: 'runGetMethod', params: { address: owner, method: 'seqno' } } };
      if (status === 429) await corsApp.inject(request);
      const response = status === 503
        ? await corsApp.inject({ url: `/api/indexer/v1/accounts/${owner}/balance`, headers: request.headers })
        : status === 400 || status === 415
          ? await corsApp.inject({ ...request, headers: { ...request.headers, 'content-type': status === 400 ? 'application/json' : 'application/octet-stream' }, payload: '{' })
          : await corsApp.inject(request);
      assert.equal(response.statusCode, status);
      assert.equal(response.headers['access-control-allow-origin'], '*');
      assert.ok(!response.body.includes('private upstream details'));
      if (status === 503) assert.equal(response.json().code, 'balance_unavailable');
    } finally { await corsApp.close(); }
  }
  console.log('Report regressions passed: registry, canonical concurrent balances, explicit precision, metrics auth, strict pagination, retryable cold reads and CORS errors.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
