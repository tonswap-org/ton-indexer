import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
import { Providers } from '../src/providers.js';
import type { Database } from '../src/db.js';
import { config, database, secondAddress } from './helpers.js';

let db: Database;
beforeAll(async () => { db = await database(); });
beforeEach(async () => { await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => { await db.close(); });
const at = '2025-06-01T12:00:00.000Z', observed = Date.parse(at) - 60000;
const cfg = () => config({ networks: ['mainnet', 'testnet'], coingeckoKey: 'synthetic-server-key', assetValuationPaths: [
  { kind: 'coingecko', network: 'mainnet', assetId: 'native', coinGeckoId: 'the-open-network' },
  { kind: 'coingecko', network: 'testnet', assetId: 'native', coinGeckoId: 'the-open-network' },
] });

describe('anonymous configured historical anchor route', () => {
  it('resolves canonical mainnet mapping and returns actual range observations without wallet authentication', async () => {
    const fetcher = vi.fn(async () => new Response(`{"prices":[[${observed},0.123456789123456789123456789]]}`));
    const app = await createServer(cfg(), db, { fetcher, logger: false });
    try {
      const response = await app.inject({ url: `/v1/historical-anchor?network=mainnet&asset=native&at=${at}` });
      expect(response.statusCode).toBe(200); expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.json()).toMatchObject({ network: 'mainnet', assetId: 'native', anchor: {
        coinGeckoId: 'the-open-network', at, currency: 'USD', priceUsd: '0.123456789123456789123456789',
        precision: 'sampled', status: 'available', lagMilliseconds: 60000,
      } });
      expect(response.body).not.toContain('synthetic-server-key'); expect(fetcher).toHaveBeenCalledTimes(1);
      const revisionId = response.json().anchor.revisionId;
      await db.query('DELETE FROM platform_quote_cache');
      const revision = await app.inject({ url: `/v1/historical-anchor/revisions/${revisionId}` });
      expect(revision.statusCode).toBe(200); expect(revision.json().evidence.observations).toEqual(response.json().anchor.observations);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await app.inject({ url: `/v1/historical-anchor/revisions/${'0'.repeat(64)}` })).statusCode).toBe(404);
      expect((await app.inject({ url: `/v1/historical-anchor/revisions/${revisionId}?wallet=${secondAddress}` })).statusCode).toBe(400);
      expect((await db.query('SELECT id FROM platform_sessions')).rows).toEqual([]);
    } finally { await app.close(); }
  });
  it('rejects simulation pricing, unconfigured asset identities and client-selected provider overrides', async () => {
    const fetcher = vi.fn(async () => { throw Error('must not fetch'); }); const app = await createServer(cfg(), db, { fetcher, logger: false });
    try {
      for (const query of [
        `network=testnet&asset=native&at=${at}`, `network=mainnet&asset=${secondAddress}&at=${at}`,
        `network=mainnet&asset=TON&at=${at}`, `network=mainnet&asset=native&at=${at}&id=bitcoin`,
        `network=mainnet&asset=native&at=${at}&wallet=${secondAddress}`, `network=mainnet&asset=native&at=${at}&method=nearest`,
      ]) expect((await app.inject({ url: `/v1/historical-anchor?${query}` })).statusCode).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('does not reuse another provider identity after the configured asset mapping changes', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(`{"prices":[[${observed},${String(url).includes('/bitcoin/') ? '90000' : '2'}]]}`));
    const first = await createServer(cfg(), db, { fetcher, logger: false });
    const changed = cfg(); changed.assetValuationPaths = [{ kind: 'coingecko', network: 'mainnet', assetId: 'native', coinGeckoId: 'bitcoin' }];
    const second = await createServer(changed, db, { fetcher, logger: false });
    try {
      const url = `/v1/historical-anchor?network=mainnet&asset=native&at=${at}`;
      expect((await first.inject({ url })).json().anchor.priceUsd).toBe('2');
      expect((await second.inject({ url })).json().anchor).toMatchObject({ coinGeckoId: 'bitcoin', priceUsd: '90000' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await first.close(); await second.close(); }
  });
  it('keeps the existing dated prices route on its independent daily mode', async () => {
    const configuration = cfg(), providers = new Providers(db, configuration);
    const daily = vi.spyOn(providers, 'prices').mockResolvedValue({ currency: 'USD', requestedAt: new Date().toISOString(), quotes: [], issues: [] });
    const range = vi.spyOn(providers, 'historicalAnchor'); const app = await createServer(configuration, db, { providers, logger: false });
    try {
      expect((await app.inject({ url: '/v1/prices?ids=bitcoin&date=2025-06-01' })).statusCode).toBe(200);
      expect(daily).toHaveBeenCalledWith(['bitcoin'], 'usd', '2025-06-01'); expect(range).not.toHaveBeenCalled();
      expect((await app.inject({ url: '/v1/prices?ids=bitcoin&date=2025-06-01&at=2025-06-01T12:00:00Z' })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
