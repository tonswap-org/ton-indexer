import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/providers.js';
import { historicalFxRequest, historicalFxCacheKey, type HistoricalFxEvidence } from '../src/historicalFx.js';
import { historicalDailyRequest, historicalDailyCacheKey, type HistoricalDailyEvidence } from '../src/historicalDaily.js';
import type { Database } from '../src/db.js';
import { config, database } from './helpers.js';

let db: Database;
const date = '2025-01-02';
const now = new Date('2026-09-11T00:00:00Z');
const key = historicalDailyCacheKey(historicalDailyRequest('bitcoin', 'USD', date, 'demo', now));
const originalPrice = '9007199254740993.123456789123456789';
const response = (id: unknown = 'bitcoin', price = originalPrice) => new Response(`{"id":${JSON.stringify(id)},"market_data":{"current_price":{"usd":${price}}}}`);
const legacyQuote = () => ({ assetId: 'bitcoin', price: '999', observedAt: `${date}T00:00:00.000Z`, observationDate: date,
  requestedDate: date, source: 'coingecko', stale: false, status: 'available', precision: 'daily', change24h: null });
const provider = (fetcher: typeof fetch, clock = () => now, tier: 'demo' | 'pro' = 'demo') =>
  new Providers(db, config({ coingeckoKey: 'synthetic-test-key', coingeckoTier: tier }), fetcher, clock);
const seed = async (cacheKey: string, value: unknown, expiresAt = '2027-09-11T00:00:00Z') => {
  await db.query('INSERT INTO platform_quote_cache(key,value,expires_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at',
    [cacheKey, JSON.stringify(value), expiresAt]);
};
const cache = async () => (await db.query<{ key: string; value: Record<string, unknown> }>('SELECT key,value FROM platform_quote_cache ORDER BY key')).rows;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.query('DELETE FROM platform_quote_cache'); });

describe('historical CoinGecko response identity and verified cache', () => {
  it.each(['demo', 'pro'] as const)('binds exact historical identity and documented ISO date with %s API provenance', async tier => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
    const service = provider(fetcher, () => now, tier);
    const result = await service.prices(['bitcoin'], 'usd', date);
    expect(result).toMatchObject({ currency: 'USD', quotes: [{ assetId: 'bitcoin', price: originalPrice, requestedDate: date,
      observationDate: date, observedAt: `${date}T00:00:00.000Z`, source: 'coingecko', precision: 'daily', status: 'available', stale: false }] });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin).toBe(tier === 'pro' ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com');
    expect(url.pathname).toBe('/api/v3/coins/bitcoin/history');
    expect(url.searchParams.get('date')).toBe(date);
    expect(url.searchParams.get('localization')).toBe('false');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get(tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key')).toBe('synthetic-test-key');
    expect((await cache()).map(row => row.key)).toEqual([historicalDailyCacheKey(historicalDailyRequest('bitcoin', 'USD', date, tier, now))]);
    await service.prices(['bitcoin'], 'usd', date);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['1e-23', `0.${'0'.repeat(22)}1`],
    ['1.23456789123456789123456789e25', '12345678912345678912345678.9'],
    [`1.${'123456789'.repeat(12)}e-23`, `0.${'0'.repeat(22)}1${'123456789'.repeat(12)}`],
    ['1e2047', `1${'0'.repeat(2047)}`],
    ['1e-2046', `0.${'0'.repeat(2045)}1`],
  ])('preserves exact historical price %s as a bounded plain decimal through fresh and stale cache', async (raw, exact) => {
    let instant = now;
    const fetcher = vi.fn().mockResolvedValueOnce(response('bitcoin', raw));
    const service = provider(fetcher, () => instant);
    const first = await service.prices(['bitcoin'], 'usd', date);
    expect(first.quotes[0]).toMatchObject({ price: exact, status: 'available', stale: false });
    expect(first.quotes[0]!.price!.length).toBeLessThanOrEqual(2048);
    expect(((await cache())[0]!.value.evidence as HistoricalDailyEvidence).observation).toMatchObject({ price: exact, sourcePriceLexeme: raw });
    expect((await service.prices(['bitcoin'], 'usd', date)).quotes[0]).toEqual(first.quotes[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    instant = new Date(now.getTime() + 21_601_000);
    fetcher.mockRejectedValueOnce(new Error('Synthetic outage'));
    expect((await service.prices(['bitcoin'], 'usd', date)).quotes[0]).toEqual({ ...first.quotes[0], stale: true });
  });

  it.each(['1e2048', '1e-2047', '1e1000000000', '1e-1000000000'])('rejects historical price %s before unbounded decimal expansion or cache insertion', async raw => {
    const result = await provider(async () => response('bitcoin', raw)).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable', stale: true });
    expect(result.issues).toEqual([`historical_price_unavailable:bitcoin:${date}`]);
    expect(await cache()).toEqual([]);
  });

  it.each(['2027-09-11T00:00:00Z', '2020-01-01T00:00:00Z'])('rejects exponent-form prices in a bound cache with expiry %s', async expiry => {
    await provider(async () => response()).prices(['bitcoin'], 'usd', date);
    const stored = (await cache())[0]!;
    const value = structuredClone(stored.value);
    (value.evidence as HistoricalDailyEvidence).observation!.price = '1e-23';
    await seed(key, value, expiry);
    const fetcher = vi.fn(async () => { throw new Error('Synthetic outage'); });
    const result = await provider(fetcher).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['ethereum', '', 'BITCOIN', ' bitcoin ', null, 1, ['bitcoin']])('rejects nonmatching response identity %j before cache insertion', async id => {
    const result = await provider(async () => response(id)).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ assetId: 'bitcoin', price: null, status: 'unavailable', stale: true });
    expect(result.issues).toContain(`historical_price_unavailable:bitcoin:${date}`);
    expect(await cache()).toEqual([]);
  });

  it('rejects a missing response ID before interpreting otherwise valid market data', async () => {
    const result = await provider(async () => new Response('{"market_data":{"current_price":{"usd":42}}}')).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable' });
    expect(await cache()).toEqual([]);
  });

  it('retains a missing price only when the provider still verifies the requested coin identity', async () => {
    const result = await provider(async () => new Response('{"id":"bitcoin","market_data":{"current_price":{"cad":12}}}')).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ assetId: 'bitcoin', price: null, status: 'missing', requestedDate: date, observationDate: null });
    expect((await cache()).map(row => row.key)).toEqual([key]);
  });

  it.each(['2027-09-11T00:00:00Z', '2020-01-01T00:00:00Z'])('never reads superseded unbound cache entries with expiry %s', async expiry => {
    await seed(`cg:history:bitcoin:${date}:usd`, legacyQuote(), expiry);
    const fetcher = vi.fn(async () => response('bitcoin', '123.456789123456789'));
    const result = await provider(fetcher).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: '123.456789123456789', stale: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await cache()).map(row => row.key)).toContain(key);
  });

  it('does not fall back to the superseded cache when the provider is unavailable', async () => {
    await seed(`cg:history:bitcoin:${date}:usd`, legacyQuote(), '2020-01-01T00:00:00Z');
    const result = await provider(async () => { throw new Error('Synthetic outage'); }).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable' });
    expect((await cache()).map(row => row.key)).toEqual([`cg:history:bitcoin:${date}:usd`]);
  });

  it.each(['2027-09-11T00:00:00Z', '2020-01-01T00:00:00Z'])('does not trust an unbound value copied into the new namespace with expiry %s', async expiry => {
    await seed(key, legacyQuote(), expiry);
    const fetcher = vi.fn(async () => response('ethereum'));
    const result = await provider(fetcher).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await cache())[0]!.value).toEqual(legacyQuote());
  });

  it.each(['outage', 'mismatched-identity'] as const)('uses only an expired verified observation as stale fallback after %s', async failure => {
    let instant = now;
    const fetcher = vi.fn().mockResolvedValueOnce(response());
    const service = provider(fetcher, () => instant);
    const first = await service.prices(['bitcoin'], 'usd', date);
    const stored = (await cache())[0];
    instant = new Date(now.getTime() + 21_601_000);
    if (failure === 'outage') fetcher.mockRejectedValueOnce(new Error('Synthetic outage'));
    else fetcher.mockResolvedValueOnce(response('ethereum', '1'));
    const fallback = await service.prices(['bitcoin'], 'usd', date);
    expect(fallback.quotes[0]).toEqual({ ...first.quotes[0], stale: true });
    expect(fallback.quotes[0]?.price).toBe(originalPrice);
    expect((await cache())[0]).toEqual(stored);
  });

  it.each(['revisionId', 'currency', 'format', 'asset', 'date', 'observation', 'precision', 'source', 'source-hash', 'expiry'])('rejects a corrupted canonical revision binding: %s', async field => {
    await provider(async () => response()).prices(['bitcoin'], 'usd', date);
    const value = structuredClone((await cache())[0]!.value);
    const evidence = value.evidence as HistoricalDailyEvidence;
    if (field === 'revisionId') value.revisionId = 'f'.repeat(64);
    if (field === 'currency') evidence.request.currency = 'CAD';
    if (field === 'format') (evidence as unknown as Record<string, unknown>).format = 'unbound';
    if (field === 'asset') evidence.request.coinGeckoId = 'ethereum';
    if (field === 'date') evidence.request.requestedDate = '2025-01-03';
    if (field === 'observation') evidence.observation!.observationDate = '2025-01-03';
    if (field === 'precision') (evidence.request as unknown as Record<string, unknown>).precision = 'spot';
    if (field === 'source') evidence.request.source.requestUrl = 'https://other.example.test/history';
    if (field === 'source-hash') evidence.sourceSha256 = '0'.repeat(64);
    if (field === 'expiry') evidence.expiresAt = '2027-01-01T00:00:00.000Z';
    await seed(key, value);
    const fetcher = vi.fn(async () => { throw new Error('Synthetic outage'); });
    const result = await provider(fetcher).prices(['bitcoin'], 'usd', date);
    expect(result.quotes[0]).toMatchObject({ price: null, status: 'unavailable' });
    expect(result.historicalPrices).toMatchObject([{ revisionId: null }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves valid partial batches without assigning one coin price to another coin', async () => {
    const fetcher = vi.fn(async (target: string | URL | Request) => {
      const asset = new URL(String(target)).pathname.split('/')[4];
      return response(asset === 'ethereum' ? 'bitcoin' : asset, asset === 'bitcoin' ? '123.456789123456789' : '2.5');
    });
    const result = await provider(fetcher).prices(['the-open-network', 'ethereum', 'bitcoin'], 'usd', date);
    expect(result.quotes).toMatchObject([{ assetId: 'bitcoin', price: '123.456789123456789', status: 'available' },
      { assetId: 'ethereum', price: null, status: 'unavailable' }, { assetId: 'the-open-network', price: '2.5', status: 'available' }]);
    expect(result.issues).toEqual([`historical_price_unavailable:ethereum:${date}`]);
    expect(result.historicalPrices).toHaveLength(3);
    expect(result.historicalPrices!.map(row => row.request.coinGeckoId)).toEqual(['bitcoin', 'ethereum', 'the-open-network']);
    expect(result.historicalPrices![1]!.revisionId).toBeNull();
    expect((await cache()).map(row => row.key)).toEqual([key, historicalDailyCacheKey(historicalDailyRequest('the-open-network', 'USD', date, 'demo', now))].sort());
  });
});

describe('historical Frankfurter exact decimal contract', () => {
  const fxResponse = (rate = '1e-8') => new Response('[{"base":"USD","quote":"CAD","rate":' + rate + ',"date":"2025-01-01","providers":[{"key":"ECB","date":"2025-01-01","rate":' + rate + ',"excluded":false}]}]');
  const fxKey = historicalFxCacheKey(historicalFxRequest('USD', ['CAD'], date, now));
  const obsoleteKey = 'fx:v2:USD:CAD:' + date;
  const unbound = () => [{ symbol: 'CAD', rate: '1e-8', observedAt: '2025-01-01T00:00:00.000Z', observationDate: '2025-01-01',
    requestedDate: date, source: 'frankfurter-v2', providers: ['ECB'], stale: false, status: 'available', precision: 'daily' }];

  it.each([
    ['1e-8', '0.00000001'],
    ['1.23456789123456789123456789e25', '12345678912345678912345678.9'],
    ['1.' + '123456789'.repeat(12) + 'e-8', '0.00000001' + '123456789'.repeat(12)],
  ])('retains rate and provider-observation digits for %s through fresh and stale cache', async (raw, exact) => {
    let instant = now;
    const fetcher = vi.fn().mockResolvedValueOnce(fxResponse(raw));
    const service = provider(fetcher, () => instant);
    const first = await service.rates('USD', ['CAD'], date);
    expect(first.quotes[0]).toMatchObject({ rate: exact, requestedDate: date, observationDate: '2025-01-01',
      status: 'available', stale: false, providerObservations: [{ key: 'ECB', rate: exact }] });
    expect(first.issues).toEqual(['prior_observation:CAD:2025-01-01']);
    expect((await cache()).map(row => row.key)).toEqual([fxKey]);
    expect((await service.rates('USD', ['CAD'], date)).quotes).toEqual(first.quotes);
    expect(fetcher).toHaveBeenCalledTimes(1);
    instant = new Date(now.getTime() + 31_536_001_000);
    fetcher.mockRejectedValueOnce(new Error('Synthetic outage'));
    expect((await service.rates('USD', ['CAD'], date)).quotes[0]).toEqual({ ...first.quotes[0], stale: true });
  });

  it.each(['2027-09-11T00:00:00Z', '2020-01-01T00:00:00Z'])('does not read unbound historical FX cache expiring %s', async expiry => {
    await seed(obsoleteKey, unbound(), expiry);
    const fetcher = vi.fn(async () => fxResponse());
    expect((await provider(fetcher).rates('USD', ['CAD'], date)).quotes[0]).toMatchObject({ rate: '0.00000001', stale: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await cache()).map(row => row.key)).toContain(fxKey);
  });

  it('cannot use old FX cache as fallback during provider failure', async () => {
    await seed(obsoleteKey, unbound(), '2020-01-01T00:00:00Z');
    expect((await provider(async () => { throw new Error('Synthetic outage'); }).rates('USD', ['CAD'], date)).quotes[0])
      .toMatchObject({ rate: null, status: 'unavailable', stale: true });
    expect((await cache()).map(row => row.key)).toEqual([obsoleteKey]);
  });

  it.each(['base', 'requestedDate', 'format', 'rate', 'provider-rate'])('rejects invalid historical FX cache evidence: %s', async field => {
    await provider(async () => fxResponse('1.25')).rates('USD', ['CAD'], date);
    const stored = (await cache())[0]!;
    const value = structuredClone(stored.value);
    const evidence = value.evidence as HistoricalFxEvidence;
    if (field === 'base') evidence.request.base = 'EUR';
    if (field === 'requestedDate') evidence.request.requestedDate = '2025-01-03';
    if (field === 'format') Object.assign(evidence, { format: 'unbound' });
    const quote = evidence.observations[0]!;
    if (field === 'rate') quote.rate = '1e-8';
    if (field === 'provider-rate') quote.providerObservations[0]!.rate = '1e-8';
    await seed(fxKey, value, '2020-01-01T00:00:00Z');
    const result = await provider(async () => { throw new Error('Synthetic outage'); }).rates('USD', ['CAD'], date);
    expect(result.quotes[0]).toMatchObject({ rate: null, status: 'unavailable' });
  });

  it('rejects an oversized historical rate before cache insertion', async () => {
    expect((await provider(async () => fxResponse('1e1000000000')).rates('USD', ['CAD'], date)).quotes[0])
      .toMatchObject({ rate: null, status: 'unavailable' });
    expect(await cache()).toEqual([]);
  });
});
