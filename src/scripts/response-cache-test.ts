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
  async runGetMethod() {
    return null;
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

  store.addTransactions(addr, [
    {
      address: addr,
      lt: '12',
      hash: 'swap1',
      utime: 100,
      success: true,
      inMessage: undefined,
      outMessages: [],
      kind: 'swap',
      actions: [
        {
          kind: 'swap',
          amountIn: '1000',
          amountOut: '995',
          queryId: '1',
          executionType: 'twap',
          twapSlice: 2,
          twapTotal: 5,
          querySequence: 1234,
          queryNonce: 7,
        },
      ],
      ui: {
        txId: '12:swap1',
        utime: 100,
        status: 'success',
        txType: 'Swap',
        outCount: 0,
        detail: {
          kind: 'swap',
          payToken: 'T3',
          receiveToken: 'TON',
          payAmount: '1000',
          receiveAmount: '995',
          queryId: '1',
          executionType: 'twap',
          twapSlice: 2,
          twapTotal: 5,
          querySequence: 1234,
          queryNonce: 7,
        },
        kind: 'swap',
        actions: [],
      },
    },
    {
      address: addr,
      lt: '13',
      hash: 'swap2',
      utime: 101,
      success: false,
      inMessage: undefined,
      outMessages: [],
      kind: 'swap',
      actions: [],
      ui: {
        txId: '13:swap2',
        utime: 101,
        status: 'failed',
        reason: 'aborted',
        txType: 'Swap',
        outCount: 0,
        detail: {
          kind: 'swap',
          payToken: 'TON',
          receiveToken: 'T3',
          payAmount: '10',
          receiveAmount: '100',
          queryId: '2',
          executionType: 'limit',
          querySequence: 555,
          queryNonce: 9,
        },
        kind: 'swap',
        actions: [],
      },
    },
  ]);

  const swaps = await service.getSwapExecutions(addr, { limit: 10 });
  assert.equal(swaps.total_swaps, 2);
  assert.equal(swaps.returned_swaps, 2);
  assert.equal(swaps.swaps[0]?.txId, '13:swap2');
  assert.equal(swaps.summary.status_counts.success, 1);
  assert.equal(swaps.summary.status_counts.failed, 1);
  assert.equal(swaps.summary.execution_type_counts.twap, 1);
  assert.equal(swaps.summary.execution_type_counts.limit, 1);
  assert.equal(swaps.summary.pending_limit_count, 0);
  assert.equal(swaps.summary.twap_run_count, 1);
  assert.equal(swaps.twap_runs[0]?.id, 'seq:1234');
  assert.equal(swaps.pending_limits.length, 0);

  const twapOnly = await service.getSwapExecutions(addr, { limit: 10, executionType: 'twap' });
  assert.equal(twapOnly.total_swaps, 1);
  assert.equal(twapOnly.swaps[0]?.twapRunId, 'seq:1234');
  assert.equal(twapOnly.swaps[0]?.queryNonce, 7);
  assert.equal(twapOnly.summary.execution_type_counts.twap, 1);
  assert.equal(twapOnly.summary.twap_run_count, 1);
  assert.equal(twapOnly.twap_runs[0]?.status, 'partial');

  const reversedPair = await service.getSwapExecutions(addr, {
    limit: 10,
    payToken: 'T3',
    receiveToken: 'TON',
    includeReverse: true,
  });
  assert.equal(reversedPair.total_swaps, 2);

  const fromWindow = await service.getSwapExecutions(addr, { limit: 10, fromUtime: 101 });
  assert.equal(fromWindow.total_swaps, 1);
  assert.equal(fromWindow.swaps[0]?.txId, '13:swap2');
  assert.equal(fromWindow.summary.pending_limit_count, 0);

  const fixedWindow = await service.getSwapExecutions(addr, { limit: 10, fromUtime: 100, toUtime: 100 });
  assert.equal(fixedWindow.total_swaps, 1);
  assert.equal(fixedWindow.swaps[0]?.txId, '12:swap1');
  assert.equal(fixedWindow.summary.twap_run_count, 1);
  assert.equal(fixedWindow.twap_runs[0]?.id, 'seq:1234');

  console.log('response cache ok');
};

run().catch((error) => {
  console.error('response cache test failed', error);
  process.exit(1);
});
