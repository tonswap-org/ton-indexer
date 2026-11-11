import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSnapshotFile, writeSnapshotFile } from '../snapshot';
import { MemoryStore } from '../store/memoryStore';
import { loadConfig } from '../config';
import { StoreSnapshot } from '../store/memoryStore';

const config = loadConfig();
const store = new MemoryStore({ ...config, maxAddresses: 10 });
const txHash = Buffer.alloc(32, 2).toString('base64');

store.addTransactions('addr1', [
  {
    address: 'addr1',
    lt: '2',
    hash: txHash,
    utime: 2,
    success: true,
    inMessage: undefined,
    outMessages: [],
    kind: 'transfer',
    actions: [],
    ui: {
      txId: `2:${txHash}`,
      utime: 2,
      status: 'success',
      txType: 'Transfer',
      outCount: 0,
      detail: { kind: 'transfer' },
      kind: 'transfer',
      actions: [],
    },
  },
]);

const snapshot: StoreSnapshot = store.exportSnapshot();
assert.equal(snapshot.entries.length, 1);

const restored = new MemoryStore({ ...config, maxAddresses: 10 });
restored.importSnapshot(snapshot);
const page = restored.getPage('addr1', 1);
assert.ok(page);
assert.equal(page?.txs.length, 1);
assert.equal(page?.txs[0]?.lt, '2');

async function fileChecks() {
  const fileSnapshot = JSON.parse(JSON.stringify(snapshot)) as StoreSnapshot;
  const directory = mkdtempSync(join(tmpdir(), 'indexer-snapshot-test-'));
  try {
    const path = join(directory, 'snapshot.json');
    await writeSnapshotFile(path, fileSnapshot);
    assert.deepEqual(loadSnapshotFile(path), fileSnapshot);
    assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(snapshot)}\n`, 'compact JSON');
    writeFileSync(`${path}.tmp`, 'interrupted write');
    assert.deepEqual(loadSnapshotFile(path), fileSnapshot);
    assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false, 'load removes stale temporary data');

    const pending = writeSnapshotFile(path, fileSnapshot);
    assert.ok(pending instanceof Promise);
    const overlapping = writeSnapshotFile(path, fileSnapshot);
    assert.ok(overlapping instanceof Promise);
    await overlapping;
    await pending;
    const later = { ...fileSnapshot, createdAt: fileSnapshot.createdAt + 1 };
    await Promise.all([writeSnapshotFile(path, fileSnapshot), writeSnapshotFile(path, later)]);
    assert.deepEqual(loadSnapshotFile(path), later, 'concurrent saves are serialized');
    assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);

    const blocked = join(directory, 'target-is-a-directory');
    mkdirSync(blocked);
    for (let i = 0; i < 3; i += 1) await assert.rejects(writeSnapshotFile(blocked, snapshot));
    assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false, 'failed saves leak no files');
    await writeSnapshotFile(path, later);
    assert.deepEqual(loadSnapshotFile(path), later, 'a failed writer cannot poison later saves');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  console.log('snapshot ok: compact atomic saves, promise writes, serialization and failure cleanup');
}
fileChecks().catch(error => { console.error(error); process.exitCode = 1; });
