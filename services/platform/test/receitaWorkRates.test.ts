import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Providers } from '../src/providers.js';
import { receitaWorkRatesRequest, receitaWorkRatesReplay, receitaWorkRatesSnapshot } from '../src/receitaWorkRates.js';
import { fetchReceitaWorkRates, receitaWorkRatesCacheKey, receitaWorkRatesEvidenceMatches, receitaWorkRatesRevisionId } from '../src/receitaWorkRatesProvider.js';
import { createServer } from '../src/server.js';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { receitaWorkRatesTestConfig as config, receitaWorkRatesTestDatabase as database } from './fixtures/receitaWorkRates.js';
const now = new Date('2026-09-12T12:00:00.000Z');
const html = (year = '2025') => readFileSync(new URL(`./fixtures/receita-work-rates/${year}.html`, import.meta.url), 'utf8');
const response = (body = html()) => new Response(body, { headers: { 'content-type': 'text/html;charset=utf-8' } });
let db: Database, cleanup = async () => {};
beforeAll(async () => {
  const value = process.env.PLATFORM_TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(value), schema = `receita_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
});
beforeEach(async () => { await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => { await cleanup(); });
const goldens = {
  2025: ['6.0394','6.0371','5.7277','5.7413','5.8701','5.6322','5.5646','5.5569','5.3922','5.3202','5.4458','5.2946'],
  2026: ['5.3923','5.384','5.2282','5.2535','4.9922','5.0648','5.0424','5.0721','5.223',null,null,null],
};
describe('official Receita receipt-month Compra evidence', () => {
  it.each(Object.entries(goldens).flatMap(([year, values]) => values.map((expected, i) => [`${year}-${String(i + 1).padStart(2,'0')}`, expected])))('replays retained original table %s without another month shift', async (month, expected) => {
    const request = receitaWorkRatesRequest(month!), evidence = await fetchReceitaWorkRates(request, async () => response(html(month!.slice(0,4))), () => now);
    expect(evidence.observation?.buy ?? null).toBe(expected); expect(evidence.observation?.receiptMonth ?? month).toBe(month);
    expect(evidence.sourceHtml).toBe(html(month!.slice(0,4)));
    expect(evidence.issues).toEqual(expected ? [] : ['receita_work_rate_missing_for_receipt_month']);
    expect(receitaWorkRatesEvidenceMatches(evidence, request, now)).toBe(true);
  });
  it('archives exact original Compra and Venda columns while selecting Compra', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => response()), p = new Providers(db, config(), fetcher, () => now), output = await p.receitaWorkRates('2025-06');
    expect(output).toMatchObject({ status:'available', stale:false, observation:{ side:'compra',buy:'5.6322',buySourceLexeme:'5,6322',sellSourceLexeme:'5,6328',sourceMonthLabel:'Junho' } });
    const revision = await p.receitaWorkRatesRevision(output.revisionId!);
    expect(revision!.evidence.sourceHtml).toBe(html()); expect(receitaWorkRatesRevisionId(revision!.evidence)).toBe(output.revisionId);
    expect(await p.ptaxRevision(output.revisionId!)).toBeNull(); expect(await p.historicalFxRevision(output.revisionId!)).toBeNull();
    expect(await p.receitaWorkRates('2025-06')).toEqual(output); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(output.request.source.requestUrl);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({redirect:'error',credentials:'omit',headers:{accept:'text/html'}});
  });
  it.each(['2024-12','2027-01','2025-00','2025-13','2025-1','2025-06?wallet=x','../../x','2025-06\n'])('rejects invalid original month %s before network', async month => {
    const fetcher=vi.fn(async()=>response());await expect(new Providers(db,config(),fetcher,()=>now).receitaWorkRates(month)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['wrong year',(s:string)=>s.replaceAll('/conversao/2025','/conversao/2026')],
    ['wrong title',(s:string)=>s.replace('class="documentFirstHeading">Tabelas para conversão de dólar em 2025','class="documentFirstHeading">Tabelas para conversão de dólar em 2026')],
    ['reversed columns',(s:string)=>s.replace('<th>Compra</th><th>Venda</th>','<th>Venda</th><th>Compra</th>')],
    ['header colspan',(s:string)=>s.replace('<th>Compra</th>','<th colspan="2">Compra</th>')],
    ['data colspan',(s:string)=>s.replace('<td>5,6322</td>','<td colspan="2">5,6322</td>')],
    ['data rowspan',(s:string)=>s.replace('<td>5,6322</td>','<td rowspan="2">5,6322</td>')],
    ['extra header data cell',(s:string)=>s.replace('<th>Mês</th>','<td>Outra moeda</td><th>Mês</th>')],
    ['extra numeric row header cell',(s:string)=>s.replace('<td>Junho</td>','<th>Outra moeda</th><td>Junho</td>')],
    ['deleted quote',(s:string)=>s.replace('<td>5,6322</td>','<td><del>5,6322</del></td>')],
    ['nested quote',(s:string)=>s.replace('<td>5,6322</td>','<td><span>5,6322</span></td>')],
    ['script split quote',(s:string)=>s.replace('<td>5,6322</td>','<td>5,6<script>void 0</script>322</td>')],
    ['extra body column',(s:string)=>s.replace('<tbody>','<tbody><td>Outra moeda</td>')],
    ['unclosed cell',(s:string)=>s.replace('<td>5,6322</td>','<td>5,6322')],
    ['missing body group',(s:string)=>s.replace('<tbody>','').replace('</tbody>','')],
    ['duplicate month',(s:string)=>s.replace('<td>Fevereiro</td>','<td>Janeiro</td>')],
    ['partial numeric row',(s:string)=>s.replace('<td>5,6328</td>','<td></td>')],
    ['zero quote',(s:string)=>s.replace('<td>5,6322</td>','<td>0,0000</td>')],
    ['exponent quote',(s:string)=>s.replace('<td>5,6322</td>','<td>5,6322e2</td>')],
    ['partial table',(s:string)=>s.replace('<td>Junho</td>','<td>June</td>')],
    ['duplicate canonical URL',(s:string)=>s.replace('<link rel="canonical"','<link rel="canonical" href="https://invalid.test" /><link rel="canonical"')],
    ['data rel instead of canonical rel',(s:string)=>s.replace('<link rel="canonical"','<link data-rel="canonical"')],
    ['data href conceals wrong URL',(s:string)=>s.replace('<link rel="canonical" href="','<link rel="canonical" href="https://invalid.test/" data-href="')],
    ['duplicate href',(s:string)=>s.replace('<link rel="canonical"','<link href="https://invalid.test/" rel="canonical"')],
    ['duplicate rel',(s:string)=>s.replace('<link rel="canonical"','<link rel="canonical" rel="alternate"')],
    ['quoted fake href',(s:string)=>s.replace('<link rel="canonical" href="','<link rel="canonical" href="https://invalid.test/" data-example=\' href="').replace('/conversao/2025" />','/conversao/2025"\' />')],
    ['data class instead of title class',(s:string)=>s.replace('<h1 class="documentFirstHeading"','<h1 data-class="documentFirstHeading"')],
    ['data id instead of content id',(s:string)=>s.replace('<div id="parent-fieldname-text"','<div data-id="parent-fieldname-text"')],
    ['duplicate content id',(s:string)=>s.replace('<div id="parent-fieldname-text"','<div id="parent-fieldname-text" id="other"')],
    ['wrong currency scope',(s:string)=>s.replace('em dólares dos Estados Unidos da América, pelo valor','em euros, pelo valor')],
    ['wrong legal side',(s:string)=>s.replace('cotação de <strong>compra</strong>','cotação de <strong>venda</strong>')],
  ] as const)('does not archive malformed official-shaped source: %s',async(_name,change)=>{
    expect(await new Providers(db,config(),async()=>response(change(html())),()=>now).receitaWorkRates('2025-06')).toMatchObject({status:'unavailable',observation:null,revisionId:null});
  });
  it('preserves missing months instead of borrowing a populated month',async()=>{
    const p=new Providers(db,config(),async()=>response(html('2026')),()=>now),result=await p.receitaWorkRates('2026-10');
    expect(result).toMatchObject({status:'missing',observation:null,stale:false,issues:['receita_work_rate_missing_for_receipt_month']});
    expect((await p.receitaWorkRatesRevision(result.revisionId!))!.evidence.observation).toBeNull();
  });
  it('keeps expired evidence, caps poisoned cache expiry and appends corrections',async()=>{
    let clock=now,failed=false,replacement=false;
    const fetcher=vi.fn(async()=>{if(failed)throw Error('offline');return response(replacement?html().replace('5,6322','5,6323'):html());});
    const p=new Providers(db,config(),fetcher,()=>clock),first=await p.receitaWorkRates('2025-06');
    await db.query('UPDATE platform_quote_cache SET expires_at=$1 WHERE key=$2',[new Date('2030-01-01'),receitaWorkRatesCacheKey(first.request)]);
    clock=new Date(now.getTime()+21_600_001);failed=true;
    expect(await p.receitaWorkRates('2025-06')).toMatchObject({stale:true,status:'available',revisionId:first.revisionId,observation:{buy:'5.6322'}});expect(fetcher).toHaveBeenCalledTimes(2);
    failed=false;replacement=true;const next=await p.receitaWorkRates('2025-06');expect(next.revisionId).not.toBe(first.revisionId);expect(next.observation!.buy).toBe('5.6323');
    expect((await p.receitaWorkRatesRevision(first.revisionId!))!.evidence.observation!.buy).toBe('5.6322');
    await expect(db.query('DELETE FROM platform_historical_fx_revisions WHERE id=$1',[first.revisionId])).rejects.toThrow();
  });
  it('single-flights, reuses durable cache after replacement and rejects altered cache values',async()=>{
    const fetcher=vi.fn(async()=>response()),p=new Providers(db,config(),fetcher,()=>now),results=await Promise.all(Array.from({length:5},()=>p.receitaWorkRates('2025-06')));expect(fetcher).toHaveBeenCalledTimes(1);
    const next=new Providers(db,config(),fetcher,()=>now);expect(await next.receitaWorkRates('2025-06')).toEqual(results[0]);
    const key=receitaWorkRatesCacheKey(results[0]!.request),record=(await db.query<{value:any}>('SELECT value FROM platform_quote_cache WHERE key=$1',[key])).rows[0]!.value;
    record.evidence.observation.buy='999';await db.query('UPDATE platform_quote_cache SET value=$1 WHERE key=$2',[JSON.stringify(record),key]);
    expect((await next.receitaWorkRates('2025-06')).observation!.buy).toBe('5.6322');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects redirects, invalid UTF-8 and over-limit streamed content',async()=>{
    for(const body of [new Response('<html/>',{status:302,headers:{location:'https://other.test'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'text/html'}}),response('a'.repeat(4_000_001))])
      expect((await new Providers(db,config(),async()=>body,()=>now).receitaWorkRates('2025-06')).status).toBe('unavailable');
  });
  it('does not invoke getters and detaches requests before HTTP await',async()=>{
    const getter=vi.fn(()=>[]);expect(()=>receitaWorkRatesSnapshot({get issues(){return getter();}})).toThrow();expect(getter).not.toHaveBeenCalled();
    const request=receitaWorkRatesRequest('2025-06'),promise=fetchReceitaWorkRates(request,async()=>{request.receiptMonth='2025-01';return response();},()=>now);expect((await promise).request.receiptMonth).toBe('2025-06');
  });
  it('replays both columns and metadata while retaining old observations after expiry',async()=>{
    const request=receitaWorkRatesRequest('2025-06'),original=await fetchReceitaWorkRates(request,async()=>response(),()=>now);
    for(const change of [(v:any)=>v.observation.buy=v.observation.sellSourceLexeme.replace(',','.'),(v:any)=>v.observation.sellSourceLexeme='99,0000',(v:any)=>v.sourceSha256='0'.repeat(64),(v:any)=>v.fetchedAt='2030-01-01T00:00:00.000Z']){
      const copy=structuredClone(original);change(copy);expect(receitaWorkRatesEvidenceMatches(copy,request,now)).toBe(false);
    }
    expect(receitaWorkRatesReplay(original,'2025-06',new Date('2027-01-01T00:00:00.000Z')).observation!.buy).toBe('5.6322');
  });
  it('exposes only strict public month/revision routes',async()=>{
    const app=await createServer(config(),db,{providers:new Providers(db,config(),async()=>response(),()=>now),logger:false});try{
      const result=await app.inject({method:'GET',url:'/v1/receita-work-rates?month=2025-06'});expect(result.statusCode).toBe(200);const payload=result.json();
      const revision=await app.inject({method:'GET',url:`/v1/receita-work-rates/revisions/${payload.revisionId}`});expect(revision.statusCode).toBe(200);expect(revision.json().evidence.sourceHtml).toBe(html());
      for(const query of ['month=2025-06&wallet=private','month=2024-06','month=2025-06&month=2025-01','month=2025-06%0A'])expect((await app.inject({method:'GET',url:'/v1/receita-work-rates?'+query})).statusCode).toBe(400);
      expect((await app.inject({method:'GET',url:`/v1/receita-work-rates/revisions/${payload.revisionId}?wallet=private`})).statusCode).toBe(400);
      expect((await app.inject({method:'GET',url:`/v1/receita-work-rates/revisions/${'0'.repeat(64)}`})).statusCode).toBe(404);
    }finally{await app.close();}
  });
});
