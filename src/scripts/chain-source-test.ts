import assert from 'node:assert/strict';
import { beginCell, serializeTuple, type TupleItem } from '@ton/core';
import { setTimeout as delay } from 'node:timers/promises';
import { createLiteChainSource } from '../data/liteClientSource';
import { ChainReadError, type ChainHead } from '../data/dataSource';
import { HeadTracker } from '../data/headTracker';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';

const currentTime = Math.floor(Date.now() / 1_000);
const logger = { info() {}, debug() {}, error() {}, warn() {} };
const address = `0:${'a'.repeat(64)}`;
const mc = proofBlock(100, currentTime, -1), shard = proofBlock(80, currentTime - 1);
const at: ChainHead = { workchain: -1, shard: mc.id.shard, seqno: mc.id.seqno, rootHashHex: mc.id.rootHash.toString('hex'),
  fileHashHex: mc.id.fileHash.toString('hex'), utime: currentTime };
function answer(req: any): unknown {
  if (req.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(mc);
  if (req.kind === 'liteServer.runSmcMethod') return { id: req.id, shardblk: shard.id, exitCode: 3001, result: serializeTuple([]).toBoc() };
  if (req.kind === 'liteServer.getAccountState') return { id: req.id, shardblk: shard.id, state: Buffer.alloc(0), proof: shard.proof, shardProof: Buffer.alloc(0) };
  throw new Error(`unexpected wire ${req.kind}`);
}
const sourceFor = (...engines: FakeLiteEngine[]) => createLiteChainSource({ network: 'testnet', logger,
  peers: engines.map((_, port) => ({ host: '127.0.0.1', port: 1000 + port, publicKey: Buffer.alloc(32) })),
  engineFactory: peer => engines[peer.port - 1000] });
const code = (name: string) => (error: unknown) => error instanceof ChainReadError && error.code === name;

async function main() {
  let created = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network discovery forbidden'); };
  const lazy = createLiteChainSource({ network: 'testnet', logger, peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }],
    engineFactory: () => { created++; return new FakeLiteEngine(async req => answer(req)); } });
  try { assert.equal(created, 0); assert.equal(lazy.health().peersReady, 0); await lazy.head(); assert.equal(created, 1); }
  finally { globalThis.fetch = originalFetch; await lazy.close(); }

  const tracker = new HeadTracker('testnet');
  assert.equal(tracker.accept(masterAnswer(mc)).seqno, 100);
  assert.throws(() => tracker.accept(masterAnswer(proofBlock(99, currentTime - 1, -1))));
  assert.throws(() => tracker.accept(masterAnswer(proofBlock(100, currentTime + 1, -1))));
  assert.throws(() => tracker.accept({ ...masterAnswer(mc), lastUtime: 0 }));
  assert.equal(tracker.current()!.seqno, 100);
  assert.equal(new HeadTracker('testnet', () => { throw new Error('observer failed'); }).accept(masterAnswer(mc)).seqno, 100);

  let firstHead = mc;
  const lagging = new FakeLiteEngine(async req => req.kind === 'liteServer.getMasterchainInfoExt' ? masterAnswer(firstHead) : answer(req));
  const current = new FakeLiteEngine(async req => req.kind === 'liteServer.getMasterchainInfoExt' ? masterAnswer(proofBlock(101, currentTime + 1, -1)) : answer(req));
  const monotonic = sourceFor(lagging, current);
  try {
    assert.equal((await monotonic.head()).seqno, 100);
    firstHead = proofBlock(99, currentTime - 1, -1);
    await delay(1_010);
    assert.equal((await monotonic.head()).seqno, 101, 'lagging first answer is skipped');
    assert.equal(monotonic.health().head!.seqno, 101);
  } finally { await monotonic.close(); }

  const peer = new FakeLiteEngine(async req => answer(req)), fallback = new FakeLiteEngine(async () => { throw new Error('VM denial must not fail over'); });
  const source = sourceFor(peer, fallback);
  try {
    const cell = beginCell().storeUint(7, 8).endCell();
    const args: TupleItem[] = [{ type: 'slice', cell }, { type: 'cell', cell }];
    const result = await source.runGetMethod(address, 'denied', args, { at });
    assert.equal(result.exitCode, 3001);
    assert.equal(fallback.requests.length, 0);
    const call = peer.requests[0];
    assert.ok(call.request.params.equals(serializeTuple(args).toBoc({ idx: false, crc32: false })));
    assert.equal(call.options.awaitSeqno, 100);
    const account = await source.getAccountState(address, { at });
    assert.equal(account.anchor!.genUtime, currentTime - 1);
    assert.equal(account.anchor!.shardBlock.seqno, 80);
    assert.equal(account.balance, '0');
    const batch = await source.read([{ kind: 'account', address }, { kind: 'getter', address, method: 'x', args: [] }], { at });
    assert.deepEqual(batch.head, at);
    assert.equal(batch.results.length, 2);
  } finally { await source.close(); }

  const wrong = new FakeLiteEngine(async req => ({ ...(answer(req) as object), id: proofBlock(99, currentTime - 1, -1).id }));
  const badSource = sourceFor(wrong);
  try { await assert.rejects(badSource.getAccountState(address, { at }), code('upstream_unavailable')); }
  finally { await badSource.close(); }

  const hung = new FakeLiteEngine(async () => new Promise(() => {}));
  const hanging = sourceFor(hung);
  try {
    const controller = new AbortController();
    const reads = [hanging.runGetMethod(address, 'hang', [], { at, signal: controller.signal }),
      hanging.runGetMethod(address, 'hang', [], { at, signal: controller.signal })];
    await delay(20);
    assert.equal(hung.requests.length, 1, 'same block/getter joins one flight');
    controller.abort();
    for (const read of reads) await assert.rejects(read, code('upstream_timeout'));
    await delay(0);
    assert.equal(hung.active, 0, 'aborting removes the real pending fake wire query');
    const next = hanging.runGetMethod(address, 'hang', [], { at, signal: AbortSignal.timeout(30) });
    await assert.rejects(next, code('upstream_timeout'));
    assert.equal(hung.requests.length, 2, 'a timed-out flight cannot poison the next request');
    assert.equal(hung.maximumActive, 1);
  } finally { await hanging.close(); }

  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sharedPeer = new FakeLiteEngine(async req => { await blocked; return answer(req); });
  const sharedSource = sourceFor(sharedPeer);
  try {
    const first = new AbortController();
    const cancelled = sharedSource.runGetMethod(address, 'shared', [], { at, signal: first.signal });
    const live = sharedSource.runGetMethod(address, 'shared', [], { at });
    await delay(10); first.abort();
    await assert.rejects(cancelled, code('upstream_timeout'));
    assert.equal(sharedPeer.active, 1, 'one caller cancellation leaves another subscriber alive');
    release();
    assert.equal((await live).exitCode, 3001);
    assert.equal(sharedPeer.requests.length, 1);
  } finally { release(); await sharedSource.close(); }

  const recovering = new FakeLiteEngine(async req => answer(req)); recovering.ready = false;
  const recoveringSource = sourceFor(recovering);
  try {
    await assert.rejects(recoveringSource.head(), code('upstream_unavailable'));
    recovering.ready = true;
    assert.equal((await recoveringSource.head()).seqno, 100);
  } finally { await recoveringSource.close(); }
  console.log('Chain source: monotonic head, pinned block, cancellable sharing, exact getter arguments, VM denials and lazy recovery passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
