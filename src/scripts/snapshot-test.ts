import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memoryStore';
import { loadConfig } from '../config';
import { StoreSnapshot } from '../store/memoryStore';

const config = loadConfig();
const store = new MemoryStore({ ...config, maxAddresses: 10 });

store.addTransactions('addr1', [
  {
    address: 'addr1',
    lt: '2',
    hash: 'b',
    utime: 2,
    success: true,
    inMessage: undefined,
    outMessages: [],
    kind: 'transfer',
    actions: [],
    ui: {
      txId: '2:b',
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

console.log('snapshot ok');
