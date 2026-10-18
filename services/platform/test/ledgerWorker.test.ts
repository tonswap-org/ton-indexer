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
  return { id: 'owner-transaction', network: 'testnet', account: address, lt: '123', hash, txId: `123:${hash}`,
    utime, status: 'success', kind: 'swap', actions: [{ kind: 'swap', minOut: '999999999999' }], issues: [],
    movements: [
      { direction: 'out', amountRaw: '100000000000000001', asset: { kind: 'jetton', id: `testnet:jetton:${'0:' + '2'.repeat(64)}` } },
      { direction: 'in', amountRaw: '95000000000000007', asset: { kind: 'jetton', id: `testnet:jetton:${'0:' + '3'.repeat(64)}` } },
    ],
    settlement: { status: 'confirmed', protocol: 'dlmm', operation: 'swap', pool, queryId: '42', evidence: [
      { account: pool, lt: '125', hash: Buffer.alloc(32, 0xbb).toString('base64'), utime }, { account: address, lt: '123', hash, utime },
    ] }, ...overrides };
}
function optionEvent(): LedgerEvent {
  const utime = Math.floor(Date.now() / 1000) - 10; const series = `0:${'4'.repeat(64)}`;
  const ownerWallet = `0:${'5'.repeat(64)}`, factoryWallet = `0:${'6'.repeat(64)}`;
  const evidence = [pool, pool, pool, series, series, address, ownerWallet, factoryWallet].map((account, index) => ({ account, lt: String(100 + index), hash, utime }));
  const positionHash = 'c'.repeat(64);
  return event({ kind: 'option_buy', settlement: { status: 'confirmed', protocol: 'options', operation: 'option_buy',
    factory: pool, series, seriesId: '7', positionId: '3', wireId: '55', queryId: '42', positionHash,
    notionalRaw: '10000', premiumRaw: '100', collateralRaw: '1100', protocolFeeRaw: '20', evidence }, movements: [
    ...(['option_premium', 'option_collateral', 'protocol_fee'] as const).map((purpose, index) => ({ purpose,
      direction: index === 2 ? 'fee' as const : 'out' as const, amountRaw: ['100', '1100', '20'][index]!,
      source: address, destination: pool, asset: { kind: 'jetton' as const, id: `testnet:jetton:${'0:' + '2'.repeat(64)}`, owner: address, wallet: ownerWallet },
      evidence: { kind: 'jetton_transfer', transactions: evidence.slice(-2) } })),
    { direction: 'in', amountRaw: '1', asset: { kind: 'option_position', id: `testnet:option-position:${pool}:7:3`,
      owner: address, factory: pool, series, seriesId: '7', positionId: '3', decimals: 0 }, evidence: {
        kind: 'option_activation', bodyHash: positionHash, transactions: evidence,
        stateBeforeHash: 'ab'.repeat(32), stateAfterHash: 'cd'.repeat(32), beforeSeqno: 2, afterSeqno: 3,
        optionPosition: { factory: pool, factoryCodeHash: 'de'.repeat(32), seriesId: '7', positionId: '3', owner: address, sourceWallet: factoryWallet,
          notionalRaw: '10000', premiumRaw: '100', collateralRaw: '1100', seriesWireId: '55', custodyWireId: '56', protocolFeeRaw: '20', excessRaw: '0', beforeBuyStateRaw: '269', buyStateRaw: '525' },
      } },
  ] });
}
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
  it('continues tracking accepted perps orders until a later payout and deduplicates each stage', async () => {
    const accepted = perpsEvent(address, Math.floor(Date.now() / 1000) - 10);
    let response = page([accepted]);
    const urls: URL[] = [];
    const worker = polling(vi.fn(async input => { urls.push(new URL(String(input))); return new Response(JSON.stringify(response)); }));
    await worker.pollWallet(job);
    expect((await notices()).filter(n => n.category === 'activity')).toMatchObject([{ title: 'Position opening confirmed' }]);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
    job = (await store.lease('perps-later-poll-worker', 10)).find(item => item.id === job.id)!;
    const received = structuredClone(accepted), p = received.settlement!.perps!;
    p.payout = { status: 'completed', wireId: '87', amountRaw: '5', evidence: p.stateEvidence!.transactions };
    received.movements.push({ purpose: 'perps_payout', direction: 'in', amountRaw: '5',
      asset: { kind: 'jetton', id: `testnet:jetton:${p.root}`, master: p.root, owner: address }, evidence: { kind: 'perps_payout' } });
    response = page([received]); response.coverage.generation = randomUUID();
    await worker.pollWallet(job);
    expect(urls[1]!.searchParams.get('after_revision')).toBe(String(revision - 1));
    expect((await notices()).filter(n => n.category === 'activity').map(n => n.title).sort()).toEqual(['Perps payout confirmed', 'Position opening confirmed']);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: String(revision), cursor: null });
    response = page([{ ...received, id: 'rebuilt-perps-event', utime: Math.floor(Date.now() / 1000) - 1 }]); response.coverage.generation = randomUUID();
    await worker.pollWallet(job);
    expect((await notices()).filter(n => n.category === 'activity')).toHaveLength(2);
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

  it('requires exact activated option ownership, split funding, and the identified activation round trip', () => {
    const option = optionEvent();
    expect(ledgerNotification(option)).toMatchObject({ category: 'activity', title: 'Option purchase confirmed' });
    const noRight = structuredClone(option); noRight.movements.pop();
    const otherOwner = structuredClone(option); otherOwner.movements[3]!.asset.owner = pool;
    const unactivated = structuredClone(option); unactivated.movements[3]!.evidence!.optionPosition!.buyStateRaw = '13';
    const missingPrerequisites = structuredClone(option); missingPrerequisites.movements[3]!.evidence!.optionPosition!.buyStateRaw = '512';
    const aborted = structuredClone(option); aborted.movements[3]!.evidence!.optionPosition!.buyStateRaw = '541';
    const wrongPosition = structuredClone(option); wrongPosition.movements[3]!.evidence!.optionPosition!.positionId = '4';
    const underfunded = structuredClone(option); underfunded.movements[0]!.amountRaw = '99';
    const wrongAsset = structuredClone(option); wrongAsset.movements[1]!.asset.id = 'different-asset';
    const noRoundTrip = structuredClone(option); noRoundTrip.settlement!.evidence.pop(); noRoundTrip.settlement!.evidence.pop();
    const incomplete = structuredClone(option); incomplete.settlement!.status = 'incomplete';
    for (const unresolved of [noRight, otherOwner, unactivated, missingPrerequisites, aborted, wrongPosition, underfunded, wrongAsset, noRoundTrip, incomplete])
      expect(ledgerNotification(unresolved)?.category).toBe('walletProtocol');
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
    expect(activity[0]?.evidence.settlement).toMatchObject({ factory: pool, seriesId: '7', positionId: '3', notionalRaw: '10000' });
  });

  it('requires identified DLMM settlement and real asset legs, including minted/burned LP position evidence', () => {
    const swap = event();
    expect(ledgerNotification(swap)?.title).toBe('Swap confirmed');
    for (const incomplete of [event({ settlement: undefined }), event({ movements: [swap.movements[0]!] }),
      event({ settlement: { ...swap.settlement!, status: 'incomplete' } }),
      event({ settlement: { ...swap.settlement!, protocol: 'jetton' } })]) {
      expect(ledgerNotification(incomplete)?.category).toBe('walletProtocol');
    }
    for (const operation of ['lp_deposit', 'lp_withdraw'] as const) {
      const deposit = operation === 'lp_deposit';
      const projected = event({ kind: operation, settlement: { ...swap.settlement!, operation }, movements: [
        { ...swap.movements[0]!, direction: deposit ? 'out' : 'in' },
        { direction: deposit ? 'in' : 'out', amountRaw: '100000000000000001', asset: { kind: 'lp_position', id: `testnet:lp:${pool}:0`, pool } },
      ] });
      if (deposit) expect(ledgerNotification(projected)?.title).toBe('Liquidity deposit confirmed');
      else expect(ledgerNotification(projected)).toBeNull(); // Aggregate cash and shares cannot replace canonical withdrawal delivery/finalization proof.
    }
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
    expect((await notices())[0]?.category).toBe('walletProtocol');
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
    expect(notice).toMatchObject({ category: 'activity', href: `/wallet?tx=${encodeURIComponent(`123:${hash}`)}`, readAt: null });
    expect(notice?.evidence.movements).toMatchObject([{ amountRaw: '100000000000000001' }, { amountRaw: '95000000000000007' }]);
    await worker.tick();
    expect((await db.query<{ state: string }>("SELECT state FROM platform_jobs WHERE kind='deliver_push'")).rows[0]?.state).toBe('ready');
    await db.query("UPDATE platform_jobs SET attempts=7,available_at=now() WHERE kind='deliver_push'");
    await worker.tick();
    expect((await db.query<{ state: string }>("SELECT state FROM platform_jobs WHERE kind='deliver_push'")).rows[0]?.state).toBe('failed');
    expect((await notices())[0]).toMatchObject({ id: notice!.id, readAt: null });
  });
});
