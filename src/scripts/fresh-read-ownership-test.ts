import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';
import { ChainReadError } from '../data/dataSource';
import { executeFreshCalls, FreshReadUnavailableError, type FreshReadCall, type FreshReadResult } from '../data/freshRead';
import { createLiteChainSource } from '../data/liteClientSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { errorDiagnostic } from '../utils/logger';
import { loadOpcodes } from '../utils/opcodes';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { fakeChainSource } from './support/fakeChainSource';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function within<T>(operation: Promise<T>, description: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Test timed out waiting for ${description}`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
const address = `0:${'1'.repeat(64)}`;
const calls: FreshReadCall[] = Array.from({ length: 8 }, (_, index) => ({ kind: 'getter', address, method: `read_${index}`, args: [] }));
const result = (call: FreshReadCall): FreshReadResult => ({ kind: 'getter', address: call.address, exitCode: 17, stack: [] });
const head = { workchain: -1, shard: '-9223372036854775808', seqno: 100, utime: Math.floor(Date.now() / 1_000),
  rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) };
const logger = { info() {}, debug() {}, error() {}, warn() {} };

async function workerOwnership() {
  for (const firstFailure of [new Error('first read failed'), undefined]) {
    const gates = calls.map(() => deferred());
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    let returned = false;
    const operation = executeFreshCalls(calls, async (call, signal) => {
      const index = calls.indexOf(call); started.push(index); signals.push(signal);
      await gates[index].promise;
      if (index === 0) throw firstFailure;
      return result(call);
    }).then(() => { throw Error('failure was lost'); }, error => { returned = true; assert.equal(error, firstFailure); });
    assert.deepEqual(started, [0, 1, 2, 3]);
    gates[0].resolve(); await tick();
    assert.equal(returned, false, 'First failure retains ownership until all active calls drain');
    assert.ok(signals.every(signal => signal.aborted), 'Active siblings receive cancellation');
    for (const index of [3, 2, 1]) gates[index].resolve();
    await operation; await tick();
    assert.deepEqual(started, [0, 1, 2, 3], 'Unstarted calls never dispatch after any failure, including throw undefined');
  }
  const gates = calls.map(() => deferred());
  const started: number[] = [];
  const successful = executeFreshCalls(calls, async call => {
    const index = calls.indexOf(call); started.push(index); await gates[index].promise;
    return { ...result(call), stack: [{ type: 'int', value: BigInt(index) }] } as FreshReadResult;
  });
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const index of [3, 2, 1, 0, 7, 6, 5, 4]) { gates[index].resolve(); await tick(); }
  assert.deepEqual(await successful, calls.map((call, index) => ({ ...result(call), stack: [{ type: 'int', value: BigInt(index) }] })));
  assert.equal(started.length, 8, 'Success preserves concurrency and input result order');
}

async function realDisconnect() {
  const entered = deferred(); const aborted = deferred(); const gate = deferred();
  const source = fakeChainSource({ read: async (requested, options) => {
    const signal = options?.signal;
    assert.ok(signal); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    entered.resolve(); await gate.promise;
    return { head, results: requested.map(result) };
  } });
  const config = { ...loadConfig(), network: 'testnet' as const };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(), []);
  const runtime = runtimeManifestFixture();
  const app = Fastify({ logger: false });
  registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, {},
    { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' });
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    request = httpRequest(`${url}/api/indexer/v1/readFresh`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    request.on('error', () => {}); request.end(JSON.stringify({ calls: [{ kind: 'getter', address, method: 'read_0', stack: [] }] }));
    await within(entered.promise, 'HTTP source entry');
    request.destroy(); await within(aborted.promise, 'HTTP disconnect cancellation');
    gate.resolve(); await tick();
  } finally { request?.destroy(); gate.resolve(); await app.close(); }
}

async function sourceCancellation() {
  const block = proofBlock(100, Math.floor(Date.now() / 1_000), -1);
  for (const cancelAtHead of [true, false]) {
    const entered = deferred(), gate = deferred();
    let reads = 0;
    const peer = new FakeLiteEngine(async request => {
      if (request.kind === 'liteServer.getMasterchainInfoExt') {
        if (cancelAtHead) { entered.resolve(); await gate.promise; }
        return masterAnswer(block);
      }
      reads++;
      if (reads === 4) entered.resolve();
      await gate.promise;
      return { id: request.id, shardblk: request.id, exitCode: 17, result: null };
    });
    const source = createLiteChainSource({ network: 'testnet', logger,
      peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => peer });
    const owner = new AbortController();
    try {
      const operation = source.read(calls, { signal: owner.signal });
      const rejected = assert.rejects(operation, ChainReadError);
      await within(entered.promise, 'owned source entry');
      owner.abort(); await rejected; await tick();
      assert.equal(peer.active, 0, 'Real cancellable wire ownership ends on cancellation');
      assert.equal(reads, cancelAtHead ? 0 : 4, 'Cancelled head or batch cannot dispatch queued getters');
      gate.resolve(); await tick();
      assert.equal(reads, cancelAtHead ? 0 : 4, 'Late underlying work cannot launch another batch');
    } finally { gate.resolve(); await source.close(); }
  }
  const cancelled = new AbortController(); cancelled.abort(); let dispatched = 0;
  await assert.rejects(executeFreshCalls(calls, async call => { dispatched++; return result(call); }, cancelled.signal), FreshReadUnavailableError);
  assert.equal(dispatched, 0);
}

async function siblingFailure() {
  const block = proofBlock(100, Math.floor(Date.now() / 1_000), -1);
  const source = createLiteChainSource({ network: 'testnet', logger,
    peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }],
    engineFactory: () => new FakeLiteEngine(async () => masterAnswer(block)) });
  const started: string[] = [], signals: AbortSignal[] = [];
  source.runGetMethod = async (_address, method, _args, options) => {
    started.push(method); signals.push(options!.signal!);
    if (method === 'read_0') { await tick(); throw new ChainReadError('upstream_unavailable'); }
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    options!.signal!.throwIfAborted();
    return { exitCode: 17, stack: [] };
  };
  try {
    await within(assert.rejects(source.read(calls), ChainReadError), 'failed sibling cancellation');
    assert.deepEqual(started, ['read_0', 'read_1', 'read_2', 'read_3']);
    assert(signals.every(signal => signal.aborted), 'The first failure cancels active siblings before returning');
  } finally { await source.close(); }
}

async function diagnosticCauses() {
  const upstream = new Error('Timeout'); Object.assign(upstream, { password: 'private property', stack: 'private stack' });
  const many = errorDiagnostic(new AggregateError(Array(5).fill(upstream), 'peers'));
  assert.equal((many.errors as unknown[]).length, 4); assert.equal(many.errorsTruncated, true);
  const source = fakeChainSource({ read: async () => { throw new ChainReadError('upstream_unavailable', { cause: upstream }); } });
  const config = { ...loadConfig(), network: 'testnet' as const };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(), []);
  const runtime = runtimeManifestFixture(), warnings: Record<string, unknown>[] = [];
  const app = Fastify({ logger: false });
  registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, {},
    { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' },
    { logger: { ...logger, warn(_message, detail) { warnings.push(detail!); } } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh',
      payload: { calls: [{ kind: 'getter', address, method: 'read_0', stack: [] }] } });
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'upstream_unavailable');
    assert(!response.body.includes('Timeout'), 'Public failure never exposes upstream causes');
    assert.equal(warnings.length, 1); assert.equal(warnings[0].manifestHash, runtime.manifestHash);
    assert(JSON.stringify(warnings[0].error).includes('Timeout')); assert(!JSON.stringify(warnings[0].error).includes('private'));
  } finally { await app.close(); }
}

async function main() {
  await workerOwnership(); await sourceCancellation(); await siblingFailure(); await realDisconnect(); await diagnosticCauses();
  console.log('fresh read cancellation, owned drain, queued-call suppression and HTTP disconnect passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
