import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Address } from '@ton/core';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { Providers } from '../src/providers.js';
import { Store } from '../src/store.js';
import { address, database, session } from './helpers.js';
import { ASSET, T3, POOL, dexConfig, freshDexBody, type FixtureCall } from './dexFixtures.js';

const token = { kind: 'ton', network: 'testnet', assetId: ASSET } as const;
const fixtureConfig = (overrides: Partial<Config> = {}) => dexConfig({ networks: ['testnet', 'mainnet'], ...overrides });
let db: Database;
const apps: FastifyInstance[] = [];
beforeAll(async () => { db = await database(); });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
afterAll(async () => { await db.close(); });
async function setup(cfg = fixtureConfig(), stale = false) {
  const store = new Store(db, cfg), providers = new Providers(db, cfg);
  const prices = vi.spyOn(providers, 'prices').mockRejectedValue(Error('Current alerts must not request CoinGecko.'));
  const search = vi.fn(async () => { throw Error('Current catalogue must not request CoinGecko.'); });
  Object.assign(providers, { searchAssets: search });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const calls: FixtureCall[] = JSON.parse(String(init?.body)).calls;
    return new Response(JSON.stringify(freshDexBody(calls, new Date(Date.now() - (stale ? 120_001 : 0)))));
  });
  const app = await createServer(cfg, db, { store, providers, fetcher, logger: false }); apps.push(app);
  const account = await session(store);
  const headers = { origin: cfg.appOrigins[0]!, cookie: `__Host-tonswap_session=${account.token}`,
    'x-csrf-token': account.csrfToken, 'x-wallet-address': address, 'x-wallet-network': 'testnet' };
  const save = (payload: unknown) => app.inject({ method: 'PUT', url: '/v1/notifications/price-rules', headers, payload: payload as object });
  const definition = (overrides: Record<string, unknown> = {}) => ({ asset: token, currency: 'T3', quoteAssetId: T3,
    releaseManifestHash: cfg.dexRelease?.manifestHash, kind: 'target', targetPrice: '1.5', direction: 'above', enabled: true, ...overrides });
  return { app, store, account, prices, search, fetcher, headers, save, definition };
}

describe('release-bound DEX alert API', () => {
  it('requires network for search and rejects disabled networks and old query formats', async () => {
    const { app, search, fetcher } = await setup(fixtureConfig({ networks: ['testnet'] }));
    for (const url of ['/v1/assets/search?q=TON', '/v1/assets/search?network=mainnet', '/v1/assets/search?network=-3', '/v1/assets/search?network=testnet&wallet=any'])
      expect((await app.inject({ url })).statusCode).toBe(400);
    expect(search).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('lists only active-release tokens with explicit denomination and truthful capabilities', async () => {
    const { app, search, prices } = await setup();
    const response = await app.inject({ url: '/v1/assets/search?network=testnet' });
    expect(response.statusCode).toBe(200);
    expect(response.json().assets).toEqual([
      { asset: { kind: 'ton', network: 'testnet', assetId: T3 }, symbol: 'T3', name: 'T3', currency: 'T3', quoteAssetId: T3,
        releaseManifestHash: fixtureConfig().dexRelease!.manifestHash, capabilities: { target: false, percent: false } },
      { asset: token, symbol: 'USDT', name: 'USDT', currency: 'T3', quoteAssetId: T3,
        releaseManifestHash: fixtureConfig().dexRelease!.manifestHash, capabilities: { target: true, percent: false } },
    ]);
    expect((await app.inject({ url: '/v1/assets/search?network=mainnet' })).json()).toEqual({ assets: [], issues: ['dex_release_not_configured'] });
    expect(search).not.toHaveBeenCalled(); expect(prices).not.toHaveBeenCalled();
  });
  it('matches friendly addresses without depending on external metadata', async () => {
    const { app, search } = await setup();
    const response = await app.inject({ url: `/v1/assets/search?network=testnet&q=${encodeURIComponent(Address.parse(ASSET).toString({ testOnly: true }))}` });
    expect(response.json()).toMatchObject({ assets: [{ asset: token, symbol: 'USDT', capabilities: { target: true, percent: false } }], issues: [] });
    expect(response.json().assets).toHaveLength(1); expect(search).not.toHaveBeenCalled();
  });
  it('advertises no current feeds without an active release and never uses historical mappings as fallback', async () => {
    const cfg = fixtureConfig({ dexRelease: undefined, coingeckoKey: 'present-but-historical-only', assetValuationPaths: [
      { kind: 'coingecko', network: 'testnet', assetId: ASSET, coinGeckoId: 'tether' },
    ] });
    const { app, search, prices } = await setup(cfg);
    expect((await app.inject({ url: '/v1/assets/search?network=testnet' })).json()).toEqual({ assets: [], issues: ['dex_release_not_configured'] });
    expect(search).not.toHaveBeenCalled(); expect(prices).not.toHaveBeenCalled();
  });
  it('rejects old, listed, implicit-USD and numeric target inputs before provider work', async () => {
    const { save, definition, prices, fetcher } = await setup();
    for (const payload of [
      { assetId: 'the-open-network', enabled: false },
      definition({ asset: { kind: 'listed', coinGeckoId: 'bitcoin' } }),
      definition({ currency: 'USD' }), definition({ quoteAssetId: undefined }), definition({ releaseManifestHash: undefined }),
      definition({ targetPrice: 1.5 }), definition({ asset: { ...token, assetId: 'bitcoin' } }),
    ]) expect((await save(payload)).statusCode).toBe(400);
    expect(prices).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves exact decimal strings and normalizes contract identity on target admission', async () => {
    const { save, definition, fetcher } = await setup();
    const response = await save(definition({ asset: { ...token, assetId: Address.parse(ASSET).toString() }, targetPrice: '9007199254740993.000000000000000001' }));
    expect(response.statusCode).toBe(200);
    expect(response.json().rule).toMatchObject({ asset: token, currency: 'T3', quoteAssetId: T3,
      releaseManifestHash: fixtureConfig().dexRelease!.manifestHash, targetPrice: '9007199254740993.000000000000000001', capabilities: { target: true, percent: false } });
    expect(fetcher).toHaveBeenCalled();
  });
  it('rejects foreign network, quote root, and release before persistence, even when disabled', async () => {
    const { save, definition, fetcher } = await setup();
    const network = await save(definition({ asset: { ...token, network: 'mainnet' }, enabled: false }));
    expect(network.statusCode).toBe(409); expect(network.json().error.code).toBe('asset_network_mismatch');
    for (const change of [{ quoteAssetId: POOL }, { releaseManifestHash: '0'.repeat(64) }]) {
      const result = await save(definition({ ...change, enabled: false }));
      expect(result.statusCode).toBe(400); expect(result.json().error.code).toBe('dex_pair_required');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps percent rules unavailable without inventing a comparable 24-hour state', async () => {
    const { save, definition } = await setup();
    const response = await save(definition({ kind: 'percent', targetPrice: null, thresholdPercent: '5', direction: 'both' }));
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('price_change_unavailable');
  });
  it('rejects stale and unknown markets but permits disabling a bound saved rule', async () => {
    const { save, definition } = await setup(fixtureConfig(), true);
    expect((await save(definition())).json().error.code).toBe('price_feed_unavailable');
    const disabled = await save(definition({ enabled: false }));
    expect(disabled.statusCode).toBe(200); expect(disabled.json().rule.enabled).toBe(false);
    expect((await save(definition({ asset: { ...token, assetId: POOL } }))).json().error.code).toBe('price_feed_unavailable');
    expect((await save(definition({ asset: { ...token, assetId: 'native' } }))).json().error.code).toBe('price_feed_unavailable');
  });
});
