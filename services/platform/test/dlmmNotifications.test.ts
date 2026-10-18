import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ledgerDiscoverySchema, ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { ledgerNotification, ledgerNotifications, Worker } from '../src/worker.js';
import { NotificationStageTimeError } from '../src/notificationEvidence.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import type { Database } from '../src/db.js';
import type { Job } from '../src/types.js';
import { database, pushConfig, session } from './helpers.js';

const bytes = readFileSync(new URL('./fixtures/dlmm-liquidity-owner.json', import.meta.url));
const source = JSON.parse(bytes.toString()) as {sourceSha256: string; owner: string; recipient: string; events: unknown[]; recipientEvents: unknown[]};
const events = () => source.events.map(row => ledgerEventSchema.parse(row));
const collections = () => events().filter(row => row.kind === 'lp_fee_collect');
const owned = () => collections().find(row => row.settlement!.dlmmLiquidity!.recipient === row.account && row.settlement!.dlmmLiquidity!.economics.totalTRaw !== '0')!;
const withdrawal = () => events().find(row => row.kind === 'lp_withdraw')!;
const payout = (event: LedgerEvent) => event.settlement!.dlmmLiquidity!.payouts[0]!;
const movement = (event: LedgerEvent) => event.movements.find(row => row.id === payout(event).movementId)!;
const different = `0:${'f'.repeat(64)}`;
afterEach(() => vi.restoreAllMocks());

describe('canonical DLMM liquidity consumer', () => {
  it('accepts every unchanged owner and recipient producer event and preserves nested delivery versus finalization evidence', () => {
    expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const raw of [...source.events, ...source.recipientEvents]) {
      const parsed = ledgerEventSchema.parse(raw);
      const original = raw as LedgerEvent;
      if (original.settlement?.dlmmLiquidity) expect(parsed.settlement!.dlmmLiquidity).toEqual(original.settlement.dlmmLiquidity);
      expect(parsed.movements.map(row => row.evidence?.dlmmReceipt)).toEqual(original.movements.map(row => row.evidence?.dlmmReceipt));
    }
    expect(events().filter(row => row.kind === 'lp_deposit').map(row => ledgerNotification(row)?.title)).toEqual(['Liquidity deposit confirmed']);
    expect(events().filter(row => row.kind === 'lp_withdraw').map(row => ledgerNotification(row)?.title)).toEqual(['Liquidity withdrawal confirmed']);
  });

  it('announces each actual positive owned collection once without a business query or monetary valuation', () => {
    const rows = collections(), before = JSON.stringify(rows), notices = rows.flatMap(ledgerNotifications);
    expect(rows).toHaveLength(4); expect(notices).toHaveLength(2);
    expect(notices.every(row => row.category === 'activity' && row.title === 'Liquidity fees received')).toBe(true);
    expect(new Set(notices.map(row => row.sourceEventId)).size).toBe(2);
    for (const e of rows) {
      expect(e.settlement!.queryId).toBeUndefined();
      const notice = ledgerNotification(e);
      if (!notice) continue;
      expect(notice.href).toBe(`/wallet?tx=${encodeURIComponent(e.txId)}`);
      expect(notice.body).toContain('LP shares are unchanged');
      expect(notice.evidence.movements).toEqual(e.movements);
      expect(notice.occurredAt).toBe(new Date(Math.max(...e.settlement!.dlmmLiquidity!.payouts.map(row => row.settlementEvidence!.poolFinalized.utime)) * 1000).toISOString());
      expect(notice.body).not.toMatch(/income|USD|price|tax/i);
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('does not call native gas refunds or a distinct recipient an owned fee receipt', () => {
    const rows = collections();
    const foreign = rows.find(row => row.settlement!.dlmmLiquidity!.recipient !== row.account)!;
    const zero = rows.find(row => row.settlement!.dlmmLiquidity!.economics.totalTRaw === '0')!;
    expect(foreign.movements.some(row => row.asset.kind === 'native')).toBe(true);
    expect(ledgerNotifications(foreign)).toEqual([]); expect(ledgerNotifications(zero)).toEqual([]);
    const outsider = owned(); outsider.account = source.recipient; expect(ledgerNotifications(outsider)).toEqual([]);
  });

  it('keeps stable physical request deduplication when presentation event IDs change', () => {
    const e = owned(), id = ledgerNotification(e)!.sourceEventId;
    e.id = 'new-projection-id'; e.txId = 'display-only';
    expect(ledgerNotification(e)!.sourceEventId).toBe(id);
  });

  it('requires finalization as a canonical field and rejects hex reference adapters or invented query identities', () => {
    const noFinalization = structuredClone(owned()) as any; delete noFinalization.settlement.dlmmLiquidity.payouts[0].finalization;
    const withQuery = structuredClone(owned()) as any; withQuery.settlement.queryId = '0';
    const hexRef = structuredClone(owned()) as any; hexRef.settlement.dlmmLiquidity.payouts[0].delivery.hash = Buffer.from(hexRef.settlement.dlmmLiquidity.payouts[0].delivery.hash, 'base64').toString('hex');
    for (const raw of [noFinalization, withQuery, hexRef]) expect(ledgerEventSchema.safeParse(raw).success).toBe(false);
  });

  const negative: [string, (e: LedgerEvent) => void][] = [
    ['incomplete settlement', e => { e.settlement!.status = 'incomplete'; }],
    ['missing canonical liquidity metadata', e => { delete e.settlement!.dlmmLiquidity; }],
    ['delivered before finalization', e => { payout(e).finalization = 'unresolved'; delete payout(e).settlementEvidence; }],
    ['partial token delivery', e => { payout(e).status = 'unresolved'; payout(e).delivery = null; }],
    ['missing delivery graph', e => { delete payout(e).deliveryEvidence; }],
    ['missing full finalization graph', e => { delete payout(e).settlementEvidence; }],
    ['other owner', e => { e.settlement!.dlmmLiquidity!.owner = different; }],
    ['other recipient', e => { e.settlement!.dlmmLiquidity!.recipient = different; }],
    ['other asset owner', e => { movement(e).asset.owner = different; }],
    ['other destination wallet', e => { movement(e).asset.wallet = different; }],
    ['wrong physical amount', e => { movement(e).amountRaw = '1'; }],
    ['duplicate physical credit', e => { e.movements.push(structuredClone(movement(e))); }],
    ['missing physical credit', e => { e.movements = e.movements.filter(row => row.id !== payout(e).movementId); }],
    ['fake principal in receipt', e => { movement(e).evidence!.dlmmReceipt!.principalRaw = '1'; }],
    ['fee component contradiction', e => { payout(e).earnedFeeRaw = '1'; }],
    ['burned LP shares', e => { e.settlement!.dlmmLiquidity!.sharesAfterRaw = '1'; }],
    ['wrong collection opcode', e => { e.settlement!.dlmmLiquidity!.request.opcode = 0x444c524d; }],
    ['same settlement for both assets', e => { e.settlement!.dlmmLiquidity!.payouts[1]!.settlementId = payout(e).settlementId; }],
    ['same token side twice', e => { e.settlement!.dlmmLiquidity!.payouts[1]!.tokenSide = 0; }],
    ['wrong request body hash', e => { payout(e).settlementEvidence!.requestBodyHash = '0'.repeat(64); }],
    ['wrong full graph amount', e => { payout(e).settlementEvidence!.amountRaw = '1'; }],
    ['forged finalizer account', e => { payout(e).settlementEvidence!.poolFinalized.account = different; }],
    ['finalizer replaces delivery', e => { payout(e).settlementEvidence!.poolFinalized = {...payout(e).settlementEvidence!.credit}; }],
    ['missing finalizer boundary', e => { payout(e).settlementEvidence!.boundaries.pop(); }],
    ['wrong code boundary', e => { payout(e).settlementEvidence!.boundaries[0]!.codeHash = '0'.repeat(64); }],
    ['contradictory delivery boundary', e => { payout(e).deliveryEvidence!.boundaries[0]!.afterDataHash = '0'.repeat(64); }],
    ['wrong movement transfer nonce', e => { movement(e).evidence!.queryId = '0'; }],
    ['unresolved source history', e => { e.issues.push('related_account_history_incomplete'); }],
  ];
  it.each(negative.flatMap(([label, change]) => (['lp_fee_collect', 'lp_withdraw'] as const).map(kind => [kind, label, change] as const)))('%s withholds misleading receipt notification for %s', (kind, _label, change) => {
    const e = kind === 'lp_withdraw' ? withdrawal() : owned(); change(e); expect(ledgerNotifications(e)).toEqual([]);
  });

  it('retains exact withdrawal principal and earned fees as components of two physical credits and one LP burn', () => {
    const e = withdrawal(), bytes = JSON.stringify(e), notice = ledgerNotification(e)!;
    expect(notice.title).toBe('Liquidity withdrawal confirmed');
    expect(e.settlement!.dlmmLiquidity!.economics).toEqual({principalTRaw: '320870', principalXRaw: '345797', earnedFeeTRaw: '74', earnedFeeXRaw: '112', totalTRaw: '320944', totalXRaw: '345909'});
    expect(e.movements.filter(row => row.evidence?.dlmmReceipt)).toHaveLength(2);
    expect(e.movements.filter(row => row.asset.kind === 'lp_position')).toHaveLength(1);
    expect(JSON.stringify(e)).toBe(bytes);
    const without = withdrawal(); without.movements = without.movements.filter(row => row.asset.kind !== 'lp_position'); expect(ledgerNotifications(without)).toEqual([]);
    const other = withdrawal(); other.movements.find(row => row.asset.kind === 'lp_position')!.asset.owner = different; expect(ledgerNotifications(other)).toEqual([]);
    const unbound = withdrawal(); unbound.movements.find(row => row.asset.kind === 'lp_position')!.evidence!.stateAfterHash = '0'.repeat(64); expect(ledgerNotifications(unbound)).toEqual([]);
    const excessive = withdrawal(); excessive.movements.find(row => row.asset.kind === 'lp_position')!.amountRaw = '666668'; expect(ledgerNotifications(excessive)).toEqual([]);
  });

  it('uses finalization time, and refuses an unbound or future finalization without swallowing the chronology error', () => {
    const changeTime = (e: LedgerEvent, timestamp: number) => {
      const full = payout(e).settlementEvidence!, target = full.poolFinalized;
      const matches = (row: {account: string; lt: string; hash: string}) => row.account === target.account && row.lt === target.lt && row.hash === target.hash;
      full.boundaries.find(row => matches(row.transaction))!.transaction.utime = timestamp;
      e.settlement!.evidence.find(matches)!.utime = timestamp; target.utime = timestamp;
    };
    const e = owned(), latest = Math.floor(Date.now() / 1000) - 1; changeTime(e, latest);
    expect(ledgerNotification(e)!.occurredAt).toBe(new Date(latest * 1000).toISOString());
    changeTime(e, latest + 100); expect(() => ledgerNotification(e)).toThrow(NotificationStageTimeError);
    const unbound = owned(), full = payout(unbound).settlementEvidence!;
    unbound.settlement!.evidence = unbound.settlement!.evidence.filter(row => row.lt !== full.poolFinalized.lt);
    expect(() => ledgerNotification(unbound)).toThrow(NotificationStageTimeError);
  });
});

describe('durable fee-collection polling', () => {
  let db: Database, store: Store;
  beforeAll(async () => { db = await database(); store = new Store(db, pushConfig()); });
  afterAll(async () => { await db.close(); });
  // Only the consumer transport network label changes in this constructed
  // variant; source addresses, amounts, bodies, hashes and dates stay intact.
  const transport = (e = owned()) => {
    e.network = 'testnet';
    for (const row of e.movements) row.asset.id = row.asset.id.replace(/^localnet:/, 'testnet:');
    for (const row of e.settlement!.dlmmLiquidity!.payouts) row.assetId = row.assetId.replace(/^localnet:/, 'testnet:');
    return e;
  };
  it('accepts a real canonical discovery payload, holds partial delivery, then emits once across new revisions', async () => {
    const current = await session(store, source.owner); await store.setPreferences(current, {activity: true, walletProtocol: false});
    const e = transport(); let since = new Date((e.utime - 1) * 1000).toISOString();
    await db.query('UPDATE platform_preferences SET activity_enabled_at=$1 WHERE wallet_address=$2 AND network=$3', [since, source.owner, 'testnet']);
    const job = (await store.lease('dlmm-fee-test', 10)).find(row => row.kind === 'poll_wallet') as Job;
    let revision = 0, event = structuredClone(e); event.settlement!.status = 'incomplete'; payout(event).finalization = 'unresolved'; delete payout(event).settlementEvidence;
    const response = () => {
      const now = new Date().toISOString(), generation = randomUUID(); revision++;
      return {network: 'testnet', account: source.owner, since, throughRevision: String(revision), revisions: [{revision: String(revision), generation, discoveredAt: now,
        evidenceUtime: Math.max(event.utime, ...event.settlement!.evidence.map(row => row.utime)), event}], nextCursor: null,
        coverage: {syncing: false, historyComplete: true, decodingComplete: true, issues: [], generation, snapshotComplete: true, publishedAt: now, headObservedAt: now, checkedAt: now}};
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(ledgerDiscoverySchema.parse(response()))));
    const cfg = pushConfig(), worker = new Worker(cfg, store, new Providers(cfg, fetcher), new PushSender(cfg), fetcher);
    await worker.pollWallet(job);
    expect((await db.query('SELECT id FROM platform_notifications')).rows).toHaveLength(0);
    event = e; await worker.pollWallet(job); event = {...e, id: 'later-projection'}; await worker.pollWallet(job);
    expect((await db.query('SELECT category,title FROM platform_notifications')).rows).toEqual([{category: 'activity', title: 'Liquidity fees received'}]);
    expect(await store.checkpoint(`ledger-discovery:testnet:${source.owner}`)).toMatchObject({afterRevision: '3', cursor: null});
    event = {...e, account: different}; await expect(worker.pollWallet(job)).rejects.toThrow('indexer_event_scope_mismatch');
    expect(await store.checkpoint(`ledger-discovery:testnet:${source.owner}`)).toMatchObject({afterRevision: '3'});
    event = structuredClone(e);
    const full = payout(event).settlementEvidence!, final = full.poolFinalized, future = Math.floor(Date.now() / 1000) + 120;
    full.boundaries.find(row => row.transaction.lt === final.lt)!.transaction.utime = future;
    event.settlement!.evidence.find(row => row.account === final.account && row.lt === final.lt)!.utime = future; final.utime = future;
    await expect(worker.pollWallet(job)).rejects.toThrow(NotificationStageTimeError);
    expect(await store.checkpoint(`ledger-discovery:testnet:${source.owner}`)).toMatchObject({afterRevision: '3'});
    expect((await db.query('SELECT id FROM platform_notifications')).rows).toHaveLength(1);
    event = transport(collections().filter(row => row.settlement!.dlmmLiquidity!.recipient === row.account && row.settlement!.dlmmLiquidity!.economics.totalTRaw !== '0').at(-1)!);
    since = new Date((event.utime + 1) * 1000).toISOString();
    await db.query('UPDATE platform_preferences SET activity_enabled_at=$1 WHERE wallet_address=$2 AND network=$3', [since, source.owner, 'testnet']);
    await worker.pollWallet(job);
    expect((await db.query('SELECT id FROM platform_notifications')).rows).toHaveLength(1);
    expect(await store.checkpoint(`ledger-discovery:testnet:${source.owner}`)).toMatchObject({since, afterRevision: '6'});
  });
});

if (process.env.DLMM_PLATFORM_EVIDENCE) console.log(JSON.stringify({fixtureSha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256: source.sourceSha256}));
