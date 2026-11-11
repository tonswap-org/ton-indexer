import { applicationServerKey, pushConfig } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import type { Job, Session } from '../src/types.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker, ledgerNotification, type LedgerEvent } from '../src/worker.js';
import { address, secondAddress, config, database, session } from './helpers.js';
import { perpsEvent } from './fixtures/perps.js';
import { currentSwap, currentOption } from './fixtures/currentLedger.js';

let db: Database; let store: Store; let current: Session; let job: Job; let floor: number;
let revision = 0; let since: string;
const checkpoint = `ledger-discovery:testnet:${address}`;
const pool = secondAddress;
const generation = '24f5b15f-f63f-444e-9652-bc72652ecc6b';
const hash = Buffer.alloc(32, 0xaa).toString('base64');
beforeAll(async () => { db = await database(); store = new Store(db, pushConfig()); current = await session(store); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  revision = 0;
  await db.query('DELETE FROM platform_jobs'); await db.query('DELETE FROM platform_notifications');
  await db.query('DELETE FROM platform_checkpoints'); await db.query('DELETE FROM platform_subscriptions');
  await store.setPreferences(current, { activity: true, walletProtocol: true });
  job = (await store.lease('ledger-test', 10)).find(item => item.kind === 'poll_wallet')!;
  floor = Math.floor(Date.now() / 1000) - 120;
  await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1),wallet_protocol_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [floor, address, 'testnet']);
  await store.setCheckpoint(checkpoint, { since: (since = new Date(floor * 1000).toISOString()), afterRevision: '0', cursor: null });
});
afterEach(() => { vi.restoreAllMocks(); });

function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const utime = Math.floor(Date.now() / 1000) - 10;
  return { ...currentSwap(address, utime, utime), ...overrides };
}
function optionEvent(): LedgerEvent { return currentOption(address, Math.floor(Date.now() / 1000) - 10); }
function page(events: LedgerEvent[] = [event()]) {
  const timestamp = new Date(Date.now()).toISOString(), publication = generation;
  const revisions = events.map(event => ({ revision: String(++revision), generation: publication,
    discoveredAt: timestamp, evidenceUtime: Math.max(event.utime, ...(event.settlement?.evidence ?? []).map(ref => ref.utime)), event }));
  return { network: 'testnet', account: address, since, throughRevision: String(revision), revisions, nextCursor: null as string | null,
    coverage: { generation: publication as string | null, publishedAt: timestamp as string | null,
      headObservedAt: timestamp as string | null, checkedAt: timestamp as string | null,
      snapshotComplete: true, historyComplete: true, decodingComplete: true, syncing: false, issues: [] as string[] } };
}
function polling(fetcher: typeof fetch, push = new PushSender(pushConfig())) {
  return new Worker(pushConfig(), store, new Providers(db, pushConfig()), push, fetcher);
}
async function notices() { return (await store.inbox(current, 100)).notifications; }

describe('durable authoritative settlement polling', () => {
  it('waits for complete current Perps settlement and deduplicates its immutable request', async () => {
    const complete = perpsEvent(address, Math.floor(Date.now() / 1000) - 10), pending = structuredClone(complete);
    pending.settlement!.status = 'incomplete'; pending.settlement!.currentPerps!.outcome = 'unresolved';
    let response = page([pending]);
    const worker = polling(vi.fn(async () => new Response(JSON.stringify(response))));
    await worker.pollWallet(job); expect(await notices()).toHaveLength(0);
    response = page([complete]); await worker.pollWallet(job);
    response = page([{ ...complete, id: 'rebuilt-current-perps' }]); await worker.pollWallet(job);
    expect((await notices()).filter(n => n.category === 'activity')).toMatchObject([{ title: 'Position opening confirmed' }]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it('records SCCP TON-local stages without claiming destination receipt or a completed bridge transfer', async () => {
    for (const burning of [true, false]) {
      const operation = burning ? 'bridge_burn' : 'bridge_mint';
      const bridge = event({ kind: operation, issues: ['bridge_counterparty_unverified'], settlement: {
        protocol: 'sccp', operation, status: 'confirmed', evidence: [{ account: pool, lt: '40', hash, utime: Math.floor(Date.now() / 1000) - 10 }],
        bridge: { messageId: burning ? 'message-burn' : 'message-mint', nonce: '1', amountRaw: '100', sourceDomain: 1, destinationDomain: 2,
          soraAssetId: 'sora:asset', recipient32: 'a'.repeat(64), tonMaster: pool, tonWallet: pool, tonOwner: address,
          masterCodeHash: hash, localStage: burning ? 'burned' : 'minted', counterpartyStatus: 'unverified', localNetworkFees: [] },
      }, movements: [{ direction: burning ? 'out' : 'in', amountRaw: '100', asset: { kind: 'jetton', id: `testnet:jetton:${pool}`, master: pool },
        evidence: { kind: burning ? 'sccp_burn_record' : 'sccp_mint', ...(burning ? { getter: { account: pool, method: 'get_sccp_burn_record', args: ['1'], result: ['record-boc'], observedAt: new Date().toISOString() } } : {}) } }] });
      const notice = ledgerNotification(bridge);
      expect(notice?.category).toBe('walletProtocol'); expect(notice?.body).toContain('remains unverified');
      await polling(vi.fn(async () => new Response(JSON.stringify(page([bridge]))))).pollWallet(job);
    }
    const recorded = await notices(); expect(recorded).toHaveLength(2); expect(recorded.every(notice => notice.category === 'walletProtocol')).toBe(true);
    expect(recorded[0]?.evidence.settlement).toMatchObject({ bridge: { counterpartyStatus: 'unverified' } });
  });

  it('keeps an option funding request pending, then emits its activated position once across projection generations', async () => {
    const option = optionEvent(); const pending = structuredClone(option); pending.settlement!.status = 'incomplete'; pending.movements.pop();
    let response = page([pending]);
    const worker = polling(vi.fn(async () => new Response(JSON.stringify(response))));
    await worker.pollWallet(job);
    expect((await notices()).filter(notice => notice.category === 'activity')).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([option]); await worker.pollWallet(job);
    response = page([{ ...option, id: 'merged-option-event' }]); response.coverage.generation = randomUUID(); await worker.pollWallet(job);
    const activity = (await notices()).filter(notice => notice.category === 'activity');
    expect(activity).toHaveLength(1); expect(activity[0]).toMatchObject({ title: 'Option purchase confirmed' });
    expect(activity[0]?.evidence.settlement).toMatchObject({ seriesId: '7', positionId: '3', currentOptions: { rightAcquiredRaw: '10000' } });
  });

  it('refuses current DLMM completion without its cash records', () => {
    const swap = event(); expect(ledgerNotification(swap)?.title).toBe('Swap confirmed');
    expect(ledgerNotification(event({ movements: [swap.movements[0]!] }))).toBeNull();
    expect(ledgerNotification(event({ settlement: { ...swap.settlement!, status: 'incomplete' } }))).toBeNull();
    expect(ledgerNotification(event({ status: 'pending' }))).toBeNull();
    expect(ledgerNotification(event({ status: 'failed' }))?.title).toBe('Wallet transaction failed');
  });

  it('rejects unpublished and stale generations, then pins complete pages and resets a changed generation', async () => {
    let response = page(); response.coverage.snapshotComplete = false;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
    const worker = polling(fetcher);
    await worker.pollWallet(job); expect(await notices()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ since, afterRevision: '0', cursor: null });
    response = page(); response.coverage.checkedAt = response.coverage.headObservedAt = new Date(Date.now() - 600_000).toISOString();
    await worker.pollWallet(job); expect(await notices()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ since, afterRevision: '0', cursor: null });
    response = page(); response.nextCursor = 'generation-one-page-two'; response.throughRevision = '4';
    await worker.pollWallet(job); expect(await notices()).toHaveLength(1);
    const pinned = await store.checkpoint(checkpoint);
    expect(pinned).toMatchObject({ generation, cursor: 'generation-one-page-two', afterRevision: '3', throughRevision: '4' });
    response = page([event({ id: 'another-event', settlement: { ...event().settlement!, evidence: [
      { account: pool, lt: '126', hash, utime: Math.floor(Date.now() / 1000) - 1 }, ...event().settlement!.evidence.slice(1),
    ] } })]); response.coverage.generation = randomUUID();
    await worker.pollWallet(job); expect(await notices()).toHaveLength(1);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ cursor: null, afterRevision: '3' });
  });

  it('uses a fresh dependency check for a quiet immutable generation and advances only to the advertised discovery revision', async () => {
    const response = page([]); response.throughRevision = '7';
    response.coverage.publishedAt = response.coverage.headObservedAt = new Date(Date.now() - 86_400_000).toISOString();
    const checked = new Date(Date.now() - 20_000).toISOString(); response.coverage.checkedAt = checked;
    const worker = polling(vi.fn(async () => new Response(JSON.stringify(response))));
    await worker.pollWallet(job);
    expect(await notices()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '7', checkedAt: checked });
  });

  it('accepts a dependency check before the owner head observation and preserves its timestamp separately from revision progress', async () => {
    const response = page();
    response.coverage.headObservedAt = new Date(Date.now() - 1000).toISOString();
    const checked = new Date(Date.now() - 30_000).toISOString(); response.coverage.checkedAt = checked;
    await polling(vi.fn(async () => new Response(JSON.stringify(response)))).pollWallet(job);
    expect(await notices()).toHaveLength(1);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '1', checkedAt: checked });
  });

  it('revisits pending settlement after the original discovery and deduplicates a later merged projection', async () => {
    const pending = event({ settlement: { ...event().settlement!, status: 'incomplete' }, issues: ['swap_settlement_unconfirmed'] });
    let response = page([pending]);
    const urls: URL[] = [];
    const worker = polling(vi.fn(async input => { urls.push(new URL(String(input))); return new Response(JSON.stringify(response)); }));
    await worker.pollWallet(job);
    expect(await notices()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const later = Date.now() + 600_000; vi.spyOn(Date, 'now').mockReturnValue(later);
    job = (await store.lease('later-poll-worker', 10)).find(item => item.id === job.id)!;
    const settled = event({ id: pending.id, utime: pending.utime }); response = page([settled]);
    await worker.pollWallet(job);
    expect(urls[1]!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect((await notices()).filter(notice => notice.category === 'activity')).toHaveLength(1);
    response = page([event({ ...settled, id: 'merged-owner-projection', utime: Math.floor(later / 1000) - 1 })]);
    await worker.pollWallet(job);
    expect((await notices()).filter(notice => notice.category === 'activity')).toHaveLength(1);
  });

  it('fences a worker whose lease expired while the indexer request was outstanding', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const work = polling(fetcher).pollWallet(job);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    const recovered = (await store.lease('recovery-worker', 10)).find(item => item.id === job.id)!;
    expect(recovered.leaseToken).not.toBe(job.leaseToken);
    resolve(new Response(JSON.stringify(page())));
    await expect(work).rejects.toThrow('no longer owned');
    expect(await notices()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ since, afterRevision: '0', cursor: null });
  });

  it('restarts an expired cursor with the same consumed revision instead of skipping its remaining events', async () => {
    const response = page(); response.nextCursor = 'expired-cursor'; response.throughRevision = '2';
    let expired = false;
    const worker = polling(vi.fn(async () => expired ? new Response('{}', { status: 400 }) : new Response(JSON.stringify(response))));
    await worker.pollWallet(job); expired = true;
    await expect(worker.pollWallet(job)).rejects.toThrow('HTTP 400');
    expect(await store.checkpoint(checkpoint)).toMatchObject({ since, cursor: null, afterRevision: '1' });
  });

  it('retains the confirmed inbox item through transient and terminal push delivery failures', async () => {
    await store.saveSubscription(current, { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/settlement-test',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
    const push = new PushSender(pushConfig()); vi.spyOn(push, 'send').mockRejectedValue({ statusCode: 503 });
    const worker = polling(vi.fn(async () => new Response(JSON.stringify(page()))), push);
    await worker.pollWallet(job);
    const [notice] = await notices();
    expect(notice).toMatchObject({ category: 'activity', href: `/wallet?tx=${encodeURIComponent(event().txId)}`, readAt: null });
    expect(notice?.evidence.movements).toMatchObject([{ amountRaw: '100000000000000001' }, { amountRaw: '95000000000000007' }]);
    await worker.tick();
    expect((await db.query<{ state: string }>("SELECT state FROM platform_jobs WHERE kind='deliver_push'")).rows[0]?.state).toBe('ready');
    await db.query("UPDATE platform_jobs SET attempts=7,available_at=now() WHERE kind='deliver_push'");
    await worker.tick();
    expect((await db.query<{ state: string }>("SELECT state FROM platform_jobs WHERE kind='deliver_push'")).rows[0]?.state).toBe('failed');
    expect((await notices())[0]).toMatchObject({ id: notice!.id, readAt: null });
  });
});
