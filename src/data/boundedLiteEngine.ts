import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { LiteEngine } from 'ton-lite-client';
import type { TLFunction } from 'ton-tl';
import { assertFreshReadActive, freshReadDelay } from './freshRead';

type QueryOptions = { timeout?: number; awaitSeqno?: number; signal?: AbortSignal; validateResponse?: (response: unknown) => void };

export class BoundedLiteQueryError extends Error {
  readonly attempts: readonly Readonly<{ endpointIndex: number; cause: unknown }>[];

  constructor(attempts: readonly Readonly<{ endpointIndex: number; cause: unknown }>[]) {
    super(`Liteserver query failed after ${attempts.length} attempts`, { cause: attempts.at(-1)?.cause });
    this.name = 'BoundedLiteQueryError';
    this.attempts = Object.freeze(attempts.map((attempt) => Object.freeze({ ...attempt })));
  }
}

/** One retry budget for a wire query, including time spent waiting for connections. */
export class BoundedLiteEngine extends EventEmitter implements LiteEngine {
  private closed = false;
  private next = 0;

  constructor(
    private readonly engines: LiteEngine[],
    private readonly options = { timeoutMs: 5_000, attemptTimeoutMs: 2_000, maxAttempts: 3 },
  ) {
    super();
    if (!engines.length) throw new Error('No liteserver endpoints configured');
    if (Object.values(options).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('Liteserver retry limits must be positive integers');
    }
    for (const engine of engines) {
      engine.on('connect', () => this.emit('connect'));
      engine.on('ready', () => this.emit('ready'));
      // Single engines handle reconnection. Consume their error events and
      // select from live readiness on each attempt instead of retaining duplicates.
      engine.on('error', () => {});
    }
  }

  async query<REQ, RES>(f: TLFunction<REQ, RES>, req: REQ, args: QueryOptions = {}): Promise<RES> {
    assertFreshReadActive(args.signal);
    if (this.closed) throw new Error('Engine is closed');
    const requestedTimeout = args.timeout ?? this.options.timeoutMs;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new Error('Liteserver query timeout must be positive');
    }
    const deadline = performance.now() + Math.min(requestedTimeout, this.options.timeoutMs);
    // Distribute starting peers globally, but keep each request's retry sequence
    // independent: concurrent queries must not consume its next failover peer.
    let next = this.next;
    this.next = (this.next + 1) % this.engines.length;
    let attempts = 0;
    const failures: { endpointIndex: number; cause: unknown }[] = [];
    while (!this.closed && performance.now() < deadline && attempts < this.options.maxAttempts) {
      assertFreshReadActive(args.signal);
      let engine: LiteEngine | undefined;
      let endpointIndex = -1;
      for (let checked = 0; checked < this.engines.length; checked += 1) {
        const index = next;
        next = (next + 1) % this.engines.length;
        const candidate = this.engines[index];
        if (!candidate.isClosed() && candidate.isReady()) {
          engine = candidate;
          endpointIndex = index;
          break;
        }
      }
      // Endpoint selection can consume the remaining budget. Node timers accept
      // whole milliseconds; never extend an expired or fractional remainder.
      const remainingMs = Math.floor(deadline - performance.now());
      if (this.closed || remainingMs < 1) break;
      if (!engine) {
        await freshReadDelay(Math.min(25, remainingMs), args.signal);
        continue;
      }
      attempts += 1;
      try {
        // LiteSingleEngine removes its pending query when this timeout elapses.
        // Do not race an unbounded retry promise and leave network work running.
        const result = await engine.query(f, req, {
          ...(args.awaitSeqno === undefined ? {} : { awaitSeqno: args.awaitSeqno }),
          timeout: Math.min(this.options.attemptTimeoutMs, remainingMs),
        });
        assertFreshReadActive(args.signal);
        // A transport-successful but stale/conflicting head must consume this
        // same bounded peer budget, not escape it or restart a compound read.
        args.validateResponse?.(result);
        return result;
      } catch (error) {
        assertFreshReadActive(args.signal);
        failures.push({ endpointIndex, cause: error });
      }
    }
    assertFreshReadActive(args.signal);
    if (this.closed) throw new Error('Engine is closed');
    throw new BoundedLiteQueryError(failures);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const engine of this.engines) engine.close();
    this.emit('close');
  }

  isClosed() { return this.closed; }
  isReady() { return !this.closed && this.engines.some((engine) => !engine.isClosed() && engine.isReady()); }
}
