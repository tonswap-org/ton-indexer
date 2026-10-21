import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Providers } from '../src/providers.js';
import { fetchPtax, ptaxCacheKey, ptaxEvidenceMatches, ptaxRequest, ptaxRevisionId } from '../src/ptax.js';
import { createReleaseTestServer as createServer, injectRelease, apiConfig as config } from './releaseRequests.js';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import {database} from './helpers.js';

let db: Database, cleanup = async () => {};
const now = new Date('2026-09-12T09:00:00.000Z'), date = '2025-08-29';
const bulletin = (buy = '5.42580', sell = '5.42640', type = 'Fechamento PTAX', at = '2025-08-29 13:10:21.165') =>
  `{"paridadeCompra":146.89000,"paridadeVenda":146.93000,"cotacaoCompra":${buy},"cotacaoVenda":${sell},"dataHoraCotacao":"${at}","tipoBoletim":"${type}","sourceExtra":9007199254740993123456789}`;
const response = (rows = bulletin()) => `{"@odata.context":"https://was-p.bcnet.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata$metadata#_CotacaoMoedaDia","value":[${rows}]}`;
const service = (body: string, clock = () => now) => new Providers(db, config(), async () => new Response(body), clock);
beforeAll(async () => {
  const value = process.env.PLATFORM_TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(value), schema = `ptax_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
});
beforeEach(async () => { await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => { await cleanup(); });

describe('Banco Central exact historical closing evidence', () => {
  it('retains both direct BRL rates, original decimals, full response and civil source time independently from USD parity', async () => {
    const fetcher = vi.fn(async () => new Response(response(`${bulletin('9', '10', 'Intermediário')},${bulletin('0.036930', '0.036940')}`)));
    const provider = new Providers(db, config(), fetcher, () => now), output = await provider.ptax('JPY', date);
    expect(output).toMatchObject({ status: 'available', stale: false, observation: {
      currency: 'JPY', quoteCurrency: 'BRL', buy: '0.03693', sell: '0.03694', buySourceLexeme: '0.036930', sellSourceLexeme: '0.036940',
      sourceLocalTimestamp: '2025-08-29 13:10:21.165', sourceTimeZone: 'America/Sao_Paulo', bulletin: 'Fechamento PTAX', observationDate: date,
    } });
    expect(output.observation).not.toHaveProperty('observedAt');
    expect(output.request.source.requestUrl).toBe('https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaDia(moeda=@moeda,dataCotacao=@dataCotacao)?%40moeda=%27JPY%27&%40dataCotacao=%2708-29-2025%27&%24format=json');
    const revision = await provider.ptaxRevision(output.revisionId!);
    expect(revision!.evidence.sourceJson).toContain('9007199254740993123456789');
    expect(revision!.evidence.sourceJson).toContain('Intermediário');
    expect(ptaxRevisionId(revision!.evidence)).toBe(output.revisionId);
    expect(await provider.ptax('JPY', date)).toEqual(output); expect(fetcher).toHaveBeenCalledTimes(1);
    // The sibling route cannot mistake a direct central-bank record for a blended FX observation.
    expect(await provider.historicalFxRevision(output.revisionId!)).toBeNull();
  });
  it.each(['Fechamento', 'Fechamento PTAX'])('accepts the provider closing label %s without averaging intermediate bulletins', async type => {
    const output = await service(response(`${bulletin('1', '2', 'Abertura')},${bulletin('3', '4', type)}`)).ptax('USD', date);
    expect(output.observation).toMatchObject({ buy: '3', sell: '4', bulletin: type });
  });
  it.each([
    ['1.2300e2', '123'], ['1e-23', `0.${'0'.repeat(22)}1`],
    ['9007199254740993123456789.123456789123456789', '9007199254740993123456789.123456789123456789'],
  ])('keeps every original rate digit for %s through durable/cache replay', async (raw, expected) => {
    const p = service(response(bulletin(raw, raw))), output = await p.ptax('USD', date), saved = await p.ptaxRevision(output.revisionId!);
    expect(saved!.evidence.observation).toMatchObject({ buy: expected, sell: expected, buySourceLexeme: raw, sellSourceLexeme: raw });
    expect((await p.ptax('USD', date)).observation).toEqual(saved!.evidence.observation);
  });
  it.each(['0', '-1', 'null', '"1.2"', '1e2048', '1e-2047'])('refuses malformed or unsupported source rate %s', async raw => {
    const output = await service(response(bulletin(raw))).ptax('USD', date);
    expect(output).toMatchObject({ status: 'unavailable', revisionId: null, observation: null, stale: true });
  });
  it.each(['2025-02-29', '2025-13-01', '2025-1-02', '1994-06-30', '2027-01-01'])('rejects invalid or non-BRL-era date %s before fetching', async bad => {
    const fetcher = vi.fn(async () => new Response(response())), p = new Providers(db, config(), fetcher, () => now);
    await expect(p.ptax('USD', bad)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['BRL', 'usd', 'USDT', "USD'&other=1", 'ZZ', 'https://other.test'])('rejects invalid currency %s before fetching', async bad => {
    const fetcher = vi.fn(async () => new Response(response())), p = new Providers(db, config(), fetcher, () => now);
    await expect(p.ptax(bad, date)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the current Brazil civil date at the UTC date boundary and respects historical daylight saving', () => {
    expect(() => ptaxRequest('USD', '2026-09-12', new Date('2026-09-12T01:00:00Z'))).toThrow();
    expect(ptaxRequest('USD', '2018-01-02', new Date('2018-01-02T02:30:00Z')).requestedDate).toBe('2018-01-02');
    expect(() => ptaxRequest('USD', '2018-01-02', new Date('2018-01-02T01:30:00Z'))).toThrow();
  });
  it.each([
    ['wrong source date', response(bulletin('1', '2', 'Fechamento PTAX', '2025-08-28 13:00:00'))],
    ['impossible time', response(bulletin('1', '2', 'Fechamento PTAX', '2025-08-29 24:00:00'))],
    ['timezone suffix instead of source civil time', response(bulletin('1', '2', 'Fechamento PTAX', '2025-08-29 13:00:00Z'))],
    ['duplicate close', response(`${bulletin()},${bulletin()}`)],
    ['competing closing labels', response(`${bulletin()},${bulletin('3', '4', 'Fechamento')}`)],
    ['unrequested intermediate date', response(`${bulletin()},${bulletin('1', '2', 'Intermediário', '2025-08-28 12:00:00')}`)],
    ['partial OData page', response().replace('"value":', '"@odata.nextLink":"https://other.test/next","value":')],
    ['unbounded rows', response(Array(101).fill(bulletin()).join(','))],
    ['nonarray value', '{"value":null}'],
  ])('refuses %s without returning a guessed quote', async (_label, body) => {
    expect(await service(body).ptax('USD', date)).toMatchObject({ status: 'unavailable', revisionId: null, observation: null });
  });
  it('does not accept a closing bulletin published after the fetch instant in Brazil', async () => {
    const output = await service(response(bulletin()), () => new Date('2025-08-29T16:00:00Z')).ptax('USD', date);
    expect(output.status).toBe('unavailable');
  });
  it('preserves a closed-day empty response without inventing a previous-business-day observation', async () => {
    const fetcher = vi.fn(async () => new Response(response(''))), p = new Providers(db, config(), fetcher, () => now);
    const output = await p.ptax('USD', '2025-08-30');
    expect(output).toMatchObject({ status: 'missing', observation: null, stale: false, issues: ['ptax_no_observation_on_requested_date'] });
    expect(output.revisionId).toMatch(/^[a-f0-9]{64}$/); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await p.ptaxRevision(output.revisionId!))!.evidence.request.requestedDate).toBe('2025-08-30');
  });
  it('distinguishes intermediate-only from an unavailable service and never substitutes an intraday quote', async () => {
    expect(await service(response(bulletin('1', '2', 'Intermediário'))).ptax('USD', date)).toMatchObject({ status: 'missing', observation: null, issues: ['ptax_daily_close_missing'] });
    const p = new Providers(db, config(), async () => new Response('down', { status: 503 }), () => now);
    await db.query('DELETE FROM platform_quote_cache');
    expect(await p.ptax('USD', date)).toMatchObject({ status: 'unavailable', observation: null, issues: ['ptax_refresh_unavailable'] });
  });
  it('keeps old observations and source revisions after a stale refresh fails or a corrected quote is published', async () => {
    let current = now, fail = false, rate = '5'; const fetcher = vi.fn(async () => new Response(fail ? 'down' : response(bulletin(rate, rate)), { status: fail ? 503 : 200 }));
    const p = new Providers(db, config(), fetcher, () => current), first = await p.ptax('USD', date);
    current = new Date(now.getTime() + 7 * 3600000); fail = true;
    expect(await p.ptax('USD', date)).toMatchObject({ status: 'available', stale: true, revisionId: first.revisionId, observation: first.observation, issues: ['ptax_refresh_unavailable'] });
    fail = false; rate = '6'; const corrected = await p.ptax('USD', date);
    expect(corrected.revisionId).not.toBe(first.revisionId); expect(corrected.stale).toBe(false);
    expect((await p.ptaxRevision(first.revisionId!))!.evidence.observation!.buy).toBe('5');
    expect((await p.ptaxRevision(corrected.revisionId!))!.evidence.observation!.buy).toBe('6');
    await expect(db.query('UPDATE platform_historical_fx_revisions SET request_key=$1 WHERE id=$2', ['changed', first.revisionId])).rejects.toThrow();
    await expect(db.query('DELETE FROM platform_historical_fx_revisions WHERE id=$1', [first.revisionId])).rejects.toThrow();
    await expect(db.query('TRUNCATE platform_historical_fx_revisions')).rejects.toThrow();
  });
  it.each(['ptax', 'frankfurter', 'coingecko'])('caps %s cache freshness at the evidence expiry and still retains stale evidence on failure', async kind => {
    let current = now, fail = false;
    const fetcher = vi.fn(async () => new Response(fail ? 'down' : kind === 'ptax' ? response() : kind === 'frankfurter'
      ? `[{"date":"${date}","base":"USD","quote":"BRL","rate":5.4,"providers":[]}]`
      : `{"prices":[[${Date.parse(`${date}T12:00:00Z`)},5.4]]}`, { status: fail ? 503 : 200 }));
    const p = new Providers(db, config({ coingeckoKey: 'synthetic-key' }), fetcher, () => current);
    const read = async () => {
      if (kind === 'ptax') return p.ptax('USD', date);
      if (kind === 'frankfurter') return (await p.rates('USD', ['BRL'], date)).historicalFx!;
      const anchor = await p.historicalAnchor('the-open-network', `${date}T12:00:00.000Z`);
      return { revisionId: anchor.revisionId, stale: anchor.stale };
    };
    const first = await read(); expect(first.revisionId).toMatch(/^[a-f0-9]{64}$/);
    await db.query("UPDATE platform_quote_cache SET expires_at=$1", [new Date(now.getTime() + 24 * 3600000)]);
    current = new Date(now.getTime() + 6 * 3600000); fail = true;
    expect(await read()).toMatchObject({ revisionId: first.revisionId, stale: true }); expect(fetcher).toHaveBeenCalledTimes(2);
    fail = false; const refreshed = await read(); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(refreshed.stale).toBe(false); expect(refreshed.revisionId).not.toBe(first.revisionId);
  });
  it.each(['request', 'sourceJson', 'sourceSha256', 'observation', 'fetchedAt', 'expiresAt', 'issues'])('rejects tampered %s on evidence replay', async field => {
    const request = ptaxRequest('USD', date, now), evidence = await fetchPtax(request, async () => new Response(response()), () => now);
    expect(ptaxEvidenceMatches(evidence, request, now)).toBe(true);
    const bad: any = structuredClone(evidence);
    if (field === 'request') bad.request.source.requestUrl = 'https://untrusted.test';
    if (field === 'sourceJson') bad.sourceJson = response(bulletin('8', '8'));
    if (field === 'sourceSha256') bad.sourceSha256 = '0'.repeat(64);
    if (field === 'observation') bad.observation.sell = '8';
    if (field === 'fetchedAt') bad.fetchedAt = '2027-01-01T00:00:00.000Z';
    if (field === 'expiresAt') bad.expiresAt = now.toISOString();
    if (field === 'issues') bad.issues = ['invented'];
    expect(ptaxEvidenceMatches(bad, request, now)).toBe(false);
  });
  it('never requests a noncanonical source URL and keeps currency/date cache identities separate', async () => {
    const request = ptaxRequest('USD', date, now), fetcher = vi.fn(async () => new Response(response()));
    request.source.requestUrl = 'https://other.test'; await expect(fetchPtax(request, fetcher, () => now)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const usd = ptaxCacheKey(ptaxRequest('USD', date, now));
    expect(usd).not.toBe(ptaxCacheKey(ptaxRequest('JPY', date, now))); expect(usd).not.toBe(ptaxCacheKey(ptaxRequest('USD', '2025-08-30', now)));
  });
  it('replays durable cache data after service restart, coalesces concurrent requests and rejects a forged cache value', async () => {
    const fetcher = vi.fn(async () => new Response(response())), first = new Providers(db, config(), fetcher, () => now);
    const values = await Promise.all(Array.from({ length: 5 }, () => first.ptax('USD', date)));
    expect(new Set(values.map(v => v.revisionId)).size).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);
    const next = new Providers(db, config(), fetcher, () => now); expect(await next.ptax('USD', date)).toEqual(values[0]); expect(fetcher).toHaveBeenCalledTimes(1);
    const key = ptaxCacheKey(values[0]!.request), saved = (await db.query<{ value: any }>('SELECT value FROM platform_quote_cache WHERE key=$1', [key])).rows[0]!.value;
    saved.evidence.observation.buy = '99'; await db.query('UPDATE platform_quote_cache SET value=$1 WHERE key=$2', [JSON.stringify(saved), key]);
    expect((await next.ptax('USD', date)).observation!.buy).toBe('5.4258'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('exposes only public currency/date requests and immutable observations without wallet authentication', async () => {
    const p = service(response()), app = await createServer(config(), db, { providers: p, logger: false });
    try {
      const initial = await injectRelease(app, { method: 'GET', url: `/v1/ptax?currency=USD&date=${date}` }); expect(initial.statusCode).toBe(200);
      const value = initial.json(); expect(value.status).toBe('available');
      const saved = await injectRelease(app, { method: 'GET', url: `/v1/ptax/revisions/${value.revisionId}` }); expect(saved.statusCode).toBe(200); expect(saved.json().evidence.observation).toEqual(value.observation);
      expect((await injectRelease(app, { method: 'GET', url: `/v1/ptax?currency=USD&date=${date}&wallet=private` })).statusCode).toBe(400);
      expect((await injectRelease(app, { method: 'GET', url: `/v1/ptax?currency=BRL&date=${date}` })).statusCode).toBe(400);
      expect((await injectRelease(app, { method: 'GET', url: `/v1/ptax/revisions/${'0'.repeat(64)}` })).statusCode).toBe(404);
      expect((await injectRelease(app, { method: 'GET', url: `/v1/ptax/revisions/${value.revisionId}?wallet=private` })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
