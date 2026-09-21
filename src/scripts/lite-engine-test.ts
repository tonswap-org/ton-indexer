import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { mock } from 'node:test';
import type { LiteEngine } from 'ton-lite-client';
import type { TLFunction } from 'ton-tl';
import { BoundedLiteEngine, BoundedLiteQueryError } from '../data/boundedLiteEngine';

const method = {} as TLFunction<{}, number>;
type Args = { timeout?: number; awaitSeqno?: number };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Endpoint extends EventEmitter implements LiteEngine {
  ready = true;
  closed = false;
  calls: Args[] = [];
  constructor(public handler: (args: Args) => Promise<unknown>) { super(); }
  async query<REQ, RES>(_f: TLFunction<REQ, RES>, _req: REQ, args: Args = {}): Promise<RES> {
    this.calls.push(args);
    return await this.handler(args) as RES;
  }
  close() { this.closed = true; this.ready = false; this.emit('close'); }
  isReady() { return this.ready; }
  isClosed() { return this.closed; }
}

// Keep the clock seam local to tests and restore it before any real-timer work.
async function withClock(run: (advance: (ms: number) => void) => Promise<void>) {
  let now = 1_000;
  const original = performance.now;
  const clock = mock.method(performance, 'now', () => now);
  try {
    await run((ms) => {
      assert.ok(Number.isFinite(ms) && ms >= 0, 'The test clock must be monotonic');
      now += ms;
    });
  } finally {
    clock.mock.restore();
    assert.equal(performance.now, original);
  }
}

async function deterministicBudgets() {
  // A fractional remainder does not authorize a one-millisecond extension.
  // A full remaining millisecond does authorize one more bounded dispatch.
  for (const elapsed of [[40.25, 19.25], [40, 19, 1]]) {
    await withClock(async (advance) => {
      const endpoint = new Endpoint(async () => {
        advance(elapsed[endpoint.calls.length - 1]);
        throw new Error('Timeout');
      });
      const engine = new BoundedLiteEngine([endpoint], { timeoutMs: 500, attemptTimeoutMs: 40, maxAttempts: 5 });
      try {
        await assert.rejects(engine.query(method, {}, { timeout: 60, awaitSeqno: 100 }),
          new RegExp(`failed after ${elapsed.length} attempts`));
        assert.deepEqual(endpoint.calls, elapsed.length === 2
          ? [{ timeout: 40, awaitSeqno: 100 }, { timeout: 19, awaitSeqno: 100 }]
          : [{ timeout: 40, awaitSeqno: 100 }, { timeout: 20, awaitSeqno: 100 }, { timeout: 1, awaitSeqno: 100 }]);
      } finally { engine.close(); }
    });
  }

  await withClock(async (advance) => {
    const endpoint = new Endpoint(async ({ timeout }) => { advance(timeout!); throw new Error('Timeout'); });
    const engine = new BoundedLiteEngine([endpoint], { timeoutMs: 60, attemptTimeoutMs: 40, maxAttempts: 5 });
    try {
      await assert.rejects(engine.query(method, {}, { timeout: 1_000 }), /failed after 2 attempts/);
      assert.deepEqual(endpoint.calls.map((call) => call.timeout), [40, 20], 'The configured total budget caps a larger caller budget');
    } finally { engine.close(); }
  });

  await withClock(async () => {
    const failure = new Error('state unavailable');
    const endpoint = new Endpoint(async () => { throw failure; });
    const engine = new BoundedLiteEngine([endpoint], { timeoutMs: 500, attemptTimeoutMs: 10, maxAttempts: 3 });
    try {
      await assert.rejects(engine.query(method, {}), (error: Error) => {
        assert.match(error.message, /failed after 3 attempts/);
        assert.equal(error.cause, failure);
        return true;
      });
      assert.deepEqual(endpoint.calls.map((call) => call.timeout), [10, 10, 10], 'Immediate failures still consume the exact attempt cap');
    } finally { engine.close(); }
  });

  for (const consumedDuringSelection of [0, 59.5, 60, 60.5]) {
    await withClock(async (advance) => {
      const endpoint = new Endpoint(async () => { throw new Error('Must not dispatch'); });
      endpoint.isReady = () => { advance(consumedDuringSelection); return true; };
      const engine = new BoundedLiteEngine([endpoint], { timeoutMs: 60, attemptTimeoutMs: 40, maxAttempts: 3 });
      try {
        await assert.rejects(engine.query(method, {}, { timeout: consumedDuringSelection === 0 ? 0.5 : 60 }), /failed after 0 attempts/);
        assert.deepEqual(endpoint.calls, [], 'Budget is checked again after endpoint selection');
      } finally { engine.close(); }
    });
  }

  for (const selectedReady of [false, true]) {
    await withClock(async () => {
      const endpoint = new Endpoint(async () => { throw new Error('Must not dispatch'); });
      const engine = new BoundedLiteEngine([endpoint]);
      endpoint.isReady = () => { engine.close(); return selectedReady; };
      const timer = mock.method(globalThis, 'setTimeout', () => { throw new Error('Must not wait after close'); });
      try {
        await assert.rejects(engine.query(method, {}), /Engine is closed/);
        assert.deepEqual(endpoint.calls, []);
        assert.equal(timer.mock.callCount(), 0);
      } finally { timer.mock.restore(); engine.close(); }
    });
  }
}

async function deterministicConnections() {
  for (const recovery of [false, true]) {
    await withClock(async (advance) => {
      const endpoint = new Endpoint(async () => 42);
      endpoint.ready = false;
      const engine = new BoundedLiteEngine([endpoint], { timeoutMs: 60, attemptTimeoutMs: 40, maxAttempts: 1 });
      const waits: number[] = [];
      // Simulate timer delivery with explicit elapsed time, including a fractional
      // scheduling delay. The real timer lifecycle is checked separately below.
      const timer = mock.method(globalThis, 'setTimeout', (callback: () => void, delay?: number) => {
        assert.ok(Number.isSafeInteger(delay) && delay! >= 1 && delay! <= 25);
        waits.push(delay!);
        advance(delay! + 0.25);
        if (recovery) endpoint.ready = true;
        queueMicrotask(callback);
        return {} as ReturnType<typeof setTimeout>;
      });
      try {
        if (recovery) {
          assert.equal(await engine.query(method, {}, { awaitSeqno: 100 }), 42);
          assert.deepEqual(waits, [25]);
          assert.deepEqual(endpoint.calls, [{ awaitSeqno: 100, timeout: 34 }], 'Waiting consumes time, but does not consume a dispatch attempt');
        } else {
          await assert.rejects(engine.query(method, {}), /failed after 0 attempts/);
          assert.deepEqual(waits, [25, 25, 9], 'No wait is rounded up from the final fractional remainder');
          assert.deepEqual(endpoint.calls, []);
        }
      } finally { timer.mock.restore(); engine.close(); }
    });
  }

  await withClock(async (advance) => {
    const endpoint = new Endpoint(async () => 1);
    endpoint.isReady = () => { advance(60); return false; };
    const engine = new BoundedLiteEngine([endpoint], { timeoutMs: 60, attemptTimeoutMs: 20, maxAttempts: 3 });
    const timer = mock.method(globalThis, 'setTimeout', () => { throw new Error('Must not wait after deadline'); });
    try {
      await assert.rejects(engine.query(method, {}), /failed after 0 attempts/);
      assert.equal(timer.mock.callCount(), 0);
      assert.deepEqual(endpoint.calls, []);
    } finally { timer.mock.restore(); engine.close(); }
  });
}

async function realTimerLifecycle() {
  let active = 0;
  const dead = new Endpoint(async ({ timeout }) => {
    active += 1;
    try { await sleep(timeout!); throw new Error('Timeout'); }
    finally { active -= 1; }
  });
  const bounded = new BoundedLiteEngine([dead], { timeoutMs: 500, attemptTimeoutMs: 10, maxAttempts: 3 });
  await assert.rejects(bounded.query(method, {}), /failed after \d+ attempts/);
  const settledCalls = dead.calls.length;
  assert.ok(settledCalls <= 3, 'Real scheduling cannot exceed the dispatch cap');
  assert.ok(dead.calls.every((call) => Number.isSafeInteger(call.timeout) && call.timeout! >= 1 && call.timeout! <= 10));
  assert.equal(active, 0, 'The wrapper awaits endpoint cleanup before rejecting');
  console.log('real timer lifecycle', JSON.stringify({ settledCalls, timeouts: dead.calls.map((call) => call.timeout), active }));
  await sleep(30);
  assert.equal(dead.calls.length, settledCalls, 'No orphaned retry loop survives a rejected query');
  dead.handler = async () => 7;
  assert.equal(await bounded.query(method, {}), 7, 'The next read recovers after endpoint recovery');
  bounded.close();
  await assert.rejects(bounded.query(method, {}), /closed/);
}

async function concurrentFailover() {
  await withClock(async () => {
    let engine: BoundedLiteEngine;
    let concurrentReads = 0;
    const failure = new Error('Exact block unavailable on this peer');
    const failing = new Endpoint(async () => {
      // Another request consumes the healthy peer while the original is in
      // flight. Shared retry state previously sent the original back here
      // after every failure, exhausting all three attempts on this one peer.
      assert.equal(await engine.query(method, {}), 42);
      concurrentReads += 1;
      throw failure;
    });
    const healthy = new Endpoint(async () => 42);
    engine = new BoundedLiteEngine([failing, healthy]);
    try {
      assert.equal(await engine.query(method, {}, { awaitSeqno: 100 }), 42,
        'The original request must reach the healthy peer despite concurrent reads');
      assert.equal(concurrentReads, 1);
      assert.equal(failing.calls.length, 1);
      assert.equal(healthy.calls.length, 2);
      assert.equal(healthy.calls[1].awaitSeqno, 100, 'Failover preserves the original request options');
      assert.deepEqual([...failing.calls, ...healthy.calls].map((args) => args.timeout), [2000, 2000, 2000]);
    } finally { engine.close(); }
  });

  await withClock(async () => {
    const causes = [new Error('peer zero'), new Error('peer one'), new Error('peer two')];
    const endpoints = causes.map((cause) => new Endpoint(async () => { throw cause; }));
    const engine = new BoundedLiteEngine(endpoints);
    try {
      const results = await Promise.allSettled([engine.query(method, {}), engine.query(method, {})]);
      for (const [index, result] of results.entries()) {
        assert.equal(result.status, 'rejected');
        if (result.status !== 'rejected') throw new Error('Expected bounded failure');
        const error: unknown = result.reason;
        assert.ok(error instanceof BoundedLiteQueryError);
        assert.equal(error.message, 'Liteserver query failed after 3 attempts');
        const peers = index === 0 ? [0, 1, 2] : [1, 2, 0];
        assert.deepEqual(error.attempts.map((attempt) => attempt.endpointIndex), peers,
          'Each concurrent request owns its ordered failover sequence');
        assert.deepEqual(error.attempts.map((attempt) => attempt.cause), peers.map((peer) => causes[peer]));
        assert.equal(error.cause, causes[peers[2]]);
        assert.ok(Object.isFrozen(error.attempts) && error.attempts.every(Object.isFrozen));
      }
      assert.equal(endpoints.reduce((count, endpoint) => count + endpoint.calls.length, 0), 6,
        'Two requests retain exactly three attempts each');
    } finally { engine.close(); }
  });
}

async function main() {
  await deterministicBudgets();
  await deterministicConnections();
  await concurrentFailover();
  await realTimerLifecycle();

  const failing = new Endpoint(async () => { throw new Error('state unavailable'); });
  const healthy = new Endpoint(async () => 42);
  const offline = new Endpoint(async () => { throw new Error('offline must not be queried'); });
  offline.ready = false;
  const pool = new BoundedLiteEngine([offline, failing, healthy]);
  assert.equal(await pool.query(method, {}), 42);
  assert.equal(offline.calls.length, 0);
  assert.equal(failing.calls.length, 1);
  assert.equal(healthy.calls.length, 1);
  pool.close();

  const unavailable = new Endpoint(async () => 1);
  unavailable.ready = false;
  const disconnected = new BoundedLiteEngine([unavailable], { timeoutMs: 40, attemptTimeoutMs: 20, maxAttempts: 3 });
  assert.equal(disconnected.isReady(), false);
  // The deterministic cases above prove deadline/attempt accounting while waiting.
  // Make the real connection ready before this query so host pauses cannot turn
  // an unrelated recovery smoke check into a timer precision assertion.
  unavailable.ready = true;
  unavailable.emit('ready');
  unavailable.emit('ready');
  assert.equal(await disconnected.query(method, {}), 1);
  assert.equal(disconnected.isReady(), true);
  unavailable.emit('error', new Error('connection dropped'));
  disconnected.close();
  console.log('bounded lite engine ok (deterministic budgets/connections, concurrent failover and real timer lifecycle)');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
