import assert from 'node:assert/strict';
import { createManifestSupervisor } from '../manifestSupervisor';
import { loadRuntimeManifest, ManifestTransportError } from '../config/manifestSource';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

async function main() {
  let mode: 'ok' | 'timeout' | 'server' | 'changed' | 'invalid' | 'not-found' = 'ok';
  const first = runtimeManifestFixture(), second = runtimeManifestFixture({ createdAt: '2026-10-06T00:00:00.000Z' });
  const fetcher: typeof fetch = async () => {
    if (mode === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    if (mode === 'server') return new Response('', { status: 503 });
    if (mode === 'not-found') return new Response('', { status: 404 });
    return new Response(mode === 'invalid' ? '{"invalid":true}' : JSON.stringify(mode === 'changed' ? second : first));
  };
  let launches = 0, stops = 0;
  const errors: unknown[] = [];
  const supervisor = createManifestSupervisor({ read: () => loadRuntimeManifest('https://manifest.example/release', 'testnet', fetcher),
    launch() {
      launches++; let exit!: () => void;
      const exited = new Promise<void>(resolve => { exit = resolve; });
      return { exited, ready: Promise.resolve(), async stop() { stops++; exit(); } };
    }, onError: error => errors.push(error), pollMs: 60_000 });
  try {
    await supervisor.start(); assert.equal(launches, 1);
    mode = 'timeout'; await supervisor.refresh(); await supervisor.refresh();
    assert.equal(stops, 0); assert.equal(errors.length, 1); assert(errors[0] instanceof ManifestTransportError);
    mode = 'server'; await supervisor.refresh(); assert.equal(stops, 0); assert.equal(errors.length, 2);
    mode = 'changed'; await supervisor.refresh(); assert.equal(stops, 1); assert.equal(launches, 2);
    mode = 'invalid'; await supervisor.refresh(); assert.equal(stops, 2); assert.equal(launches, 2);
    mode = 'ok'; await supervisor.refresh(); assert.equal(launches, 3);
    mode = 'not-found'; await supervisor.refresh(); assert.equal(stops, 3);
  } finally { await supervisor.stop(); }
  const brokenBody: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('disconnected')); } }));
  await assert.rejects(loadRuntimeManifest('https://manifest.example/release', 'testnet', brokenBody), ManifestTransportError);
  console.log('Manifest supervisor preserves running workers on transport outages and retires changed, invalid or withdrawn publications');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
