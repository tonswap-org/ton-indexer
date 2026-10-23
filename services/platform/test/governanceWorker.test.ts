import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import type { Job } from '../src/types.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { address, database, session } from './helpers.js';
import { nativeGovernanceFixture } from './nativeGovernanceFixtures.js';
import type { Config } from '../src/config.js';
let db: Database, store: Store, job: Job, cfg: Config, base: any;
let checkpoint: string;
beforeAll(async () => {
  const fixture = nativeGovernanceFixture();
  vi.spyOn(Date, 'now').mockReturnValue(fixture.sample.utime * 1000);
  base = await fixture.page(); cfg = fixture.cfg;
  checkpoint = `governance:testnet:${cfg.dexRelease!.manifestHash}:${base.governance}`;
  db = await database(); store = new Store(db, cfg);
}, 90_000);
afterAll(async () => { await db.close(); vi.restoreAllMocks(); });
afterEach(() => { vi.mocked(Date.now).mockReturnValue(base.asOf.utime * 1000); });
beforeEach(async () => {
  await db.query('DELETE FROM platform_jobs'); await db.query('DELETE FROM platform_checkpoints');
  await db.query('DELETE FROM platform_notifications');
  await store.enqueue(db, 'poll_governance', 'governance:testnet', { network: 'testnet' });
  job = (await store.lease('governance-test', 1))[0]!;
});
function page() { return structuredClone(base); }
function response(value: unknown, release = cfg.dexRelease!.manifestHash) {
  return new Response(JSON.stringify(value), { headers: { 'x-tonswap-release': release } });
}
function worker(fetcher: typeof fetch, config = cfg, clock = () => new Date(Date.now())) {
  return new Worker(config, store, new Providers(db, config), new PushSender(config), fetcher, clock);
}
function paged(start = '1', closed = false) {
  const result = page(), first = Number(start), end = Math.min(66, first + 64);
  const original = result.proposals[0];
  result.nextProposalId = '66'; result.liveProposalCount = 2;
  result.proposals = [{ ...original, id: start }];
  result.prunedProposalIds = Array.from({ length: end - first - 1 }, (_, i) => String(first + i + 1));
  result.page = { startId: start, nextStartId: end < 66 ? String(end) : null, scanned: end - first, complete: true, historyComplete: false };
  if (closed) {
    result.asOf = { ...result.asOf, seqno: result.asOf.seqno + 1, utime: original.closeAt };
    result.proposals[0].status = 'closed';
  }
  return result;
}

describe('current Governance consumer', () => {
  it('uses the exact manifest source, release header and canonical snapshot contract', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${cfg.dexRelease!.indexerUrl}/governance/${encodeURIComponent(base.governance)}/snapshot?max_scan=64&start_id=1`);
      expect(init?.headers).toMatchObject({ 'x-tonswap-release': cfg.dexRelease!.manifestHash });
      return response(page());
    });
    await worker(fetcher).pollGovernance(job);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ schema: 'current-governance-monitor-v1', initialized: true,
      nextStartId: '1', nextProposalId: base.nextProposalId, head: base.asOf });
    expect(await store.checkpoint(`governance:testnet:${base.governance}`)).toBeNull();
  });

  it.each([
    ['wrong schema', (p: any) => { p.schema = 'retired-voting'; }],
    ['wrong network', (p: any) => { p.network = 'mainnet'; }],
    ['wrong contract', (p: any) => { p.governance = address; }],
    ['wrong release id', (p: any) => { p.releaseId += '-other'; }],
    ['wrong release hash', (p: any) => { p.manifestHash = 'e'.repeat(64); }],
    ['wrong code pin', (p: any) => { p.codeHash = 'e'.repeat(64); }],
    ['missing data commitment', (p: any) => { delete p.dataHash; }],
    ['invalid head shard', (p: any) => { p.asOf.shard = '0'; }],
    ['stale head', (p: any) => { p.asOf.utime -= 31; }],
    ['future head', (p: any) => { p.asOf.utime += 6; }],
    ['incomplete page', (p: any) => { p.page.complete = false; }],
    ['invented complete history', (p: any) => { p.page.historyComplete = true; }],
    ['missing allocated proposal', (p: any) => { p.proposals.pop(); }],
    ['duplicate proposal', (p: any) => { p.proposals.push(p.proposals[0]); }],
    ['out-of-range proposal', (p: any) => { p.proposals[0].id = p.nextProposalId; }],
    ['overlapping pruned id', (p: any) => { p.prunedProposalIds.push(p.proposals[0].id); }],
    ['wrong start', (p: any) => { p.page.startId = '2'; }],
    ['skipped page', (p: any) => { p.page.nextStartId = '129'; }],
    ['stalled page', (p: any) => { p.page.nextStartId = '1'; }],
    ['wrong scan count', (p: any) => { p.page.scanned += 1; }],
    ['counter above uint32', (p: any) => { p.nextProposalId = '4294967296'; }],
    ['private owner response', (p: any) => { p.owner = address; }],
    ['wrong timing', (p: any) => { p.proposals[0].closeAt += 1; }],
    ['invented execution state', (p: any) => { p.proposals[0].status = 'executed'; }],
    ['invented queued state', (p: any) => { p.proposals[0].status = 'queued'; }],
    ['wrong action hash', (p: any) => { p.proposals[0].actionsHash = 'e'.repeat(64); }],
    ['malformed action bytes', (p: any) => { p.proposals[0].actionsBoc = 'broken'; }],
    ['obsolete numeric status', (p: any) => { p.proposals[0].status = '0'; }],
    ['unknown retired fields', (p: any) => { p.voting = p.governance; }],
  ])('refuses %s without advancing a checkpoint or creating inbox data', async (_name, mutate) => {
    const changed = page(); mutate(changed);
    await expect(worker(vi.fn(async () => response(changed))).pollGovernance(job)).rejects.toThrow(/governance_/);
    expect(await store.checkpoint(checkpoint)).toBeNull();
    expect((await db.query('SELECT * FROM platform_notifications')).rows).toEqual([]);
  });

  it.each(['', 'e'.repeat(64)])('refuses missing/different response release headers before parsing (%s)', async header => {
    await expect(worker(vi.fn(async () => response(page(), header))).pollGovernance(job)).rejects.toThrow('governance_release_mismatch');
    expect(await store.checkpoint(checkpoint)).toBeNull();
  });

  it('refuses the removed Voting shape rather than adapting it', async () => {
    const retired = { network: 'testnet', voting: base.governance, start_id: '1', next_start_id: null,
      coverage: { rangeKnown: true, pageComplete: true, scanComplete: true, nextProposalId: '2' },
      proposals: [{ id: '1', status: '0', maxCloseTime: '123' }] };
    await expect(worker(vi.fn(async () => response(retired))).pollGovernance(job)).rejects.toThrow('governance_snapshot_invalid');
    expect(await store.checkpoint(checkpoint)).toBeNull();
  });

  it('accepts a canonical masterchain proposer wallet without changing the manifest Governance pin', async () => {
    const result = page(); result.proposals[0].proposer = `-1:${'7'.repeat(64)}`;
    await worker(vi.fn(async () => response(result))).pollGovernance(job);
    expect((await store.checkpoint<any>(checkpoint)).proposals[result.proposals[0].id].proposer).toBe(result.proposals[0].proposer);
  });

  it('does not call an unbound source or a second network', async () => {
    const fetcher = vi.fn(async () => response(page()));
    for (const config of [{ ...cfg, dexRelease: undefined }, { ...cfg, indexerUrls: {} },
      { ...cfg, indexerUrls: { testnet: 'https://other.example.test/v1' } },
      { ...cfg, dexRelease: { ...cfg.dexRelease!, governance: null } }])
      expect(await worker(fetcher, config).pollGovernance(job)).toBeUndefined();
    expect(await worker(fetcher).pollGovernance({ ...job, dedupeKey: 'governance:mainnet', payload: { network: 'mainnet' } })).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pages past 64 with pruned IDs, establishes a full baseline and resumes after an incomplete page', async () => {
    const owner = await session(store); await store.setPreferences(owner, { governance: true });
    let closed = false, incomplete = false;
    const starts: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const start = new URL(String(url)).searchParams.get('start_id')!; starts.push(start);
      const result = paged(start, closed); if (incomplete) result.page.complete = false;
      return response(result);
    });
    const polling = worker(fetcher);
    expect(await polling.pollGovernance(job)).toBe(1);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ initialized: false, nextStartId: '65' });
    expect(await polling.pollGovernance(job)).toBe(120);
    expect((await store.inbox(owner, 100)).notifications).toEqual([]);
    closed = true; incomplete = true;
    const previous = await store.checkpoint(checkpoint);
    await expect(polling.pollGovernance(job)).rejects.toThrow('governance_snapshot_invalid');
    expect(await store.checkpoint(checkpoint)).toEqual(previous);
    incomplete = false;
    await store.finish(job);
    const observed = paged('1', true).asOf.utime; vi.mocked(Date.now).mockReturnValue(observed * 1000);
    await store.enqueue(db, 'poll_governance', 'governance:testnet', { network: 'testnet' }, true);
    job = (await store.lease('governance-next-cycle', 100)).find(value => value.kind === 'poll_governance')!;
    expect(job).toBeDefined();
    await polling.pollGovernance(job); await polling.pollGovernance(job);
    expect(starts).toEqual(['1', '65', '1', '1', '65']);
    const notices = (await store.inbox(owner, 100)).notifications;
    expect(notices).toHaveLength(2);
    expect(notices.map(n => n.href).sort()).toEqual(['/earn/vote?proposal=1', '/earn/vote?proposal=65']);
    vi.mocked(Date.now).mockReturnValue(base.asOf.utime * 1000);
  });

  it('keeps pruned outcomes unknown and deduplicates them after a restart', async () => {
    const owner = await session(store); await store.setPreferences(owner, { governance: true });
    await worker(vi.fn(async () => response(page()))).pollGovernance(job);
    const pruned = page(), id = pruned.proposals[0].id;
    pruned.proposals = pruned.proposals.filter((p: any) => p.id !== id); pruned.liveProposalCount--;
    pruned.prunedProposalIds.push(id);
    pruned.asOf.seqno++; pruned.dataHash = 'e'.repeat(64);
    const polling = worker(vi.fn(async () => response(pruned)));
    await polling.pollGovernance(job); await polling.pollGovernance(job);
    const notices = (await store.inbox(owner, 100)).notifications;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ evidence: { proposalId: id, status: 'unknown', pruned: true, targetExecution: 'unverified' } });
    expect(notices[0]!.body).toContain('terminal outcome and target execution remain unverified');
    expect((await store.checkpoint<any>(checkpoint)).proposals[id]).toBeUndefined();
  });

  it.each(['lower head', 'same-height fork', 'same-height account fork', 'same-height counter change', 'lower counter', 'changed proposal identity'])('refuses %s after a baseline', async kind => {
    await worker(vi.fn(async () => response(page()))).pollGovernance(job);
    const changed = page();
    if (kind === 'lower head') changed.asOf.seqno--;
    if (kind === 'same-height fork') changed.asOf.rootHashHex = 'e'.repeat(64);
    if (kind === 'same-height account fork') changed.dataHash = 'e'.repeat(64);
    if (kind === 'same-height counter change') changed.nextProposalId = String(Number(changed.nextProposalId) + 1);
    if (kind === 'lower counter') changed.nextProposalId = '1';
    if (kind === 'changed proposal identity') changed.proposals[0].descriptionHash = 'e'.repeat(64);
    const previous = await store.checkpoint(checkpoint);
    await expect(worker(vi.fn(async () => response(changed))).pollGovernance(job)).rejects.toThrow(/governance_/);
    expect(await store.checkpoint(checkpoint)).toEqual(previous);
  });

  it('rechecks freshness after database contention', async () => {
    let calls = 0;
    await expect(worker(vi.fn(async () => response(page())), cfg,
      () => new Date((base.asOf.utime + (calls++ ? 31 : 0)) * 1000)).pollGovernance(job)).rejects.toThrow('governance_snapshot_stale');
    expect(await store.checkpoint(checkpoint)).toBeNull();
  });

  it('rolls back notices and both checkpoints when the final checkpoint write exhausts freshness', async () => {
    const owner = await session(store); await store.setPreferences(owner, { governance: true });
    await worker(vi.fn(async () => response(page()))).pollGovernance(job);
    const coverageKey = `governance-coverage:testnet:${cfg.dexRelease!.manifestHash}:${base.governance}`;
    const previous = await store.checkpoint(checkpoint), previousCoverage = await store.checkpoint(coverageKey);
    const pruned = page(), id = pruned.proposals[0].id;
    pruned.proposals = pruned.proposals.filter((p: any) => p.id !== id); pruned.liveProposalCount--;
    pruned.prunedProposalIds.push(id); pruned.asOf.seqno++; pruned.dataHash = 'e'.repeat(64);
    let now = pruned.asOf.utime * 1000;
    const writeCheckpoint = store.setCheckpoint.bind(store);
    const writes = vi.spyOn(store, 'setCheckpoint').mockImplementation(async (key, value, sql) => {
      await writeCheckpoint(key, value, sql);
      if (key === coverageKey) now += 31_000;
    });
    const emits = vi.spyOn(store, 'emit');
    try {
      await expect(worker(vi.fn(async () => response(pruned)), cfg, () => new Date(now)).pollGovernance(job))
        .rejects.toThrow('governance_snapshot_stale');
      expect(emits).toHaveBeenCalledTimes(1);
      expect(writes.mock.calls.map(([key]) => key)).toEqual([checkpoint, coverageKey]);
      expect((await store.inbox(owner, 100)).notifications).toEqual([]);
      expect(await store.checkpoint(checkpoint)).toEqual(previous);
      expect(await store.checkpoint(coverageKey)).toEqual(previousCoverage);
    } finally { writes.mockRestore(); emits.mockRestore(); }
  });

  it('fences a recovered job before an outstanding current page can write', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const pending = worker(fetcher).pollGovernance(job);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    await store.lease('recovered', 1);
    resolve(response(page()));
    await expect(pending).rejects.toThrow('no longer owned');
    expect(await store.checkpoint(checkpoint)).toBeNull();
    expect(await store.checkpoint(`governance-coverage:testnet:${cfg.dexRelease!.manifestHash}:${base.governance}`)).toBeNull();
  });
});
