import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { config, database, session, address, secondAddress } from './helpers.js';
import type { Session } from '../src/types.js';

const firstKey = webpush.generateVAPIDKeys(), nextKey = webpush.generateVAPIDKeys();
const cfg = config({ vapidPublicKey: firstKey.publicKey, vapidPrivateKey: firstKey.privateKey, vapidSubject: 'mailto:test@example.test' });
let db: Database, store: Store, current: Session;
let cleanup = async () => {};
beforeAll(async () => {
  const nativeUrl = process.env.PLATFORM_TEST_DATABASE_URL;
  if (nativeUrl) {
    const url = new URL(nativeUrl);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Only an owned disposable loopback database is allowed.');
    const admin = postgres(nativeUrl), schema = `push_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
  store = new Store(db, cfg); current = await session(store);
});
afterAll(async () => { await cleanup(); });
beforeEach(async () => {
  vi.restoreAllMocks(); cfg.vapidPublicKey = firstKey.publicKey; cfg.vapidPrivateKey = firstKey.privateKey;
  for (const table of ['platform_jobs', 'platform_notifications', 'platform_subscriptions']) await db.query(`DELETE FROM ${table}`);
  await store.setPreferences(current, { walletProtocol: true });
});
const input = (key = firstKey.publicKey, suffix = '') => ({ applicationServerKey: key,
  endpoint: `https://fcm.googleapis.com/fcm/send/binding${suffix}`, expirationTime: null,
  keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } });
const rotate = () => { cfg.vapidPublicKey = nextKey.publicKey; cfg.vapidPrivateKey = nextKey.privateKey; };
async function delivery() {
  const saved = await store.saveSubscription(current, input());
  const noticeId = await store.emit(address, 'testnet', { category: 'walletProtocol', sourceEventId: randomUUID(), title: 'Verified event',
    body: 'Indexed event evidence', href: '/wallet?tx=1', occurredAt: new Date().toISOString(), evidence: { observed: true } });
  const job = (await store.lease('binding-worker', 100)).find(item => item.kind === 'deliver_push' && item.payload.notificationId === noticeId)!;
  const push = new PushSender(cfg), send = vi.spyOn(push, 'send').mockResolvedValue();
  const worker = new Worker(cfg, store, new Providers(db, cfg), push);
  return { saved, noticeId: noticeId!, job, send, worker };
}
const row = async (id: string) => (await db.query<{ active: boolean; retirement_reason: string | null; last_sent_at: Date | null }>(
  'SELECT active,retirement_reason,last_sent_at FROM platform_subscriptions WHERE id=$1', [id])).rows[0]!;

describe('canonical VAPID registration and delivery binding', () => {
  it('queues a requested test with neutral inbox copy and no assertion of observed delivery', async () => {
    const verified = await session(store), saved = await store.saveSubscription(verified, input());
    const app = await createServer(cfg, db, { store, logger: false });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/push/test', headers: { origin: cfg.appOrigins[0]!, cookie: `__Host-tonswap_session=${verified.token}`,
        'x-csrf-token': verified.csrfToken, 'x-wallet-address': address, 'x-wallet-network': 'testnet' }, payload: { subscriptionId: saved.id } });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ queued: true, delivery: 'pending' });
      expect((await store.inbox(verified, 20)).notifications).toEqual([expect.objectContaining({ id: response.json().notificationId,
        body: 'This is your requested notification test. Check for it outside the app.', href: '/settings/notifications', readAt: null })]);
      expect(await row(saved.id)).toMatchObject({ last_sent_at: null });
    } finally { await app.close(); }
  });
  it('rejects config-read/POST rotation without retiring a device or losing inbox/read state, then accepts explicit renewal', async () => {
    const verified = await session(store);
    const headers = { origin: cfg.appOrigins[0]!, cookie: `__Host-tonswap_session=${verified.token}`, 'x-csrf-token': verified.csrfToken,
      'x-wallet-address': address, 'x-wallet-network': 'testnet' };
    const app = await createServer(cfg, db, { store, logger: false });
    try {
      const existing = await store.saveSubscription(verified, input());
      const notice = await store.emit(address, 'testnet', { category: 'walletProtocol', sourceEventId: 'key-race', title: 'Kept', body: 'Kept', href: '/wallet', occurredAt: new Date().toISOString(), evidence: {} });
      await store.markRead(verified, notice!);
      expect((await app.inject({ url: '/v1/push/config' })).json().publicKey).toBe(firstKey.publicKey);
      rotate();
      const rejected = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers, payload: { ...input(), replacesSubscriptionId: existing.id } });
      expect(rejected.statusCode).toBe(409); expect(rejected.json().error.code).toBe('push_key_changed');
      expect(await row(existing.id)).toMatchObject({ active: true, last_sent_at: null });
      expect((await store.inbox(verified, 20)).notifications[0]).toMatchObject({ id: notice, readAt: expect.any(String) });
      const test = await app.inject({ method: 'POST', url: '/v1/push/test', headers, payload: { subscriptionId: existing.id } });
      expect(test.statusCode).toBe(409); expect(test.json().error.code).toBe('push_key_changed');
      const renewed = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers, payload: { ...input(nextKey.publicKey, '-new'), replacesSubscriptionId: existing.id } });
      expect(renewed.statusCode).toBe(200); expect(renewed.json()).toMatchObject({ active: true, applicationServerKey: nextKey.publicKey });
      expect(await row(existing.id)).toMatchObject({ active: false, retirement_reason: 'replaced' });
      const devices = (await app.inject({ url: '/v1/push/subscriptions', headers })).json().subscriptions;
      expect(devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: existing.id, applicationServerKey: firstKey.publicKey }),
        expect.objectContaining({ id: renewed.json().id, applicationServerKey: nextKey.publicKey })]));
      expect((await store.inbox(verified, 20)).notifications).toHaveLength(1);
    } finally { await app.close(); }
  });
  it.each(['missing', 'padded', 'short'] as const)('rejects %s registration keys without a compatibility path', async mode => {
    const verified = await session(store), app = await createServer(cfg, db, { store, logger: false });
    try {
      const payload: Record<string, unknown> = input();
      if (mode === 'missing') delete payload.applicationServerKey;
      else payload.applicationServerKey = mode === 'padded' ? firstKey.publicKey + '=' : 'BAAA';
      const response = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers: { origin: cfg.appOrigins[0]!, cookie: `__Host-tonswap_session=${verified.token}`,
        'x-csrf-token': verified.csrfToken, 'x-wallet-address': address, 'x-wallet-network': 'testnet' }, payload });
      expect(response.statusCode).toBe(400); expect(await store.listSubscriptions(verified)).toEqual([]);
    } finally { await app.close(); }
  });
  it('retires a proven old-key binding before any provider send and retains the authoritative read inbox', async () => {
    const d = await delivery(); await store.markRead(current, d.noticeId); rotate();
    await d.worker.deliver(d.job); expect(d.send).not.toHaveBeenCalled();
    expect(await row(d.saved.id)).toMatchObject({ active: false, retirement_reason: 'vapid_key_changed', last_sent_at: null });
    expect((await store.inbox(current, 20)).notifications[0]).toMatchObject({ id: d.noticeId, readAt: expect.any(String) });
  });
  it('delivers a renewed key and stamps only its current registration', async () => {
    rotate(); const saved = await store.saveSubscription(current, input(nextKey.publicKey));
    const id = await store.emit(address, 'testnet', { category: 'walletProtocol', sourceEventId: 'renewed', title: 'Test', body: 'Test', href: '/wallet', occurredAt: new Date().toISOString(), evidence: {} });
    const job = (await store.lease('renewed-worker', 100)).find(item => item.payload.notificationId === id)!;
    const push = new PushSender(cfg), send = vi.spyOn(push, 'send').mockResolvedValue();
    await new Worker(cfg, store, new Providers(db, cfg), push).deliver(job);
    expect(send).toHaveBeenCalledOnce(); expect(await row(saved.id)).toMatchObject({ active: true, last_sent_at: expect.anything() });
  });
  it('keeps unrelated 403 failures retryable and does not claim expiry', async () => {
    const d = await delivery(); d.send.mockRejectedValue({ statusCode: 403 });
    await expect(d.worker.deliver(d.job)).rejects.toMatchObject({ statusCode: 403 });
    expect(await row(d.saved.id)).toMatchObject({ active: true, retirement_reason: null, last_sent_at: null });
  });
  it.each(['sent', 'expired'] as const)('fences a late %s result after the same endpoint is registered again', async outcome => {
    const d = await delivery();
    d.send.mockImplementation(async () => { await store.saveSubscription(current, { ...input(), deviceName: 'Registered again' }); if (outcome === 'expired') throw { statusCode: 410 }; });
    await d.worker.deliver(d.job);
    expect(await row(d.saved.id)).toMatchObject({ active: true, retirement_reason: null, last_sent_at: null });
  });
  it('fences a late provider result after endpoint ownership changes', async () => {
    const d = await delivery(), other = await session(store, secondAddress);
    d.send.mockImplementation(async () => { await store.saveSubscription(other, input()); });
    await d.worker.deliver(d.job);
    expect(await row(d.saved.id)).toMatchObject({ active: true, last_sent_at: null });
    expect((await store.subscription(d.saved.id))?.walletAddress).toBe(secondAddress);
    expect((await store.inbox(other, 20)).notifications).toEqual([]);
  });
  it('rejects a lost lease before sending and after provider completion', async () => {
    const d = await delivery();
    await expect(d.worker.deliver({ ...d.job, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'job_lease_lost' });
    expect(d.send).not.toHaveBeenCalled();
    d.send.mockImplementation(async () => { await db.query('UPDATE platform_jobs SET lease_token=$2 WHERE id=$1', [d.job.id, randomUUID()]); });
    await expect(d.worker.deliver(d.job)).rejects.toMatchObject({ code: 'job_lease_lost' });
    expect(await row(d.saved.id)).toMatchObject({ active: true, last_sent_at: null });
  });
  it('cannot stamp success if the configured key changes during provider delivery', async () => {
    const d = await delivery(); d.send.mockImplementation(async () => { rotate(); });
    await d.worker.deliver(d.job);
    expect(await row(d.saved.id)).toMatchObject({ active: false, retirement_reason: 'vapid_key_changed', last_sent_at: null });
  });
  it('rejects delivery payload key tampering without sending or retiring the valid device', async () => {
    const d = await delivery(); await d.worker.deliver({ ...d.job, payload: { ...d.job.payload, applicationServerKey: nextKey.publicKey } });
    expect(d.send).not.toHaveBeenCalled(); expect(await row(d.saved.id)).toMatchObject({ active: true, last_sent_at: null });
  });
  it.each(['wallet', 'network'] as const)('discards a queued delivery referring to another %s inbox without sending or retrying', async scope => {
    const d = await delivery();
    const walletAddress = scope === 'wallet' ? secondAddress : address;
    const network = scope === 'network' ? 'mainnet' : 'testnet';
    const challenge = await store.createChallenge(walletAddress, network, 'app.example.test');
    const owner = await store.createSession(challenge.payload, walletAddress, network);
    await store.setPreferences(owner, { walletProtocol: true });
    const foreignId = await store.emit(walletAddress, network, { category: 'walletProtocol', sourceEventId: 'isolated-inbox-item',
      title: 'Private other inbox item', body: 'Private transaction description', href: '/wallet?tx=private-other-transaction',
      occurredAt: new Date().toISOString(), evidence: { privateTransaction: 'other-inbox-evidence' } });
    expect(foreignId).not.toBeNull();
    await store.markRead(owner, foreignId!);
    const beforeCurrent = await store.inbox(current, 20), beforeForeign = await store.inbox(owner, 20);
    // Persist the corrupt reference, then exercise real leasing, dispatch and completion.
    // Other fixture jobs are postponed, without deleting inbox or outbox records.
    await db.query("UPDATE platform_jobs SET available_at=now()+interval '1 day' WHERE id<>$1", [d.job.id]);
    await db.query(`UPDATE platform_jobs SET payload=$2::jsonb,state='ready',available_at=now(),lease_token=NULL,lease_until=NULL,attempts=0
      WHERE id=$1`, [d.job.id, JSON.stringify({ ...d.job.payload, notificationId: foreignId })]);
    expect(await d.worker.tick()).toBe(1);
    expect(d.send).not.toHaveBeenCalled();
    expect(await row(d.saved.id)).toMatchObject({ active: true, retirement_reason: null, last_sent_at: null });
    expect((await db.query('SELECT state,attempts,last_error FROM platform_jobs WHERE id=$1', [d.job.id])).rows[0])
      .toEqual({ state: 'done', attempts: 0, last_error: null });
    expect(await store.inbox(current, 20)).toEqual(beforeCurrent);
    expect(await store.inbox(owner, 20)).toEqual(beforeForeign);
  });
  it('PushSender rejects a mismatched key before constructing provider transport', async () => {
    const d = await delivery(); d.send.mockRestore(); rotate();
    await expect(new PushSender(cfg).send(input(), (await store.notification(d.noticeId, current.walletAddress, current.network))!, cfg.appOrigins[0]!)).rejects.toMatchObject({ code: 'push_key_changed' });
  });
});
