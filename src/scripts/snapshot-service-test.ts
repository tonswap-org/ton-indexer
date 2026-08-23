import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { SnapshotService } from '../snapshotService';

const config = loadConfig();
const dir = mkdtempSync(join(tmpdir(), 'ton-indexer-'));
const path = join(dir, 'snapshot.json');
const store = new MemoryStore({ ...config, maxAddresses: 10 });
const service = new SnapshotService({ ...config, snapshotPath: path }, store);
const firstHash = Buffer.alloc(32, 2).toString('base64');
const secondHash = Buffer.alloc(32, 1).toString('base64');

store.addTransactions('addr1', [
  {
    address: 'addr1',
    lt: '2',
    hash: firstHash,
    utime: 2,
    success: true,
    inMessage: undefined,
    outMessages: [],
    kind: 'transfer',
    actions: [],
    ui: {
      txId: `2:${firstHash}`,
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

const save = service.save();
assert.ok(save.entries === 1);

store.addTransactions('addr1', [
  {
    address: 'addr1',
    lt: '1',
    hash: secondHash,
    utime: 1,
    success: true,
    inMessage: undefined,
    outMessages: [],
    kind: 'transfer',
    actions: [],
    ui: {
      txId: `1:${secondHash}`,
      utime: 1,
      status: 'success',
      txType: 'Transfer',
      outCount: 0,
      detail: { kind: 'transfer' },
      kind: 'transfer',
      actions: [],
    },
  },
]);

const load = service.load();
assert.ok(load.entries === 1);
const page = store.getPage('addr1', 1);
assert.equal(page?.txs.length, 1);
assert.equal(page?.txs[0]?.lt, '2');

rmSync(dir, { recursive: true, force: true });
console.log('snapshot service ok');
