import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { createReleaseTestServer as createServer, injectRelease, apiConfig as config } from './releaseRequests.js';
import type { Database } from '../src/db.js';
import {database} from './helpers.js';
let db:Database;
beforeAll(async()=>{db=await database();});beforeEach(async()=>{await db.query('DELETE FROM platform_quote_cache');});afterAll(async()=>db.close());
const body='[{"base":"USD","quote":"CAD","date":"2025-01-03","rate":1.230000000000000000009,"providers":[{"key":"BOC","date":"2025-01-03","rate":1.230000000000000000009}]}]';
describe('anonymous immutable dated FX API',()=>{
  it('returns archived quote membership and retrieves revision without cookies, wallet data or source call',async()=>{
    const fetcher=vi.fn(async()=>new Response(body));const app=await createServer(config(),db,{fetcher,logger:false});
    try{
      const rates=await injectRelease(app, {url:'/v1/rates?base=USD&symbols=CAD&date=2025-01-05'});
      expect(rates.statusCode).toBe(200);expect(rates.headers['set-cookie']).toBeUndefined();
      const output=rates.json();expect(output.quotes[0]).toMatchObject({rate:'1.230000000000000000009',requestedDate:'2025-01-05',observationDate:'2025-01-03'});
      const id=output.historicalFx.revisionId;await db.query('DELETE FROM platform_quote_cache');
      const revision=await injectRelease(app, {url:`/v1/rates/revisions/${id}`});expect(revision.statusCode).toBe(200);
      expect(revision.json().evidence.observations[0].rate).toBe(output.quotes[0].rate);expect(revision.json().evidence.request).toEqual(output.historicalFx.request);
      expect(fetcher).toHaveBeenCalledTimes(1);expect((await db.query('SELECT id FROM platform_sessions')).rows).toEqual([]);
      expect((await injectRelease(app, {url:`/v1/rates/revisions/${'0'.repeat(64)}`})).statusCode).toBe(404);
      expect((await injectRelease(app, {url:`/v1/rates/revisions/${id}?wallet=private`})).statusCode).toBe(400);
    }finally{await app.close();}
  });
  it.each(['date=2025-02-29','date=2099-01-01','date=2025-01-05&wallet=private','date=2025-01-05&providers=BOC','date=2025-01-05&from=2025-01-01'])('rejects invalid/ambiguous public inputs %s before source call',async query=>{
    const fetcher=vi.fn(async()=>new Response(body)),app=await createServer(config(),db,{fetcher,logger:false});
    try{expect((await injectRelease(app, {url:`/v1/rates?base=USD&symbols=CAD&${query}`})).statusCode).toBe(400);expect(fetcher).not.toHaveBeenCalled();}finally{await app.close();}
  });
  it('keeps current rates unarchived and currency identity explicit',async()=>{
    const app=await createServer(config(),db,{fetcher:async()=>new Response(body),logger:false});
    try{expect((await injectRelease(app, {url:'/v1/rates?base=USD&symbols=CAD'})).json().historicalFx).toBeUndefined();
      const identity=(await injectRelease(app, {url:'/v1/rates?base=USD&symbols=USD&date=2025-01-05'})).json();
      expect(identity.historicalFx).toBeUndefined();expect(identity.quotes[0]).toMatchObject({source:'identity',rate:'1',providers:[]});
    }finally{await app.close();}
  });
});
