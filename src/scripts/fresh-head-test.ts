import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { ChainReadError } from '../data/dataSource';
import { HeadTracker } from '../data/headTracker';
import { assertFreshHeadTime, assertFreshLiteHeadTime } from '../data/freshHead';
import { createLiteChainSource } from '../data/liteClientSource';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';

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
  assert.throws(() => tracker.accept(masterAnswer(proofBlock(101, now - 31, -1))), ChainReadError);
  assert.equal(tracker.current()?.seqno, 100, 'Rejected peers cannot replace the authenticated process head');
  const clock = mock.method(Date, 'now', () => (now + 31) * 1_000);
  try { assert.equal(tracker.fresh(), null, 'Expired block time cannot be reused as current'); }
  finally { clock.mock.restore(); }
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

async function main() {
  timeAndIdentity(); await boundedPeerSelection(); await currentAtCompletion(); await concurrentBoundary();
  console.log('fresh process head: clock bounds, peer rejection, causal floor and concurrent pinned boundaries passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
