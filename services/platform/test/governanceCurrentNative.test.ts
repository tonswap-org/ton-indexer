import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { Store } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { database, session } from './helpers.js';
import { nativeGovernanceFixture } from './nativeGovernanceFixtures.js';
let db: Database;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db.close(); vi.restoreAllMocks(); });
beforeEach(async () => {
  await db.query('DELETE FROM platform_jobs'); await db.query('DELETE FROM platform_checkpoints');
  await db.query('DELETE FROM platform_notifications');
});
afterEach(() => vi.restoreAllMocks());
it.each([0, 1])('consumes current native Governance world %s and retains exact release/head evidence without claiming target execution', async worldIndex => {
  const fixture = nativeGovernanceFixture(worldIndex);
  const now = vi.spyOn(Date, 'now').mockReturnValue(fixture.sample.utime * 1000);
  const store = new Store(db, fixture.cfg), owner = await session(store);
  await store.setPreferences(owner, { governance: true });
  let job = (await store.lease('native-governance-test', 100)).find(value => value.kind === 'poll_governance');
  expect(job).toBeDefined();
  let snapshot = await fixture.page();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(snapshot), { headers: { 'x-tonswap-release': fixture.release.manifestHash } }));
  const worker = new Worker(fixture.cfg, store, new Providers(db, fixture.cfg), new PushSender(fixture.cfg), fetcher, () => new Date(Date.now()));
  await worker.pollGovernance(job!);
  expect((await store.inbox(owner, 100)).notifications).toEqual([]);
  const proposal = snapshot.proposals.find(value => value.status === 'voting')!;
  expect(proposal).toBeDefined();
  // A new recurring poll owns a new database lease after chain time advances.
  // Keeping the first 90-second lease across this native multi-minute jump is invalid.
  await store.finish(job!);
  now.mockReturnValue(proposal.closeAt * 1000);
  snapshot = await fixture.page(fixture.sample, proposal.closeAt);
  await store.enqueue(db, 'poll_governance', 'governance:testnet', { network: 'testnet' }, true);
  job = (await store.lease('native-governance-next-poll', 100)).find(value => value.kind === 'poll_governance');
  expect(job).toBeDefined();
  const replacement = new Worker(fixture.cfg, new Store(db, fixture.cfg), new Providers(db, fixture.cfg), new PushSender(fixture.cfg), fetcher, () => new Date(Date.now()));
  await replacement.pollGovernance(job!);
  const notice = (await store.inbox(owner, 100)).notifications.find(value => value.evidence.proposalId === proposal.id)!;
  expect(notice).toMatchObject({ category: 'governance', href: `/earn/vote?proposal=${proposal.id}`,
    evidence: { proposalId: proposal.id, previousStatus: 'voting', status: 'closed', targetExecution: 'unverified',
      releaseId: snapshot.releaseId, manifestHash: snapshot.manifestHash, governance: snapshot.governance,
      codeHash: snapshot.codeHash, dataHash: snapshot.dataHash, asOf: snapshot.asOf } });
  expect(notice.occurredAt).toBe(new Date(snapshot.asOf.utime * 1000).toISOString());
  await replacement.pollGovernance(job!);
  expect((await store.inbox(owner, 100)).notifications.filter(value => value.evidence.proposalId === proposal.id)).toHaveLength(1);

  const queuedRow = fixture.selectedWorld.rows.find((row: any) => fixture.proposal(row, proposal.id)?.queued);
  expect(queuedRow).toBeDefined();
  await store.finish(job!);
  const queuedObservedAt = Math.max(queuedRow.utime, proposal.closeAt);
  now.mockReturnValue(queuedObservedAt * 1000);
  snapshot = await fixture.page(queuedRow, queuedObservedAt);
  expect(snapshot.proposals.find(value => value.id === proposal.id)?.status).toBe('queued');
  await store.enqueue(db, 'poll_governance', 'governance:testnet', { network: 'testnet' }, true);
  job = (await store.lease('native-governance-queued-poll', 100)).find(value => value.kind === 'poll_governance');
  expect(job).toBeDefined();
  await replacement.pollGovernance(job!);
  const queued = (await store.inbox(owner, 100)).notifications.find(value => value.evidence.proposalId === proposal.id && value.evidence.status === 'queued')!;
  expect(queued).toMatchObject({ evidence: { previousStatus: 'closed', status: 'queued', targetExecution: 'unverified' } });
  expect(queued.body).toBe('The proposal is queued. Execution of its target actions remains unverified.');
}, 90_000);
