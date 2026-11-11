import { applicationServerKey, pushConfig } from './helpers.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { Store } from '../src/store.js';
import type { PriceRuleInput } from '../src/types.js';
import { Address } from '@ton/core';
import { address, secondAddress, config, database, session } from './helpers.js';
let db: Database; let store: Store;
beforeAll(async () => { db = await database(); store = new Store(db, config()); });
afterAll(async () => { await db.close(); });
describe('PostgreSQL durable storage', () => {
  it('persists the explicit quote denomination and release with the exact canonical asset', async () => {
    const owner = await session(store, `0:${'2'.repeat(64)}`);
    await store.setPreferences(owner, { priceAlerts: true });
    const base = { currency: 'T3', quoteAssetId: secondAddress, releaseManifestHash: 'a'.repeat(64), enabled: true,
      kind: 'target', thresholdPercent: null, targetPrice: '1.000000000000000001', direction: 'above' } as const;
    const token = await store.saveRule(owner, { ...base, asset: { kind: 'ton', network: 'testnet', assetId: Address.parse(address).toString() } });
    expect(token).toMatchObject({ currency: 'T3', quoteAssetId: secondAddress, releaseManifestHash: base.releaseManifestHash,
      asset: { kind: 'ton', network: 'testnet', assetId: address }, targetPrice: base.targetPrice });
    const updated = await store.saveRule(owner, { ...base, asset: token.asset, enabled: false, targetPrice: '2' });
    expect(updated).toMatchObject({ id: token.id, enabled: false, targetPrice: '2' });
    expect(await store.rules(owner)).toHaveLength(1);
    await expect(store.saveRule(owner, { ...base, asset: { kind: 'listed', coinGeckoId: 'native' } })).rejects.toMatchObject({ code: 'dex_pair_required' });
    await expect(store.saveRule(owner, { ...base, asset: { kind: 'ton', network: 'mainnet', assetId: address } })).rejects.toMatchObject({ code: 'asset_network_mismatch' });
  });
  it('rejects missing pair identities and constrains persisted denomination', async () => {
    const owner = await session(store, `0:${'3'.repeat(64)}`);
    const base = { enabled: true, kind: 'target', thresholdPercent: null, targetPrice: '1', direction: 'above' } as const;
    await expect(store.saveRule(owner, { ...base, asset: { kind: 'ton', network: 'testnet', assetId: address } } as PriceRuleInput)).rejects.toThrow();
    const rule = await store.saveRule(owner, { ...base, currency: 'T3', quoteAssetId: secondAddress, releaseManifestHash: 'a'.repeat(64),
      asset: { kind: 'ton', network: 'testnet', assetId: address } });
    for (const statement of ["currency='USD'", "quote_asset_id='USDT'", "release_manifest_hash='other'", "asset_kind='listed'", "asset_id='EQinvalid'", "network='other'"]) {
      await expect(db.query(`UPDATE platform_price_rules SET ${statement} WHERE id=$1`, [rule.id])).rejects.toThrow();
    }
  });
  it('consumes a challenge exactly once, including concurrent attempts', async () => {
    const challenge = await store.createChallenge(address, 'testnet', 'app.example.test');
    const attempts = await Promise.allSettled([store.createSession(challenge.payload, address, 'testnet'), store.createSession(challenge.payload, address, 'testnet')]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('scopes inbox and read state to wallet and network', async () => {
    const first = await session(store); const second = await session(store, secondAddress);
    await store.setPreferences(first, { activity: true });
    const id = await store.emit(address, 'testnet', { category: 'activity', title: 'Confirmed', body: 'Confirmed on-chain.',
      href: '/wallet', occurredAt: new Date().toISOString(), sourceEventId: 'scope-event', evidence: {} });
    await store.markRead(second, id!);
    expect((await store.inbox(first, 10)).notifications[0]?.readAt).toBeNull();
    expect((await store.inbox(second, 10)).notifications).toHaveLength(0);
    expect((await store.inbox({ ...first, network: 'mainnet' }, 10)).notifications).toHaveLength(0);
    expect(await store.emit(address, 'testnet', { category: 'activity', title: 'Duplicate', body: '', href: '/wallet',
      occurredAt: new Date().toISOString(), sourceEventId: 'scope-event', evidence: {} })).toBeNull();
  });
  it('stores encrypted endpoints and retires this session device on logout', async () => {
    const current = await session(store);
    const input = { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/private-endpoint-token',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
    const saved = await store.saveSubscription(current, input);
    const row = (await db.query<{ encrypted_subscription: string; endpoint_hash: string }>('SELECT encrypted_subscription,endpoint_hash FROM platform_subscriptions WHERE id=$1', [saved.id])).rows[0]!;
    expect(row.encrypted_subscription).not.toContain('private-endpoint-token');
    expect(row.endpoint_hash).not.toContain('private-endpoint-token');
    await store.logout(current);
    expect((await store.subscription(saved.id))?.active).toBe(false);
    expect(await store.session(current.token)).toBeNull();
  });
  it('atomically replaces only this wallet and network device while keeping other devices enabled', async () => {
    const first = await session(store); const other = await session(store, secondAddress);
    const input = { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/old-browser',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
    const old = await store.saveSubscription(first, input);
    const remote = await store.saveSubscription(first, { ...input, endpoint: input.endpoint + '-remote' });
    const replacement = await store.saveSubscription(first, { ...input, endpoint: input.endpoint + '-renewed' }, old.id);
    expect((await store.subscription(old.id))?.active).toBe(false);
    expect((await store.subscription(remote.id))?.active).toBe(true);
    expect((await store.subscription(replacement.id))?.active).toBe(true);
    await store.saveSubscription(other, { ...input, endpoint: input.endpoint + '-other' }, remote.id);
    expect((await store.subscription(remote.id))?.active).toBe(true);
    await store.retireSubscription(remote.id, 'user_disabled', other);
    expect((await store.subscription(remote.id))?.active).toBe(true);
    const devices = await store.listSubscriptions(first);
    expect(devices).toContainEqual(expect.objectContaining({ id: replacement.id, endpointHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(JSON.stringify(devices)).not.toContain('https://');
  });
  it('leases exclude other workers and expired leases are recoverable with fencing', async () => {
    await db.query('DELETE FROM platform_jobs');
    await store.enqueue(db, 'deliver_push', 'unique-delivery', {});
    const [first] = await store.lease('worker-a', 1); expect(first).toBeDefined();
    expect(await store.lease('worker-b', 1)).toHaveLength(0);
    await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [first!.id]);
    const [recovered] = await store.lease('worker-b', 1); expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
    await store.finish(first!);
    const stillLeased = (await db.query<{ state: string }>('SELECT state FROM platform_jobs WHERE id=$1', [first!.id])).rows[0];
    expect(stillLeased?.state).toBe('leased');
    await store.finish(recovered!); expect(await store.lease('worker-c', 1)).toHaveLength(0);
  });
  it('retries transient failures and places terminal delivery failures in failed state', async () => {
    await store.enqueue(db, 'deliver_push', 'retry-delivery', {});
    const [job] = await store.lease('worker-a', 1);
    await store.fail(job!, 'provider_unavailable');
    let row = (await db.query<{ state: string; available_at: Date }>('SELECT state,available_at FROM platform_jobs WHERE id=$1', [job!.id])).rows[0]!;
    expect(row.state).toBe('ready'); expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now());
    await db.query("UPDATE platform_jobs SET available_at=now(),attempts=7 WHERE id=$1", [job!.id]);
    const [last] = await store.lease('worker-a', 1); await store.fail(last!, 'provider_unavailable');
    row = (await db.query<{ state: string; available_at: Date }>('SELECT state,available_at FROM platform_jobs WHERE id=$1', [job!.id])).rows[0]!;
    expect(row.state).toBe('failed');
  });
});
