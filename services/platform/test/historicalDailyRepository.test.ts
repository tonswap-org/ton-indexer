import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Providers } from '../src/providers.js';
import { Store } from '../src/store.js';
import { HistoricalDailyRepository } from '../src/historicalDailyRepository.js';
import { historicalDailyRequest, historicalDailyCacheKey, historicalDailyRevisionId, fetchHistoricalDaily } from '../src/historicalDaily.js';
import { config, database } from './helpers.js';
let db: Database, cleanup = async () => {}, counter = 0;
const date = '2025-06-01';
const initialNow = () => new Date(Date.parse('2026-09-11T12:00:00.000Z') + counter * 1000);
const response = (price = '1.000000000000000000003') => new Response(`{"id":"bitcoin","market_data":{"current_price":{"usd":${price}}}}`);
beforeAll(async () => {
  const value = process.env.PLATFORM_TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(value), schema = `historical_daily_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
});
beforeEach(async () => { counter++; await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => cleanup());
const service = (fetcher: typeof fetch = async () => response(), clock = initialNow, connection = db) => new Providers(connection, config({coingeckoKey: 'synthetic-key'}), fetcher, clock);
const read = (revisionId: string, now = initialNow()) => new HistoricalDailyRepository(db).read(revisionId, now);
const failingArchive = (): Database => ({ ...db, query: async <T>(sql: string, values?: unknown[]) => {
  if (sql.includes('INSERT INTO platform_historical_daily_revisions')) throw Error('Synthetic preservation outage');
  return db.query<T>(sql, values);
} });

describe('durable immutable daily crypto price revisions', () => {
  it('commits source evidence before publishing an available price and verifies content-addressed cache linkage', async () => {
    const output = await service().prices(['bitcoin'],'usd',date), revisionId = output.historicalPrices![0]!.revisionId!;
    expect(output.quotes[0]).toMatchObject({ price:'1.000000000000000000003',status:'available' });
    const revision = await read(revisionId); expect(historicalDailyRevisionId(revision!.evidence)).toBe(revisionId);
    expect(revision!.evidence.observation!.price).toBe(output.quotes[0]!.price);
    expect((await db.query<{value:unknown}>('SELECT value FROM platform_quote_cache')).rows[0]!.value).toEqual(revision);
  });
  it('preserves every source/fetch revision across refreshes and process restart', async () => {
    let now = initialNow(), rate = '1.25'; const providers = service(async () => response(rate), () => now);
    const first = await providers.prices(['bitcoin'],'usd',date); now = new Date(now.getTime()+21601000); rate='1.26';
    const second = await providers.prices(['bitcoin'],'usd',date); now = new Date(now.getTime()+21601000);
    const third = await providers.prices(['bitcoin'],'usd',date);
    const ids=[first,second,third].map(output=>output.historicalPrices![0]!.revisionId!); expect(new Set(ids).size).toBe(3);
    expect((await read(ids[0]!,now))!.evidence.observation!.price).toBe('1.25');
    expect((await read(ids[1]!,now))!.evidence.observation!.price).toBe('1.26');
    expect((await read(ids[2]!,now))!.evidence.fetchedAt).toBe(now.toISOString());
  });
  it('idempotently preserves concurrent identical writers', async () => {
    const request=historicalDailyRequest('bitcoin','USD',date,'demo',initialNow()), evidence=await fetchHistoricalDaily(request,'synthetic-key',async()=>response(),initialNow);
    const revisions=await Promise.all([new HistoricalDailyRepository(db).persist(evidence,initialNow()),new HistoricalDailyRepository(db).persist(evidence,initialNow())]);
    expect(revisions[0]).toEqual(revisions[1]); expect((await db.query('SELECT id FROM platform_historical_daily_revisions WHERE id=$1',[revisions[0]!.revisionId])).rows).toHaveLength(1);
  });
  it('rejects UPDATE, DELETE and TRUNCATE of preserved evidence', async () => {
    const output=await service().prices(['bitcoin'],'usd',date), id=output.historicalPrices![0]!.revisionId!;
    await expect(db.query('UPDATE platform_historical_daily_revisions SET evidence=evidence WHERE id=$1',[id])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM platform_historical_daily_revisions WHERE id=$1',[id])).rejects.toThrow('immutable');
    await expect(db.query('TRUNCATE platform_historical_daily_revisions')).rejects.toThrow('immutable');
    expect(await read(id)).not.toBeNull();
  });
  it('does not expire evidence when operational cache is cleaned', async () => {
    const output=await service().prices(['bitcoin'],'usd',date);
    await db.query("UPDATE platform_quote_cache SET expires_at=now()-interval '10 days'"); await new Store(db,config()).cleanup();
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toEqual([]);
    const restarted=service(async()=>{throw Error('no source call');}); expect(await restarted.historicalDailyRevision(output.historicalPrices![0]!.revisionId!)).not.toBeNull();
  });
  it('never returns an unarchived Available price on persistence failure', async () => {
    const output=await service(async()=>response(),initialNow,failingArchive()).prices(['bitcoin'],'usd',date);
    expect(output.historicalPrices![0]).toMatchObject({revisionId:null,fetchedAt:null,stale:true}); expect(output.quotes[0]).toMatchObject({price:null,status:'unavailable'});
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toEqual([]);
  });
  it('returns only the prior durable revision as stale when a refresh cannot be preserved', async () => {
    const first=await service().prices(['bitcoin'],'usd',date), now=new Date(initialNow().getTime()+21601000);
    const output=await service(async()=>response('999'),()=>now,failingArchive()).prices(['bitcoin'],'usd',date);
    expect(output.historicalPrices![0]).toMatchObject({revisionId:first.historicalPrices![0]!.revisionId,stale:true,fetchedAt:first.historicalPrices![0]!.fetchedAt});
    expect(output.quotes[0]).toMatchObject({price:first.quotes[0]!.price,stale:true}); expect(output.issues).toContain(`historical_price_refresh_unavailable_cached_revision:bitcoin:${date}`);
  });
  it('rejects a valid-looking cache whose revision was never archived', async () => {
    const request=historicalDailyRequest('bitcoin','USD',date,'demo',initialNow()),evidence=await fetchHistoricalDaily(request,'synthetic-key',async()=>response(),initialNow);
    await db.query('INSERT INTO platform_quote_cache(key,value,expires_at) VALUES($1,$2,$3)',[historicalDailyCacheKey(request),JSON.stringify({revisionId:historicalDailyRevisionId(evidence),evidence}),new Date(initialNow().getTime()+60000)]);
    const fetcher=vi.fn(async()=>new Response('',{status:503})); const output=await service(fetcher).prices(['bitcoin'],'usd',date);
    expect(output.quotes[0]).toMatchObject({price:null,status:'unavailable'});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects changed source identity before archive insert', async () => {
    const request=historicalDailyRequest('bitcoin','USD',date,'demo',initialNow()),evidence=await fetchHistoricalDaily(request,'synthetic-key',async()=>response(),initialNow);
    evidence.request.source.requestUrl='https://other.example.test/rates';
    await expect(new HistoricalDailyRepository(db).persist(evidence,initialNow())).rejects.toThrow('Invalid historical evidence');
  });
  it.each([null,{}, {fetchedAt:null}, {fetchedAt:'2020-01-01T00:00:00.000Z'}])('rejects missing/crossed immutable schema metadata %j', async evidence => {
    await expect(db.query('INSERT INTO platform_historical_daily_revisions(id,request_key,fetched_at,evidence) VALUES($1,$2,$3,$4)',
      ['f'.repeat(64),'invalid',initialNow(),JSON.stringify(evidence)])).rejects.toThrow();
  });
});

describe('daily revision freshness and missing retry boundaries', () => {
  it('retries missing observations at sixty seconds and retains the original missing revision', async () => {
    let now=initialNow(), body='{"id":"bitcoin","market_data":{"current_price":{"usd":null}}}';
    const fetcher=vi.fn(async()=>new Response(body)), providers=service(fetcher,()=>now);
    const missing=await providers.prices(['bitcoin'],'usd',date), missingId=missing.historicalPrices![0]!.revisionId!;
    expect(missing.quotes[0]).toMatchObject({price:null,status:'missing'});
    expect(missing.historicalPrices![0]).toMatchObject({revisionId:expect.any(String),stale:false,expiresAt:new Date(now.getTime()+60000).toISOString()});
    body='{"id":"bitcoin","market_data":{"current_price":{"usd":2.000000000000000000001}}}';
    now=new Date(now.getTime()+59999);
    expect((await providers.prices(['bitcoin'],'usd',date)).quotes[0]!.status).toBe('missing'); expect(fetcher).toHaveBeenCalledTimes(1);
    now=new Date(now.getTime()+1);
    const recovered=await providers.prices(['bitcoin'],'usd',date);
    expect(recovered.quotes[0]).toMatchObject({price:'2.000000000000000000001',status:'available',stale:false});
    expect(fetcher).toHaveBeenCalledTimes(2); expect(recovered.historicalPrices![0]!.revisionId).not.toBe(missingId);
    expect((await read(missingId,now))!.evidence.observation).toBeNull();
  });
  it('cannot extend an available or missing source expiry through the mutable cache', async () => {
    for(const price of ['2','null']) {
      await db.query('DELETE FROM platform_quote_cache');
      let now=initialNow(); const fetcher=vi.fn(async()=>response(price)), providers=service(fetcher,()=>now);
      const first=await providers.prices(['bitcoin'],'usd',date), envelope=first.historicalPrices![0]!;
      await db.query("UPDATE platform_quote_cache SET expires_at='2099-01-01'");
      now=new Date(Date.parse(envelope.expiresAt!)); fetcher.mockRejectedValueOnce(Error('provider unavailable'));
      const expired=await providers.prices(['bitcoin'],'usd',date);
      expect(fetcher).toHaveBeenCalledTimes(2); expect(expired.historicalPrices![0]).toEqual({...envelope,stale:true});
      expect(expired.quotes[0]).toEqual({...first.quotes[0],stale:true});
    }
  });
  it('keeps provider-corrected source prices and missing revisions after cleanup with a restarted provider', async () => {
    let now=initialNow(), price='100.12345678901234567890123456789';
    const provider=service(async()=>response(price),()=>now), first=await provider.prices(['bitcoin'],'usd',date);
    now=new Date(now.getTime()+21601000); price='101.5'; const corrected=await provider.prices(['bitcoin'],'usd',date);
    now=new Date(now.getTime()+21601000); price='null'; const missing=await provider.prices(['bitcoin'],'usd',date);
    await db.query("UPDATE platform_quote_cache SET expires_at=now()-interval '10 days'"); await new Store(db,config()).cleanup();
    const restarted=service(async()=>{throw Error('offline');},()=>now);
    const revisions=await Promise.all([first,corrected,missing].map(output=>restarted.historicalDailyRevision(output.historicalPrices![0]!.revisionId!)));
    expect(revisions.map(item=>item!.evidence.observation?.price??null)).toEqual(['100.12345678901234567890123456789','101.5',null]);
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toHaveLength(0);
  });
  it('refuses an altered archive row even if its mutable cache content remains intact', async () => {
    const output=await service().prices(['bitcoin'],'usd',date), id=output.historicalPrices![0]!.revisionId!;
    const corrupt:Database={...db,query:async<T>(sql:string,values?:unknown[])=>{
      const result=await db.query<T>(sql,values);
      if(sql.startsWith('SELECT request_key,fetched_at,evidence FROM platform_historical_daily_revisions'))
        return {rows:result.rows.map(row=>({...row,evidence:{fetchedAt:initialNow().toISOString(),request:null}})) as T[]};
      return result;
    }};
    expect(await new HistoricalDailyRepository(corrupt).read(id,initialNow())).toBeNull();
    const result=await service(async()=>{throw Error('offline');},initialNow,corrupt).prices(['bitcoin'],'usd',date);
    expect(result.quotes[0]).toMatchObject({price:null,status:'unavailable'});
    expect(result.historicalPrices![0]!.revisionId).toBeNull();
  });
});
