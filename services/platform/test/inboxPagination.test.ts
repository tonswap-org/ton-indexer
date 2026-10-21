import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';
import { createReleaseTestServer as createServer, injectRelease, apiConfig as config } from './releaseRequests.js';
import {address, database, secondAddress, session} from './helpers.js';
import type { FastifyInstance } from 'fastify';

let db: Database, store: Store, app: FastifyInstance, current: Awaited<ReturnType<typeof session>>, other: Awaited<ReturnType<typeof session>>;
let close = async () => {};
const cfg = config(), id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
beforeAll(async () => {
  const native = process.env.PLATFORM_TEST_DATABASE_URL;
  if (native) {
    const url = new URL(native);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable owned loopback database required.');
    const admin = postgres(native), schema = `inbox_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`); db = postgres(url.toString()); await migrate(db);
    close = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); close = () => db.close(); }
  store = new Store(db, cfg); current = await session(store); other = await session(store, secondAddress); app = await createServer(cfg, db, { store, logger: false });
});
afterAll(async () => { await app?.close(); await close(); });
beforeEach(async () => { await db.query('DELETE FROM platform_notifications'); });
async function seed(value: number, timestamp: string, wallet = address, network = 'testnet') {
  await db.query(`INSERT INTO platform_notifications(id,wallet_address,network,category,title,body,href,occurred_at,source_event_id,evidence,created_at)
    VALUES($1,$2,$3,'activity','Verified fixture','Local constructed event','/wallet',$4,$5,'{}',$4)`, [id(value), wallet, network, timestamp, `source:${value}`]);
}
const headers = () => ({ cookie: `__Host-tonswap_session=${current.token}`, 'x-wallet-address': address, 'x-wallet-network': 'testnet' });
async function apiPage(limit: number, cursor?: string) {
  const response = await injectRelease(app, { url: `/v1/notifications/inbox?limit=${limit}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, headers: headers() });
  expect(response.statusCode).toBe(200); return response.json<{ notifications: { id: string; readAt: string | null; createdAt: string }[]; nextCursor: string | null }>();
}
async function allPages(limit: number) {
  let cursor: string | undefined, ids: string[] = [];
  for (let page = 0; page < 100; page++) {
    const result = await apiPage(limit, cursor); ids.push(...result.notifications.map(row => row.id));
    if (!result.nextCursor) return ids;
    expect(result.nextCursor).not.toBe(cursor); cursor = result.nextCursor;
  }
  throw Error('Inbox pagination did not finish.');
}

describe('lossless PostgreSQL inbox cursors', () => {
  it.each([1, 2, 30])('returns every microsecond-tied notification once with page size%s', async limit => {
    for (let i = 1; i <= 35; i++) await seed(i, '2026-09-13T00:00:00.123456Z');
    const first = await apiPage(limit), decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    expect(decoded.createdAt).toBe('2026-09-13T00:00:00.123456Z'); expect(first.notifications[0]!.createdAt).toBe('2026-09-13T00:00:00.123Z');
    expect(await allPages(limit)).toEqual(Array.from({ length: 35 }, (_, i) => id(35 - i)));
  });
  it('keeps both distinct microseconds and exact millisecond boundaries in SQL order', async () => {
    const timestamps = ['2026-09-13T00:00:00.122999Z', '2026-09-13T00:00:00.123000Z', '2026-09-13T00:00:00.123455Z', '2026-09-13T00:00:00.123456Z', '2026-09-13T00:00:00.123457Z'];
    for (let i = 0; i < timestamps.length; i++) await seed(i + 1, timestamps[i]!);
    expect(await allPages(2)).toEqual([5, 4, 3, 2, 1].map(id));
  });
  it('uses absolute UTC microseconds regardless of the database session display timezone', async () => {
    await seed(1, '2026-09-13T09:00:00.999999+09:00'); await seed(2, '2026-09-13T00:00:00.999999Z');
    await db.transaction(async sql => {
      await sql.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
      const scoped = new Store({ ...db, query: sql.query.bind(sql) }, cfg), first = await scoped.inbox(current, 1);
      expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()).createdAt).toBe('2026-09-13T00:00:00.999999Z');
      expect((await scoped.inbox(current, 1, first.nextCursor!)).notifications.map(row => row.id)).toEqual([id(1)]);
    });
    expect(await allPages(1)).toEqual([id(2), id(1)]);
  });
  it('keeps an older cursor valid when new notifications arrive and read state changes', async () => {
    for (let i = 1; i <= 4; i++) await seed(i, '2026-09-13T00:00:00.123456Z');
    const first = await apiPage(2); await seed(5, '2026-09-13T00:00:00.123457Z'); await store.markRead(current, id(2));
    const next = await apiPage(2, first.nextCursor!); expect(next.notifications.map(row => row.id)).toEqual([id(2), id(1)]); expect(next.notifications[0]!.readAt).not.toBeNull(); expect(next.nextCursor).toBeNull();
    expect(await allPages(2)).toEqual([5, 4, 3, 2, 1].map(id));
  });
  it('keeps wallet and network isolation on every page and leaves stored evidence untouched', async () => {
    for (let i = 1; i <= 4; i++) await seed(i, '2026-09-13T00:00:00.123456Z');
    await seed(5, '2026-09-13T00:00:00.123456Z', secondAddress); await seed(6, '2026-09-13T00:00:00.123456Z', address, 'mainnet');
    const snapshot = (await db.query('SELECT * FROM platform_notifications ORDER BY id')).rows;
    expect(await allPages(2)).toEqual([4, 3, 2, 1].map(id));
    expect((await store.inbox(other, 2)).notifications.map(row => row.id)).toEqual([id(5)]);
    expect((await store.inbox({ ...current, network: 'mainnet' }, 2)).notifications.map(row => row.id)).toEqual([id(6)]);
    expect((await db.query('SELECT * FROM platform_notifications ORDER BY id')).rows).toEqual(snapshot);
  });
  it.each([
    { createdAt: '2026-09-13T00:00:00.123Z', id: id(2) },
    { createdAt: '2026-02-30T00:00:00.123456Z', id: id(2) },
    { createdAt: '2026-09-13T00:00:00.123456+00:00', id: id(2) },
    { createdAt: '2026-09-13T00:00:00.123456Z', id: '-'.repeat(36) },
    { createdAt: '2026-09-13T00:00:00.123456Z', id: id(2), old: true },
    { createdAt: 123, id: id(2) }, null,
  ])('rejects malformed or superseded cursor format%j with a client error', async value => {
    const response = await injectRelease(app, { url: `/v1/notifications/inbox?cursor=${encodeURIComponent(encoded(value))}`, headers: headers() });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('invalid_cursor');
  });
  it('rejects noncanonical base64url rather than ignoring trailing bytes', async () => {
    const cursor = encoded({ createdAt: '2026-09-13T00:00:00.123456Z', id: id(2) }) + '!';
    const response = await injectRelease(app, { url: `/v1/notifications/inbox?cursor=${encodeURIComponent(cursor)}`, headers: headers() });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('invalid_cursor');
  });
});
