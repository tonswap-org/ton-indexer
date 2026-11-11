import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDiskGuard, type DiskState } from '../diskGuard';

async function main() {
  let bytes = 200n;
  let fail = false;
  const changes: Array<{ state: DiskState; path: string; free: number }> = [];
  const guard = createDiskGuard({
    paths: ['/snapshot', '/database'], softFloorBytes: 100, hardFloorBytes: 50, intervalMs: 5,
    statfs: async path => { if (fail) throw new Error('unavailable'); return { bavail: path === '/snapshot' ? 500n : bytes, bsize: 1n }; },
    onChange: (state, path, free) => { changes.push({ state, path, free }); },
  });
  const waitFor = async (state: DiskState) => {
    for (let i = 0; i < 100 && (guard.state() !== state || guard.freeBytes() !== (fail ? null : Number(bytes))); i += 1) await delay(5);
    assert.equal(guard.state(), state);
  };
  try {
    assert.equal(guard.state(), 'critical', 'unknown capacity does not admit work');
    assert.equal(guard.freeBytes(), null);
    await waitFor('ok');
    bytes = 99n; await waitFor('low');
    await delay(20);
    assert.equal(changes.length, 2, 'repeated low samples are quiet');
    bytes = 49n; await waitFor('critical');
    bytes = 50n; await waitFor('low');
    bytes = 100n; await waitFor('ok');
    fail = true; await waitFor('critical');
    assert.equal(guard.freeBytes(), null);
    fail = false; bytes = 200n; await waitFor('ok');
    assert.deepEqual(changes.map(row => row.state), ['ok', 'low', 'critical', 'low', 'ok', 'critical', 'ok']);
    assert.equal(changes[1].path, '/database');
    assert.equal(changes[1].free, 99);
  } finally { guard.stop(); }
  const count = changes.length;
  bytes = 1n;
  await delay(20);
  assert.equal(changes.length, count, 'stop ends sampling');
  assert.throws(() => createDiskGuard({ paths: [], softFloorBytes: 100, hardFloorBytes: 50 }));
  assert.throws(() => createDiskGuard({ paths: ['/'], softFloorBytes: 10, hardFloorBytes: 50 }));

  let resolve!: (value: { bavail: bigint; bsize: bigint }) => void;
  let calls = 0;
  const pending = createDiskGuard({ paths: ['/'], softFloorBytes: 100, hardFloorBytes: 50, intervalMs: 1,
    statfs: () => { calls += 1; return new Promise(done => { resolve = done; }); } });
  await delay(20);
  assert.equal(calls, 1, 'slow filesystem probes never overlap');
  pending.stop();
  resolve({ bavail: 200n, bsize: 1n });
  await delay(1);
  assert.equal(pending.freeBytes(), null, 'a completed probe after stop changes nothing');
  console.log('Disk guard samples capacity, reports only transitions, fails closed and stops cleanly');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
