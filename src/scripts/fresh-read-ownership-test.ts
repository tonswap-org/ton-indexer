import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mock } from 'node:test';
import Fastify from 'fastify';
import type { LiteEngine } from 'ton-lite-client';
import type { TLFunction } from 'ton-tl';
import { withFreshReadDeadline } from '../api/freshReadRequest';
import { registerRoutes } from '../api/routes';
import { PUBLIC_RPC_ZERO_STATES } from '../api/rpcNetwork';
import { loadConfig } from '../config';
import { BoundedLiteEngine } from '../data/boundedLiteEngine';
import type { TonDataSource } from '../data/dataSource';
import { executeFreshCalls, FreshReadUnavailableError, type FreshReadBatch, type FreshReadCall, type FreshReadResult } from '../data/freshRead';
import { LiteClientDataSource } from '../data/liteClientSource';
import { ResilientTonDataSource } from '../data/resilientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { errorDiagnostic } from '../utils/logger';
import { loadOpcodes } from '../utils/opcodes';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

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
const batch = (results = calls.map(result)): FreshReadBatch => ({ network: 'testnet',
  readContext: { source: 'lite', queriedAt: Date.now(), head: { workchain: -1, shard: '-9223372036854775808', seqno: 100,
    rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) } }, results });
const stub = (readFresh: NonNullable<TonDataSource['readFresh']>): TonDataSource => ({ network: 'testnet', readFresh,
  async getMasterchainInfo() { return { seqno: 1 }; }, async getAccountState() { throw Error('ordinary state forbidden'); },
  async getTransactions() { return []; }, async runGetMethod() { throw Error('ordinary getter forbidden'); },
  async getJettonBalance() { return null; }, async getJettonMetadata() { return null; }, async close() {} });
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

async function cancellationAndFallback() {
  const cancelled = new AbortController(); cancelled.abort(new Error('caller stopped'));
  let dispatched = 0;
  await assert.rejects(executeFreshCalls(calls, async call => { dispatched++; return result(call); }, cancelled.signal), FreshReadUnavailableError);
  assert.equal(dispatched, 0);
  for (const cancel of [false, true]) {
    const owner = new AbortController();
    const gates = calls.map(() => deferred());
    const started: number[] = [];
    let fallbackStarts = 0;
    const primary = stub(async (requested, signal) => batch(await executeFreshCalls(requested, async call => {
      const index = calls.indexOf(call); started.push(index); await gates[index].promise;
      if (index === 0 && !cancel) throw new Error('primary failed');
      return result(call);
    }, signal)));
    const fallback = stub(async () => { fallbackStarts++; return batch(); });
    const operation = new ResilientTonDataSource(primary, fallback).readFresh(calls, owner.signal);
    const outcome = operation.then(value => value, error => error);
    if (cancel) owner.abort(new Error('caller stopped'));
    else gates[0].resolve();
    await tick();
    assert.equal(fallbackStarts, 0, 'Fallback cannot overlap active primary siblings');
    for (let index = 0; index < 4; index++) gates[index].resolve();
    const observed = await outcome;
    assert.deepEqual(started, [0, 1, 2, 3]);
    assert.equal(fallbackStarts, cancel ? 0 : 1, 'Caller cancellation never starts fallback');
    if (cancel) assert.ok(observed instanceof FreshReadUnavailableError);
    else assert.equal(observed.results[0].exitCode, 17, 'An actual nonzero VM outcome is not infrastructure failure');
  }
}

async function deadlineOwnership() {
  const owner = new AbortController();
  const gates = calls.map(() => deferred());
  const started: number[] = [];
  let fireDeadline!: () => void;
  const timer = mock.method(globalThis, 'setTimeout', (callback: () => void) => {
    fireDeadline = callback; return -1 as any;
  });
  let draining!: Promise<FreshReadResult[]>;
  try {
    const request = withFreshReadDeadline(signal => {
      draining = executeFreshCalls(calls, async call => {
        const index = calls.indexOf(call); started.push(index); await gates[index].promise; return result(call);
      }, signal);
      return draining;
    }, owner, 18_000);
    const rejected = assert.rejects(request, FreshReadUnavailableError);
    await tick();
    assert.deepEqual(started, [0, 1, 2, 3]);
    fireDeadline(); await rejected;
    assert.equal(owner.signal.aborted, true, 'The HTTP deadline aborts the same source owner');
    for (let index = 0; index < 4; index++) gates[index].resolve();
    await assert.rejects(draining, FreshReadUnavailableError);
    assert.deepEqual(started, [0, 1, 2, 3], 'Deadline outcome leaves no queued source dispatch');
  } finally { timer.mock.restore(); }
}

async function sourceCancellation() {
  const head = { workchain: -1, shard: '-9223372036854775808', seqno: 100, rootHash: Buffer.alloc(32, 1), fileHash: Buffer.alloc(32, 2) };
  const init = { workchain: -1, rootHash: PUBLIC_RPC_ZERO_STATES.testnet.root_hash, fileHash: PUBLIC_RPC_ZERO_STATES.testnet.file_hash };
  for (const kind of ['lite', 'http4'] as const) {
    const owner = new AbortController(); const gate = deferred(); let reads = 0;
    const headRead = async (args?: { signal?: AbortSignal }) => {
      if (kind === 'lite') assert.equal(args?.signal, owner.signal, 'Lite head wire receives caller ownership');
      await gate.promise; return { last: head, init, lastUtime: Math.floor(Date.now() / 1_000), now: Math.floor(Date.now() / 1_000) };
    };
    const client = { getMasterchainInfoExt: headRead, getLastBlock: headRead,
      async getAccountStateRaw() { reads++; throw Error('must not read'); },
      async runMethod() { reads++; throw Error('must not read'); } };
    const source = kind === 'lite' ? Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource
      : Reflect.construct(TonClient4DataSource, ['testnet', client, ['https://one.invalid', 'https://two.invalid']]) as TonClient4DataSource;
    let rotations = 0;
    if (kind === 'http4') Object.defineProperty(source, 'rotateEndpoint', { value: () => { rotations++; } });
    const operation = source.readFresh(calls, owner.signal);
    const rejected = assert.rejects(operation, FreshReadUnavailableError);
    owner.abort(new Error('caller stopped')); gate.resolve(); await rejected;
    assert.equal(reads, 0, 'Cancelled head cannot start any account/getter reads');
    assert.equal(rotations, 0, 'Cancelled HTTP call cannot rotate or retry endpoints');
  }
  const mixedCalls: FreshReadCall[] = calls.map((call, index) => index % 2 ? call : { kind: 'account', address });
  const ownerOfBatch = new AbortController(); const activeGate = deferred();
  const wireSignals: AbortSignal[] = [];
  const client = {
    async getMasterchainInfoExt() { return { last: head, init, lastUtime: Math.floor(Date.now() / 1_000), now: Math.floor(Date.now() / 1_000) }; },
    async getAccountStateRaw(_address: unknown, _block: unknown, args: { signal: AbortSignal }) {
      wireSignals.push(args.signal); await activeGate.promise;
      return { block: head, state: null, balance: { coins: 0n }, lastTx: null };
    },
    async runMethod(_address: unknown, _method: string, _args: unknown, _block: unknown, args: { signal: AbortSignal }) {
      wireSignals.push(args.signal); await activeGate.promise;
      return { block: head, exitCode: 17, result: null };
    },
  };
  const lite = Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource;
  const active = lite.readFresh(mixedCalls, ownerOfBatch.signal);
  const cancelledActive = assert.rejects(active, FreshReadUnavailableError);
  await tick();
  assert.equal(wireSignals.length, 4, 'Only four real source reads begin');
  assert.ok(wireSignals.every(signal => signal === wireSignals[0]), 'Raw accounts and getters share batch wire ownership');
  ownerOfBatch.abort(new Error('client stopped'));
  assert.ok(wireSignals.every(signal => signal.aborted));
  activeGate.resolve(); await cancelledActive;
  assert.equal(wireSignals.length, 4, 'Source cancellation never starts a fifth raw account/getter');
  class Endpoint extends EventEmitter implements LiteEngine {
    calls = 0;
    readonly gate = deferred();
    async query<REQ, RES>(): Promise<RES> { this.calls++; await this.gate.promise; throw Error('Timeout'); }
    close() {} isClosed() { return false; } isReady() { return true; }
  }
  const endpoint = new Endpoint(); const engine = new BoundedLiteEngine([endpoint]);
  const owner = new AbortController();
  const wire = engine.query({} as TLFunction<{}, number>, {}, { signal: owner.signal });
  const rejected = assert.rejects(wire, FreshReadUnavailableError);
  owner.abort(new Error('caller stopped')); endpoint.gate.resolve(); await rejected;
  assert.equal(endpoint.calls, 1, 'Owned active wire drains without starting retry');
  engine.close();
}

async function realDisconnect() {
  const entered = deferred(); const aborted = deferred(); const gate = deferred();
  const source = stub(async (requested, signal) => {
    assert.ok(signal); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    entered.resolve(); await gate.promise;
    return batch(requested.map(result));
  });
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

async function diagnosticCauses() {
  const upstream = new Error('Timeout'); Object.assign(upstream, { password: 'private property', stack: 'private stack' });
  const source = new ResilientTonDataSource(stub(async () => { throw upstream; }), stub(async () => { throw new Error('HTTP unavailable'); }));
  await assert.rejects(source.readFresh(calls), (error: Error) => {
    const diagnostic = errorDiagnostic(error);
    assert.deepEqual((diagnostic.cause as any).errors, [{ name: 'Error', message: 'Timeout' }, { name: 'Error', message: 'HTTP unavailable' }]);
    assert.ok(!JSON.stringify(diagnostic).includes('private')); return true;
  });
  const many = errorDiagnostic(new AggregateError(Array(5).fill(upstream), 'sources'));
  assert.equal((many.errors as unknown[]).length, 4); assert.equal(many.errorsTruncated, true);
  const config = { ...loadConfig(), network: 'testnet' as const };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(), []);
  const runtime = runtimeManifestFixture();
  const warnings: Record<string, unknown>[] = [];
  const app = Fastify({ logger: false });
  registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, {},
    { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' },
    { ...logger, warn(_message, detail) { warnings.push(detail!); } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh',
      payload: { calls: [{ kind: 'getter', address, method: 'read_0', stack: [] }] } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'fresh_read_unavailable');
    assert.ok(!response.body.includes('Timeout'), 'Public failure never exposes upstream causes');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].calls, 1);
    assert.equal(warnings[0].manifestHash, runtime.manifestHash);
    assert.ok(JSON.stringify(warnings[0].error).includes('Timeout'), 'Production logger receives the underlying fresh-source failure');
  } finally { await app.close(); }
}

async function main() {
  await workerOwnership(); await cancellationAndFallback(); await deadlineOwnership();
  await sourceCancellation(); await realDisconnect(); await diagnosticCauses();
  console.log('fresh read cancellation, owned drain, fallback and HTTP disconnect ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
