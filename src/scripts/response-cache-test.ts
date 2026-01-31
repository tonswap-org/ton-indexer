import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { IndexerService } from '../indexerService';
import { loadOpcodes } from '../utils/opcodes';
import { AccountState } from '../models';
import { TonDataSource } from '../data/dataSource';

const config = {
  ...loadConfig(),
  responseCacheEnabled: true,
  balanceCacheTtlMs: 100000,
  txCacheTtlMs: 100000,
  stateCacheTtlMs: 100000,
};

const store = new MemoryStore({ ...config, maxAddresses: 10 });
const opcodes = loadOpcodes(undefined);
let accountStateCalls = 0;

const dummySource: TonDataSource = {
  network: 'mainnet',
  async getMasterchainInfo() {
    return { seqno: 0 };
  },
  async getAccountState() {
    accountStateCalls += 1;
    return { balance: '100', lastTxLt: '1', lastTxHash: 'hash1' };
  },
  async getTransactions() {
    return [];
  },
  async getJettonBalance() {
    return null;
  },
  async getJettonMetadata() {
    return null;
  },
  async close() {
    return;
  },
};

const service = new IndexerService(config, store, dummySource, opcodes, []);

const run = async () => {
  const addr = `0:${'1'.repeat(64)}`;
  const first = await service.getBalance(addr);
  assert.equal(first.ton.balance, '100');
  assert.equal(accountStateCalls, 1);

  const second = await service.getBalance(addr);
  assert.equal(second.ton.balance, '100');
  assert.equal(accountStateCalls, 1);

  const updatedState: AccountState = {
    address: addr,
    balance: '200',
    lastTxLt: '2',
    lastTxHash: 'hash2',
    updatedAt: Date.now(),
  };
  store.setBalance(addr, updatedState);
  const third = await service.getBalance(addr);
  assert.equal(third.ton.balance, '200');

  store.addTransactions(addr, [
    {
      address: addr,
      lt: '10',
      hash: 'tx1',
      utime: 0,
      success: true,
      inMessage: undefined,
      outMessages: [],
      kind: 'transfer',
      actions: [],
      ui: {
        txId: '10:tx1',
        utime: 0,
        status: 'success',
        txType: 'Transfer',
        outCount: 0,
        detail: { kind: 'transfer' },
        kind: 'transfer',
        actions: [],
      },
    },
  ]);

  const txs1 = await service.getTransactions(addr, 1);
  assert.equal(txs1.txs[0]?.lt, '10');

  store.addTransactions(addr, [
    {
      address: addr,
      lt: '11',
      hash: 'tx2',
      utime: 0,
      success: true,
      inMessage: undefined,
      outMessages: [],
      kind: 'transfer',
      actions: [],
      ui: {
        txId: '11:tx2',
        utime: 0,
        status: 'success',
        txType: 'Transfer',
        outCount: 0,
        detail: { kind: 'transfer' },
        kind: 'transfer',
        actions: [],
      },
    },
  ]);

  const txs2 = await service.getTransactions(addr, 1);
  assert.equal(txs2.txs[0]?.lt, '11');

  console.log('response cache ok');
};

run().catch((error) => {
  console.error('response cache test failed', error);
  process.exit(1);
});
