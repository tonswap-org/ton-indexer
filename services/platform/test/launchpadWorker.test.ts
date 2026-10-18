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
import { database, pushConfig, session } from './helpers.js';
import type { Job, Session } from '../src/types.js';

const fixture = (state: 'confirmed' | 'pending') => JSON.parse(readFileSync(new URL(`./fixtures/launchpad-fixed-refund-${state}.json`, import.meta.url), 'utf8'));
const refund = (state: 'confirmed' | 'pending') => ledgerEventSchema.parse(fixture(state).events.find((event: LedgerEvent) => event.kind === 'launchpad_refund'));
const owner = refund('confirmed').account;
const checkpoint = `ledger-discovery:testnet:${owner}`;
let db: Database, store: Store, current: Session, job: Job;
let cleanup = async () => {};
let revision = 0; let since: string;
beforeAll(async () => {
  const nativeUrl = process.env.PLATFORM_TEST_DATABASE_URL;
  if (nativeUrl) {
    const url = new URL(nativeUrl);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_'))
      throw Error('Native integration requires an explicitly named disposable loopback test database.');
    const admin = postgres(nativeUrl), schema = `launchpad_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString());
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
    await migrate(db);
  } else { db = await database(); cleanup = () => db.close(); }
  store = new Store(db, pushConfig()); current = await session(store, owner);
});
afterAll(async () => { await cleanup(); });
beforeEach(async () => {
  revision = 0;
  for (const table of ['platform_jobs', 'platform_notifications', 'platform_checkpoints', 'platform_subscriptions']) await db.query(`DELETE FROM ${table}`);
  await store.setPreferences(current, { activity: true, walletProtocol: true });
  job = (await store.lease('launchpad-refund-test', 10)).find(row => row.kind === 'poll_wallet')!;
  const floor = refund('pending').utime - 1000;
  await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1),wallet_protocol_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [floor, owner, 'testnet']);
  await store.setCheckpoint(checkpoint, { since: (since = new Date(floor * 1000).toISOString()), afterRevision: '0', cursor: null });
});
const inbox = async () => (await store.inbox(current, 100)).notifications;
function page(events: LedgerEvent[]) {
  const timestamp = new Date(Date.now()).toISOString(), publication = randomUUID();
  const revisions = events.map(event => ({ revision: String(++revision), generation: publication,
    discoveredAt: timestamp, evidenceUtime: Math.max(event.utime, ...(event.settlement?.evidence ?? []).map(ref => ref.utime)), event }));
  return { network: 'testnet', account: owner, since, throughRevision: String(revision), revisions, nextCursor: null as string | null,
    coverage: { generation: publication as string | null, publishedAt: timestamp as string | null,
      headObservedAt: timestamp as string | null, checkedAt: timestamp as string | null,
      snapshotComplete: true, historyComplete: true, decodingComplete: true, syncing: false, issues: [] as string[] } };
}

type Model = 'fixed' | 'bonding' | 'auction';
const participationPage = (model: Model, variant = '') => JSON.parse(readFileSync(new URL(`./fixtures/launchpad-${model}${variant}-participation.json`, import.meta.url), 'utf8'));
const accepted = (model: Model): LedgerEvent[] => participationPage(model).events.map((row: unknown) => ledgerEventSchema.parse(row))
  .filter((row: LedgerEvent) => row.kind === 'launchpad_participation' && row.settlement?.status === 'confirmed');
async function participationContext(model: Model) {
  const events = accepted(model), owner = events[0]!.account, current = await session(store, owner);
  await db.query('DELETE FROM platform_jobs');
  await store.setPreferences(current, { activity: true, walletProtocol: true });
  const job = (await store.lease('launchpad-participation-test', 10)).find(row => row.kind === 'poll_wallet' && row.payload.walletAddress === owner)!;
  expect(job).toBeDefined();
  const checkpoint = `ledger-discovery:testnet:${owner}`, floor = events[0]!.utime - 1000;
  await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1),wallet_protocol_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [floor, owner, 'testnet']);
  await store.setCheckpoint(checkpoint, { since: (since = new Date(floor * 1000).toISOString()), afterRevision: '0', cursor: null });
  return { events, current, job, checkpoint, page: (rows: LedgerEvent[]) => ({ ...page(rows), account: owner }),
    inbox: async () => (await store.inbox(current, 100)).notifications };
}

describe('durable original contribution and bid acceptance', () => {
  it.each(['fixed', 'bonding', 'auction'] as const)('%s follows a pre-credit original through archived acceptance after restart and preserves read state', async model => {
    const context = await participationContext(model), confirmed = context.events[0]!;
    const stage = (variant: string) => ledgerEventSchema.parse(participationPage(model, variant).events.find((row: LedgerEvent) => row.id === confirmed.id));
    const early = stage('-before-credit'), pending = stage('-archive-missing');
    expect(Math.floor(Date.now() / 1000) - early.utime).toBeGreaterThan(300);
    expect(early.launchpadRequests).toEqual(confirmed.launchpadRequests);
    let response = context.page([early]); const urls: URL[] = [];
    const fetcher = async (url: string | URL | Request) => { urls.push(new URL(String(url))); return new Response(JSON.stringify(response)); };
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    await worker.pollWallet(context.job);
    expect(await context.inbox()).toEqual([]); expect(await store.checkpoint(context.checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const resumed = new Worker(pushConfig(), new Store(db, pushConfig()), new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    response = context.page([pending]); await resumed.pollWallet(context.job);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect(await context.inbox()).toEqual([]); expect(await store.checkpoint(context.checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = context.page([confirmed]); await resumed.pollWallet(context.job);
    const delivered = await context.inbox(); expect(delivered.map(n => n.title)).toEqual([model === 'auction' ? 'Bid accepted' : 'Contribution accepted']);
    expect(await store.checkpoint(context.checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    await store.markRead(context.current, delivered[0]!.id);
    response = context.page([{ ...confirmed, id: 'rebuilt-projection-id' }]); await resumed.pollWallet(context.job);
    expect((await context.inbox()).map(n => n.id)).toEqual([delivered[0]!.id]); expect((await context.inbox())[0]!.readAt).not.toBeNull();
    const other = await session(store, `0:${'e'.repeat(64)}`); expect((await store.inbox(other, 100)).notifications).toEqual([]);
  });
  it.each(['bonding', 'auction'] as const)('%s emits each actual separately funded original even when query and body repeat', async model => {
    const context = await participationContext(model);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()),
      async () => new Response(JSON.stringify(context.page(context.events))));
    await worker.pollWallet(context.job);
    const notices = await context.inbox(); expect(notices).toHaveLength(context.events.length);
    expect(new Set(notices.map(n => n.id)).size).toBe(context.events.length);
  });
  it('rolls back acceptance notice and checkpoint together, then retries exact evidence', async () => {
    const context = await participationContext('bonding'), before = await store.checkpoint(context.checkpoint);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()),
      async () => new Response(JSON.stringify(context.page([context.events[0]!]))));
    const emit = store.emit.bind(store), failure = vi.spyOn(store, 'emit').mockImplementation(async (...args) => { await emit(...args); throw Error('participation_insert_failed'); });
    try { await expect(worker.pollWallet(context.job)).rejects.toThrow('participation_insert_failed'); } finally { failure.mockRestore(); }
    expect(await context.inbox()).toEqual([]); expect(await store.checkpoint(context.checkpoint)).toEqual(before);
    await worker.pollWallet(context.job); expect(await context.inbox()).toHaveLength(1);
  });
  it('does not pin or announce generic unrelated Launchpad incomplete evidence', async () => {
    const context = await participationContext('bonding'), event = structuredClone(context.events[0]!);
    event.kind = 'transfer'; event.settlement = { protocol: 'launchpad', operation: 'transfer', status: 'incomplete', evidence: [] };
    event.issues = ['launchpad_identity_or_cash_settlement_unverified']; delete event.launchpadRequests;
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()),
      async () => new Response(JSON.stringify(context.page([event]))));
    await worker.pollWallet(context.job); expect(await context.inbox()).toEqual([]);
    expect(await store.checkpoint(context.checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });
});

describe('durable fixed failed-sale refund inbox', () => {
  it('keeps an early untyped CLAM archive gap after the original discovery and resumes the same original request through higher pending and confirmed revisions', async () => {
    const source = JSON.parse(readFileSync(new URL('./fixtures/launchpad-fixed-refund-claim-unresolved.json', import.meta.url), 'utf8'));
    const early = ledgerEventSchema.parse(source.events.find((row: LedgerEvent) => row.issues.includes('launchpad_claim_settlement_unverified')));
    const pending = refund('pending'), confirmed = refund('confirmed');
    expect(early.id).toBe(confirmed.id); expect(early.kind).not.toBe('launchpad_refund');
    expect(Math.floor(Date.now() / 1000) - early.utime).toBeGreaterThan(300);
    let response = page([early]); const urls: URL[] = [];
    const fetcher = async (url: string | URL | Request) => { urls.push(new URL(String(url))); return new Response(JSON.stringify(response)); };
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]); expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const resumedStore = new Store(db, pushConfig());
    const resumed = new Worker(pushConfig(), resumedStore, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    response = page([pending]); await resumed.pollWallet(job);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect(await inbox()).toEqual([]); expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([confirmed]); await resumed.pollWallet(job);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect((await inbox()).map(row => row.title)).toEqual(['Launchpad refund received']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it('retains an old pending refund through restart, then deduplicates actual cash across rebuilt generations and preserves read state', async () => {
    const pending = refund('pending'), confirmed = refund('confirmed');
    expect(Math.floor(Date.now() / 1000) - pending.utime).toBeGreaterThan(300);
    let response = page([pending]); const urls: URL[] = [];
    const fetcher = async (url: string | URL | Request) => { urls.push(new URL(String(url))); return new Response(JSON.stringify(response)); };
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    const resumedStore = new Store(db, pushConfig());
    const resumed = new Worker(pushConfig(), resumedStore, new Providers(db, pushConfig()), new PushSender(pushConfig()), fetcher);
    response = page([confirmed]); await resumed.pollWallet(job);
    expect(urls.at(-1)!.searchParams.get('after_revision')).toBe(String(revision - 1));
    const delivered = await inbox(); expect(delivered).toHaveLength(1);
    expect(delivered[0]!.title).toBe('Launchpad refund received');
    expect(delivered[0]!.category).toBe('activity');
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    await store.markRead(current, delivered[0]!.id);
    response = page([{ ...confirmed, id: 'rebuilt-fixed-refund-generation' }]);
    await resumed.pollWallet(job);
    expect((await inbox()).map(row => row.id)).toEqual([delivered[0]!.id]);
    expect((await inbox())[0]!.readAt).not.toBeNull();
  });

  it('keeps claimed/finalized business state without physical refund credit unresolved', async () => {
    const event = refund('confirmed'); event.movements = event.movements.filter(row => row.purpose !== 'launchpad_refund');
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(page([event]))));
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
  });

  it('retains the pending boundary when a later publication is incomplete and recovers on a complete snapshot', async () => {
    const pending = refund('pending'), confirmed = refund('confirmed');
    let response = page([pending]);
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await worker.pollWallet(job);
    response = page([confirmed]); response.coverage.snapshotComplete = false;
    await worker.pollWallet(job);
    expect(await inbox()).toEqual([]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision - 1), cursor: null });
    response = page([confirmed]); await worker.pollWallet(job);
    expect(await inbox()).toHaveLength(1);
  });

  it('commits the refund notice and checkpoint atomically and retries a rolled-back insertion', async () => {
    const original = await store.checkpoint(checkpoint), confirmed = refund('confirmed');
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(page([confirmed]))));
    const emit = store.emit.bind(store);
    const failure = vi.spyOn(store, 'emit').mockImplementation(async (...args) => { await emit(...args); throw Error('simulated_launchpad_insert_failure'); });
    try { await expect(worker.pollWallet(job)).rejects.toThrow('simulated_launchpad_insert_failure'); } finally { failure.mockRestore(); }
    expect(await inbox()).toEqual([]); expect(await store.checkpoint(checkpoint)).toEqual(original);
    await worker.pollWallet(job); expect(await inbox()).toHaveLength(1);
  });

  it('rejects another owner page before publishing private activity', async () => {
    const response = page([refund('confirmed')]); response.account = `0:${'f'.repeat(64)}`;
    const worker = new Worker(pushConfig(), store, new Providers(db, pushConfig()), new PushSender(pushConfig()), async () => new Response(JSON.stringify(response)));
    await expect(worker.pollWallet(job)).rejects.toThrow('indexer_scope_mismatch');
    expect(await inbox()).toEqual([]);
  });
});
