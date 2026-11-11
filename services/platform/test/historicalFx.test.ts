import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/providers.js';
import type { Database } from '../src/db.js';
import { fetchHistoricalFx, historicalFxRequest, historicalFxCacheKey, historicalFxEvidenceMatches, historicalFxRevisionId } from '../src/historicalFx.js';
import { config, database } from './helpers.js';
let db: Database;
const now = new Date('2026-09-11T12:00:00.000Z'), date = '2025-01-05';
const row = (rate = '1.23456789123456789123456789', extra = '') => `{"base":"USD","quote":"CAD","date":"2025-01-03","rate":${rate},"providers":[{"key":"BOC","date":"2025-01-03","rate":${rate}},{"key":"ECB","date":"2025-01-02","rate":1.09,"excluded":true}]${extra}}`;
const result = (body: string) => new Response(body);
const provider = (body: string, clock = () => now) => new Providers(db, config(), async () => result(body), clock);
beforeAll(async () => { db = await database(); }); beforeEach(async () => { await db.query('DELETE FROM platform_quote_cache'); }); afterAll(async () => db.close());

describe('canonical dated FX evidence', () => {
  it('preserves source dates, excluded providers, exact lexemes, additional source data and request identity', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => result(`[${row('1.2300e2', ',"additional_source_number":9007199254740993123456789')}]`));
    const service = new Providers(db, config(), fetcher, () => now), output = await service.rates('USD', ['CAD'], date);
    expect(output.quotes[0]).toMatchObject({ rate: '123', requestedDate: date, observationDate: '2025-01-03', observedAt: '2025-01-03T00:00:00.000Z',
      providers: ['BOC'], precision: 'daily', stale: false });
    expect(output.historicalFx).toMatchObject({ request: { base: 'USD', symbols: ['CAD'], requestedDate: date, method: 'frankfurter-v2-daily-blend', precision: 'daily' }, fetchedAt: now.toISOString(), stale: false });
    const revision = await service.historicalFxRevision(output.historicalFx!.revisionId!);
    expect(revision!.evidence.observations[0]).toMatchObject({ sourceRateLexeme: '1.2300e2', rate: '123', attribution: 'provider-observations', providerObservations: [
      { key: 'BOC', date: '2025-01-03', rate: '123', sourceRateLexeme: '1.2300e2', excluded: false }, { key: 'ECB', excluded: true },
    ] });
    expect(revision!.evidence.sourceJson).toContain('9007199254740993123456789');
    expect(revision!.evidence.observations[0]!.providerObservations[0]!.sourceUrl).toBe('https://api.frankfurter.dev/v2/providers/BOC/rate/USD/CAD?date=2025-01-03');
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://api.frankfurter.dev/v2/rates?base=USD&quotes=CAD&expand=providers&date=2025-01-05');
    expect(historicalFxRevisionId(revision!.evidence)).toBe(output.historicalFx!.revisionId);
    expect(output.issues).toEqual(['prior_observation:CAD:2025-01-03']);
  });
  it.each([
    ['1e-23', `0.${'0'.repeat(22)}1`], ['9007199254740993123456789.123456789123456789', '9007199254740993123456789.123456789123456789'],
    ['1.' + '123456789'.repeat(15) + 'e-8', '0.00000001' + '123456789'.repeat(15)], ['1e2047', '1' + '0'.repeat(2047)], ['1e-2046', '0.' + '0'.repeat(2045) + '1'],
  ])('preserves every rate digit for %s through provider, archive and cache', async (raw, exact) => {
    const service = provider(`[${row(raw)}]`), first = await service.rates('USD', ['CAD'], date), second = await service.rates('USD', ['CAD'], date);
    expect(first.quotes[0]!.rate).toBe(exact); expect(second).toEqual(first);
    const revision = await service.historicalFxRevision(first.historicalFx!.revisionId!);
    expect(revision!.evidence.observations[0]).toMatchObject({ rate: exact, sourceRateLexeme: raw, providerObservations: [{ rate: exact, sourceRateLexeme: raw }, { rate: '1.09' }] });
  });
  it.each(['1e2048', '1e-2047', '1e1000000000', '0', '-1', '"1.25"', 'null'])('does not publish unsupported/malformed rate %s', async raw => {
    const output = await provider(`[${row(raw)}]`).rates('USD', ['CAD'], date);
    expect(output.quotes[0]).toMatchObject({ rate: null, status: 'unavailable' }); expect(output.historicalFx!.revisionId).toBeNull();
  });
  it.each(['2025-02-29', '2025-13-01', '1947-12-31', '2027-01-01', '2025-1-05'])('rejects invalid requested date %s before provider access', async requested => {
    const fetcher = vi.fn(async () => result('[]'));
    await expect(new Providers(db, config(), fetcher, () => now).rates('USD', ['CAD'], requested)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['wrong base', row().replace('"USD"', '"EUR"')], ['future observation', row().replaceAll('2025-01-03', '2025-01-06')],
    ['impossible date', row().replaceAll('2025-01-03', '2025-02-30')], ['duplicate pair', `${row()},${row('2')}`],
    ['invalid provider date', row().replace('2025-01-02', '2026-01-01')], ['provider null', row().replace('"rate":1.09', '"rate":null')],
    ['duplicate provider', row().replace('"ECB"', '"BOC"')], ['string excluded', row().replace('"excluded":true', '"excluded":"false"')],
  ])('rejects %s while retaining a valid independent requested pair', async (_name, invalid) => {
    const service = provider(`[${invalid},{"base":"USD","quote":"JPY","date":"2025-01-03","rate":150}]`);
    const output = await service.rates('USD', ['CAD','JPY'], date);
    expect(output.quotes[0]!.rate).toBeNull(); expect(output.quotes[1]).toMatchObject({ rate: '150', status: 'available' });
    const archive = await service.historicalFxRevision(output.historicalFx!.revisionId!);
    expect(archive!.evidence.observations.map(item => item.symbol)).toEqual(['JPY']); expect(archive!.evidence.sourceJson).toContain('CAD');
    expect(output.issues.some(issue => issue.includes('CAD'))).toBe(true);
  });
  it('preserves omitted provider attribution without inventing a peg or central bank', async () => {
    const service = provider('[{"base":"USD","quote":"CAD","date":"2025-01-03","rate":1.25}]');
    const output = await service.rates('USD', ['CAD'], date), archive = await service.historicalFxRevision(output.historicalFx!.revisionId!);
    expect(archive!.evidence.observations[0]).toMatchObject({ attribution: 'provider-field-omitted', providerObservations: [] }); expect(output.quotes[0]!.providers).toEqual([]);
  });
  it('archives successful empty observations as missing, never parity', async () => {
    const service = provider('[]'), output = await service.rates('USD', ['CAD'], date);
    expect(output.quotes[0]).toMatchObject({ rate: null, status: 'missing' }); expect(output.historicalFx!.revisionId).toMatch(/^[a-f0-9]{64}$/);
  });
  it('keeps currency identity mathematical and current FX behavior outside the archive', async () => {
    const count = (await db.query('SELECT id FROM platform_historical_fx_revisions')).rows.length;
    const fetcher = vi.fn(async () => result(`[${row()}]`)), service = new Providers(db, config(), fetcher, () => now);
    const identity = await service.rates('USD', ['USD'], date);
    expect(identity.quotes[0]).toMatchObject({ rate: '1', source: 'identity', providers: [] }); expect(identity.historicalFx).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled();
    const current = await service.rates('USD', ['CAD']); expect(current.historicalFx).toBeUndefined();
    expect((await db.query('SELECT id FROM platform_historical_fx_revisions')).rows).toHaveLength(count);
  });
  it('retains dated cache identity across sorting but never crosses base/date/source', async () => {
    const request = historicalFxRequest('USD', ['JPY','CAD','CAD'], date, now);
    expect(request.symbols).toEqual(['CAD','JPY']);
    expect(historicalFxCacheKey(request)).toBe(historicalFxCacheKey(historicalFxRequest('USD',['CAD','JPY'],date,now)));
    for (const other of [historicalFxRequest('EUR',['CAD','JPY'],date,now),historicalFxRequest('USD',['CAD','JPY'],'2025-01-04',now)]) expect(historicalFxCacheKey(request)).not.toBe(historicalFxCacheKey(other));
  });
  it.each(['request','sourceJson','observations','fetchedAt','expiresAt'])('rejects altered preserved %s evidence', async field => {
    const request = historicalFxRequest('USD',['CAD'],date,now), evidence = await fetchHistoricalFx(request, async () => result(`[${row()}]`), () => now);
    expect(historicalFxEvidenceMatches(evidence,request,now)).toBe(true);
    if (field==='request') evidence.request.source.requestUrl='https://other.example.test/rates';
    if (field==='sourceJson') evidence.sourceJson=evidence.sourceJson.replace('1.23456789123456789123456789','9');
    if (field==='observations') evidence.observations[0]!.rate='9';
    if (field==='fetchedAt') evidence.fetchedAt='2027-01-01T00:00:00.000Z';
    if (field==='expiresAt') evidence.expiresAt='2027-01-01T00:00:00.000Z';
    expect(historicalFxEvidenceMatches(evidence,request,now)).toBe(false);
  });
});
