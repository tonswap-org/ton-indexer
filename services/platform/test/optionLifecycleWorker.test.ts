import { applicationServerKey, pushConfig } from './helpers.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { config, database, session } from './helpers.js';
import type { Job, Session } from '../src/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/option-exercise.json', import.meta.url), 'utf8'));
const owner = fixture.scope.owner;
let db: Database, store: Store, current: Session, job: Job;
let cleanup = async () => {};
let revision = 0; let since: string; let fixtureTime: number;
const checkpoint = `ledger-discovery:testnet:${owner}`;
beforeAll(async () => {
  const nativeUrl = process.env.PLATFORM_TEST_DATABASE_URL;
  if (nativeUrl) {
    const url = new URL(nativeUrl);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Native integration requires an explicitly named disposable loopback test database.');
    const admin = postgres(nativeUrl), schema = `options_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString());
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
    await migrate(db);
  } else { db = await database(); cleanup = () => db.close(); }
  store = new Store(db, pushConfig()); current = await session(store, owner);
});
afterAll(async () => { await cleanup(); });
beforeEach(async () => {
  revision = 0; fixtureTime = Math.floor(Date.now() / 1000) - 600;
  for (const table of ['platform_jobs', 'platform_notifications', 'platform_checkpoints', 'platform_subscriptions']) await db.query(`DELETE FROM ${table}`);
  await store.setPreferences(current, { activity: true, walletProtocol: true });
  job = (await store.lease('option-lifecycle-test', 10)).find(j => j.kind === 'poll_wallet')!;
  const floor = Math.floor(Date.now() / 1000) - 1000;
  await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1),wallet_protocol_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [floor, owner, 'testnet']);
  await store.setCheckpoint(checkpoint, { since: (since = new Date(floor * 1000).toISOString()), afterRevision: '0', cursor: null });
});
// Translate the synthetic trace's full evidence timeline together. A stage's
// physical timestamp, not the request timestamp alone, controls enrollment.
function retime(event: LedgerEvent): LedgerEvent {
  const offset = fixtureTime - event.utime;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'utime' && typeof item === 'number') (value as Record<string, unknown>)[key] = item + offset;
      else visit(item);
    }
  };
  visit(event); return event;
}
function exercise(): LedgerEvent {
  const e = ledgerEventSchema.parse(fixture.events.find((e: any) => e.kind === 'option_exercise'));
  return retime(e);
}
type OrphanStatus = 'failed' | 'unobserved';
type AbortFixture = 'factory' | 'partial' | 'split' | 'committed-interleaved' | `orphan-${OrphanStatus}-${'factory' | 'vault' | 'split' | 'pending' | 'interleaved'}`;
const abortBranches = [
  { name: 'committed', partial: 'partial', complete: 'split' },
  { name: 'failed', partial: 'orphan-failed-factory', complete: 'orphan-failed-split' },
  { name: 'unobserved', partial: 'orphan-unobserved-factory', complete: 'orphan-unobserved-split' },
] as const;
function aborted(name: AbortFixture = 'split'): LedgerEvent {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/option-abort-${name}.json`, import.meta.url), 'utf8'));
  const e = ledgerEventSchema.parse(f.events.find((event: any) => event.kind === 'option_refund'));
  return retime(e);
}
function page(events: LedgerEvent[], account = owner) {
  const timestamp = new Date(Date.now()).toISOString(), publication = randomUUID();
  const revisions = events.map(event => ({ revision: String(++revision), generation: publication,
    discoveredAt: timestamp, evidenceUtime: Math.max(event.utime, ...(event.settlement?.evidence ?? []).map(ref => ref.utime)), event }));
  return { network: 'testnet', account, since, throughRevision: String(revision), revisions, nextCursor: null as string | null,
    coverage: { generation: publication as string | null, publishedAt: timestamp as string | null,
      headObservedAt: timestamp as string | null, checkedAt: timestamp as string | null,
      snapshotComplete: true, historyComplete: true, decodingComplete: true, syncing: false, issues: [] as string[] } };
}
const inbox = async () => (await store.inbox(current, 100)).notifications;
function initialBuyBounce(product: 'shout' | 'outperformance', status: 'pending' | 'complete'): LedgerEvent {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/option-buy-bounce-${product}-${status}.json`, import.meta.url), 'utf8'));
  const event = ledgerEventSchema.parse(fixture.events.find((row: any) => row.kind === 'option_refund'));
  return retime(event);
}
describe('durable automatic initial-buy bounce refunds', () => {
  it.each(['shout', 'outperformance'] as const)('retains %s pending recovery and preserves delivered inbox read state across rebuilt generations', async product => {
    const pending = initialBuyBounce(product, 'pending'), complete = initialBuyBounce(product, 'complete');
    complete.utime = pending.utime;
    let response = page([pending]); const urls: URL[] = [];
    const fetcher = async (url: string | URL | Request) => { urls.push(new URL(String(url))); return new Response(JSON.stringify(response)); };
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const resumedStore = new Store(db, pushConfig());
    const resumed = new Worker(pushConfig(), resumedStore, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    response = page([complete]); await resumed.pollWallet(job);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    const delivered = await inbox();
    expect(delivered.map(notice => notice.title).sort()).toEqual(['Option factory refund received', 'Option purchase refund complete']);
    expect(delivered.every(notice => notice.body.includes('failed option purchase') && !notice.body.includes('owner-requested'))).toBe(true);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const receipt = delivered.find(notice => notice.title === 'Option factory refund received')!;
    await store.markRead(current, receipt.id);
    response = page([{ ...complete, id: 'rebuilt-initial-buy-bounce' }]);
    await resumed.pollWallet(job);
    expect((await inbox()).map(notice => notice.id).sort()).toEqual(delivered.map(notice => notice.id).sort());
    expect((await inbox()).find(notice => notice.id === receipt.id)?.readAt).not.toBeNull();
  });

  it.each(['shout', 'outperformance'] as const)('keeps %s incomplete cash finalization unresolved before accepting actual factory credit', async product => {
    const complete = initialBuyBounce(product, 'complete'), incomplete = structuredClone(complete);
    const cash = incomplete.settlement!.optionLifecycle!.refund!.unwind!.factoryReturn;
    cash.evidence = cash.evidence.slice(0, -1);
    let response = page([incomplete]);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([complete]); await worker.pollWallet(job);
    expect((await inbox()).map(notice => notice.title).sort()).toEqual(['Option factory refund received', 'Option purchase refund complete']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });
});
describe('durable option lifecycle delivery', () => {
  it('delivers third-party cash only to its recipient and retires both completed discovery revisions', async () => {
    const f = JSON.parse(readFileSync(new URL('./fixtures/option-third-party-exercise.json', import.meta.url), 'utf8'));
    const recipient = await session(store, f.scope.recipient);
    await store.setPreferences(recipient, { activity: true, walletProtocol: true });
    const recipientJob = (await store.lease('option-recipient-test', 10)).find(j => j.payload.walletAddress === recipient.walletAddress)!;
    // Both synthetic wallets enroll at the same explicit fixture epoch.
    const recipientCheckpoint = `ledger-discovery:testnet:${recipient.walletAddress}`, floor = Date.parse(since) / 1000;
    await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1),wallet_protocol_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [floor, recipient.walletAddress, 'testnet']);
    await store.setCheckpoint(recipientCheckpoint, { since, afterRevision: '0', cursor: null });
    const holderEvent = ledgerEventSchema.parse(f.ownerEvents[0]), recipientEvent = ledgerEventSchema.parse(f.recipientEvents[0]);
    retime(holderEvent); retime(recipientEvent);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async url => {
      const isHolder = decodeURIComponent(new URL(String(url)).pathname).includes(owner);
      return new Response(JSON.stringify(page([isHolder ? holderEvent : recipientEvent], isHolder ? owner : recipient.walletAddress)));
    });
    await worker.pollWallet(job); await worker.pollWallet(recipientJob);
    expect((await inbox()).map(n => n.title)).toEqual(['Option exercise confirmed']);
    expect((await store.inbox(recipient, 100)).notifications.map(n => n.title)).toEqual(['Option payout confirmed']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '1', cursor: null });
    expect(await store.checkpoint(recipientCheckpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });
  it('finds delayed cash after the original discovery and deduplicates right and cash across rebuilt generations', async () => {
    const original = exercise(), pending = structuredClone(original);
    pending.settlement!.optionLifecycle!.payout.status = 'pending'; pending.movements = pending.movements.filter(m => m.purpose !== 'option_payout');
    let response = page([pending]); const urls: URL[] = [];
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), vi.fn(async url => {
      urls.push(new URL(String(url))); return new Response(JSON.stringify(response));
    }));
    await worker.pollWallet(job);
    expect((await inbox()).map(n => n.title)).toEqual(['Option exercise confirmed']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([{ ...original, id: 'later-projection' }]); await worker.pollWallet(job);
    expect(urls[1]!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect((await inbox()).map(n => n.title).sort()).toEqual(['Option exercise confirmed', 'Option payout confirmed']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([{ ...original, id: 'rebuilt-again', utime: Math.floor(Date.now() / 1000) - 1 }]); await worker.pollWallet(job);
    expect(await inbox()).toHaveLength(2);
  });
  it('retains the previous consumed revision through incomplete generations and emits no generic lifecycle success', async () => {
    const original = exercise(); original.settlement!.status = 'incomplete';
    let response = page([original]);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await worker.pollWallet(job); expect(await inbox()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([exercise()]); response.coverage.snapshotComplete = false;
    await worker.pollWallet(job); expect(await inbox()).toHaveLength(0);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '1', cursor: null });
  });
  it('keeps both durable inbox stages when push transport fails', async () => {
    await store.saveSubscription(current, { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/option-lifecycle-test',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
    const push = new PushSender(pushConfig()); vi.spyOn(push, 'send').mockRejectedValue({ statusCode: 503 });
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), push, async () => new Response(JSON.stringify(page([exercise()]))));
    await worker.pollWallet(job); expect(await inbox()).toHaveLength(2);
    await worker.tick(); expect(await inbox()).toHaveLength(2);
    expect((await db.query<{ state: string }>("SELECT state FROM platform_jobs WHERE kind='deliver_push'")).rows).toEqual([{ state: 'ready' }, { state: 'ready' }]);
  });
});

describe('durable owner-requested option abort returns', () => {
  it.each(['committed-interleaved', 'orphan-failed-interleaved', 'orphan-unobserved-interleaved'] as const)('publishes exact cash after unrelated vault activity for %s', async name => {
    const e = aborted(name), u = e.settlement!.optionLifecycle!.refund!.unwind!;
    if (u.commit?.stateEvidence) expect(u.commit.stateEvidence.stateAfterHash).not.toBe(u.vaultAbort!.stateEvidence.stateBeforeHash);
    expect(u.vaultReturn.beforeJournal?.accountingApplied).toBe(0);
    expect(u.vaultReturn.afterJournal?.accountingApplied).toBe(1);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(page([e]))));
    await worker.pollWallet(job);
    expect((await inbox()).map(n => n.title).sort()).toEqual(['Option factory refund received', 'Option purchase refund complete', 'Option vault refund received']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    await worker.pollWallet(job);
    expect(await inbox()).toHaveLength(3);
  });

  it.each(['failed', 'unobserved'] as const)('waits for %s orphan cash and rejects a false accounting boundary before publishing any stage', async status => {
    const pending = aborted(`orphan-${status}-pending`), complete = aborted(`orphan-${status}-split`);
    complete.utime = pending.utime;
    let response = page([pending]);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const invalid = structuredClone(complete), boundary = invalid.settlement!.optionLifecycle!.refund!.unwind!.vaultAbort!;
    boundary.trackedBalanceAfterRaw = String(BigInt(boundary.trackedBalanceAfterRaw) + 1n);
    response = page([invalid]); await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([complete]); await worker.pollWallet(job);
    expect((await inbox()).map(n => n.title).sort()).toEqual(['Option factory refund received', 'Option purchase refund complete', 'Option vault refund received']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it.each(abortBranches)('preserves $name partial credit through a lost lease, restart and later complete revision without duplicating or resetting read state', async branch => {
    const pending = aborted(branch.partial), complete = aborted(branch.complete); complete.utime = pending.utime;
    let response = page([pending]); const urls: URL[] = [];
    const fetcher = async (url: string | URL | Request) => {
      urls.push(new URL(String(url))); return new Response(JSON.stringify(response));
    };
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    await worker.pollWallet(job);
    const first = (await inbox())[0]!;
    expect((await inbox()).map(n => n.title)).toEqual(['Option factory refund received']);
    expect(first.evidence.movements).toEqual(pending.movements);
    expect(pending.movements.filter(m => m.purpose === 'option_refund').map(m => m.amountRaw)).toEqual(['37']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    await store.markRead(current, first.id);

    // A replacement worker uses the persisted checkpoint and obtains a new fencing
    // token after the original lease expires. The abandoned worker cannot commit.
    await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    const resumedStore = new Store(db, pushConfig());
    const resumedJob = (await resumedStore.lease('option-abort-restarted', 10)).find(j => j.id === job.id)!;
    expect(resumedJob.leaseToken).not.toBe(job.leaseToken);
    response = page([complete]);
    await expect(worker.pollWallet(job)).rejects.toMatchObject({ code: 'job_lease_lost' });
    expect(await inbox()).toHaveLength(1);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '1', cursor: null });
    const resumed = new Worker(pushConfig(), resumedStore, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    await resumed.pollWallet(resumedJob);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    const delivered = await inbox();
    expect(delivered.map(n => n.title).sort()).toEqual([
      'Option factory refund received', 'Option purchase refund complete', 'Option vault refund received',
    ]);
    expect(delivered.find(n => n.id === first.id)?.readAt).not.toBeNull();
    expect(delivered.find(n => n.id === first.id)?.sourceEventId).toBe(first.sourceEventId);
    expect(delivered.find(n => n.title === 'Option purchase refund complete')?.body).toContain('protocol accounting remains unverified');
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });

    // Rescanning a rebuilt projection preserves the original time and physical
    // evidence; neither its new ledger ID nor generation creates another notice.
    response = page([{ ...complete, id: 'rebuilt-option-abort' }]);
    await resumed.pollWallet(resumedJob);
    expect((await inbox()).map(n => n.id).sort()).toEqual(delivered.map(n => n.id).sort());
    expect((await inbox()).find(n => n.id === first.id)?.readAt).not.toBeNull();
  });

  it('does not turn completed cancellation or promised aggregate cash into a delivered refund', async () => {
    const complete = aborted(), promised = structuredClone(complete);
    promised.movements = promised.movements.filter(m => m.purpose !== 'option_refund');
    let response = page([promised]);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([complete]); await worker.pollWallet(job);
    expect(await inbox()).toHaveLength(3);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it.each(['factory', 'vault'] as const)('keeps verified %s cash while the other return lacks a recipient credit', async lane => {
    const e = aborted(), l = e.settlement!.optionLifecycle!;
    const authority = lane === 'factory' ? l.factory : l.vault;
    e.movements = e.movements.filter(m => m.purpose !== 'option_refund' || m.source === authority);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(page([e]))));
    await worker.pollWallet(job);
    expect((await inbox()).map(n => n.title)).toEqual([`Option ${lane} refund received`]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it('completes a factory-only unwind without inventing a vault payout', async () => {
    const e = aborted('factory');
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(page([e]))));
    await worker.pollWallet(job);
    expect((await inbox()).map(n => n.title).sort()).toEqual(['Option factory refund received', 'Option purchase refund complete']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it('retains partial returns and their consumed discovery revision when a later snapshot is incomplete', async () => {
    const pending = aborted('partial'), complete = aborted(); complete.utime = pending.utime;
    let response = page([pending]);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await worker.pollWallet(job); const first = (await inbox())[0]!;
    response = page([complete]); response.coverage.snapshotComplete = false;
    await worker.pollWallet(job);
    expect((await inbox()).map(n => n.id)).toEqual([first.id]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision - 1), cursor: null });
    response = page([complete]); await worker.pollWallet(job);
    expect(await inbox()).toHaveLength(3);
  });

  it('persists the consumed revision across cursor pages and worker replacement', async () => {
    const pending = aborted('partial');
    let response = page([pending]); response.nextCursor = 'remaining-option-history'; response.throughRevision = '2';
    const firstCoverage = response.coverage;
    const urls: URL[] = [];
    const fetcher = async (url: string | URL | Request) => { urls.push(new URL(String(url))); return new Response(JSON.stringify(response)); };
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    expect(await worker.pollWallet(job)).toBe(1);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '1', throughRevision: '2', cursor: 'remaining-option-history' });
    await store.finish(job, 0);
    const resumedStore = new Store(db, pushConfig());
    const resumedJob = (await resumedStore.lease('option-abort-page-resumed', 10)).find(j => j.id === job.id)!;
    const resumed = new Worker(pushConfig(), resumedStore, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    response = { ...page([{ ...pending, id: 'unrelated-pending-request', kind: 'transfer', status: 'pending', settlement: undefined, movements: [], issues: [] }]), coverage: firstCoverage };
    response.revisions[0]!.generation = firstCoverage.generation!;
    response.revisions[0]!.discoveredAt = firstCoverage.publishedAt!;
    await resumed.pollWallet(resumedJob);
    expect(urls.at(-1)!.searchParams.get('cursor')).toBe('remaining-option-history');
    expect(await resumedStore.checkpoint(checkpoint)).toMatchObject({ afterRevision: '2', cursor: null });
    const complete = aborted(); complete.utime = pending.utime;
    response = page([complete]); await resumed.pollWallet(resumedJob);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect(await inbox()).toHaveLength(3);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it.each(abortBranches)('rolls back every $name refund notice and its checkpoint when one insertion fails, then retries atomically', async branch => {
    const originalCheckpoint = await store.checkpoint(checkpoint);
    const e = aborted(branch.complete);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(page([e]))));
    const emit = store.emit.bind(store);
    const failure = vi.spyOn(store, 'emit').mockImplementation(async (wallet, network, notice, options) => {
      if (notice.title === 'Option vault refund received') throw Error('simulated_database_failure');
      return emit(wallet, network, notice, options);
    });
    try { await expect(worker.pollWallet(job)).rejects.toThrow('simulated_database_failure'); }
    finally { failure.mockRestore(); }
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toEqual(originalCheckpoint);
    await worker.pollWallet(job);
    expect(await inbox()).toHaveLength(3);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it.each(abortBranches.flatMap(branch => [503, 410].map(statusCode => ({ ...branch, statusCode }))))('retains each $name refund stage when background delivery fails with $statusCode', async ({ complete, statusCode }) => {
    const subscription = await store.saveSubscription(current, { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/option-abort-test',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
    const push = new PushSender(pushConfig()); vi.spyOn(push, 'send').mockRejectedValue({ statusCode });
    const e = aborted(complete);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), push, async () => new Response(JSON.stringify(page([e]))));
    await worker.pollWallet(job); const delivered = await inbox();
    expect(delivered).toHaveLength(3);
    await worker.tick();
    expect((await inbox()).map(n => n.id).sort()).toEqual(delivered.map(n => n.id).sort());
    const jobs = (await db.query<{ state: string }>("SELECT state FROM platform_jobs WHERE kind='deliver_push'")).rows;
    expect(jobs).toHaveLength(3);
    expect(jobs.every(j => j.state === (statusCode === 503 ? 'ready' : 'done'))).toBe(true);
    expect((await db.query<{ active: boolean }>('SELECT active FROM platform_subscriptions WHERE id=$1', [subscription.id])).rows[0]!.active).toBe(statusCode !== 410);
  });
});
