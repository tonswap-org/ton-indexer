import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Address, TupleItem } from '@ton/core';
import { AdmissionError, AdmissionIdentity, AdmissionRequest, AdmissionResult, ADMISSION_OUTPUT_BYTES,
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

class NativeWorker {
  private child: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private errorBytes = 0;
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
  constructor(private readonly config: AdmissionRuntimeConfig, onExit: () => void) {
    verifyFile(config.binaryPath, config.binarySha256, true, 128 * 1024 * 1024);
    verifyFile(config.configPath, config.configSha256, false, 1024 * 1024);
    this.started = new Promise((resolve, reject) => { this.startupResolve = resolve; this.startupReject = reject; });
    this.exited = new Promise(resolve => { this.exitedResolve = resolve; });
    this.child = spawn(config.binaryPath, [config.configPath, config.engine, Buffer.from(config.codeHash, 'hex').toString('base64')], {
      stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
    });
    this.startupTimer = setTimeout(() => this.fail(new AdmissionError('admission_timeout')), ADMISSION_STARTUP_MS);
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    this.child.stderr.on('data', (data: Buffer) => {
      this.errorBytes += data.length;
      // Bound/drain upstream diagnostics without exposing remote strings through
      // the public API or retaining unbounded validator progress logs in memory.
      if (this.errorBytes > 1024 * 1024) this.fail(new AdmissionError('admission_worker_failure'));
    });
    this.child.on('error', () => this.fail(new AdmissionError('admission_worker_failure')));
    this.child.stdin.on('error', () => this.fail(new AdmissionError('admission_worker_failure')));
    this.child.once('close', () => {
      this.fail(new AdmissionError('admission_worker_failure'), false);
      this.exitedResolve(); onExit();
    });
  }
  private fail(error: Error, terminate = true): void {
    if (!this.dead) {
      this.dead = true; clearTimeout(this.startupTimer); this.startupReject(error);
      if (this.job) { clearTimeout(this.job.timer); this.job.reject(error); this.job = undefined; }
    }
    if (terminate && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
  private receive(data: Buffer): void {
    if (this.dead) return;
    if (this.pending.length + data.length > ADMISSION_OUTPUT_BYTES) return this.fail(new AdmissionError('admission_worker_failure'));
    this.pending = Buffer.concat([this.pending, data]);
    for (;;) {
      const newline = this.pending.indexOf(10); if (newline < 0) return;
      const line = this.pending.subarray(0, newline); this.pending = this.pending.subarray(newline + 1);
      try {
        const response: unknown = JSON.parse(line.toString('utf8'));
        if (!this.initialized) {
          decodeAdmissionReadiness(this.config, response);
          verifyFile(this.config.binaryPath, this.config.binarySha256, true, 128 * 1024 * 1024);
          verifyFile(this.config.configPath, this.config.configSha256, false, 1024 * 1024);
          this.initialized = true; clearTimeout(this.startupTimer); this.startupResolve();
        } else {
          const job = this.job;
          if (!job) throw new AdmissionError('admission_worker_failure');
          clearTimeout(job.timer); this.job = undefined; this.jobs++;
          try { job.resolve(decodeAdmissionResult(this.config, job.request, response)); }
          catch (error) { job.reject(error instanceof AdmissionError ? error : new AdmissionError('admission_invalid_context')); }
          if (this.jobs === 128) this.child.stdin.end();
        }
      } catch (error) { this.fail(error instanceof AdmissionError ? error : new AdmissionError('admission_worker_failure')); return; }
    }
  }
  run(request: AdmissionRequest): Promise<AdmissionResult> {
    if (!this.ready) return Promise.reject(new AdmissionError('admission_busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AdmissionError('admission_timeout')), ADMISSION_TIMEOUT_MS);
      this.job = { request, resolve, reject, timer };
      this.child.stdin.write(request.wire + '\n');
    });
  }
  async close(): Promise<void> { this.fail(new AdmissionError('admission_unavailable')); await this.exited; }
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
  get engine(): string { return this.config.engine; }
  get ready(): boolean { return !this.closed && [...this.workers].some(worker => worker.warm); }
  private readonly config: Readonly<AdmissionRuntimeConfig>;
  constructor(config: AdmissionRuntimeConfig) {
    this.config = Object.freeze({ ...config, engine: Address.parse(config.engine).toRawString() });
  }
  private create(): NativeWorker {
    let worker!: NativeWorker;
    worker = new NativeWorker(this.config, () => {
      this.workers.delete(worker);
      this.scheduleReplacement();
    });
    this.workers.add(worker); return worker;
  }
  private scheduleReplacement(): void {
      if (!this.closed && this.started && this.workers.size < 2 && !this.replacementTimer && this.replacements < 3) {
        // Bounded restart backoff is readiness maintenance. A failed request is
        // already rejected and is never retained or replayed by a replacement.
        this.replacementTimer = setTimeout(() => {
          this.replacementTimer = undefined;
          while (!this.closed && this.workers.size < 2 && this.replacements < 3) {
            this.replacements++;
            try { void this.create().started.then(() => { this.replacements = 0; }, () => {}); }
            catch { this.scheduleReplacement(); break; }
          }
        }, 1000 * 2 ** this.replacements);
      }
  }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new AdmissionError('admission_unavailable');
    try {
      const first = this.create();
      // A constructor failure must not leave an owned cold process or an
      // unhandled readiness rejection behind.
      void first.started.catch(() => {});
      const second = this.create();
      await Promise.all([first.started, second.started]);
      this.started = true;
    } catch { await this.close(); throw new AdmissionError('admission_unavailable'); }
  }
  run(method: string, args: TupleItem[]): Promise<AdmissionResult> {
    try {
      const request = makeAdmissionRequest(this.config, method, args);
      const worker = [...this.workers].find(value => value.ready);
      if (!worker) throw new AdmissionError(this.workers.size ? 'admission_busy' : 'admission_unavailable');
      return worker.run(request);
    } catch (error) { return Promise.reject(error instanceof AdmissionError ? error : new AdmissionError('admission_invalid_request')); }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.replacementTimer) clearTimeout(this.replacementTimer);
    await Promise.all([...this.workers].map(worker => worker.close()));
  }
}
