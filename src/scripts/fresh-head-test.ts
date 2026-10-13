import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { LiteClient, type LiteEngine } from 'ton-lite-client';
import type { TLFunction } from 'ton-tl';
import { PUBLIC_RPC_ZERO_STATES } from '../api/rpcNetwork';
import { BoundedLiteEngine, BoundedLiteQueryError } from '../data/boundedLiteEngine';
import type { TonDataSource } from '../data/dataSource';
import { FreshHeadFence, assertFreshLiteHeadTime, type FreshReadHeadFloor } from '../data/freshHead';
import { FreshReadUnavailableError, freshMasterchainBlock, type FreshReadBatch, type FreshReadCall } from '../data/freshRead';
import { LiteClientDataSource } from '../data/liteClientSource';
import { ResilientTonDataSource } from '../data/resilientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';

const address = `0:${'1'.repeat(64)}`;
const calls: FreshReadCall[] = [{ kind: 'getter', address, method: 'oracle_market_preview', args: [] }];
const block = (seqno: number, salt = 0) => ({ workchain: -1, shard: '-9223372036854775808', seqno,
  rootHash: Buffer.alloc(32, seqno + salt), fileHash: Buffer.alloc(32, seqno + salt + 1) });
const head = (seqno: number, salt = 0) => freshMasterchainBlock(block(seqno, salt));
const init = { workchain: -1, rootHash: PUBLIC_RPC_ZERO_STATES.testnet.root_hash, fileHash: PUBLIC_RPC_ZERO_STATES.testnet.file_hash };
const metadata = (seqno: number, age = 0, salt = 0) => ({ last: block(seqno, salt), init,
  lastUtime: Math.floor(Date.now() / 1_000) - age, now: Math.floor(Date.now() / 1_000) });
const logger = { info() {}, debug() {}, error() {}, warn() {} };
const batch = (seqno: number, salt = 0): FreshReadBatch => ({ network: 'testnet',
  readContext: { source: 'lite', head: head(seqno, salt), queriedAt: Date.now() },
  results: [{ kind: 'getter', address, exitCode: 17, stack: [] }] });
const stub = (readFresh: NonNullable<TonDataSource['readFresh']>): TonDataSource => ({ network: 'testnet', readFresh,
  async getMasterchainInfo() { throw Error('ordinary head forbidden'); }, async getAccountState() { throw Error('ordinary state forbidden'); },
  async getTransactions() { return []; }, async runGetMethod() { throw Error('ordinary getter forbidden'); },
  async getJettonBalance() { return null; }, async getJettonMetadata() { return null; }, async close() {} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fenceCases() {
  const fence = new FreshHeadFence();
  const initial = fence.capture();
  const original = head(100);
  fence.accept(original, initial);
  original.seqno = 1; original.rootHashHex = 'f'.repeat(64);
  const floor = fence.capture();
  assert.equal(floor.head?.seqno, 100, 'Retained identities own their immutable primitives');
  assert.throws(() => { (floor.head as any).seqno = 1; });
  fence.accept(head(102), floor);
  fence.accept(head(101), floor);
  assert.equal(fence.capture().head?.seqno, 102, 'A slower concurrent completion cannot lower the next causal floor');
  assert.throws(() => fence.assert(head(101), fence.capture()), FreshReadUnavailableError);
  assert.throws(() => fence.accept(head(100, 1), floor), FreshReadUnavailableError);
  assert.throws(() => fence.accept(head(102, 1), floor), FreshReadUnavailableError);
  assert.throws(() => fence.accept({ ...head(102), fileHashHex: 'f'.repeat(64) }, floor), FreshReadUnavailableError);
  assert.throws(() => fence.accept({ ...head(102), rootHashHex: 'f'.repeat(64) }, floor), FreshReadUnavailableError);
  assert.equal(fence.capture(initial).head, undefined, 'An inherited initially empty floor remains empty');
  assert.doesNotThrow(() => fence.accept(head(100), fence.capture(floor)));
}

function timeCases() {
  const nowMs = Date.now(), now = Math.floor(nowMs / 1_000);
  for (const age of [0, 30]) assertFreshLiteHeadTime({ lastUtime: now - age, now }, nowMs);
  assertFreshLiteHeadTime({ lastUtime: now + 5, now: now + 5 }, nowMs);
  for (const value of [
    { lastUtime: now - 31, now }, { lastUtime: now + 6, now: now + 6 },
    { lastUtime: now, now: now - 1 }, { lastUtime: now, now: now + 31 },
    { lastUtime: NaN, now }, { lastUtime: now, now: Infinity },
  ]) assert.throws(() => assertFreshLiteHeadTime(value, nowMs), FreshReadUnavailableError);
}

type QueryArgs = { timeout?: number; awaitSeqno?: number };
class Endpoint extends EventEmitter implements LiteEngine {
  seen: QueryArgs[] = [];
  constructor(public response: () => unknown) { super(); }
  async query<REQ, RES>(_f: TLFunction<REQ, RES>, _req: REQ, args: QueryArgs = {}): Promise<RES> {
    this.seen.push(args); return this.response() as RES;
  }
  close() {}
  isClosed() { return false; }
  isReady() { return true; }
}

async function boundedPeerSelection() {
  const stale = new Endpoint(() => metadata(200, 90));
  const behind = new Endpoint(() => metadata(99));
  const current = new Endpoint(() => metadata(101));
  const engine = new BoundedLiteEngine([stale, behind, current]);
  // Use the actual SDK metadata method: it must forward our validation and
  // awaitSeqno through the one existing engine deadline, not swallow them.
  const sdk = new LiteClient({ engine });
  let getters = 0;
  const client = { getMasterchainInfoExt: sdk.getMasterchainInfoExt,
    async runMethod(_a: unknown, _m: unknown, _args: unknown, at: ReturnType<typeof block>) {
      getters++; return { block: at, exitCode: 17, result: null };
    } };
  const source = Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource;
  const result = await source.readFresh(calls, undefined, { head: head(100) });
  assert.equal(result.readContext.head.seqno, 101);
  assert.equal(getters, 1, 'Rejected metadata peers never dispatch financial reads');
  for (const peer of [stale, behind, current]) {
    assert.equal(peer.seen.length, 1);
    assert.equal(peer.seen[0].awaitSeqno, 100);
    assert.deepEqual(Object.keys(peer.seen[0]).sort(), ['awaitSeqno', 'timeout'], 'Validation is local, not a wire field');
  }
  current.response = () => metadata(101, 0, 1);
  await assert.rejects(source.readFresh(calls), BoundedLiteQueryError);
  assert.equal(getters, 1, 'All three invalid peers fail closed without repeating a getter');
  engine.close();

  const malformed = new Endpoint(() => undefined);
  const wrongNetwork = new Endpoint(() => ({ ...metadata(102), init: {
    workchain: -1, rootHash: PUBLIC_RPC_ZERO_STATES.mainnet.root_hash, fileHash: PUBLIC_RPC_ZERO_STATES.mainnet.file_hash,
  } }));
  const healthy = new Endpoint(() => metadata(102));
  const recoveryEngine = new BoundedLiteEngine([malformed, wrongNetwork, healthy]);
  const recoverySdk = new LiteClient({ engine: recoveryEngine });
  const recovered = Reflect.construct(LiteClientDataSource, ['testnet', {
    ...client, getMasterchainInfoExt: recoverySdk.getMasterchainInfoExt,
  }, logger]) as LiteClientDataSource;
  assert.equal((await recovered.readFresh(calls)).readContext.head.seqno, 102);
  assert.ok([malformed, wrongNetwork, healthy].every(peer => peer.seen.length === 1));
  recoveryEngine.close();

  const owner = new AbortController();
  const aborting = new Endpoint(() => { owner.abort(); return metadata(100, 90); });
  const unused = new Endpoint(() => metadata(103));
  const cancelledEngine = new BoundedLiteEngine([aborting, unused]);
  const cancelledSdk = new LiteClient({ engine: cancelledEngine });
  const cancelled = Reflect.construct(LiteClientDataSource, ['testnet', {
    ...client, getMasterchainInfoExt: cancelledSdk.getMasterchainInfoExt,
  }, logger]) as LiteClientDataSource;
  await assert.rejects(cancelled.readFresh(calls, owner.signal), FreshReadUnavailableError);
  assert.equal(unused.seen.length, 0, 'Cancellation during stale metadata stops failover');
  cancelledEngine.close();
}

async function sourceCases(kind: 'lite' | 'http4') {
  let seqno = 100, salt = 0, getterCalls = 0, cancel: AbortController | undefined;
  let slow = deferred(); let gateSeqno = -1;
  const client = {
    async getMasterchainInfoExt() { return metadata(seqno, 0, salt); },
    async getLastBlock() { return metadata(seqno, 0, salt); },
    async runMethod(...args: unknown[]) {
      const at = kind === 'lite' ? args[3] as ReturnType<typeof block> : block(args[0] as number, salt);
      getterCalls++;
      if (at.seqno === gateSeqno) await slow.promise;
      cancel?.abort();
      return { block: at, exitCode: 17, result: kind === 'lite' ? null : [] };
    },
  };
  const source = kind === 'lite'
    ? Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource
    : Reflect.construct(TonClient4DataSource, ['testnet', client, []]) as TonClient4DataSource;
  await source.readFresh(calls);
  seqno = 101; gateSeqno = 101;
  const older = source.readFresh(calls); await tick();
  seqno = 102;
  await source.readFresh(calls);
  slow.resolve();
  assert.equal((await older).readContext.head.seqno, 101, `${kind}: valid out-of-order completion is accepted`);
  seqno = 101;
  await assert.rejects(source.readFresh(calls), FreshReadUnavailableError);
  assert.equal(getterCalls, 3, `${kind}: the retained102 floor rejects101 before getters`);
  seqno = 102; salt = 1;
  await assert.rejects(source.readFresh(calls), FreshReadUnavailableError);
  salt = 0; seqno = 200; cancel = new AbortController();
  await assert.rejects(source.readFresh(calls, cancel.signal), FreshReadUnavailableError);
  cancel = undefined; seqno = 103;
  assert.equal((await source.readFresh(calls)).readContext.head.seqno, 103, 'Cancelled200 did not poison the next floor');
  slow = deferred(); seqno = 104; salt = 1; gateSeqno = 104;
  const conflicting = source.readFresh(calls);
  const rejectedConflict = assert.rejects(conflicting, FreshReadUnavailableError);
  await tick();
  gateSeqno = -1; salt = 0;
  await source.readFresh(calls);
  slow.resolve(); await rejectedConflict;
}


async function completionAge() {
  const start = Date.now(); let clockMs = start;
  const clock = mock.method(Date, 'now', () => clockMs);
  try {
    let seqno = 200, delay = true;
    const client = { async getMasterchainInfoExt() { return metadata(seqno); },
      async runMethod(_a: unknown, _m: unknown, _args: unknown, at: ReturnType<typeof block>) {
        if (delay) clockMs += 31_000;
        return { block: at, exitCode: 0, result: null };
      } };
    const source = Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource;
    await assert.rejects(source.readFresh(calls), FreshReadUnavailableError);
    seqno = 100; delay = false;
    assert.equal((await source.readFresh(calls)).readContext.head.seqno, 100, 'Age-expired200 never advances the retained floor');
  } finally { clock.mock.restore(); }
}

async function resilientCases() {
  let primarySeqno = 100, fallbackSeqno = 99, failPrimary = false, fallbackCalls = 0;
  const floors: (FreshReadHeadFloor | undefined)[] = [];
  const primary = stub(async (_calls, _signal, floor) => {
    floors.push(floor); if (failPrimary) throw Error('peer down'); return batch(primarySeqno);
  });
  const fallback = stub(async (_calls, _signal, floor) => {
    floors.push(floor); fallbackCalls++; return { ...batch(fallbackSeqno), readContext: { ...batch(fallbackSeqno).readContext, source: 'http4' } };
  });
  const source = new ResilientTonDataSource(primary, fallback);
  await source.readFresh(calls);
  assert.equal(fallbackCalls, 0, 'VM exit17 is preserved, not a fallback trigger');
  failPrimary = true;
  await assert.rejects(source.readFresh(calls), FreshReadUnavailableError);
  assert.equal(floors.at(-1)?.head?.seqno, 100, 'Fallback inherits the exact primary request floor');
  fallbackSeqno = 101;
  await source.readFresh(calls);
  failPrimary = false; primarySeqno = 100; fallbackSeqno = 102;
  assert.equal((await source.readFresh(calls)).readContext.head.seqno, 102, 'A recovered primary cannot regress a head established by fallback');

  const slow = deferred(); let count = 0;
  const concurrent = new ResilientTonDataSource(stub(async () => {
    if (++count === 1) { await slow.promise; throw Error('slow primary failed'); }
    return batch(110);
  }), stub(async (_calls, _signal, floor) => {
    assert.equal(floor?.head, undefined, 'Fallback does not capture a newer unrelated completion');
    return batch(100);
  }));
  const older = concurrent.readFresh(calls); await tick();
  await concurrent.readFresh(calls); slow.resolve();
  assert.equal((await older).readContext.head.seqno, 100, 'Slow valid fallback is accepted against original empty floor');
  primarySeqno = 109;
  // A subsequent caller still captures110, despite that older completion.
  const captured: FreshReadHeadFloor[] = [];
  Object.defineProperty(concurrent, 'primary', { value: stub(async (_calls, _signal, floor) => {
    captured.push(floor!); return batch(109);
  }) });
  Object.defineProperty(concurrent, 'fallback', { value: stub(async (_calls, _signal, floor) => {
    captured.push(floor!); return batch(110);
  }) });
  assert.equal((await concurrent.readFresh(calls)).readContext.head.seqno, 110);
  assert.ok(captured.every(floor => floor.head?.seqno === 110));
}

async function main() {
  fenceCases(); timeCases();
  await boundedPeerSelection();
  await sourceCases('lite'); await sourceCases('http4');
  await completionAge(); await resilientCases();
  console.log('fresh head floors ok (bounded peer selection, block age, concurrency, immutable identity, source fallback and cancellation)');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
