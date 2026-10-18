import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import type { Job } from '../src/types.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { address, config, database, session } from './helpers.js';
let db: Database; let store: Store; let job: Job;
const cfg = config({ governanceContracts: { testnet: address } });
const checkpoint = `governance:testnet:${address}`;
beforeAll(async () => { db = await database(); store = new Store(db, cfg); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.query('DELETE FROM platform_jobs'); await db.query('DELETE FROM platform_checkpoints');
  await store.enqueue(db, 'poll_governance', 'governance:testnet', { network: 'testnet' });
  job = (await store.lease('governance-test', 1))[0]!;
});
function page() { return { network: 'testnet', voting: address, start_id: '1', next_start_id: null as string | null,
  coverage: { rangeKnown: true, pageComplete: true, scanComplete: true, nextProposalId: '3' },
  proposals: [{ id: '1', status: '0', maxCloseTime: '123' }, { id: '2', status: '0', maxCloseTime: '123' }] }; }
function worker(fetcher: typeof fetch) { return new Worker(cfg, store, new Providers(db, cfg), new PushSender(cfg), fetcher); }
describe('governance cursor and lease integrity', () => {
  it('links an indexed proposal change directly to the canonical voting screen', async () => {
    const owner = await session(store);
    await store.setPreferences(owner, { governance: true });
    await worker(vi.fn(async () => new Response(JSON.stringify(page())))).pollGovernance(job);
    expect((await store.inbox(owner, 20)).notifications).toEqual([]);
    const changed = page(); changed.proposals[1]!.status = '1';
    await worker(vi.fn(async () => new Response(JSON.stringify(changed)))).pollGovernance(job);
    expect((await store.inbox(owner, 20)).notifications).toEqual([expect.objectContaining({
      category: 'governance', href: '/earn/vote?proposal=2', evidence: expect.objectContaining({ proposalId: '2', previousStatus: '0', status: '1' }),
    })]);
  });
  it('does not advance across missing, duplicate, out-of-range, or stalled proposal pages', async () => {
    const missing = page(); missing.proposals.pop();
    const duplicate = page(); duplicate.proposals[1]!.id = '1';
    const outside = page(); outside.proposals[1]!.id = '3';
    const stalled = page(); stalled.next_start_id = '1'; stalled.coverage.scanComplete = false;
    const skipped = page(); skipped.next_start_id = '129'; skipped.coverage.nextProposalId = '200'; skipped.coverage.scanComplete = false;
    const wrongStart = page(); wrongStart.start_id = '2';
    for (const response of [missing, duplicate, outside, stalled, skipped, wrongStart]) {
      await expect(worker(vi.fn(async () => new Response(JSON.stringify(response)))).pollGovernance(job)).rejects.toThrow(/governance_(page|cursor)_invalid/);
      expect(await store.checkpoint(checkpoint)).toBeNull();
    }
    await worker(vi.fn(async () => new Response(JSON.stringify(page())))).pollGovernance(job);
    expect(await store.checkpoint(checkpoint)).toMatchObject({ initialized: true, nextStartId: '1' });
  });
  it('fences a recovered job before an outstanding governance page can write state', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const pending = worker(fetcher).pollGovernance(job);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    await store.lease('recovered', 1);
    resolve(new Response(JSON.stringify(page())));
    await expect(pending).rejects.toThrow('no longer owned');
    expect(await store.checkpoint(checkpoint)).toBeNull();
    expect(await store.checkpoint('governance-coverage:testnet')).toBeNull();
  });
});
