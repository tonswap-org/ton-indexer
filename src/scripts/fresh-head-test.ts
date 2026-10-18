import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { ChainReadError } from '../data/dataSource';
import { FreshReadUnavailableError } from '../data/freshRead';
import { HeadTracker } from '../data/headTracker';
import { assertFreshHeadTime, assertFreshLiteHeadTime } from '../data/freshHead';
import { createLiteChainSource } from '../data/liteClientSource';
import { FakeLiteEngine, masterAnswer, proofBlock, proofMasterchain } from './support/fakeLiteEngine';

const logger = { info() {}, debug() {}, error() {}, warn() {} };
const address = `0:${'1'.repeat(64)}`;
const calls = [{ kind: 'getter' as const, address, method: 'oracle_market_preview', args: [] }];
const now = Math.floor(Date.now() / 1_000);
const sourceFor = (...peers: FakeLiteEngine[]) => createLiteChainSource({ network: 'testnet', logger,
  peers: peers.map((_, port) => ({ host: '127.0.0.1', port: 1000 + port, publicKey: Buffer.alloc(32) })),
  engineFactory: peer => peers[peer.port - 1000] });
const getter = (request: any) => ({ id: request.id, shardblk: request.id, exitCode: 17, result: null });

function timeAndIdentity() {
  const wall = now * 1_000;
  for (const age of [0, 30]) assertFreshLiteHeadTime({ lastUtime: now - age, now }, wall);
  assertFreshLiteHeadTime({ lastUtime: now + 5, now: now + 5 }, wall);
  assertFreshHeadTime(now + 5, wall);
  for (const candidate of [{ lastUtime: now - 31, now }, { lastUtime: now + 6, now: now + 6 },
    { lastUtime: now, now: now - 1 }, { lastUtime: now, now: now + 31 },
    { lastUtime: NaN, now }, { lastUtime: now, now: Infinity }])
    assert.throws(() => assertFreshLiteHeadTime(candidate, wall));
  const tracker = new HeadTracker('testnet');
  const accepted = tracker.accept(masterAnswer(proofBlock(100, now, -1)));
  assert(Object.isFrozen(accepted));
  assert.throws(() => { accepted.seqno = 1; });
  assert.throws(() => tracker.accept(masterAnswer(proofBlock(99, now, -1))), ChainReadError);
  assert.throws(() => tracker.accept(masterAnswer(proofBlock(100, now + 1, -1))), ChainReadError);
  assert.throws(() => tracker.accept(masterAnswer(proofBlock(101, now - 31, -1))), ChainReadError, 'A later block cannot have an earlier time');
  assert.equal(tracker.current()?.seqno, 100, 'Rejected peers cannot replace the authenticated process head');
  tracker.assertCurrent(accepted);
  const clock = mock.method(Date, 'now', () => (now + 31) * 1_000);
  try {
    assert.equal(tracker.fresh(), null, 'The reuse window measures observation age');
    assert.throws(() => tracker.assertCurrent(accepted), FreshReadUnavailableError, 'Expired block time is not current');
  } finally { clock.mock.restore(); }

  // Wall-clock age is not head validity; only current reads check it.
  const stalled = new HeadTracker('testnet');
  const old = stalled.accept({ ...masterAnswer(proofBlock(100, now - 60, -1)), now });
  assert.equal(old.seqno, 100, 'A 60 s old block is a valid process head');
  assert.throws(() => stalled.assertCurrent(old), FreshReadUnavailableError);
  const skewed = stalled.accept({ ...masterAnswer(proofBlock(101, now, -1)), now: now + 45 });
  assert.equal(stalled.current(), skewed, 'A peer clock 45 s off still supplies a valid monotonic head');
  assert.throws(() => stalled.assertCurrent(skewed), FreshReadUnavailableError, 'An inconsistent peer clock is not current');
  assert.throws(() => stalled.assertCurrent({ ...skewed }), FreshReadUnavailableError, 'Only a head observed by this tracker can be current');
}

async function boundedPeerSelection() {
  let initial = true;
  const stale = new FakeLiteEngine(async request => request.kind === 'liteServer.getMasterchainInfoExt'
    ? masterAnswer(proofBlock(initial ? 100 : 200, initial ? now : now - 90, -1)) : getter(request));
  const behind = new FakeLiteEngine(async request => request.kind === 'liteServer.getMasterchainInfoExt'
    ? masterAnswer(proofBlock(99, now, -1)) : getter(request));
  const current = new FakeLiteEngine(async request => request.kind === 'liteServer.getMasterchainInfoExt'
    ? masterAnswer(proofBlock(101, now, -1)) : getter(request));
  const source = sourceFor(stale, behind, current);
  let clock: ReturnType<typeof mock.method> | undefined;
  try {
    assert.equal((await source.head()).seqno, 100);
    initial = false; clock = mock.method(Date, 'now', () => (now + 2) * 1_000);
    const result = await source.read(calls);
    assert.equal(result.head.seqno, 101);
    assert.equal(result.results[0].kind === 'getter' && result.results[0].exitCode, 17);
    assert.equal([stale, behind, current].flatMap(peer => peer.requests).filter(row => row.request.kind === 'liteServer.runSmcMethod').length, 1,
      'Stale or lagging metadata never dispatches financial reads');
    for (const peer of [stale, behind, current]) {
      const latest = peer.requests.filter(row => row.request.kind === 'liteServer.getMasterchainInfoExt').at(-1)!;
      assert.equal(latest.options.awaitSeqno, 100, 'Dependent queries wait above the authenticated causal floor');
    }
  } finally { clock?.mock.restore(); await source.close(); }
}

async function currentAtCompletion() {
  let wall = now * 1_000;
  const clock = mock.method(Date, 'now', () => wall);
  const peer = new FakeLiteEngine(async request => {
    if (request.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(proofBlock(100, now - 29, -1));
    wall += 2_000;
    return getter(request);
  });
  const source = sourceFor(peer);
  try { await assert.rejects(source.read(calls), ChainReadError, 'A head that becomes stale during preflight cannot approve readiness'); }
  finally { clock.mock.restore(); await source.close(); }
}

async function concurrentBoundary() {
  let wall = now * 1_000, seqno = 100, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const clock = mock.method(Date, 'now', () => wall);
  const peer = new FakeLiteEngine(async request => {
    if (request.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(proofBlock(seqno, now, -1));
    if (request.id.seqno === 100) { entered(); await gate; }
    return getter(request);
  });
  const source = sourceFor(peer);
  try {
    const older = source.read(calls); await started;
    seqno = 102; wall += 2_000;
    assert.equal((await source.head()).seqno, 102);
    release(); assert.equal((await older).head.seqno, 100, 'An already pinned concurrent batch retains its honest valid boundary');
    assert.equal((await source.read(calls)).head.seqno, 102, 'The older completion cannot lower a dependent read');
  } finally { release(); clock.mock.restore(); await source.close(); }
}

const unavailable = (error: unknown) => error instanceof ChainReadError && error.code === 'upstream_unavailable';
const dispatchedGetters = (peer: FakeLiteEngine) => peer.requests.filter(row => row.request.kind === 'liteServer.runSmcMethod').length;
const headQueries = (peer: FakeLiteEngine) => peer.requests.filter(row => row.request.kind === 'liteServer.getMasterchainInfoExt').length;

/** Wall-clock freshness belongs to unpinned current reads. A testnet stall or a
 * skewed host clock must neither refuse a valid head nor fail its peer. */
async function staleOrSkewedHeadServesExplicitBlocks() {
  for (const [label, blockTime, hostAhead] of [
    ['testnet stall: newest block 60 s old, peer clock correct', now - 60, 0],
    ['host clock 45 s ahead of chain and peer', now, 45],
    ['both: newest block 60 s old and host clock 45 s ahead', now - 60, 45],
  ] as const) {
    const shard = proofBlock(80, blockTime - 1), master = proofMasterchain(100, blockTime, shard);
    let wall = (now + hostAhead) * 1_000;
    const clock = mock.method(Date, 'now', () => wall);
    const peer = new FakeLiteEngine(async request => {
      if (request.kind === 'liteServer.getMasterchainInfoExt') return { ...masterAnswer(master), now };
      if (request.kind === 'liteServer.getAccountState')
        return { id: request.id, shardblk: shard.id, state: Buffer.alloc(0), proof: shard.proof, shardProof: master.proof };
      return getter(request);
    });
    const source = sourceFor(peer);
    const healthy = () => assert.deepEqual(source.health().peers.map(row => [row.failures, row.open]), [[0, false]],
      `${label}: wall-clock staleness is never a peer failure or an open circuit`);
    try {
      const head = await source.head();
      assert.equal(head.seqno, 100, `${label}: any valid monotonic head is the process head`);
      wall += 2_000;
      assert.equal((await source.head()).seqno, 100, `${label}: later head polls keep succeeding`);
      healthy();
      const account = await source.getAccountState(address, { at: head });
      assert.equal(account.anchor!.shardBlock.seqno, 80, `${label}: an explicit-block account read is served`);
      const pinned = await source.read(calls, { at: head });
      assert.equal(pinned.head, head);
      assert.equal(pinned.results[0].kind === 'getter' && pinned.results[0].exitCode, 17, `${label}: an explicit-block batch is served`);
      const before = dispatchedGetters(peer), heads = headQueries(peer);
      await assert.rejects(source.read(calls), unavailable, `${label}: an unpinned current read is still refused`);
      assert.equal(dispatchedGetters(peer), before, `${label}: a stale current read dispatches no financial read`);
      assert.equal(headQueries(peer), heads + 1, `${label}: one bounded query does not repeat a valid stale answer`);
      healthy();
      assert.equal((await source.getAccountState(address, { at: head })).balance, '0', `${label}: a refused current read leaves pinned reads working`);
      assert.equal((await source.read(calls, { at: head })).head, head);
      healthy();
    } finally { clock.mock.restore(); await source.close(); }
  }
}

/** A current read still reaches a fresh peer when the preferred peer lags in wall time. */
async function stalePeerSkippedWithoutFault() {
  const lagging = new FakeLiteEngine(async request => request.kind === 'liteServer.getMasterchainInfoExt'
    ? { ...masterAnswer(proofBlock(100, now - 60, -1)), now } : getter(request));
  const current = new FakeLiteEngine(async request => request.kind === 'liteServer.getMasterchainInfoExt'
    ? masterAnswer(proofBlock(101, now, -1)) : getter(request));
  const source = sourceFor(lagging, current);
  try {
    const result = await source.read(calls);
    assert.equal(result.head.seqno, 101, 'A wall-clock-stale answer asks another peer within the same bounded query');
    assert.equal(headQueries(lagging), 1, 'The stale peer is asked once');
    assert.equal(dispatchedGetters(lagging) + dispatchedGetters(current), 1);
    assert.deepEqual(source.health().peers.map(row => [row.failures, row.open]), [[0, false], [0, false]],
      'A stale but valid answer is not a peer failure');
  } finally { await source.close(); }
}

async function main() {
  timeAndIdentity(); await boundedPeerSelection(); await currentAtCompletion(); await concurrentBoundary();
  await staleOrSkewedHeadServesExplicitBlocks(); await stalePeerSkippedWithoutFault();
  console.log('fresh process head: clock bounds, peer rejection, causal floor and concurrent pinned boundaries passed');
  console.log('fresh process head: a stalled chain or skewed clock serves explicit blocks, refuses unpinned current reads and fails no peer');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
