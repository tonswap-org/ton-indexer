import { fork } from 'node:child_process';
import type { LoadedManifest } from './config/manifestSource';
import type { ManifestWorker } from './manifestSupervisor';
import { ADMISSION_STARTUP_MS } from './data/admission/protocol';

// The authenticated native runtime has its own cold-start deadline. Allow
// additional time for data-source, ledger and HTTP startup after it succeeds.
export const MANIFEST_WORKER_STARTUP_TIMEOUT_MS = ADMISSION_STARTUP_MS + 120_000;

export function launchManifestWorker(entrypoint: string, manifest: LoadedManifest, startupTimeoutMs = MANIFEST_WORKER_STARTUP_TIMEOUT_MS): ManifestWorker {
  const child = fork(entrypoint, ['--manifest-worker'], { execArgv: process.execArgv, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const deadline = setTimeout(() => { rejectReady(Error('Manifest worker startup timed out')); child.kill('SIGTERM'); }, startupTimeoutMs);
  child.on('message', (message: any) => {
    if (message?.type === 'manifest-ready' && message.manifestHash === manifest.runtime.manifestHash) {
      clearTimeout(deadline); resolveReady();
    }
  });
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => { clearTimeout(deadline); rejectReady(Error('Manifest worker exited')); resolve(); });
    child.once('error', () => resolve());
  });
  child.once('error', error => { clearTimeout(deadline); rejectReady(error); });
  child.send({ type: 'manifest-start', manifest: manifest.runtime });
  let stopping: Promise<void> | undefined;
  return { ready, exited, stop: () => stopping ??= (async () => {
    const force = setTimeout(() => child.kill('SIGKILL'), 25_000);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(force); }
  })() };
}
