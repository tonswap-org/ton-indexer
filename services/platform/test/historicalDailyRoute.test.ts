import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { createReleaseTestServer as createServer, injectRelease, apiConfig as config } from './releaseRequests.js';
import type { Database } from '../src/db.js';
import {database} from './helpers.js';
let db:Database;
beforeAll(async()=>{db=await database();});beforeEach(async()=>{await db.query('DELETE FROM platform_quote_cache');});afterAll(async()=>db.close());
const body='{"id":"bitcoin","market_data":{"current_price":{"usd":9007199254740993.123456789123456789}},"developer_data":{"stars":9007199254740993}}';
const settings=()=>config({coingeckoKey:'synthetic-key'});
describe('anonymous immutable dated price API',()=>{
  it('returns one source-bound envelope per asset and retrieves evidence after cache deletion without authentication or refetch',async()=>{
    const fetcher=vi.fn(async()=>new Response(body)),app=await createServer(settings(),db,{fetcher,logger:false});
    try{
      const prices=await injectRelease(app, {url:'/v1/prices?ids=bitcoin,bitcoin&vs=usd&date=2025-01-05'});
      expect(prices.statusCode).toBe(200);expect(prices.headers['set-cookie']).toBeUndefined();
      const output=prices.json();expect(output.quotes[0]).toMatchObject({price:'9007199254740993.123456789123456789',requestedDate:'2025-01-05',observationDate:'2025-01-05'});
      expect(output.historicalPrices).toHaveLength(1);
      const envelope=output.historicalPrices[0],id=envelope.revisionId;
      expect(envelope).toMatchObject({stale:false,request:{coinGeckoId:'bitcoin',currency:'USD',method:'coingecko-utc-daily-snapshot',precision:'daily'}});
      await db.query('DELETE FROM platform_quote_cache');
      const revision=await injectRelease(app, {url:`/v1/prices/revisions/${id}`});expect(revision.statusCode).toBe(200);
      expect(revision.json().evidence.observation.price).toBe(output.quotes[0].price);
      expect(revision.json().evidence.request).toEqual(envelope.request);expect(revision.json().evidence.sourceJson).toBe(body);
      expect(fetcher).toHaveBeenCalledTimes(1);expect((await db.query('SELECT id FROM platform_sessions')).rows).toEqual([]);
      expect((await injectRelease(app, {url:`/v1/prices/revisions/${'0'.repeat(64)}`})).statusCode).toBe(404);
      expect((await injectRelease(app, {url:`/v1/prices/revisions/${id}?wallet=private`})).statusCode).toBe(400);
      expect((await injectRelease(app, {url:'/v1/prices/revisions/not-an-id'})).statusCode).toBe(400);
    }finally{await app.close();}
  });
  it.each(['date=2025-02-29','date=2099-01-01','date=2025-01-05&wallet=private','date=2025-01-05&from=2025-01-01','date=2025-01-05&precision=spot'])('rejects invalid or ambiguous query %s before source calls',async query=>{
    const fetcher=vi.fn(async()=>new Response(body)),app=await createServer(settings(),db,{fetcher,logger:false});
    try{expect((await injectRelease(app, {url:`/v1/prices?ids=bitcoin&vs=usd&${query}`})).statusCode).toBe(400);expect(fetcher).not.toHaveBeenCalled();}finally{await app.close();}
  });
  it('propagates the original BTC daily price revision through dated denomination rates',async()=>{
    const app=await createServer(settings(),db,{fetcher:async()=>new Response('{"id":"bitcoin","market_data":{"current_price":{"usd":4}}}'),logger:false});
    try{
      const output=(await injectRelease(app, {url:'/v1/rates?base=USD&symbols=BTC&date=2025-01-05'})).json();
      expect(output.quotes[0]).toMatchObject({symbol:'BTC',rate:'0.25',source:'coingecko',status:'available',precision:'daily'});
      expect(output.historicalPrices).toHaveLength(1);
      const revision=(await injectRelease(app, {url:`/v1/prices/revisions/${output.historicalPrices[0].revisionId}`})).json();
      expect(revision.evidence.observation.price).toBe('4');expect(revision.evidence.request.currency).toBe('USD');
    }finally{await app.close();}
  });
  it('keeps spot responses separate and gives each unavailable daily request an explicit null revision',async()=>{
    const fetcher=vi.fn(async()=>new Response(body)),app=await createServer(config(),db,{fetcher,logger:false});
    try{
      const spot=(await injectRelease(app, {url:'/v1/prices?ids=bitcoin'})).json();expect(spot.historicalPrices).toBeUndefined();
      const missing=(await injectRelease(app, {url:'/v1/prices?ids=ethereum,bitcoin&date=2025-01-05'})).json();
      expect(missing.historicalPrices.map((item:{request:{coinGeckoId:string}})=>item.request.coinGeckoId)).toEqual(['bitcoin','ethereum']);
      expect(missing.historicalPrices.every((item:{revisionId:null;fetchedAt:null;stale:boolean})=>item.revisionId===null&&item.fetchedAt===null&&item.stale)).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    }finally{await app.close();}
  });
});
