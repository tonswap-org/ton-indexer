import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { createReleaseTestServer as createServer, injectRelease } from './releaseRequests.js';
import { database } from './helpers.js';
import { ASSET, T3, dexConfig, freshDexBody } from './dexFixtures.js';
let db: Database;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db.close(); });
describe('public DEX pricing routes', () => {
  it('serves only release-bound T3 quotes and keeps monetary USD unavailable', async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      expect(String(url)).toBe(dexConfig().dexRelease!.indexerUrl + '/readFresh');
      const calls = JSON.parse(String(init?.body)).calls;
      return new Response(JSON.stringify(freshDexBody(calls, new Date())));
    });
    const app = await createServer(dexConfig({ coingeckoKey: 'should-never-be-used' }), db, { fetcher, logger: false });
    try {
      for (const route of ['/v1/prices', '/v1/dex-prices']) {
        const result = await injectRelease(app, { url: `${route}?network=testnet&assets=${encodeURIComponent(ASSET + ',native')}` });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toMatchObject({ network: 'testnet', currency: 'T3', quoteAssetId: T3,
          quotes: [{ assetId: ASSET, price: '1', source: 'tonswap-dex', stale: false, change24h: null },
            { assetId: 'native', price: null, status: 'unavailable' }] });
      }
      const usd = (await injectRelease(app, { url: `/v1/asset-valuations?network=testnet&assets=${encodeURIComponent(ASSET)}` })).json();
      expect(usd.quotes[0]).toMatchObject({ priceUsd: null, status: 'unavailable' });
      expect(usd.dex).toMatchObject({ currency: 'T3', quotes: [{ price: '1', source: 'tonswap-dex' }] });
      const health = (await injectRelease(app, { url: '/v1/health' })).json();
      expect(health).toMatchObject({ prices: 'configured', priceSource: 'tonswap-dex' });
      expect(requests).toHaveLength(3);
      expect((await injectRelease(app, { url: '/v1/prices?ids=bitcoin&vs=usd' })).statusCode).toBe(400);
      expect((await injectRelease(app, { url: `/v1/prices?network=mainnet&assets=${ASSET}` })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
