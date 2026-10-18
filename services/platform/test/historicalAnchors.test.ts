import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/providers.js';
import { historicalAnchorRequest, historicalAnchorCacheKey, HISTORICAL_ANCHOR_METHOD } from '../src/historicalAnchors.js';
import type { Database } from '../src/db.js';
import { config, database } from './helpers.js';

let db: Database;
beforeAll(async () => { db = await database(); });
beforeEach(async () => { await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => { await db.close(); });
const instant = '2025-06-01T12:00:00.500Z', target = Date.parse(instant), initialNow = new Date('2026-09-10T12:00:00.000Z');
const point = (time: number, price: string) => `[${time},${price}]`;
const body = (...points: string[]) => `{"prices":[${points.join(',')}],"market_caps":[],"total_volumes":[]}`;
const normal = () => new Response(body(point(target - 1000, '0.123456789123456789123456789')));
function provider(fetcher: typeof fetch, overrides = {}, clock = () => initialNow) {
  return new Providers(db, config({ coingeckoKey: 'synthetic-key', ...overrides }), fetcher, clock);
}

describe('keyed historical range anchors', () => {
  it.each(['demo', 'pro'] as const)('uses %s key headers and exact ID/range/hourly/full query binding', async tier => {
    const fetcher = vi.fn(async () => normal()); const result = await provider(fetcher, { coingeckoTier: tier }).historicalAnchor('the-open-network', instant);
    expect(result).toMatchObject({ coinGeckoId: 'the-open-network', currency: 'USD', at: instant, method: HISTORICAL_ANCHOR_METHOD,
      status: 'available', precision: 'sampled', observedAt: new Date(target - 1000).toISOString(), lagMilliseconds: 1000, stale: false,
      source: { identityBinding: 'request-path', interval: 'hourly', pricePrecision: 'full' } });
    const [request, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit]; const url = new URL(request);
    expect(url.hostname).toBe(tier === 'pro' ? 'pro-api.coingecko.com' : 'api.coingecko.com');
    expect(url.pathname).toBe('/api/v3/coins/the-open-network/market_chart/range');
    expect(Object.fromEntries(url.searchParams)).toEqual({ vs_currency: 'usd', from: String(Math.floor(target / 1000) - 7200), to: String(Math.ceil(target / 1000)), interval: 'hourly', precision: 'full' });
    expect(init.headers).toEqual({ [tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: 'synthetic-key' });
    expect(init.redirect).toBe('error'); expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });
  it.each([
    ['1e-23', '0.00000000000000000000001'],
    ['123456789012345678901234567890.12345678901234567890123456789', '123456789012345678901234567890.12345678901234567890123456789'],
    ['1' + '2'.repeat(100) + '.00000000000000000003', '1' + '2'.repeat(100) + '.00000000000000000003'],
    ['1.230000e+30', '1230000000000000000000000000000'],
  ])('retains exact provider price lexeme %s without Number or significant-digit rounding', async (lexeme, value) => {
    const result = await provider(async () => new Response(body(point(target - 125, lexeme)))).historicalAnchor('bitcoin', instant);
    expect(result.priceUsd).toBe(value);
    expect(result.observations[0]).toEqual({ timestampMs: String(target - 125), observedAt: new Date(target - 125).toISOString(),
      priceUsd: value, sourceTimestampLexeme: String(target - 125), sourcePriceLexeme: lexeme });
    expect(result.lagMilliseconds).toBe(125);
  });
  it('selects the latest eligible sample irrespective of array order and retains all source observations', async () => {
    const result = await provider(async () => new Response(body(point(target - 1000, '3'), point(target - 3600000, '2'), point(target - 5000, '1')))).historicalAnchor('bitcoin', instant);
    expect(result.priceUsd).toBe('3'); expect(result.selectedObservationIndex).toBe(0); expect(result.observations).toHaveLength(3);
    expect(result.maximumLagSeconds).toBe(7200); expect(result.pricesSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('never selects a later sample even inside the rounded provider upper bound', async () => {
    const result = await provider(async () => new Response(body(point(target + 100, '3')))).historicalAnchor('bitcoin', instant);
    expect(result).toMatchObject({ status: 'missing', priceUsd: null, observedAt: null, selectedObservationIndex: null,
      issues: ['no_observation_at_or_before_requested_time'] });
    expect(result.observations[0]!.priceUsd).toBe('3');
  });
  it('enforces maximum lag including the requested fractional second', async () => {
    const result = await provider(async () => new Response(body(point(Math.floor(target / 1000) * 1000 - 7200000, '3')))).historicalAnchor('bitcoin', instant);
    expect(result.status).toBe('missing'); expect(result.priceUsd).toBeNull();
  });
  it('preserves exact integer timestamp lexemes but rejects hidden fractional rounding', async () => {
    const timestamp = target - 125;
    const accepted = await provider(async () => new Response(body(`[${timestamp}e0,1]`))).historicalAnchor('bitcoin', instant);
    expect(accepted.observations[0]!.sourceTimestampLexeme).toBe(`${timestamp}e0`);
    await db.query('DELETE FROM platform_quote_cache');
    const rejected = await provider(async () => new Response(body(`[${timestamp}.000000000001,1]`))).historicalAnchor('bitcoin', instant);
    expect(rejected).toMatchObject({ status: 'unavailable', priceUsd: null });
  });
  it.each([
    body(point(Math.floor(target / 1000) * 1000 - 7200001, '1')),
    body(point(Math.ceil(target / 1000) * 1000 + 1, '1')),
    body(point(target - 1000, '1'), point(target - 1000, '2')),
    body(point(target - 1000, '1'), point(target - 1000, '1')),
    body(point(target - 1000, '0')),
    body(point(target - 1000, '-1')),
    body(point(target - 1000, '1e999999')),
    body(`[${target - 1000},"1.23"]`),
    body(`[${target - 1000},1,2]`),
    '{"prices":null}',
    '{"id":"foreign-coin","prices":[]}',
  ])('rejects malformed, conflicting or out-of-range evidence (%#)', async payload => {
    const result = await provider(async () => new Response(payload)).historicalAnchor('bitcoin', instant);
    expect(result).toMatchObject({ status: 'unavailable', priceUsd: null, observedAt: null, observations: [], stale: true });
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toHaveLength(0);
  });
  it('reports missing samples without asking daily/current pricing endpoints', async () => {
    const fetcher = vi.fn(async () => new Response(body())); const result = await provider(fetcher).historicalAnchor('bitcoin', instant);
    expect(result.status).toBe('missing'); expect(result.priceUsd).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/market_chart/range');
  });
  it('does not call any provider without the configured server key', async () => {
    const fetcher = vi.fn(async () => normal()); const result = await provider(fetcher, { coingeckoKey: undefined }).historicalAnchor('bitcoin', instant);
    expect(result).toMatchObject({ status: 'unavailable', issues: ['coingecko_key_not_configured'] }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a future source sample even inside the rounded requested range', async () => {
    const result = await provider(async () => new Response(body(point(target + 100, '1'))), {}, () => new Date(target + 50)).historicalAnchor('bitcoin', instant);
    expect(result).toMatchObject({ status: 'unavailable', priceUsd: null, observations: [] });
  });
  it('bounds response observation count without truncating evidence into a fabricated selection', async () => {
    const result = await provider(async () => new Response(body(...Array.from({ length: 513 }, (_, index) => point(target - index, '1'))))).historicalAnchor('bitcoin', instant);
    expect(result).toMatchObject({ status: 'unavailable', priceUsd: null, observations: [] });
  });
  it('reads validated JSONB cache after a restart and coalesces identical requests', async () => {
    const fetcher = vi.fn(async () => normal()), p = provider(fetcher);
    const [first, second] = await Promise.all([p.historicalAnchor('bitcoin', instant), p.historicalAnchor('bitcoin', instant)]);
    const restarted = await provider(fetcher).historicalAnchor('bitcoin', instant);
    expect(restarted).toEqual(first); expect(second).toEqual(first); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('binds cache by ID, full instant and provider path while normalizing equivalent offsets', async () => {
    const fetcher = vi.fn(async () => new Response(body())), p = provider(fetcher);
    await p.historicalAnchor('bitcoin', instant); await p.historicalAnchor('bitcoin', '2025-06-01T14:00:00.500+02:00');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await p.historicalAnchor('ethereum', instant); await p.historicalAnchor('bitcoin', '2025-06-01T12:00:00.501Z');
    await provider(fetcher, { coingeckoTier: 'pro' }).historicalAnchor('bitcoin', instant);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('retains historical evidence with its original times on provider failure and labels expired cache stale', async () => {
    let now = initialNow; const fetcher = vi.fn(async () => normal()), p = provider(fetcher, {}, () => now);
    const first = await p.historicalAnchor('bitcoin', instant); now = new Date(now.getTime() + 21601000);
    fetcher.mockResolvedValue(new Response('unavailable', { status: 503 })); const second = await p.historicalAnchor('bitcoin', instant);
    expect(second).toMatchObject({ status: 'available', priceUsd: first.priceUsd, observedAt: first.observedAt, stale: true,
      cache: { fetchedAt: first.cache.fetchedAt, expiresAt: first.cache.expiresAt, stale: true },
      issues: ['historical_anchor_refresh_unavailable_cached_revision'] });
    expect(second.observations).toEqual(first.observations); expect(second.pricesSha256).toBe(first.pricesSha256); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['identity', 'range', 'method', 'price', 'lexeme', 'fetchedAt', 'hash'])('does not serve corrupt %s cache on a provider outage', async field => {
    const p = provider(async () => normal()); await p.historicalAnchor('bitcoin', instant);
    const key = historicalAnchorCacheKey(historicalAnchorRequest('bitcoin', instant, 'demo', initialNow));
    const stored = (await db.query<{ value: any }>('SELECT value FROM platform_quote_cache WHERE key=$1', [key])).rows[0]!.value;
    const row = stored.evidence;
    if (field === 'identity') row.request.coinGeckoId = 'ethereum';
    if (field === 'range') row.request.range.toUnixSeconds += 1;
    if (field === 'method') row.request.method = 'nearest';
    if (field === 'price') row.observations[0].priceUsd = '999';
    if (field === 'lexeme') row.observations[0].sourcePriceLexeme = '999';
    if (field === 'fetchedAt') row.fetchedAt = '2999-01-01T00:00:00.000Z';
    if (field === 'hash') row.pricesSha256 = 'a'.repeat(64);
    await db.query('UPDATE platform_quote_cache SET value=$2 WHERE key=$1', [key, JSON.stringify(stored)]);
    const result = await provider(async () => new Response('', { status: 403 })).historicalAnchor('bitcoin', instant);
    expect(result.status).toBe('unavailable'); expect(result.priceUsd).toBeNull();
  });
  it.each(['2025-02-30T12:00:00Z', '2025-06-01T25:00:00Z', '2025-06-01T12:00:00', '2025-06-01',
    '2025-06-01T12:00:60Z', '2025-06-01T12:00:00.0001Z', '2025-06-01T12:00:00+02:99', '2999-01-01T00:00:00Z'])('rejects invalid requested timestamp %s before transport', async at => {
    const fetcher = vi.fn(async () => normal()); await expect(provider(fetcher).historicalAnchor('bitcoin', at)).rejects.toMatchObject({ code: 'invalid_historical_time' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
