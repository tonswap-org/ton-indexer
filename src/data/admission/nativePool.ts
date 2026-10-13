import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Address, TupleItem } from '@ton/core';
import type { Logger } from '../../utils/logger';
import { AdmissionError, AdmissionErrorCode, AdmissionIdentity, AdmissionRequest, AdmissionResult, ADMISSION_OUTPUT_BYTES,
  ADMISSION_STARTUP_MS, ADMISSION_TIMEOUT_MS, decodeAdmissionResult, decodeAdmissionReadiness, makeAdmissionRequest } from './protocol';

export interface AdmissionRuntimeConfig extends AdmissionIdentity {
  binaryPath: string; binarySha256: string; configPath: string;
}
export interface AdmissionExecutor {
  readonly engine: string;
  readonly ready: boolean;
  run(method: string, args: TupleItem[]): Promise<AdmissionResult>;
  close(): Promise<void>;
}
const verifyFile = (file: string, hash: string, executable: boolean, maximum: number): void => {
  if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(hash)) throw new AdmissionError('admission_unavailable');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor), pathMetadata = lstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || metadata.mode & 0o022 ||
        metadata.size <= 0 || metadata.size > maximum || (executable && !(metadata.mode & 0o100)) ||
        pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino ||
        createHash('sha256').update(readFileSync(descriptor)).digest('hex') !== hash) throw new AdmissionError('admission_unavailable');
  } finally { closeSync(descriptor); }
};
type Job = { request: AdmissionRequest; resolve: (value: AdmissionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type WorkerPhase = 'startup' | 'idle' | 'request' | 'retiring';
type FailureOrigin = 'startup_timeout' | 'request_timeout' | 'stderr_limit' | 'stdout_limit' |
  'spawn_error' | 'stdin_error' | 'output_invalid' | 'readiness_rejected' | 'artifact_recheck_failed' |
  'unexpected_output' | 'worker_exit' | 'shutdown' | 'job_limit';
const STDERR_TAIL_BYTES = 4096;
export interface AdmissionWorkerDiagnostic {
  workerId: number; pid: number | null; expected: boolean; authenticated: boolean;
  phase: WorkerPhase; origin: FailureOrigin; errorCode: AdmissionErrorCode;
  closeCode: number | null; closeSignal: NodeJS.Signals | null; parentKillRequested: boolean;
  lifetimeMs: number; startupMs: number | null; requests: number; completedJobs: number;
  stdoutBytes: number; stdoutFrames: number; stdoutPendingBytes: number; stderrBytes: number;
  stderrTail: string; stderrTailBytes: number; stderrTruncated: boolean;
}

class NativeWorker {
  private child: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private errorBytes = 0;
  private errorTail = Buffer.alloc(0);
  private outputBytes = 0;
  private outputFrames = 0;
  private requests = 0;
  private phase: WorkerPhase = 'startup';
  private firstFailure?: { origin: FailureOrigin; phase: WorkerPhase; code: AdmissionErrorCode };
  private parentKillRequested = false;
  private diagnosticEmitted = false;
  private readonly createdAt = performance.now();
  private readyAt?: number;
  private initialized = false;
  private dead = false;
  private jobs = 0;
  private job?: Job;
  private startupTimer: NodeJS.Timeout;
  private startupResolve!: () => void;
  private startupReject!: (reason: Error) => void;
  private exitedResolve!: () => void;
  readonly exited: Promise<void>;
  readonly started: Promise<void>;
  get ready(): boolean { return this.initialized && !this.dead && !this.job && this.jobs < 128; }
  get warm(): boolean { return this.initialized && !this.dead && this.jobs < 128; }
  constructor(private readonly config: AdmissionRuntimeConfig, onExit: () => void,
    private readonly workerId: number, private readonly logger?: Pick<Logger, 'info' | 'warn'>) {
    verifyFile(config.binaryPath, config.binarySha256, true, 128 * 1024 * 1024);
    verifyFile(config.configPath, config.configSha256, false, 1024 * 1024);
    this.started = new Promise((resolve, reject) => { this.startupResolve = resolve; this.startupReject = reject; });
    this.exited = new Promise(resolve => { this.exitedResolve = resolve; });
    this.child = spawn(config.binaryPath, [config.configPath, config.engine, Buffer.from(config.codeHash, 'hex').toString('base64')], {
      stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
    });
    this.startupTimer = setTimeout(() => this.fail(new AdmissionError('admission_timeout'), 'startup_timeout'), ADMISSION_STARTUP_MS);
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    this.child.stderr.on('data', (data: Buffer) => {
      this.errorBytes += data.length;
      this.errorTail = data.length >= STDERR_TAIL_BYTES ? Buffer.from(data.subarray(data.length - STDERR_TAIL_BYTES)) :
        Buffer.from(Buffer.concat([this.errorTail, data]).subarray(-STDERR_TAIL_BYTES));
      // The existing lifetime output guard is separate from this bounded tail.
      // Neither the tail nor transport diagnostics cross the public API.
      if (this.errorBytes > 1024 * 1024) this.fail(new AdmissionError('admission_worker_failure'), 'stderr_limit');
    });
    this.child.on('error', () => this.fail(new AdmissionError('admission_worker_failure'), 'spawn_error'));
    this.child.stdin.on('error', () => this.fail(new AdmissionError('admission_worker_failure'), 'stdin_error'));
    this.child.once('close', (code, signal) => {
      this.fail(new AdmissionError('admission_worker_failure'), this.jobs === 128 && code === 0 && signal === null ? 'job_limit' : 'worker_exit', false);
      try { this.reportExit(code, signal); }
      finally { this.exitedResolve(); onExit(); }
    });
  }
  private fail(error: AdmissionError, origin: FailureOrigin, terminate = true): void {
    if (!this.dead) {
      this.firstFailure = { origin, phase: this.phase, code: error.code };
      this.dead = true; clearTimeout(this.startupTimer); this.startupReject(error);
      if (this.job) { clearTimeout(this.job.timer); this.job.reject(error); this.job = undefined; }
    }
    if (terminate && this.child.exitCode === null && this.child.signalCode === null) {
      this.parentKillRequested = this.child.kill('SIGKILL') || this.parentKillRequested;
    }
  }
  private reportExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.diagnosticEmitted) return;
    this.diagnosticEmitted = true;
    const failure = this.firstFailure!;
    const expected = failure.origin === 'job_limit' && code === 0 && signal === null ||
      failure.origin === 'shutdown' && (code === 0 && signal === null || this.parentKillRequested && signal === 'SIGKILL');
    // ASCII-only operator text cannot inject terminal controls, bidi text or log
    // lines. Stdout contains financial proofs/payloads: retain counters only.
    const stderrTail = [...this.errorTail].map(byte => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ' ').join('');
    const diagnostic: AdmissionWorkerDiagnostic = {
      workerId: this.workerId, pid: this.child.pid ?? null, expected, authenticated: this.initialized,
      phase: failure.phase, origin: failure.origin, errorCode: failure.code,
      closeCode: code, closeSignal: signal, parentKillRequested: this.parentKillRequested,
      lifetimeMs: Math.max(0, Math.round(performance.now() - this.createdAt)),
      startupMs: this.readyAt === undefined ? null : Math.max(0, Math.round(this.readyAt - this.createdAt)),
      requests: this.requests, completedJobs: this.jobs, stdoutBytes: this.outputBytes,
      stdoutFrames: this.outputFrames, stdoutPendingBytes: this.pending.length, stderrBytes: this.errorBytes,
      stderrTail, stderrTailBytes: this.errorTail.length, stderrTruncated: this.errorBytes > this.errorTail.length,
    };
    try {
      // Logging must never prevent rejection, reaping or replacement, including
      // a custom sink that throws synchronously or returns a rejected promise.
      void Promise.resolve(this.logger?.[expected ? 'info' : 'warn']('perps admission worker closed', { admissionWorker: diagnostic })).catch(() => {});
    } catch { /* The owned lifecycle remains authoritative when a sink fails. */ }
  }
  private receive(data: Buffer): void {
    this.outputBytes += data.length;
    if (this.dead) return;
    if (this.pending.length + data.length > ADMISSION_OUTPUT_BYTES) return this.fail(new AdmissionError('admission_worker_failure'), 'stdout_limit');
    this.pending = Buffer.concat([this.pending, data]);
    for (;;) {
      const newline = this.pending.indexOf(10); if (newline < 0) return;
      const line = this.pending.subarray(0, newline); this.pending = this.pending.subarray(newline + 1);
      this.outputFrames++;
      let origin: FailureOrigin = 'output_invalid';
      try {
        const response: unknown = JSON.parse(line.toString('utf8'));
        if (!this.initialized) {
          origin = 'readiness_rejected';
          decodeAdmissionReadiness(this.config, response);
          origin = 'artifact_recheck_failed';
          verifyFile(this.config.binaryPath, this.config.binarySha256, true, 128 * 1024 * 1024);
          verifyFile(this.config.configPath, this.config.configSha256, false, 1024 * 1024);
          this.initialized = true; this.readyAt = performance.now(); this.phase = 'idle';
          clearTimeout(this.startupTimer); this.startupResolve();
        } else {
          const job = this.job;
          origin = 'unexpected_output';
          if (!job) throw new AdmissionError('admission_worker_failure');
          clearTimeout(job.timer); this.job = undefined; this.jobs++; this.phase = 'idle';
          try { job.resolve(decodeAdmissionResult(this.config, job.request, response)); }
          catch (error) { job.reject(error instanceof AdmissionError ? error : new AdmissionError('admission_invalid_context')); }
          if (this.jobs === 128) { this.phase = 'retiring'; this.child.stdin.end(); }
        }
      } catch (error) { this.fail(error instanceof AdmissionError ? error : new AdmissionError('admission_worker_failure'), origin); return; }
    }
  }
  run(request: AdmissionRequest): Promise<AdmissionResult> {
    if (!this.ready) return Promise.reject(new AdmissionError('admission_busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AdmissionError('admission_timeout'), 'request_timeout'), ADMISSION_TIMEOUT_MS);
      this.job = { request, resolve, reject, timer };
      this.requests++; this.phase = 'request';
      this.child.stdin.write(request.wire + '\n');
    });
  }
  async close(): Promise<void> { this.fail(new AdmissionError('admission_unavailable'), 'shutdown'); await this.exited; }
}

/** Two persistent owned processes, no queue and no execution retry. A cold
 * replacement never receives public work. Each process retains its official
 * authenticated LastBlock state until it exits; there is no invented checkpoint. */
export class NativeAdmissionPool implements AdmissionExecutor {
  private readonly workers = new Set<NativeWorker>();
  private closed = false;
  private started = false;
  private replacementTimer?: NodeJS.Timeout;
  private replacements = 0;
  private nextWorkerId = 1;
  get engine(): string { return this.config.engine; }
  get ready(): boolean { return !this.closed && [...this.workers].some(worker => worker.warm); }
  private readonly config: Readonly<AdmissionRuntimeConfig>;
  constructor(config: AdmissionRuntimeConfig, private readonly logger?: Pick<Logger, 'info' | 'warn'>) {
    this.config = Object.freeze({ ...config, engine: Address.parse(config.engine).toRawString() });
  }
  private create(): NativeWorker {
    let worker!: NativeWorker;
    worker = new NativeWorker(this.config, () => {
      this.workers.delete(worker);
      this.scheduleReplacement();
    }, this.nextWorkerId++, this.logger);
    this.workers.add(worker);
    void worker.started.then(() => { this.replacements = 0; }, () => { this.replacements++; this.scheduleReplacement(); });
    return worker;
  }
  private scheduleReplacement(): void {
      if (!this.closed && this.started && this.workers.size < 2 && !this.replacementTimer) {
        // Bounded restart backoff is readiness maintenance. A failed request is
        // already rejected and is never retained or replayed by a replacement.
        this.replacementTimer = setTimeout(() => {
          this.replacementTimer = undefined;
          while (!this.closed && this.workers.size < 2) {
            try { this.create(); }
            catch { this.replacements++; this.scheduleReplacement(); break; }
          }
        }, Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(0, this.replacements - 1), 6)));
        this.replacementTimer.unref();
      }
  }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new AdmissionError('admission_unavailable');
    this.started = true;
    const attempts: Promise<void>[] = [];
    for (let slot = 0; slot < 2; slot++) {
      try {
        const worker = this.create();
        attempts.push(worker.started.then(() => {
          // A worker may authenticate and then fail while draining the same
          // output chunk. Such an attempt cannot win the readiness race.
          if (this.closed || !worker.warm) throw new AdmissionError('admission_unavailable');
        }));
      }
      catch {
        // Account for this slot without discarding a sibling that is still
        // authenticating. Every successfully created process remains owned by
        // the pool, including when another constructor fails synchronously.
        this.replacements++;
        attempts.push(Promise.reject(new AdmissionError('admission_unavailable')));
      }
    }
    this.scheduleReplacement();
    try {
      // Readiness has always required one authenticated live worker. A failed
      // or slow cold sibling must not prevent that worker from serving. Both
      // rejected attempts still fail closed; maintenance never replays work.
      await Promise.any(attempts);
      if (!this.ready) throw new AdmissionError('admission_unavailable');
    } catch { throw new AdmissionError('admission_unavailable'); }
  }
  run(method: string, args: TupleItem[]): Promise<AdmissionResult> {
    try {
      const request = makeAdmissionRequest(this.config, method, args);
      const worker = [...this.workers].find(value => value.ready);
      if (!worker) throw new AdmissionError(this.ready ? 'admission_busy' : 'admission_unavailable');
      return worker.run(request);
    } catch (error) { return Promise.reject(error instanceof AdmissionError ? error : new AdmissionError('admission_invalid_request')); }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.replacementTimer) clearTimeout(this.replacementTimer);
    await Promise.all([...this.workers].map(worker => worker.close()));
  }
}
