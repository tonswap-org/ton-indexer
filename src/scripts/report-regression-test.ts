import { fixtureChainSource, type FixtureChainSource } from './support/chainFixture';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import fastify from 'fastify';
import { loadConfig } from '../config';
import { registerRoutes } from '../api/routes';
import { runtimeMetadataFixture } from './fixtures/runtimeManifest';
import { setCorsHeaders } from '../api/cors';
import { RateLimiter } from '../api/rateLimit';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';

import { loadOpcodes } from '../utils/opcodes';
import { BalanceService } from '../balances/balanceService';
import { fixtureHead } from './support/chainFixture';
import { ChainReadError } from '../data/dataSource';

const owner = `0:${'1'.repeat(64)}`, root = `0:${'2'.repeat(64)}`, wallet = `0:${'3'.repeat(64)}`;
const config = { ...loadConfig(), network: 'testnet' as const, adminToken: 'report-test-token' };
const source: FixtureChainSource = fixtureChainSource({
  network: 'testnet', async head() { return { seqno: 1 }; },
  async getAccountState() { return { balance: '2000000000', accountState: 'uninitialized' as const }; },
  async getTransactions() { return []; }, async runGetMethod() { return null; },
  async walletBalance() { return { wallet: Address.parse(wallet).toString(), balance: '1000000000000' }; },
  async jettonMetadata() { return null; }, async close() {},
});

async function main() {
  let walletReads = 0;
  const reader = { async wallets(roots: readonly string[], requestedOwner: string) {
    walletReads++;
    assert.deepEqual(roots, [root]); assert.equal(requestedOwner, owner);
    return { head: fixtureHead(), owner: { balance: '2000000000' },
      rows: [{root, wallet, status: 'ok' as const, lastTxLt: '1', lastTxHash: '1'.repeat(64), balanceRaw: '1000000000000'}] };
  } };
  const roots = [{ master: root, symbol: 'USDT', decimals: 9 }];
  const balances = new BalanceService({ reader, roots, network: 'testnet' });
  assert.throws(() => new BalanceService({ reader, roots: [...roots, {...roots[0]!, master: Address.parse(root).toString()}], network: 'testnet' }), /Invalid release balance roots/);
  const reads = await Promise.all(Array.from({ length: 20 }, (_, index) => balances.read(index % 2 ? owner : Address.parse(owner).toString())));
  assert.equal(walletReads, 1);
  for (const read of reads) {
    assert.deepEqual(read, reads[0]); assert.equal(read.complete, true);
    assert.equal(read.assets.length, 2);
    assert.equal(read.assets[1]!.kind, 'jetton');
    assert.equal((read.assets[1] as any).root, root);
    assert.equal((read.assets[1] as any).wallet, wallet);
    assert.equal(read.assets[1]!.balance_raw, '1000000000000');
    assert.equal(read.assets[1]!.decimals, 9, 'USDT symbol must not override release precision');
    assert.equal('balance' in read.assets[1]!, false, 'Only atomic amounts are exposed');
  }
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(), []);
  const app = fastify();
  registerRoutes(app, config, service, { getMetrics: () => ({ secret: 'operational' }), getPrometheus: () => 'metric 1\n' } as any, undefined, undefined, undefined, undefined, runtimeMetadataFixture(config.network), { balances });
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
    assert.equal((await app.inject({ url: `/api/indexer/v1/accounts/${owner}/balances` })).statusCode, 200);
  } finally { await app.close(); }

  for (const status of [400, 415, 429, 503]) {
    const limitedConfig = { ...config, rateLimitBuckets: { ...config.rateLimitBuckets, rpc: { windowMs: 60000, max: 1 } } };
    const corsApp = fastify();
    corsApp.addHook('onRequest', async (request, reply) => { setCorsHeaders(request, reply, limitedConfig); });
    registerRoutes(corsApp, limitedConfig, {
      async runGetMethod() { return { stack: [], exit_code: 0 }; },

    } as any, undefined, undefined, undefined, new RateLimiter(limitedConfig), undefined, runtimeMetadataFixture(config.network), { balances: { async read() { throw new ChainReadError('upstream_unavailable', {cause: new Error('private upstream details')}); } } });
    await corsApp.ready();
    try {
      const request = { method: 'POST' as const, url: '/jsonRPC', headers: { origin: 'https://test.tonswap.org' },
        payload: { id: 1, jsonrpc: '2.0', method: 'runGetMethod', params: { address: owner, method: 'seqno' } } };
      if (status === 429) await corsApp.inject(request);
      const response = status === 503
        ? await corsApp.inject({ url: `/api/indexer/v1/accounts/${owner}/balances`, headers: request.headers })
        : status === 400 || status === 415
          ? await corsApp.inject({ ...request, headers: { ...request.headers, 'content-type': status === 400 ? 'application/json' : 'application/octet-stream' }, payload: '{' })
          : await corsApp.inject(request);
      assert.equal(response.statusCode, status);
      assert.equal(response.headers['access-control-allow-origin'], '*');
      assert.ok(!response.body.includes('private upstream details'));
      if (status === 503) assert.equal(response.json().code, 'upstream_unavailable');
    } finally { await corsApp.close(); }
  }
  console.log('Report regressions passed: canonical concurrent balances, explicit precision, metrics auth, strict pagination, retryable cold reads and CORS errors.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
