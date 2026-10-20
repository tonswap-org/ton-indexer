import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import type { AlertAsset, PriceRuleInput } from '../src/types.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { address, database, session } from './helpers.js';
import { ASSET, T3, dexConfig, freshDexBody, oracleFixture, type FixtureCall } from './dexFixtures.js';
let db: Database;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db.close(); });

it('resolves witnessed DEX prices through a leased scan into a durable scoped inbox across worker replacement', async () => {
  const token: AlertAsset = { kind: 'ton', network: 'testnet', assetId: ASSET };
  const cfg = dexConfig({ networks: ['testnet', 'mainnet'] });
  const store = new Store(db, cfg), current = await session(store);
  const challenge = await store.createChallenge(address, 'mainnet', 'app.example.test');
  const mainnet = await store.createSession(challenge.payload, address, 'mainnet');
  for (const owner of [current, mainnet]) await store.setPreferences(owner, { priceAlerts: true });
  const target = (asset: AlertAsset): PriceRuleInput => ({ asset, currency: 'T3', quoteAssetId: T3,
    releaseManifestHash: cfg.dexRelease!.manifestHash, kind: 'target', targetPrice: '1.500000000000000001',
    thresholdPercent: null, direction: 'above', enabled: true });
  const rule = await store.saveRule(current, target(token));
  await store.saveRule(mainnet, target({ ...token, network: 'mainnet' }));
  let observed = Date.now() - 3_000, priceE9 = 1_000_000_000n;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).hostname).toBe('indexer.example.test');
    const calls: FixtureCall[] = JSON.parse(String(init?.body)).calls;
    const body = freshDexBody(calls, new Date(observed + 1_000));
    const active = body.results.find((_: unknown, index: number) => calls[index]?.method === 'oracle_evidence');
    active.stack[0][1].bytes = oracleFixture({servedAt:body.readContext.head.utime,at:body.readContext.head.utime,spot:priceE9,short:priceE9,medium:priceE9,long:priceE9});
    return new Response(JSON.stringify(body));
  });
  const providers = new Providers(db, cfg, fetcher);
  const historicalPrices = vi.spyOn(providers, 'prices').mockRejectedValue(Error('Current alerts must not request CoinGecko.'));
  const job = (await store.lease('actual-alert-resolver-test', 100)).find(value => value.kind === 'price_scan')!;
  expect(job).toBeDefined();
  await new Worker(cfg, store, providers, new PushSender(cfg), fetcher).scanPrices(job);
  expect((await store.inbox(current, 100)).notifications).toHaveLength(0);
  expect((await store.rules(current)).find(value => value.id === rule.id)?.monitoring).toMatchObject({ state: 'monitoring', source: 'tonswap-dex' });
  expect((await store.rules(mainnet))[0]?.monitoring.state).toBe('unavailable');

  observed += 1_000; priceE9 = 2_000_000_000n;
  const replacement = new Worker(cfg, new Store(db, cfg), providers, new PushSender(cfg), fetcher);
  await replacement.scanPrices(job);
  const events = (await store.inbox(current, 100)).notifications;
  expect(events).toHaveLength(1);
  expect(events[0]?.evidence).toMatchObject({ asset: token, price: '2', currency: 'T3', quoteAssetId: T3, change24h: null,
    source: 'tonswap-dex', valuationEvidence: { method: 'pool_twap_median_v1', marketKey: 'spot:USDT-T3', release: { manifestHash: cfg.dexRelease!.manifestHash } } });
  expect((await store.inbox(mainnet, 100)).notifications).toHaveLength(0);
  await replacement.scanPrices(job);
  expect((await store.inbox(current, 100)).notifications.map(event => event.id)).toEqual(events.map(event => event.id));
  expect(historicalPrices).not.toHaveBeenCalled();

  const app = await createServer(cfg, db, { providers, fetcher, logger: false });
  try {
    const response = await app.inject({ url: '/v1/notifications/inbox', headers: { cookie: `__Host-tonswap_session=${current.token}`,
      'x-wallet-address': address, 'x-wallet-network': 'testnet' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().notifications.map((event: { id: string }) => event.id)).toEqual(events.map(event => event.id));
  } finally { await app.close(); }
});
