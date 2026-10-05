import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { loadRuntimeManifest, MAX_MANIFEST_BYTES } from '../config/manifestSource';
import { parseCanonicalReleaseManifest } from '../config/releaseManifest';
import { createManifestSupervisor, MANIFEST_POLL_INTERVAL_MS, type ManifestWorker } from '../manifestSupervisor';
import { releaseDatabaseSchema } from '../releaseState';
import { releasePoolConfig } from '../ledger/releasePool';
import { launchManifestWorker, MANIFEST_WORKER_STARTUP_TIMEOUT_MS } from '../manifestWorker';
import { ADMISSION_STARTUP_MS } from '../data/admission/protocol';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

const first = runtimeManifestFixture();
const second = runtimeManifestFixture({ createdAt: '2026-10-06T00:00:00.000Z' });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
};
const until = async (condition: () => boolean) => {
  const end = Date.now() + 5_000;
  while (!condition()) { if (Date.now() >= end) throw Error('Manifest polling test timed out'); await delay(5); }
};

async function main() {
  assert.equal(MANIFEST_POLL_INTERVAL_MS, 5_000);
  assert(MANIFEST_WORKER_STARTUP_TIMEOUT_MS >= ADMISSION_STARTUP_MS + 60_000,
    'supervisor must allow the complete native authentication window and remaining startup');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-manifest-unit-')));
  let body = JSON.stringify(first);
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/release-manifest.json`;
  try {
    const path = join(directory, 'release-manifest.json');
    writeFileSync(path, body, { mode: 0o600 });
    assert.equal((await loadRuntimeManifest(path, 'testnet')).runtime.manifestHash, first.manifestHash);
    assert.equal((await loadRuntimeManifest(url, 'testnet')).runtime.manifestHash, first.manifestHash);
    await assert.rejects(loadRuntimeManifest(url, 'mainnet'), /network mismatch/);
    await assert.rejects(loadRuntimeManifest('http://untrusted.example/manifest', 'testnet'), /HTTPS/);
    await assert.rejects(loadRuntimeManifest('https://user:secret@example.com/manifest', 'testnet'), /without credentials/);
    const oversizedHeader = (async () => new Response('{}', { headers: { 'content-length': String(MAX_MANIFEST_BYTES + 1) } })) as typeof fetch;
    await assert.rejects(loadRuntimeManifest('https://example.com/manifest', 'testnet', oversizedHeader), /byte limit/);
    const oversizedBody = (async () => new Response(new Uint8Array(MAX_MANIFEST_BYTES + 1))) as typeof fetch;
    await assert.rejects(loadRuntimeManifest('https://example.com/manifest', 'testnet', oversizedBody), /byte limit/);
    body = JSON.stringify(first).replace('"schema":', '"schema":"wrong","schema":');
    await assert.rejects(loadRuntimeManifest(url, 'testnet'), /Duplicate|duplicate/);

    // A changed URL is polled, and an invalid publication retires the old
    // worker instead of continuing to serve an unverified release.
    body = JSON.stringify(first);
    const launches: string[] = [], stops: string[] = [], errors: unknown[] = [];
    const launch = (hash: string): ManifestWorker => {
      launches.push(hash);
      const exited = deferred<void>();
      return { ready: Promise.resolve(), exited: exited.promise, stop: async () => { stops.push(hash); exited.resolve(); } };
    };
    const supervisor = createManifestSupervisor({ read: () => loadRuntimeManifest(url, 'testnet'),
      launch: manifest => launch(manifest.runtime.manifestHash), onError: error => errors.push(error), pollMs: 10 });
    await supervisor.start();
    try {
      await supervisor.refresh(); assert.deepEqual(launches, [first.manifestHash]);
      body = JSON.stringify(second);
      await until(() => launches.length === 2);
      assert.deepEqual(stops, [first.manifestHash]);
      assert.deepEqual(launches, [first.manifestHash, second.manifestHash]);
      body = JSON.stringify({ ...second, globalId: -239 });
      await until(() => errors.length === 1);
      assert.deepEqual(stops, [first.manifestHash, second.manifestHash]);
      body = JSON.stringify(second);
      await until(() => launches.length === 3);
    } finally { await supervisor.stop(); }
    assert.equal(stops.length, 3);

    // Poll even while cold authentication has not completed. A later ready
    // event from a retired child must not affect its replacement.
    body = JSON.stringify(first);
    const warming: { hash: string; ready: ReturnType<typeof deferred<void>>; stopped: boolean }[] = [];
    const cold = createManifestSupervisor({ read: () => loadRuntimeManifest(url, 'testnet'),
      launch: manifest => {
        const state = { hash: manifest.runtime.manifestHash, ready: deferred<void>(), stopped: false };
        warming.push(state); const exited = deferred<void>();
        return { ready: state.ready.promise, exited: exited.promise,
          stop: async () => { state.stopped = true; exited.resolve(); } };
      }, onError: error => errors.push(error), pollMs: 10 });
    await cold.start();
    try {
      assert.equal(warming.length, 1);
      body = JSON.stringify(second);
      await until(() => warming.length === 2);
      assert(warming[0].stopped, 'a changed manifest retires a child whose readiness is pending');
      warming[0].ready.resolve();
      await cold.refresh();
      assert.equal(warming.length, 2);
      body = JSON.stringify({ ...second, globalId: -239 });
      await until(() => warming[1].stopped);
      assert.equal(warming.length, 2, 'an invalid manifest cannot launch another child');
    } finally { await cold.stop(); }

    // A failed startup remains fenced until its process has actually exited.
    const failedReady = deferred<void>(), failedDrain = deferred<void>();
    let failedStops = 0, failedLaunches = 0;
    const failed = createManifestSupervisor({ read: async () => parseCanonicalReleaseManifest(first, 'testnet'),
      launch: () => {
        failedLaunches++; const exited = deferred<void>(); let stop: Promise<void> | undefined;
        return { ready: failedReady.promise, exited: exited.promise,
          stop: () => stop ??= (async () => { failedStops++; await failedDrain.promise; exited.resolve(); })() };
      }, onError: error => errors.push(error), pollMs: 60_000 });
    await failed.start();
    failedReady.reject(Error('cold authentication failed'));
    await until(() => failedStops === 1);
    await failed.refresh();
    assert.equal(failedLaunches, 1, 'failed startup cannot overlap a draining child');
    const stopFailed = failed.stop();
    failedDrain.resolve(); await stopFailed;

    // Repeated polls serialize, and replacement cannot launch while old work
    // is still draining. Shutdown during that drain cannot start a new worker.
    let current = first;
    const drain = deferred<void>(), stopping = deferred<void>();
    let count = 0;
    const fenced = createManifestSupervisor({ read: async () => parseCanonicalReleaseManifest(current, 'testnet'),
      launch: () => { count++; const exited = deferred<void>(); return { ready: Promise.resolve(), exited: exited.promise,
        stop: async () => { stopping.resolve(); await drain.promise; exited.resolve(); } }; }, onError: error => { throw error; }, pollMs: 60_000 });
    await fenced.start(); current = second;
    const replacing = fenced.refresh();
    await stopping.promise;
    assert.equal(count, 1);
    const stoppingSupervisor = fenced.stop();
    drain.resolve(); await Promise.all([replacing, stoppingSupervisor]);
    assert.equal(count, 1, 'shutdown must prevent a late replacement');

    // Verify against the actual installed pg parser: URL options cannot force
    // the next release back into public or another release's schema.
    const config = releasePoolConfig('postgres://unit:unit@127.0.0.1/tonswap?options=-c%20search_path%3Dpublic', first.manifestHash);
    const client = new Client(config);
    assert.equal((client as any).connectionParameters.options, `-c search_path=${releaseDatabaseSchema(first.manifestHash)}`);
    assert.notEqual(releaseDatabaseSchema(first.manifestHash), releaseDatabaseSchema(second.manifestHash));
    const processWorker = launchManifestWorker(__filename, parseCanonicalReleaseManifest(first, 'testnet'));
    await processWorker.ready;
    await processWorker.stop(); await processWorker.stop(); await processWorker.exited;
    const wrongReady = runtimeManifestFixture({ services: { ...first.services, indexer: 'https://wrong-ready.test' } });
    const rejectedWorker = launchManifestWorker(__filename, parseCanonicalReleaseManifest(wrongReady, 'testnet'), 1_000);
    await assert.rejects(rejectedWorker.ready, /timed out/);
    await rejectedWorker.stop(); await rejectedWorker.exited;
    process.stdout.write('runtime manifest transport, polling, restart and release isolation ok\n');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv.includes('--manifest-worker')) {
  process.once('message', (message: any) => {
    assert.equal(message.type, 'manifest-start');
    const manifest = parseCanonicalReleaseManifest(message.manifest, 'testnet');
    process.send?.({ type: 'manifest-ready', manifestHash: manifest.runtime.services.indexer === 'https://wrong-ready.test'
      ? '0'.repeat(64) : manifest.runtime.manifestHash });
    setInterval(() => undefined, 1_000);
    process.on('SIGTERM', () => process.exit(0));
  });
} else main().catch(error => { console.error(error); process.exitCode = 1; });
