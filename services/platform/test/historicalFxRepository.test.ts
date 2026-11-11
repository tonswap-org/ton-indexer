import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Providers } from '../src/providers.js';
import { Store } from '../src/store.js';
import { HistoricalFxRepository } from '../src/historicalFxRepository.js';
import { historicalFxRequest, historicalFxCacheKey, historicalFxRevisionId, fetchHistoricalFx } from '../src/historicalFx.js';
import { config, database } from './helpers.js';
let db: Database, cleanup = async () => {}, counter = 0;
const date = '2025-06-01';
const initialNow = () => new Date(Date.parse('2026-09-11T12:00:00.000Z') + counter * 1000);
const response = (rate = '1.000000000000000000003') => new Response(`[{"date":"2025-05-30","base":"USD","quote":"CAD","rate":${rate},"providers":[{"key":"BOC","date":"2025-05-30","rate":${rate}}]}]`);
beforeAll(async () => {
  const value = process.env.PLATFORM_TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(value), schema = `historical_fx_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
});
beforeEach(async () => { counter++; await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => cleanup());
const service = (fetcher: typeof fetch = async () => response(), clock = initialNow, connection = db) => new Providers(connection, config(), fetcher, clock);
const read = (revisionId: string, now = initialNow()) => new HistoricalFxRepository(db).read(revisionId, now);
const failingArchive = (): Database => ({ ...db, query: async <T>(sql: string, values?: unknown[]) => {
  if (sql.includes('INSERT INTO platform_historical_fx_revisions')) throw Error('Synthetic preservation outage');
  return db.query<T>(sql, values);
} });

describe('durable immutable daily FX revisions', () => {
  it('commits source evidence before publishing an available rate and verifies content-addressed cache linkage', async () => {
    const output = await service().rates('USD',['CAD'],date), revisionId = output.historicalFx!.revisionId!;
    expect(output.quotes[0]).toMatchObject({ rate:'1.000000000000000000003',status:'available' });
    const revision = await read(revisionId); expect(historicalFxRevisionId(revision!.evidence)).toBe(revisionId);
    expect(revision!.evidence.observations[0]!.rate).toBe(output.quotes[0]!.rate);
    expect((await db.query<{value:unknown}>('SELECT value FROM platform_quote_cache')).rows[0]!.value).toEqual(revision);
  });
  it('preserves every source/fetch revision across refreshes and process restart', async () => {
    let now = initialNow(), rate = '1.25'; const providers = service(async () => response(rate), () => now);
    const first = await providers.rates('USD',['CAD'],date); now = new Date(now.getTime()+21601000); rate='1.26';
    const second = await providers.rates('USD',['CAD'],date); now = new Date(now.getTime()+21601000);
    const third = await providers.rates('USD',['CAD'],date);
    const ids=[first,second,third].map(output=>output.historicalFx!.revisionId!); expect(new Set(ids).size).toBe(3);
    expect((await read(ids[0]!,now))!.evidence.observations[0]!.rate).toBe('1.25');
    expect((await read(ids[1]!,now))!.evidence.observations[0]!.rate).toBe('1.26');
    expect((await read(ids[2]!,now))!.evidence.fetchedAt).toBe(now.toISOString());
  });
  it('idempotently preserves concurrent identical writers', async () => {
    const request=historicalFxRequest('USD',['CAD'],date,initialNow()), evidence=await fetchHistoricalFx(request,async()=>response(),initialNow);
    const revisions=await Promise.all([new HistoricalFxRepository(db).persist(evidence,initialNow()),new HistoricalFxRepository(db).persist(evidence,initialNow())]);
    expect(revisions[0]).toEqual(revisions[1]); expect((await db.query('SELECT id FROM platform_historical_fx_revisions WHERE id=$1',[revisions[0]!.revisionId])).rows).toHaveLength(1);
  });
  it('rejects UPDATE, DELETE and TRUNCATE of preserved evidence', async () => {
    const output=await service().rates('USD',['CAD'],date), id=output.historicalFx!.revisionId!;
    await expect(db.query('UPDATE platform_historical_fx_revisions SET evidence=evidence WHERE id=$1',[id])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM platform_historical_fx_revisions WHERE id=$1',[id])).rejects.toThrow('immutable');
    await expect(db.query('TRUNCATE platform_historical_fx_revisions')).rejects.toThrow('immutable');
    expect(await read(id)).not.toBeNull();
  });
  it('does not expire evidence when operational cache is cleaned', async () => {
    const output=await service().rates('USD',['CAD'],date);
    await db.query("UPDATE platform_quote_cache SET expires_at=now()-interval '10 days'"); await new Store(db,config()).cleanup();
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toEqual([]);
    const restarted=service(async()=>{throw Error('no source call');}); expect(await restarted.historicalFxRevision(output.historicalFx!.revisionId!)).not.toBeNull();
  });
  it('never returns an unarchived Available rate on persistence failure', async () => {
    const output=await service(async()=>response(),initialNow,failingArchive()).rates('USD',['CAD'],date);
    expect(output.historicalFx).toMatchObject({revisionId:null,fetchedAt:null,stale:true}); expect(output.quotes[0]).toMatchObject({rate:null,status:'unavailable'});
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toEqual([]);
  });
  it('returns only the prior durable revision as stale when a refresh cannot be preserved', async () => {
    const first=await service().rates('USD',['CAD'],date), now=new Date(initialNow().getTime()+21601000);
    const output=await service(async()=>response('999'),()=>now,failingArchive()).rates('USD',['CAD'],date);
    expect(output.historicalFx).toMatchObject({revisionId:first.historicalFx!.revisionId,stale:true,fetchedAt:first.historicalFx!.fetchedAt});
    expect(output.quotes[0]).toMatchObject({rate:first.quotes[0]!.rate,stale:true}); expect(output.issues).toContain('historical_fx_refresh_unavailable_cached_revision');
  });
  it('rejects a valid-looking cache whose revision was never archived', async () => {
    const request=historicalFxRequest('USD',['CAD'],date,initialNow()),evidence=await fetchHistoricalFx(request,async()=>response(),initialNow);
    await db.query('INSERT INTO platform_quote_cache(key,value,expires_at) VALUES($1,$2,$3)',[historicalFxCacheKey(request),JSON.stringify({revisionId:historicalFxRevisionId(evidence),evidence}),new Date(initialNow().getTime()+60000)]);
    const fetcher=vi.fn(async()=>new Response('',{status:503})); const output=await service(fetcher).rates('USD',['CAD'],date);
    expect(output.quotes[0]).toMatchObject({rate:null,status:'unavailable'});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects changed source identity before archive insert', async () => {
    const request=historicalFxRequest('USD',['CAD'],date,initialNow()),evidence=await fetchHistoricalFx(request,async()=>response(),initialNow);
    evidence.request.source.requestUrl='https://other.example.test/rates';
    await expect(new HistoricalFxRepository(db).persist(evidence,initialNow())).rejects.toThrow('Invalid historical evidence');
  });
  it.each([null,{}, {fetchedAt:null}, {fetchedAt:'2020-01-01T00:00:00.000Z'}])('rejects missing/crossed immutable schema metadata %j', async evidence => {
    await expect(db.query('INSERT INTO platform_historical_fx_revisions(id,request_key,fetched_at,evidence) VALUES($1,$2,$3,$4)',
      ['f'.repeat(64),'invalid',initialNow(),JSON.stringify(evidence)])).rejects.toThrow();
  });
});
