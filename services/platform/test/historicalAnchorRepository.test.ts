import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Providers } from '../src/providers.js';
import { Store } from '../src/store.js';
import { HistoricalAnchorRepository } from '../src/historicalAnchorRepository.js';
import { historicalAnchorRequest, historicalAnchorCacheKey, historicalAnchorRevisionId, fetchHistoricalAnchor } from '../src/historicalAnchors.js';
import { config, database } from './helpers.js';

let db: Database, cleanup = async () => {};
let counter = 0;
const at = '2025-06-01T12:00:00.000Z', initialNow = new Date('2026-09-10T12:00:00.000Z');
const cfg = config({ coingeckoKey: 'synthetic-key' });
const response = (price = '1.000000000000000000003') => new Response(`{"prices":[[${Date.parse(at) - 60000},${price}]]}`);
beforeAll(async () => {
  const value = process.env.PLATFORM_TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(value), schema = `historical_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
});
beforeEach(async () => { counter++; await db.query('DELETE FROM platform_quote_cache'); });
afterAll(async () => { await cleanup(); });
const id = () => `fixture-coin-${counter}`;

describe('immutable historical anchor revisions', () => {
  it('persists the exact source revision before returning an available price and binds the cache to it', async () => {
    const result = await new Providers(db, cfg, async () => response(), () => initialNow).historicalAnchor(id(), at);
    expect(result.revisionId).toMatch(/^[a-f0-9]{64}$/); expect(result.status).toBe('available');
    const repository = new HistoricalAnchorRepository(db), revision = await repository.read(result.revisionId!, initialNow);
    expect(revision?.evidence.observations).toEqual(result.observations); expect(revision?.evidence.fetchedAt).toBe(result.cache.fetchedAt);
    expect(historicalAnchorRevisionId(revision!.evidence)).toBe(result.revisionId);
    expect((await db.query<{ value: unknown }>('SELECT value FROM platform_quote_cache')).rows[0]!.value).toEqual(revision);
  });
  it('preserves each changed or newly fetched evidence revision without overwriting the earlier one', async () => {
    let now = initialNow, price = '1.000000000000000000003';
    const providers = new Providers(db, cfg, async () => response(price), () => now);
    const first = await providers.historicalAnchor(id(), at); now = new Date(now.getTime() + 21601000); price = '2.000000000000000000007';
    const second = await providers.historicalAnchor(id(), at); now = new Date(now.getTime() + 21601000);
    const third = await providers.historicalAnchor(id(), at);
    expect(new Set([first.revisionId, second.revisionId, third.revisionId]).size).toBe(3);
    const repository = new HistoricalAnchorRepository(db);
    expect((await repository.read(first.revisionId!, now))?.evidence.observations[0]!.priceUsd).toBe(first.priceUsd);
    expect((await repository.read(second.revisionId!, now))?.evidence.observations[0]!.priceUsd).toBe(second.priceUsd);
    expect((await repository.read(third.revisionId!, now))?.evidence.fetchedAt).not.toBe(second.cache.fetchedAt);
    const requestKey = historicalAnchorCacheKey(historicalAnchorRequest(id(), at, 'demo', now));
    expect((await db.query('SELECT id FROM platform_historical_anchor_revisions WHERE request_key=$1', [requestKey])).rows).toHaveLength(3);
  });
  it('idempotently preserves identical evidence across concurrent repository writers', async () => {
    const request = historicalAnchorRequest(id(), at, 'demo', initialNow);
    const evidence = await fetchHistoricalAnchor(request, 'synthetic-key', 'demo', async () => response(), () => initialNow);
    const [first, second] = await Promise.all([new HistoricalAnchorRepository(db).persist(evidence, initialNow), new HistoricalAnchorRepository(db).persist(evidence, initialNow)]);
    expect(first).toEqual(second); expect((await db.query('SELECT id FROM platform_historical_anchor_revisions WHERE id=$1', [first.revisionId])).rows).toHaveLength(1);
  });
  it('rejects UPDATE, DELETE and TRUNCATE while allowing append-only reads', async () => {
    const result = await new Providers(db, cfg, async () => response(), () => initialNow).historicalAnchor(id(), at);
    await expect(db.query('UPDATE platform_historical_anchor_revisions SET evidence=evidence WHERE id=$1', [result.revisionId])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM platform_historical_anchor_revisions WHERE id=$1', [result.revisionId])).rejects.toThrow('immutable');
    await expect(db.query('TRUNCATE platform_historical_anchor_revisions')).rejects.toThrow('immutable');
    expect(await new HistoricalAnchorRepository(db).read(result.revisionId!, initialNow)).not.toBeNull();
  });
  it('keeps revisions accessible after cache cleanup and process replacement', async () => {
    const result = await new Providers(db, cfg, async () => response(), () => initialNow).historicalAnchor(id(), at);
    await db.query("UPDATE platform_quote_cache SET expires_at=now()-interval '10 days'");
    await new Store(db, cfg).cleanup(); expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toEqual([]);
    const restarted = new Providers(db, cfg, async () => { throw Error('no provider access during immutable lookup'); }, () => initialNow);
    const revision = await restarted.historicalAnchorRevision(result.revisionId!);
    expect(revision?.evidence.observations).toEqual(result.observations);
  });
  it('never publishes a volatile available observation when preservation fails', async () => {
    const broken: Database = { ...db, query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO platform_historical_anchor_revisions')) throw Error('simulated preservation outage');
      return db.query<T>(sql, values);
    } };
    const result = await new Providers(broken, cfg, async () => response(), () => initialNow).historicalAnchor(id(), at);
    expect(result).toMatchObject({ status: 'unavailable', priceUsd: null, revisionId: null, observations: [] });
    expect((await db.query('SELECT key FROM platform_quote_cache')).rows).toEqual([]);
  });
  it('retains the prior durable revision as stale when a later preservation attempt fails', async () => {
    let now = initialNow; const first = await new Providers(db, cfg, async () => response(), () => now).historicalAnchor(id(), at);
    now = new Date(now.getTime() + 21601000);
    const broken: Database = { ...db, query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO platform_historical_anchor_revisions')) throw Error('simulated preservation outage');
      return db.query<T>(sql, values);
    } };
    const result = await new Providers(broken, cfg, async () => response('999'), () => now).historicalAnchor(id(), at);
    expect(result).toMatchObject({ status: 'available', priceUsd: first.priceUsd, revisionId: first.revisionId, stale: true });
  });
  it('cannot admit a valid-looking cache without a matching durable revision', async () => {
    const request = historicalAnchorRequest(id(), at, 'demo', initialNow);
    const evidence = await fetchHistoricalAnchor(request, 'synthetic-key', 'demo', async () => response(), () => initialNow);
    await db.query('INSERT INTO platform_quote_cache(key,value,expires_at) VALUES($1,$2,$3)', [historicalAnchorCacheKey(request),
      JSON.stringify({ revisionId: historicalAnchorRevisionId(evidence), evidence }), new Date(initialNow.getTime() + 60000)]);
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    const result = await new Providers(db, cfg, fetcher, () => initialNow).historicalAnchor(id(), at);
    expect(result).toMatchObject({ status: 'unavailable', priceUsd: null, revisionId: null }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a self-consistent fabricated source URL before any archive insert', async () => {
    const request = historicalAnchorRequest(id(), at, 'demo', initialNow);
    const evidence = await fetchHistoricalAnchor(request, 'synthetic-key', 'demo', async () => response(), () => initialNow);
    evidence.request.source.requestUrl = 'https://other.example.test/prices';
    await expect(new HistoricalAnchorRepository(db).persist(evidence, initialNow)).rejects.toThrow('Invalid historical evidence');
  });
});
