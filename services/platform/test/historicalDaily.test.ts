import { describe, expect, it, vi } from 'vitest';
import { hash } from '../src/crypto.js';
import { fetchHistoricalDaily, historicalDailyRequest, historicalDailyEvidenceMatches, historicalDailyRevisionId, historicalDailyCacheKey } from '../src/historicalDaily.js';
const now = new Date('2026-09-13T12:00:00.000Z');
const request = historicalDailyRequest('bitcoin', 'USD', '2025-01-02', 'demo', now);
const source = (price = '123.000000000000000000009') => `{"id":"bitcoin","name":"Bitcoin","market_data":{"current_price":{"usd":${price},"eur":99.000000000000000009},"total_volume":{"usd":9007199254740993123}},"unrelated":{"array":[1.00000000000000001,null,"raw"]}}`;
const evidence = (body = source()) => fetchHistoricalDaily(request, 'synthetic-key', async () => new Response(body), () => now);
describe('canonical exact daily source evidence', () => {
  it('retains complete provider JSON with numeric lexemes, source hash, and documented UTC snapshot clock', async () => {
    const value = await evidence();
    expect(value.sourceJson).toBe(source());
    expect(value.sourceSha256).toBe(hash(source()));
    expect(value.observation).toEqual({ price: '123.000000000000000000009', sourcePriceLexeme: '123.000000000000000000009', observationDate: '2025-01-02', observedAt: '2025-01-02T00:00:00.000Z' });
    expect(value.expiresAt).toBe('2026-09-13T18:00:00.000Z');
    expect(historicalDailyEvidenceMatches(value, request, now)).toBe(true);
    expect(historicalDailyEvidenceMatches(value, request, new Date('2029-01-01T00:00:00Z'))).toBe(true);
  });
  it('hashes canonical evidence independently of property order while preserving raw source spelling', async () => {
    const value = await evidence(' { "id":"bitcoin", "market_data":{"current_price":{"usd":1.2300e+2}} } ');
    expect(value.observation).toMatchObject({price:'123',sourcePriceLexeme:'1.2300e+2'});
    expect(value.sourceJson).toContain('1.2300e+2');
    const reversed = Object.fromEntries(Object.entries(value).reverse()) as typeof value;
    expect(historicalDailyRevisionId(reversed)).toBe(historicalDailyRevisionId(value));
    expect(historicalDailyRevisionId(await evidence(source('123')))).not.toBe(historicalDailyRevisionId(value));
  });
  it.each(['{}','{"market_data":null}','{"market_data":{}}','{"market_data":{"current_price":null}}','{"market_data":{"current_price":{}}}','{"market_data":{"current_price":{"usd":null}}}'])('archives explicit missing source fields with a one-minute expiry: %s', async fields => {
    const value = await evidence(JSON.stringify({id:'bitcoin',...JSON.parse(fields)}));
    expect(value.observation).toBeNull(); expect(value.expiresAt).toBe('2026-09-13T12:01:00.000Z');
    expect(historicalDailyEvidenceMatches(value,request,now)).toBe(true);
  });
  it.each(['0','-1','"1.25"','true','[]','{}','{"isLosslessNumber":true,"value":"1.25"}','1e2048','1e-2047','1e1000000000'])('refuses malformed, nonpositive, or inexact source price %s', async price => {
    await expect(evidence(source(price))).rejects.toThrow();
  });
  it.each(['{"id":"bitcoin","market_data":[]}','{"id":"bitcoin","market_data":1}','{"id":"bitcoin","market_data":{"current_price":"bad"}}','{"id":"bitcoin","id":"ethereum","market_data":{"current_price":{"usd":1}}}','{"id":"bitcoin","market_data":{"current_price":{"usd":1,"usd":2}}}'])('refuses ambiguous/malformed original JSON %s', async body => {
    await expect(evidence(body)).rejects.toThrow();
  });
  it.each(['2025-02-29','2025-13-01','2025-1-02','2099-01-01'])('rejects nonhistorical calendar date %s before fetching', date => {
    expect(()=>historicalDailyRequest('bitcoin','USD',date,'demo',now)).toThrow();
  });
  it('binds request identity, tier and currency without including credentials', async () => {
    const pro = historicalDailyRequest('bitcoin','USD','2025-01-02','pro',now);
    expect(historicalDailyCacheKey(pro)).not.toBe(historicalDailyCacheKey(request));
    expect(historicalDailyCacheKey(historicalDailyRequest('bitcoin','CAD','2025-01-02','demo',now))).not.toBe(historicalDailyCacheKey(request));
    const fetcher=vi.fn(async()=>new Response(source()));
    await expect(fetchHistoricalDaily({...request,source:{...request.source,requestUrl:'https://other.test/api/v3/coins/bitcoin/history?date=2025-01-02&localization=false'}},'secret',fetcher,()=>now)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(await evidence())).not.toContain('synthetic-key');
  });
  it.each(['source','observation','extra','fetched','expiry','hash'])('replays evidence rather than trusting altered %s', async mutation => {
    const value=await evidence();
    if(mutation==='source') value.sourceJson=source('9');
    if(mutation==='observation') value.observation!.price='9';
    if(mutation==='extra') Object.assign(value,{unrecognized:true});
    if(mutation==='fetched') value.fetchedAt='2026-09-13T12:00:01.000Z';
    if(mutation==='expiry') value.expiresAt='2027-09-13T12:00:00.000Z';
    if(mutation==='hash') value.sourceSha256='0'.repeat(64);
    expect(historicalDailyEvidenceMatches(value,request,now)).toBe(false);
  });
});
