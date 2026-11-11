import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/providers.js';
import type { Database } from '../src/db.js';
import { config, database } from './helpers.js';
let db: Database;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db.close(); });
describe('source-backed prices and FX', () => {
  it('uses Frankfurter v2 batches and preserves exact decimal/provenance/date', async () => {
    const fetcher = vi.fn(async () => new Response('[{"base":"USD","quote":"JPY","date":"2026-09-04","rate":148.123456789123456789,"providers":[{"key":"ECB","date":"2026-09-04","rate":148.123456789123456789},{"key":"EXCLUDED","date":"2026-09-03","rate":1,"excluded":true}]}]'));
    const provider = new Providers(db, config(), fetcher, () => new Date('2026-09-06T12:00:00Z'));
    const result = await provider.rates('USD', ['JPY'], '2026-09-05');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v2/rates?');
    expect(result.quotes[0]).toMatchObject({ rate: '148.123456789123456789', observationDate: '2026-09-04',
      requestedDate: '2026-09-05', providers: ['ECB'], precision: 'daily', status: 'available' });
    expect(result.quotes[0]?.providerObservations).toEqual([{ key: 'ECB', date: '2026-09-04', rate: '148.123456789123456789', excluded: false },
      { key: 'EXCLUDED', date: '2026-09-03', rate: '1', excluded: true }]);
    expect(result.issues).toContain('prior_observation:JPY:2026-09-04');
    await provider.rates('USD', ['JPY'], '2026-09-05'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent identical FX requests', async () => {
    const fetcher = vi.fn(async () => new Response('[{"base":"USD","quote":"EUR","date":"2026-09-05","rate":0.87}]'));
    const provider = new Providers(db, config(), fetcher);
    await Promise.all([provider.rates('USD', ['EUR'], '2026-09-05'), provider.rates('USD', ['EUR'], '2026-09-05')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not fabricate parity or reuse a current quote for missing historical prices', async () => {
    const fetcher = vi.fn(async () => new Response('{"bitcoin":{"usd":100,"last_updated_at":1788696000}}'));
    const provider = new Providers(db, config({ coingeckoKey: 'test-key' }), fetcher, () => new Date('2026-09-06T12:00:00Z'));
    const result = await provider.prices(['bitcoin'], 'usd', '2025-01-01');
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable', requestedDate: '2025-01-01' });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/coins/bitcoin/history?date=2025-01-01');
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toHaveProperty('x-cg-demo-api-key', 'test-key');
    expect((await provider.rates('USD', ['GRAM'])).quotes[0]).toMatchObject({ rate: null, status: 'unavailable' });
  });
  it('never requests current external prices or revives their cached observations, with or without a key', async () => {
    const fetcher = vi.fn(async () => { throw new Error('External spot calls forbidden'); });
    for (const coingeckoKey of [undefined, 'test-key']) {
      const provider = new Providers(db, config({ coingeckoKey }), fetcher);
      expect((await provider.prices(['bitcoin', 'ethereum'])).quotes.every(value => value.price === null && value.source === 'unavailable')).toBe(true);
      const rates = await provider.rates('USD', ['BTC', 'XOR', 'GRAM']);
      expect(rates.quotes.every(value => value.rate === null && value.status === 'unavailable')).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects impossible observation dates and ambiguous duplicate FX rows', async () => {
    const invalid=new Providers(db,config(),async()=>new Response('[{"base":"GBP","quote":"CAD","date":"2026-02-30","rate":2}]'));
    expect((await invalid.rates('GBP',['CAD'],'2026-03-01')).quotes[0]?.rate).toBeNull();
    const duplicate=new Providers(db,config(),async()=>new Response('[{"base":"GBP","quote":"JPY","date":"2026-03-01","rate":2},{"base":"GBP","quote":"JPY","date":"2026-03-01","rate":3}]'));
    expect((await duplicate.rates('GBP',['JPY'],'2026-03-01')).quotes[0]?.rate).toBeNull();
  });
});
