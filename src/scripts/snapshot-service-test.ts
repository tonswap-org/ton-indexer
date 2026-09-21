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

// The system-health route consumes only the current four/five-field FeeRouter ABI.
const checkFeeRouterSnapshots = async () => {
  const { Address, beginCell } = await import('@ton/core');
  const { decodeFeeRouterStateSnapshot, decodeFeeRouterTargetsSnapshot } = await import('../indexerService');
  const address = new Address(0, Buffer.alloc(32, 19));
  const state = [12n, 7n, 2_000_000_000n, 900n].map(value => ({ type: 'int' as const, value }));
  assert.deepEqual(decodeFeeRouterStateSnapshot(state), { balance: '12', lastSequence: '7', lastTimestamp: '2000000000', lastProfitAmount: '900' });
  for (const invalid of [state.slice(0, 3), [...state, { type: 'int' as const, value: 0n }],
    Array.from({ length: 15 }, () => ({ type: 'int' as const, value: 0n }))]) assert.equal(decodeFeeRouterStateSnapshot(invalid), null);
  for (const [index, value] of [[0, -1n], [0, 1n << 120n], [1, 1n << 32n], [2, 1n << 63n], [3, -1n], [3, 1n << 120n]] as const) {
    const invalid = [...state]; invalid[index] = { type: 'int', value };
    assert.equal(decodeFeeRouterStateSnapshot(invalid), null);
  }
  assert.equal(decodeFeeRouterStateSnapshot([{ type: 'null' }, ...state.slice(1)]), null);
  const targets = [address, address, address, address, null].map(value => ({ type: 'slice' as const,
    cell: beginCell().storeAddress(value).endCell() }));
  assert.deepEqual(decodeFeeRouterTargetsSnapshot(targets), { t3Root: address.toRawString(), t3Wallet: address.toRawString(),
    treasuryTarget: address.toRawString(), referralTarget: address.toRawString(), referralRegistry: null });
  assert.deepEqual(decodeFeeRouterTargetsSnapshot(targets.map(() => ({ type: 'slice', cell: beginCell().storeAddress(null).endCell() }))),
    { t3Root: null, t3Wallet: null, treasuryTarget: null, referralTarget: null, referralRegistry: null });
  for (const invalid of [targets.slice(0, 4), [...targets, ...targets.slice(0, 4)],
    [{ type: 'int' as const, value: 0n }, ...targets.slice(1)],
    [{ type: 'cell' as const, cell: beginCell().endCell() }, ...targets.slice(1)],
    [{ type: 'slice' as const, cell: beginCell().storeAddress(address).storeBit(1).endCell() }, ...targets.slice(1)],
    [{ type: 'slice' as const, cell: beginCell().storeAddress(null).storeRef(beginCell().endCell()).endCell() }, ...targets.slice(1)]])
    assert.equal(decodeFeeRouterTargetsSnapshot(invalid), null);
  console.log('FeeRouter current snapshots:19 acceptance/rejection checks passed');
};
checkFeeRouterSnapshots().catch(error => { console.error(error); process.exitCode = 1; });
