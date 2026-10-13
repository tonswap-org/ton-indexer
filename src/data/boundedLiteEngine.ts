import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ADNLClientTCP } from 'adnl';
import type { LiteEngine } from 'ton-lite-client';
import { Codecs, Functions } from 'ton-lite-client/dist/schema';
import { TLReadBuffer, TLWriteBuffer, type TLFunction } from 'ton-tl';
import { ChainReadError } from './dataSource';

export type LiteQueryOptions = { timeout?: number; awaitSeqno?: number; signal?: AbortSignal;
  validate?: (value: unknown, peer: number) => void };
const context = new AsyncLocalStorage<LiteQueryOptions>();
const cancelled = () => new ChainReadError('upstream_timeout');
const hedgeCancelled = new Error('Redundant liteserver hedge cancelled');

export class BoundedLiteQueryError extends Error {
  readonly attempts: readonly Readonly<{ endpointIndex: number; cause: unknown }>[];
  constructor(attempts: readonly Readonly<{ endpointIndex: number; cause: unknown }>[], readonly timedOut = false) {
    super(`Liteserver query failed after ${attempts.length} attempts`, { cause: attempts.at(-1)?.cause });
    this.name = 'BoundedLiteQueryError';
    this.attempts = Object.freeze(attempts.map(attempt => Object.freeze({ ...attempt })));
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? cancelled()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** The installed LiteSingleEngine cannot cancel an individual pending query.
 * This small ADNL adapter owns that lifecycle, including timers and reconnects;
 * cancelling one request never disconnects another request on the same peer. */
export class AbortableLitePeer extends EventEmitter implements LiteEngine {
  private closed = false;
  private ready = false;
  private client?: ADNLClientTCP;
  private reconnect?: NodeJS.Timeout;
  private readonly pending = new Map<string, { finish(error?: unknown, value?: unknown): void; decode(data: Buffer): unknown }>();
  constructor(private readonly host: string, private readonly publicKey: Buffer,
    private readonly clientFactory: (host: string, publicKey: Buffer) => ADNLClientTCP = (host, key) => new ADNLClientTCP(host, key)) {
    super();
    this.connect();
  }
  private connect(): void {
    if (this.closed) return;
    const client = this.clientFactory(this.host, this.publicKey);
    this.client = client;
    client.on('connect', () => { if (this.client === client && !this.closed) this.emit('connect'); });
    client.on('ready', () => { if (this.client === client && !this.closed) { this.ready = true; this.emit('ready'); } });
    const disconnected = (error: unknown) => {
      if (this.client !== client) return;
      this.client = undefined;
      this.ready = false;
      for (const query of [...this.pending.values()]) query.finish(error);
      try { client.end(); } catch { /* Already disconnected. */ }
      if (!this.closed) {
        this.emit('close');
        this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, 1_000);
        this.reconnect.unref();
      }
    };
    client.on('close', () => disconnected(new Error('Liteserver disconnected')));
    client.on('error', error => { if (this.listenerCount('error')) this.emit('error', error); disconnected(error); });
    client.on('data', data => {
      try {
        const answer = Codecs.adnl_Message.decode(new TLReadBuffer(data));
        if (answer.kind !== 'adnl.message.answer') return;
        const query = this.pending.get(answer.queryId.toString('hex'));
        if (!query) return;
        if (answer.answer.length >= 4 && answer.answer.readInt32LE(0) === -1146494648)
          query.finish(new Error(Codecs.liteServer_Error.decode(new TLReadBuffer(answer.answer)).message));
        else {
          try { query.finish(undefined, query.decode(answer.answer)); } catch (error) { query.finish(error); }
        }
      } catch (error) { disconnected(error); }
    });
    void client.connect().catch(disconnected);
  }
  async query<REQ, RES>(f: TLFunction<REQ, RES>, req: REQ, options: LiteQueryOptions = {}): Promise<RES> {
    if (this.closed || !this.ready || !this.client) throw new Error('Liteserver is not ready');
    if (options.signal?.aborted) throw options.signal.reason ?? cancelled();
    const timeout = options.timeout ?? 1_500;
    const writer = new TLWriteBuffer();
    if (options.awaitSeqno !== undefined) Functions.liteServer_waitMasterchainSeqno.encodeRequest({
      kind: 'liteServer.waitMasterchainSeqno', seqno: options.awaitSeqno, timeoutMs: timeout,
    }, writer);
    f.encodeRequest(req, writer);
    const wrapped = new TLWriteBuffer();
    Functions.liteServer_query.encodeRequest({ kind: 'liteServer.query', data: writer.build() }, wrapped);
    const queryId = randomBytes(32), key = queryId.toString('hex');
    const packet = new TLWriteBuffer();
    Codecs.adnl_Message.encode({ kind: 'adnl.message.query', queryId, query: wrapped.build() }, packet);
    return new Promise<RES>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        this.pending.delete(key);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value as RES);
      };
      const abort = () => finish(options.signal?.reason ?? cancelled());
      const timer = setTimeout(() => finish(cancelled()), timeout);
      this.pending.set(key, { finish, decode: data => f.decodeResponse(new TLReadBuffer(data)) });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      else { try { this.client!.write(packet.build()); } catch (error) { finish(error); } }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    for (const query of [...this.pending.values()]) query.finish(new Error('Engine is closed'));
    const client = this.client; this.client = undefined;
    client?.end(); this.emit('close');
  }
  isClosed() { return this.closed; }
  isReady() { return this.ready && !this.closed; }
}

type PeerState = { failures: number; latencyMs: number | null; until: number; probing: boolean };
type Limits = { timeoutMs: number; attemptTimeoutMs: number; maxAttempts: number };

/** One deadline and bounded hedging budget for each complete wire query. */
export class BoundedLiteEngine extends EventEmitter implements LiteEngine {
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly peers: PeerState[];
  private hedges = 0;
  constructor(private readonly engines: LiteEngine[],
    private readonly options: Limits = { timeoutMs: 5_000, attemptTimeoutMs: 1_500, maxAttempts: 3 },
    private readonly observer?: (peer: number, ok: boolean, ms: number) => void) {
    super();
    if (!engines.length) throw new Error('No liteserver endpoints configured');
    if (Object.values(options).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Liteserver retry limits must be positive integers');
    this.peers = engines.map(() => ({ failures: 0, latencyMs: null, until: 0, probing: false }));
    for (const engine of engines) {
      engine.on('connect', () => this.emit('connect'));
      engine.on('ready', () => this.emit('ready'));
      engine.on('error', () => {});
    }
  }
  withOptions<T>(options: LiteQueryOptions, run: () => Promise<T>): Promise<T> { return context.run(options, run); }
  health() {
    return this.peers.map((peer, index) => ({ index, ready: !this.closed && this.engines[index].isReady() && !this.engines[index].isClosed(),
      open: peer.until > performance.now() || peer.probing, failures: peer.failures, latencyMs: peer.latencyMs }));
  }
  private candidates(used: Set<number>): number[] {
    const now = performance.now();
    return this.peers.map((_, index) => index).filter(index => !used.has(index) && !this.engines[index].isClosed()
      && this.engines[index].isReady() && this.peers[index].until <= now && !this.peers[index].probing)
      .sort((a, b) => this.peers[a].failures - this.peers[b].failures
        || (this.peers[a].latencyMs ?? 500) - (this.peers[b].latencyMs ?? 500) || a - b);
  }
  async query<REQ, RES>(f: TLFunction<REQ, RES>, req: REQ, supplied: LiteQueryOptions = {}): Promise<RES> {
    if (this.closed) throw new Error('Engine is closed');
    const args = { ...context.getStore(), ...supplied };
    const requested = args.timeout ?? this.options.timeoutMs;
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('Liteserver query timeout must be positive');
    const budget = Math.min(requested, this.options.timeoutMs);
    const started = performance.now();
    const deadline = started + budget;
    const deadlineController = new AbortController();
    const timer = setTimeout(() => deadlineController.abort(cancelled()), budget);
    const signal = AbortSignal.any([deadlineController.signal, this.shutdown.signal, ...(args.signal ? [args.signal] : [])]);
    const failures: { endpointIndex: number; cause: unknown }[] = [];
    const used = new Set<number>();
    let attempts = 0;
    let hedged = false;
    let timedOut = false;
    // Submission is a side effect. Never hedge or automatically resend a BOC
    // whose first transport attempt may already have reached the network.
    const send = (req as { kind?: string }).kind === 'liteServer.sendMessage';
    const maxAttempts = send ? 1 : this.options.maxAttempts;
    const controllers = new Set<AbortController>();
    const attempt = async (index: number): Promise<RES> => {
      attempts++; used.add(index);
      const state = this.peers[index];
      if (state.failures >= 2) state.probing = true;
      const start = performance.now();
      const timeout = Math.max(1, Math.min(Math.floor(deadline - start), this.options.attemptTimeoutMs,
        Math.max(400, Math.min(1_500, Math.round(3 * (state.latencyMs ?? 500))))));
      const controller = new AbortController(); controllers.add(controller);
      const perAttempt = setTimeout(() => controller.abort(cancelled()), timeout);
      const attemptSignal = AbortSignal.any([signal, controller.signal]);
      let ok = false;
      try {
        const value = await abortable(this.engines[index].query(f, req, { timeout, awaitSeqno: args.awaitSeqno, signal: attemptSignal } as LiteQueryOptions), attemptSignal);
        args.validate?.(value, index);
        ok = true;
        const latency = performance.now() - start;
        state.latencyMs = state.latencyMs === null ? latency : state.latencyMs * 0.75 + latency * 0.25;
        state.failures = 0; state.until = 0;
        return value;
      } catch (cause) {
        if (attemptSignal.reason !== hedgeCancelled && !signal.aborted) {
          state.failures++;
          if (state.failures >= 2) state.until = performance.now() + Math.min(60_000, 2_000 * 2 ** Math.min(state.failures - 2, 5));
          failures.push({ endpointIndex: index, cause });
        }
        if (cause instanceof ChainReadError && cause.code === 'upstream_timeout') timedOut = true;
        throw cause;
      } finally {
        clearTimeout(perAttempt); controllers.delete(controller); state.probing = false;
        try { this.observer?.(index, ok, performance.now() - start); } catch { /* Telemetry cannot fail a read. */ }
      }
    };
    try {
      while (!signal.aborted && attempts < maxAttempts && Math.floor(deadline - performance.now()) >= 1) {
        let available = this.candidates(used);
        if (!available.length && used.size) { used.clear(); available = this.candidates(used); }
        if (!available.length) {
          if (!attempts && performance.now() - started >= 250) break;
          if (attempts && this.health().every(peer => !peer.ready || peer.open)) break;
          await abortable(new Promise<void>(resolve => {
            const wait = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(25, Math.max(1, Math.floor(deadline - performance.now()))));
            const abort = () => { clearTimeout(wait); resolve(); };
            signal.addEventListener('abort', abort, { once: true });
          }), signal);
          continue;
        }
        const first = available[0];
        const primary = attempt(first);
        let hedgeTimer: NodeJS.Timeout | undefined;
        const mayHedge = !send && !hedged && available.length > 1 && this.hedges < 8 && attempts < maxAttempts;
        try {
          if (!mayHedge) return await primary;
          const delay = Math.max(150, Math.min(800, 2 * (this.peers[first].latencyMs ?? 400)));
          const initial = await Promise.race([
            primary.then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error })),
            new Promise<{ kind: 'hedge' }>(resolve => { hedgeTimer = setTimeout(() => resolve({ kind: 'hedge' }), delay); }),
          ]);
          if (initial.kind === 'value') return initial.value;
          if (initial.kind === 'error') continue;
          const second = this.candidates(used)[0];
          if (signal.aborted || second === undefined || this.hedges >= 8) return await primary;
          hedged = true; this.hedges++;
          try { return await Promise.any([primary, attempt(second)]); }
          finally { this.hedges--; }
        } catch { /* Only transport/validation failures enter the next bounded attempt. */ }
        finally { if (hedgeTimer) clearTimeout(hedgeTimer); }
      }
    } catch (error) {
      if (this.closed) throw new Error('Engine is closed');
      if (args.signal?.aborted) throw args.signal.reason ?? cancelled();
      if (!(error instanceof ChainReadError)) throw error;
    } finally {
      clearTimeout(timer);
      for (const controller of controllers) controller.abort(hedgeCancelled);
    }
    if (this.closed) throw new Error('Engine is closed');
    if (args.signal?.aborted) throw args.signal.reason ?? cancelled();
    throw new BoundedLiteQueryError(failures, timedOut || (attempts > 0 && deadlineController.signal.aborted));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.shutdown.abort(new Error('Engine is closed'));
    for (const engine of this.engines) engine.close();
    this.emit('close');
  }
  isClosed() { return this.closed; }
  isReady() { return this.health().some(peer => peer.ready && !peer.open); }
}
