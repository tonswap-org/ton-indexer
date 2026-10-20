import { dexDefinition, dexQuote, otherToken, release } from './dexAlertFixtures.js';
import { applicationServerKey, pushConfig } from './helpers.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker, ledgerNotification, type LedgerEvent } from '../src/worker.js';
import type { AlertQuote, Job, Session } from '../src/types.js';
import { address, config, database, session } from './helpers.js';
let db: Database; let store: Store; let worker: Worker; let current: Session;
const priceConfig = pushConfig({ dexRelease: release });
let priceJob: Job; let priceClock = new Date();
beforeAll(async () => { db = await database(); store = new Store(db, priceConfig); current = await session(store);
  await store.setPreferences(current, { priceAlerts: true, activity: true, walletProtocol: true });
  worker = new Worker(priceConfig, store, new Providers(db, priceConfig), new PushSender(priceConfig), undefined, () => priceClock); });
afterAll(async () => { await db.close(); });
const quote = (hour: number, price: string): AlertQuote => dexQuote({ price }, Date.UTC(2026, 0, 1, hour));
async function applyPrice(id: string, value: AlertQuote) {
  priceClock = new Date(value.observedAt!);
  if (!priceJob) {
    const jobs = await store.lease('price-test', 100);
    priceJob = jobs.find(job => job.kind === 'price_scan')!;
    for (const job of jobs) if (job !== priceJob) await store.finish(job, 0);
  }
  const watched = (await store.watchedRules()).find(rule => rule.id === id)!;
  await worker.applyPrice(watched, value, { startedAt: priceClock.toISOString(), currency: 'T3' }, priceJob);
}
describe('verified notification workers', () => {
  it('establishes a baseline, alerts on crossing, suppresses repeats and honors cooldown/rearming', async () => {
    const rule = await store.saveRule(current, dexDefinition());
    await applyPrice(rule.id, quote(0, '107')); expect((await store.inbox(current, 100)).notifications).toHaveLength(0);
    await applyPrice(rule.id, quote(1, '103')); await applyPrice(rule.id, quote(2, '105'));
    expect((await store.inbox(current, 100)).notifications).toHaveLength(1);
    await applyPrice(rule.id, quote(3, '108')); await applyPrice(rule.id, quote(4, '104'));
    expect((await store.inbox(current, 100)).notifications).toHaveLength(1);
    await applyPrice(rule.id, quote(26, '100')); await applyPrice(rule.id, quote(27, '105'));
    expect((await store.inbox(current, 100)).notifications).toHaveLength(2);
    await applyPrice(rule.id, quote(25, '104')); // An out-of-order observation cannot change state.
    expect((await store.rules(current))[0]?.lastDirection).toBe('up');
  });
  it('supports exact decimal target crossings and rejects stale observations', async () => {
    const rule = await store.saveRule(current, dexDefinition({ asset: otherToken, targetPrice: '100.000000000000000001' }));
    const otherQuote = (hour: number, price: string, stale = false) => dexQuote({ asset: otherToken, price, stale }, Date.UTC(2026, 0, 1, hour));
    await applyPrice(rule.id, otherQuote(0, '100'));
    await applyPrice(rule.id, otherQuote(1, '100.000000001', true));
    expect((await store.rules(current)).find(item => item.id === rule.id)?.lastDirection).toBe('inside');
    await applyPrice(rule.id, otherQuote(2, '100.000000001'));
    expect((await store.rules(current)).find(item => item.id === rule.id)?.lastDirection).toBe('up');
  });
  it('never turns a successful wallet request or requested minimum into a product fill', () => {
    const event: LedgerEvent = { id: 'a', network: 'testnet', account: address, lt: '123', hash: 'abc', txId: '123:abc',
      utime: 1767225600, status: 'success', kind: 'swap', movements: [], actions: [{ kind: 'swap', minOut: '100' }], issues: ['settlement_not_decoded'] };
    expect(ledgerNotification(event)?.category).toBe('walletProtocol');
    expect(ledgerNotification({ ...event, issues: [] })?.category).toBe('walletProtocol');
    expect(ledgerNotification({ ...event, issues: [], actions: [{ kind: 'swap', amountOut: '99' }] })?.category).toBe('walletProtocol');
    expect(ledgerNotification({ ...event, status: 'pending' })).toBeNull();
    expect(ledgerNotification({ ...event, status: 'failed' })?.title).toBe('Wallet transaction failed');
  });
  it('validates indexer scope and deduplicates confirmed events across higher discovery revisions', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1),wallet_protocol_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [now - 60, address, 'testnet']);
    const since = new Date((now - 60) * 1000).toISOString();
    await store.setCheckpoint(`ledger-discovery:testnet:${address}`, { since, afterRevision: '0', cursor: null });
    const event = { id: 'verified-event', network: 'testnet', account: address, lt: '124', hash: Buffer.alloc(32, 0xaa).toString('base64'), txId: `124:${Buffer.alloc(32, 0xaa).toString('base64')}`,
      utime: now - 1, status: 'success', kind: 'transfer', movements: [], actions: [], issues: [] };
    const page = { network: 'testnet', account: address, since, throughRevision: '1', revisions: [{ revision: '1', generation: '8c95e605-a3d4-4a9e-b80d-a8d47bba33c2', discoveredAt: new Date().toISOString(), evidenceUtime: event.utime, event }], nextCursor: null,
      coverage: { historyComplete: true, decodingComplete: true, syncing: false, issues: [], generation: '8c95e605-a3d4-4a9e-b80d-a8d47bba33c2',
        publishedAt: new Date().toISOString(), headObservedAt: new Date(Date.now() - 1000).toISOString(), checkedAt: new Date().toISOString(), snapshotComplete: true } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(page)));
    const polling = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    const job = (await store.lease('poll-test', 100)).find(item => item.kind === 'poll_wallet')!;
    await polling.pollWallet(job); page.revisions[0]!.revision = page.throughRevision = '2'; await polling.pollWallet(job);
    expect(await store.checkpoint(`ledger-discovery:testnet:${address}`)).toMatchObject({ afterRevision: '2' });
    expect((await store.inbox(current, 100)).notifications.filter(item => item.sourceEventId.includes('verified-event'))).toHaveLength(1);
    page.network = 'mainnet'; await expect(polling.pollWallet(job)).rejects.toThrow('indexer_scope_mismatch');
  });
  it('retires an expired push endpoint and does not redeliver', async () => {
    const saved = await store.saveSubscription(current, { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
    const noticeId = await store.emit(address, 'testnet', { category: 'walletProtocol', sourceEventId: 'push-expired', title: 'Test', body: 'Test', href: '/wallet', occurredAt: new Date().toISOString(), evidence: {} });
    const push = new PushSender(pushConfig()); const send = vi.spyOn(push, 'send').mockRejectedValue({ statusCode: 410 });
    const delivery = new Worker(pushConfig(), store, new Providers(db, pushConfig()), push);
    const job = (await store.lease('push-expiration-test', 100)).find(item => item.kind === 'deliver_push' && item.payload.notificationId === noticeId)!;
    await delivery.deliver(job); expect((await store.subscription(saved.id))?.active).toBe(false);
    await delivery.deliver(job); expect(send).toHaveBeenCalledTimes(1);
  });
  it('pages governance beyond 64, establishes one full baseline and retries incomplete pages', async () => {
    await store.setPreferences(current, { governance: true });
    const cfg = config({ governanceContracts: { testnet: address } });
    let cycle = 0; let incomplete = false;
    const starts: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const start = new URL(String(url)).searchParams.get('start_id')!; starts.push(start);
      const next = start === '1' ? '65' : null;
      return new Response(JSON.stringify({ network: 'testnet', voting: address, start_id: start, next_start_id: next,
        coverage: { rangeKnown: true, pageComplete: !incomplete, scanComplete: !next, nextProposalId: '66' },
        proposals: Array.from({ length: next ? 64 : 1 }, (_, offset) => ({ id: String(Number(start) + offset), status: cycle && offset === 0 ? '1' : '0', maxCloseTime: '123' })) }));
    });
    const governance = new Worker(cfg, store, new Providers(db, cfg), new PushSender(cfg), fetcher);
    await store.enqueue(db, 'poll_governance', 'governance:testnet', { network: 'testnet' });
    const job = (await store.lease('governance-test', 100)).find(item => item.kind === 'poll_governance')!;
    expect(await governance.pollGovernance(job)).toBe(1);
    expect(await governance.pollGovernance(job)).toBe(120);
    expect((await store.inbox(current, 100)).notifications.filter(notice => notice.category === 'governance')).toHaveLength(0);
    cycle = 1; incomplete = true;
    await expect(governance.pollGovernance(job)).rejects.toThrow('governance_scan_incomplete');
    incomplete = false; await governance.pollGovernance(job); await governance.pollGovernance(job);
    expect(starts).toEqual(['1', '65', '1', '1', '65']);
    const notices = (await store.inbox(current, 100)).notifications.filter(notice => notice.category === 'governance');
    expect(notices).toHaveLength(2); expect(notices.some(notice => notice.href === '/earn/vote?proposal=65')).toBe(true);
  });
});
