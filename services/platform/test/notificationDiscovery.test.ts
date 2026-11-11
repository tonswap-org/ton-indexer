import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresLedgerStore, type LedgerSqlPool } from '../../../src/ledger/store';
import { registerLedgerRoutes } from '../../../src/ledger/routes';
import type { LedgerService } from '../../../src/ledger/service';
import type { LedgerEvent as IndexerEvent } from '../../../src/ledger/types';
import { Worker, ledgerNotifications, type LedgerEvent } from '../src/worker.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import type { Database } from '../src/db.js';
import { database, config, address, secondAddress, session } from './helpers.js';
import { perpsEvent } from './fixtures/perps.js';
import { currentSwap } from './fixtures/currentLedger.js';

let db: Database, store: Store, indexerDb: PGlite, ledger: PostgresLedgerStore;
const app = fastify(), cfg = config(), queries: URL[] = [];
let scope: Awaited<ReturnType<typeof session>>;
const hash = Buffer.alloc(32, 11).toString('base64');
const base = Math.floor(Date.now() / 1000) - 86_400;
function swap(id: string, requested: number, settled: number | null): LedgerEvent {
  return currentSwap(address, requested, settled, id);
}
async function publish(events: LedgerEvent[]) {
  const generation = randomUUID();
  await ledger.begin('testnet', address, generation);
  await ledger.project(generation, { events: events as unknown as IndexerEvent[], projectionScope: { kind: 'owner', owner: address, physicalAccounts: [address] } }, [], []);
  await ledger.complete('testnet', address, generation);
  return generation;
}
async function poll() {
  const job = (await store.lease('discovery-integration', 10)).find(row => row.kind === 'poll_wallet')!;
  expect(job).toBeDefined();
  const worker = new Worker(cfg, store, new Providers(db, cfg), new PushSender(cfg), async input => {
    const url = new URL(String(input)); queries.push(url);
    const response = await app.inject(url.pathname + url.search);
    return new Response(response.body, { status: response.statusCode });
  });
  await worker.pollWallet(job); await store.finish(job, 0);
}
beforeAll(async () => {
  db = await database(); store = new Store(db, cfg); scope = await session(store);
  indexerDb = new PGlite();
  const pool: LedgerSqlPool = { query: async (sql, values) => !values && sql.includes(';') ? { rows: (await indexerDb.exec(sql)).at(-1)?.rows ?? [] } : indexerDb.query(sql, values),
    connect: async () => pool, end: () => indexerDb.close() };
  ledger = new PostgresLedgerStore(pool); await ledger.initialize();
  registerLedgerRoutes(app, { discoveries: (account: string, query: any) => ledger.discoveries('testnet', account, query) } as LedgerService);
  await store.setPreferences(scope, { activity: true });
  await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3', [base, address, 'testnet']);
});
afterAll(async () => { await app.close(); await db.close(); await indexerDb.close(); });

describe('actual durable indexer to notification discovery', () => {
  it('recovers an old request settled after enrollment, without replaying an old completed activity', async () => {
    const old = swap('completed-before-enrollment', base - 200, base - 100);
    const recovered = swap('requested-before-enrollment', base - 100, base + 60);
    await publish([old, recovered]); await poll();
    const inbox = await store.inbox(scope, 100);
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.notifications[0]).toMatchObject({ title: 'Swap confirmed', occurredAt: new Date((base + 60) * 1000).toISOString() });
    expect(inbox.notifications[0]!.evidence).toMatchObject({ requestOccurredAt: new Date((base - 100) * 1000).toISOString(), discovery: { revision: '2' } });
    expect(queries[0]!.pathname).toMatch(/\/ledger\/discoveries$/);
    expect(queries[0]!.searchParams.has('from_utime')).toBe(false);
    expect(await store.checkpoint(`ledger-discovery:testnet:${address}`)).toMatchObject({ afterRevision: '2', cursor: null });
    expect((await store.inbox(await session(store, secondAddress), 100)).notifications).toEqual([]);
  });
  it('finds a later semantic revision after cursor completion even when both request and chain settlement are many hours old', async () => {
    const delayed = swap('delayed-archival-evidence', base - 500, null);
    await publish([delayed]); await poll();
    expect((await store.inbox(scope, 100)).notifications).toHaveLength(1);
    const confirmed = swap(delayed.id, delayed.utime, base + 120);
    await publish([confirmed]); await poll(); await poll();
    const inbox = await store.inbox(scope, 100);
    expect(inbox.notifications).toHaveLength(2);
    expect(inbox.notifications.find(row => row.href.includes(encodeURIComponent(confirmed.txId)))?.occurredAt).toBe(new Date((base + 120) * 1000).toISOString());
    expect(queries.at(-1)!.searchParams.get('after_revision')).toBe('4');
    expect(await store.checkpoint(`ledger-discovery:testnet:${address}`)).toMatchObject({ afterRevision: '4', cursor: null });
  });
  it('retains stable notification identities if an owner projection is re-anchored', async () => {
    const reanchored = swap('different-projection-anchor', base - 500, base + 120);
    await publish([reanchored]); await poll();
    expect((await store.inbox(scope, 100)).notifications).toHaveLength(2);
  });
});

describe('stage time comes from qualified evidence', () => {
  it('retains a future current revision until its unchanged qualified stage time arrives', async () => {
    const initial = Date.now(), future = Math.floor(initial / 1000) + 30;
    const event = swap('future-stage', Math.floor(initial / 1000), future);
    const localDb = await database(), localStore = new Store(localDb, cfg), current = await session(localStore, event.account);
    try {
      await localStore.setPreferences(current, { activity: true });
      const since = (await localStore.walletMonitoring(event.account, 'testnet')).activity!;
      const job = (await localStore.lease('future-stage', 10)).find(row => row.kind === 'poll_wallet')!;
      const generation = randomUUID(), timestamp = new Date(initial).toISOString();
      const worker = new Worker(cfg, localStore, new Providers(localDb, cfg), new PushSender(cfg), async () => new Response(JSON.stringify({
        network: 'testnet', account: event.account, since, throughRevision: '1', nextCursor: null,
        revisions: [{ revision: '1', generation, discoveredAt: timestamp, evidenceUtime: future, event }],
        coverage: { generation, publishedAt: timestamp, headObservedAt: timestamp, checkedAt: timestamp,
          snapshotComplete: true, historyComplete: true, decodingComplete: true, syncing: false, issues: [] },
      })));
      await expect(worker.pollWallet(job)).rejects.toThrow('notification_stage_time_invalid');
      expect(await localStore.checkpoint(`ledger-discovery:testnet:${event.account}`)).toBeNull();
      expect((await localStore.inbox(current, 100)).notifications).toEqual([]);
      vi.spyOn(Date, 'now').mockReturnValue(initial + 40_000);
      await worker.pollWallet(job);
      expect(await localStore.checkpoint(`ledger-discovery:testnet:${event.account}`)).toMatchObject({ afterRevision: '1' });
      expect((await localStore.inbox(current, 100)).notifications).toMatchObject([{ title: 'Swap confirmed', occurredAt: new Date(future * 1000).toISOString() }]);
    } finally { vi.restoreAllMocks(); await localDb.close(); }
  });
  it('refuses an unrelated later transaction outside the current proof set', () => {
    const event = perpsEvent(address, base - 100);
    expect(ledgerNotifications(event)[0]?.occurredAt).toBe(new Date((base - 100) * 1000).toISOString());
    event.settlement!.evidence.push({ account: address, lt: '999', hash, utime: base + 500 });
    expect(ledgerNotifications(event)).toEqual([]);
  });
  it('rejects future or contradictory chain time instead of substituting publication time', () => {
    expect(() => ledgerNotifications(swap('future', base - 10, Math.floor(Date.now() / 1000) + 60))).toThrow('notification_stage_time_invalid');
    const broken = swap('contradiction', base - 10, base + 10);
    broken.settlement!.evidence.push({ ...broken.settlement!.evidence[1]!, utime: base + 11 });
    expect(ledgerNotifications(broken)).toEqual([]);
  });
});
