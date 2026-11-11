import { randomUUID } from 'node:crypto';
import { currentSwap } from './fixtures/currentLedger.js';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Store, type NewNotification } from '../src/store.js';
import { Worker, type LedgerEvent } from '../src/worker.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import type { Session } from '../src/types.js';
import { applicationServerKey, address, secondAddress, database, pushConfig, session } from './helpers.js';

let db: Database, store: Store, current: Session;
let cleanup = async () => {};
const cfg = pushConfig(), checkpoint = `ledger-discovery:testnet:${address}`;
beforeAll(async () => {
  const value = process.env.PLATFORM_TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(value), schema = `enrollment_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
  store = new Store(db, cfg); current = await session(store);
});
afterAll(async () => { await cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  for (const table of ['platform_jobs', 'platform_notifications', 'platform_checkpoints', 'platform_subscriptions']) await db.query(`DELETE FROM ${table}`);
  await store.setPreferences(current, { activity: false, walletProtocol: false, governance: false, priceAlerts: false });
});
const seconds = () => Math.floor(Date.now() / 1000);
const at = (time: number) => new Date(time * 1000).toISOString();
async function historicalActivation(category: 'activity' | 'walletProtocol', time: number) {
  await store.setPreferences(current, { [category]: true });
  const column = category === 'activity' ? 'activity_enabled_at' : 'wallet_protocol_enabled_at';
  await db.query(`UPDATE platform_preferences SET ${column}=to_timestamp($1),updated_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3`, [time, address, 'testnet']);
}
const notice = (category: 'activity' | 'walletProtocol', time: number): NewNotification => ({ category, occurredAt: at(time), sourceEventId: randomUUID(),
  title: 'Verified event', body: 'Canonical source evidence', href: '/wallet', evidence: {} });
const inbox = async () => (await store.inbox(current, 100)).notifications;
async function lease() { return (await store.lease('enrollment-test', 100)).find(row => row.kind === 'poll_wallet')!; }
function event(time: number, kind: 'activity' | 'walletProtocol' = 'activity'): LedgerEvent {
  const hash = Buffer.alloc(32, 5).toString('base64'), id = `${kind}:${time}`, lt = String(time);
  const base: LedgerEvent = { id, network: 'testnet', account: address, lt, hash, txId: `${lt}:${hash}`, utime: time,
    status: kind === 'walletProtocol' ? 'failed' : 'success', kind: kind === 'walletProtocol' ? 'transfer' : 'swap', movements: [], actions: [], issues: [] };
  if (kind === 'activity') return currentSwap(address, time, time, id);
  return base;
}
function response(events: LedgerEvent[], since: string, afterRevision = '0') {
  const now = new Date(Date.now()).toISOString(), generation = randomUUID();
  const all = events.map((event, index) => ({ revision: String(index + 1), generation, discoveredAt: now,
    evidenceUtime: Math.max(event.utime, ...(event.settlement?.evidence ?? []).map(ref => ref.utime)), event }));
  return { network: 'testnet', account: address, since, throughRevision: String(events.length),
    revisions: all.filter(row => BigInt(row.revision) > BigInt(afterRevision)), nextCursor: null,
    coverage: { generation, publishedAt: now, headObservedAt: now, checkedAt: now,
      snapshotComplete: true, historyComplete: true, decodingComplete: true, syncing: false, issues: [] } };
}
function fetchEvents(events: LedgerEvent[], urls: URL[]) { return async (input: string | URL | Request) => {
  const url = new URL(String(input)); urls.push(url);
  expect(url.pathname).toMatch(/\/ledger\/discoveries$/);
  return new Response(JSON.stringify(response(events, url.searchParams.get('since')!, url.searchParams.get('after_revision')!)));
}; }

function worker(fetcher: typeof fetch, target = store, push = new PushSender(cfg)) { return new Worker(cfg, target, new Providers(db, cfg), push, fetcher); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('independent durable wallet-event activation epochs', () => {
  it('defaults both epochs off and records a real database activation at whole-second precision', async () => {
    expect(await store.walletMonitoring(address, 'testnet')).toEqual({ activity: null, walletProtocol: null });
    const before = seconds(); await store.setPreferences(current, { activity: true }); const m = await store.walletMonitoring(address, 'testnet');
    expect(m.walletProtocol).toBeNull(); expect(Date.parse(m.activity!) % 1000).toBe(0);
    expect(Date.parse(m.activity!) / 1000).toBeGreaterThanOrEqual(before); expect(Date.parse(m.activity!) / 1000).toBeLessThanOrEqual(seconds());
  });
  it('preserves activation across unrelated edits, repeated enables and Store replacement', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t);
    await store.setPreferences(current, { priceAlerts: true }); await store.setPreferences(current, { governance: true, activity: true });
    expect(await new Store(db, cfg).walletMonitoring(address, 'testnet')).toEqual({ activity: at(t), walletProtocol: null });
  });
  it('retains concurrent category changes without replacing either activation', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t);
    await Promise.all([store.setPreferences(current, { walletProtocol: true }), store.setPreferences(current, { priceAlerts: true }), store.setPreferences(current, { governance: true })]);
    expect(await store.preferences(address, 'testnet')).toEqual({ activity: true, walletProtocol: true, priceAlerts: true, governance: true });
    const m = await store.walletMonitoring(address, 'testnet'); expect(m.activity).toBe(at(t)); expect(m.walletProtocol).not.toBeNull();
  });
  it('rejects enabled preferences without canonical enrollment metadata in the fresh schema', async () => {
    await expect(db.query("UPDATE platform_preferences SET preferences=preferences || '{\"activity\":true}'::jsonb WHERE wallet_address=$1", [address])).rejects.toThrow();
    await expect(db.query('UPDATE platform_preferences SET activity_enabled_at=now() WHERE wallet_address=$1', [address])).rejects.toThrow();
  });
  it.each(['activity', 'walletProtocol'] as const)('rejects null, missing, string and crossed %s metadata', async category => {
    for (const value of ['null', '"true"']) await expect(db.query('UPDATE platform_preferences SET preferences=jsonb_set(preferences,ARRAY[$1],$2::jsonb) WHERE wallet_address=$3', [category, value, address])).rejects.toThrow();
    await expect(db.query('UPDATE platform_preferences SET preferences=preferences-$1::text WHERE wallet_address=$2', [category, address])).rejects.toThrow();
    const column = category === 'activity' ? 'activity_enabled_at' : 'wallet_protocol_enabled_at';
    await expect(db.query(`UPDATE platform_preferences SET ${column}=now() WHERE wallet_address=$1`, [address])).rejects.toThrow();
  });
  it('admits the activation second, rejects prior seconds, and keeps categories independent', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t); await historicalActivation('walletProtocol', t + 50);
    expect(await store.emit(address, 'testnet', notice('activity', t - 1))).toBeNull();
    expect(await store.emit(address, 'testnet', notice('activity', t))).not.toBeNull();
    expect(await store.emit(address, 'testnet', notice('walletProtocol', t + 49))).toBeNull();
    expect(await store.emit(address, 'testnet', notice('walletProtocol', t + 50))).not.toBeNull();
    expect(await store.emit(address, 'mainnet', notice('activity', t + 50))).toBeNull();
    expect(await store.emit(secondAddress, 'testnet', notice('activity', t + 50))).toBeNull();
  });
  it('the first unseeded poll survives delay and an unrelated category edit without replaying older history', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t); await store.setPreferences(current, { priceAlerts: true });
    expect(await store.checkpoint(checkpoint)).toBeNull(); const urls: URL[] = [], restart = new Store(db, cfg);
    await worker(fetchEvents([event(t - 10), event(t + 10)], urls), restart).pollWallet(await lease());
    expect(urls[0]!.searchParams.get('since')).toBe(at(t)); expect(urls[0]!.searchParams.get('after_revision')).toBe('0');
    expect((await inbox()).map(n => n.title)).toEqual(['Swap confirmed']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ since: at(t), afterRevision: '2', cursor: null });
  });
  it('does not retroactively opt a later category into an earlier category’s scan', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t); await historicalActivation('walletProtocol', t + 50);
    const urls: URL[] = []; await worker(fetchEvents([event(t + 10), event(t + 10, 'walletProtocol'), event(t + 60, 'walletProtocol')], urls)).pollWallet(await lease());
    expect((await inbox()).map(n => n.title).sort()).toEqual(['Swap confirmed', 'Wallet transaction failed']);
  });
  it('rechecks a category enabled while the indexer request is in flight', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t); const entered = deferred(), release = deferred();
    const polling = worker(async () => { entered.resolve(); await release.promise; return new Response(JSON.stringify(response([event(t + 10), event(t + 10, 'walletProtocol')], at(t)))); }).pollWallet(await lease());
    await entered.promise; await store.setPreferences(current, { walletProtocol: true }); release.resolve(); await polling;
    expect((await inbox()).map(n => n.title)).toEqual(['Swap confirmed']);
  });
  it('rechecks disablement while a poll is in flight', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t); const entered = deferred(), release = deferred();
    const polling = worker(async () => { entered.resolve(); await release.promise; return new Response(JSON.stringify(response([event(t + 10)], at(t)))); }).pollWallet(await lease());
    await entered.promise; await store.setPreferences(current, { activity: false }); release.resolve(); await polling;
    expect(await inbox()).toEqual([]); expect((await store.walletMonitoring(address, 'testnet')).activity).toBeNull();
  });
  it('a new epoch abandons an obsolete cursor and revision checkpoint without a catch-up flood', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t);
    await store.setCheckpoint(checkpoint, { since: at(t), afterRevision: '9', cursor: 'old-epoch-cursor', throughRevision: '10', generation: randomUUID(), publishedAt: at(t), headObservedAt: at(t), checkedAt: at(t) });
    await store.setPreferences(current, { activity: false }); await store.setPreferences(current, { activity: true });
    const enabled = Date.parse((await store.walletMonitoring(address, 'testnet')).activity!) / 1000, urls: URL[] = [];
    await worker(fetchEvents([event(t + 10)], urls)).pollWallet(await lease());
    expect(urls[0]!.searchParams.has('cursor')).toBe(false); expect(urls[0]!.searchParams.get('since')).toBe(at(enabled)); expect(urls[0]!.searchParams.get('after_revision')).toBe('0'); expect(await inbox()).toEqual([]);
  });
  it('does not send a queued old-epoch push after re-enabling, while preserving the authoritative inbox', async () => {
    const t = seconds() - 100; await historicalActivation('walletProtocol', t);
    await store.saveSubscription(current, { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/enrollment',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') } });
    const id = await store.emit(address, 'testnet', notice('walletProtocol', t + 10)); expect(id).not.toBeNull();
    const job = (await store.lease('delivery-enrollment', 100)).find(j => j.kind === 'deliver_push')!;
    await store.setPreferences(current, { walletProtocol: false }); await store.setPreferences(current, { walletProtocol: true });
    const push = new PushSender(cfg), send = vi.spyOn(push, 'send').mockResolvedValue(); await worker(fetchEvents([], []), store, push).deliver(job);
    expect(send).not.toHaveBeenCalled(); expect((await inbox()).map(n => n.id)).toEqual([id]);
  });
  it('rolls back preference and activation when atomic scheduling fails', async () => {
    const original = await store.walletMonitoring(address, 'testnet'); const enqueue = vi.spyOn(store, 'enqueue').mockRejectedValue(Error('scheduling failed'));
    try { await expect(store.setPreferences(current, { activity: true })).rejects.toThrow('scheduling failed'); } finally { enqueue.mockRestore(); }
    expect(await store.walletMonitoring(address, 'testnet')).toEqual(original); expect((await store.preferences(address, 'testnet')).activity).toBe(false);
  });
  it('uses the worker job-before-preference order during a concurrent edit without deadlock', async () => {
    const t = seconds() - 100; await historicalActivation('activity', t); const job = await lease(), locked = deferred(), release = deferred(), editEntered = deferred();
    const queries: string[] = [];
    const editDb: Database = { ...db, transaction: fn => db.transaction(sql => fn({ query: async <T>(text: string, values?: unknown[]) => {
      queries.push(text); editEntered.resolve(); return sql.query<T>(text, values);
    } })) };
    const held = db.transaction(async sql => { await store.assertLease(sql, job); locked.resolve(); await release.promise;
      return store.emit(address, 'testnet', notice('activity', t + 10), { sql }); });
    await locked.promise; const editing = new Store(editDb, cfg).setPreferences(current, { priceAlerts: true });
    // PGlite serializes transactions before the first query; real PG executes the blocked job-lock query.
    if (process.env.PLATFORM_TEST_DATABASE_URL) await editEntered.promise;
    release.resolve(); await Promise.all([held, editing]);
    expect(queries[0]).toContain('pg_advisory_xact_lock');
    expect(queries.findIndex(q => q.includes('FROM platform_preferences'))).toBeGreaterThan(0);
    expect(await inbox()).toHaveLength(1); expect((await store.preferences(address, 'testnet')).priceAlerts).toBe(true);
  }, 8000);
  it.skipIf(!process.env.PLATFORM_TEST_DATABASE_URL)('locks a missing recurring job identity before consent so a concurrent creator cannot invert the worker lock order', async () => {
    const held = deferred(), release = deferred();
    const editingDb: Database = { ...db, transaction: fn => db.transaction(sql => fn({ query: async <T>(text: string, values?: unknown[]) => {
      const result = await sql.query<T>(text, values);
      if (text.includes('FROM platform_preferences') && text.includes('FOR UPDATE')) { held.resolve(); await release.promise; }
      return result;
    } })) };
    const edit = new Store(editingDb, cfg).setPreferences(current, { priceAlerts: true }); await held.promise;
    expect((await db.query('SELECT id FROM platform_jobs WHERE dedupe_key=$1', ['prices'])).rows).toEqual([]);
    const competitor = store.enqueue(db, 'price_scan', 'prices', {}, true);
    try {
      // Prove the actual INSERT is waiting on the missing identity, not merely
      // that the observer happened to run before the creator reached PostgreSQL.
      await expect.poll(async () => (await db.query<{ waiting: number }>(`SELECT count(*)::int AS waiting
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event='advisory' AND query LIKE '%job_identity%'`)).rows[0]!.waiting).toBe(1);
      expect(await store.lease('missing-job-race', 100)).toEqual([]);
    } finally { release.resolve(); await Promise.all([edit, competitor]); }
    expect((await db.query('SELECT id FROM platform_jobs WHERE dedupe_key=$1', ['prices'])).rows).toHaveLength(1);
    expect((await store.preferences(address, 'testnet')).priceAlerts).toBe(true);
  }, 8000);

});
