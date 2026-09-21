import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { IndexerService } from '../indexerService';
import { loadOpcodes } from '../utils/opcodes';
import { AccountState } from '../models';
import { TonDataSource } from '../data/dataSource';
import { runGetterFreshnessTests } from './getter-freshness-cases';

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
const txHash = (lt: number) =>
  Buffer.from(BigInt(lt).toString(16).padStart(64, '0'), 'hex').toString('base64');

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
  await runGetterFreshnessTests();
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
    lastTxLt: '10',
    lastTxHash: txHash(10),
    updatedAt: Date.now(),
  };
  store.setBalance(addr, updatedState);
  const third = await service.getBalance(addr);
  assert.equal(third.ton.balance, '200');

  store.addTransactions(addr, [
    {
      address: addr,
      lt: '10',
      hash: txHash(10),
      prevTransactionLt: '0',
      prevTransactionHash: txHash(0),
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

  store.setBalance(addr, {
    ...updatedState,
    lastTxLt: '11',
    lastTxHash: txHash(11),
    updatedAt: Date.now(),
  });
  store.addTransactions(addr, [
    {
      address: addr,
      lt: '11',
      hash: txHash(11),
      prevTransactionLt: '10',
      prevTransactionHash: txHash(10),
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

  store.setBalance(addr, {
    ...updatedState,
    lastTxLt: '13',
    lastTxHash: txHash(13),
    updatedAt: Date.now(),
  });
  store.addTransactions(addr, [
    {
      address: addr,
      lt: '12',
      hash: txHash(12),
      prevTransactionLt: '11',
      prevTransactionHash: txHash(11),
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
          tokenIn: { kind: 'jetton', master: addr, symbol: 'T3' },
          tokenOut: { kind: 'ton' },
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
      hash: txHash(13),
      prevTransactionLt: '12',
      prevTransactionHash: txHash(12),
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
          payToken: 'GRAM',
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
  assert.ok(Number.isInteger(swaps.synced_at) && swaps.synced_at > 0);
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
  assert.ok(Number.isInteger(twapOnly.synced_at) && twapOnly.synced_at > 0);
  assert.equal(twapOnly.swaps[0]?.twapRunId, 'seq:1234');
  assert.equal(twapOnly.swaps[0]?.queryNonce, 7);
  assert.equal(twapOnly.summary.execution_type_counts.twap, 1);
  assert.equal(twapOnly.summary.twap_run_count, 1);
  assert.equal(twapOnly.twap_runs[0]?.status, 'partial');

  const reversedPair = await service.getSwapExecutions(addr, {
    limit: 10,
    payToken: 'T3',
    receiveToken: 'GRAM',
    includeReverse: true,
  });
  assert.equal(reversedPair.total_swaps, 2);

  const nativePair = await service.getSwapExecutions(addr, {
    limit: 10, payToken: 'GRAM', receiveToken: 'T3',
  });
  assert.equal(nativePair.total_swaps, 1);
  assert.equal(nativePair.swaps[0]?.payToken, 'GRAM');
  const unrelatedTicker = await service.getSwapExecutions(addr, {
    limit: 10, payToken: 'TON', receiveToken: 'T3', includeReverse: true,
  });
  assert.equal(unrelatedTicker.total_swaps, 0, 'TON must not alias the native GRAM ticker');

  const fromWindow = await service.getSwapExecutions(addr, { limit: 10, fromUtime: 101 });
  assert.equal(fromWindow.total_swaps, 1);
  assert.equal(fromWindow.swaps[0]?.txId, '13:swap2');
  assert.equal(fromWindow.summary.pending_limit_count, 0);

  const fixedWindow = await service.getSwapExecutions(addr, { limit: 10, fromUtime: 100, toUtime: 100 });
  assert.equal(fixedWindow.total_swaps, 1);
  assert.equal(fixedWindow.swaps[0]?.txId, '12:swap1');
  assert.equal(fixedWindow.summary.twap_run_count, 1);
  assert.equal(fixedWindow.twap_runs[0]?.id, 'seq:1234');

  const original = store.get(addr)!.txs.find((tx) => tx.lt === '12')!;
  store.setBalance(addr, { ...updatedState, lastTxLt: '14', lastTxHash: txHash(14), updatedAt: Date.now() });
  store.addTransactions(addr, [{
    ...original, lt: '14', hash: txHash(14), prevTransactionLt: '13', prevTransactionHash: txHash(13), utime: 102,
    actions: [{ kind: 'swap', tokenIn: { kind: 'ton' }, tokenOut: { kind: 'jetton', master: addr, symbol: 'T3' },
      amountIn: '1000000000', amountOut: '2000000000' }],
    ui: { ...original.ui, txId: '14:native-swap', utime: 102, detail: { kind: 'swap' } },
  }]);
  const nativeFallback = await service.getSwapExecutions(addr, { limit: 10, payToken: 'GRAM', receiveToken: 'T3' });
  assert.equal(nativeFallback.swaps[0]?.payToken, 'GRAM');
  assert.equal(nativeFallback.swaps[0]?.receiveToken, 'T3');
  const nativeCandles = await service.getMarketCandles('spot:GRAM-T3', addr, {
    assetSymbol: 'GRAM', quoteSymbol: 'T3', assetDecimals: 9, quoteDecimals: 9, fromUtime: 102,
  });
  assert.equal(nativeCandles.market_key, 'spot:GRAM-T3');
  assert.equal(nativeCandles.candle_count, 1);
  assert.equal(nativeCandles.candles[0]?.close, 2);
  assert.deepEqual(nativeCandles.candles[0]?.sourceTxIds, ['14:native-swap']);

  console.log('response cache ok');
};

run().catch((error) => {
  console.error('response cache test failed', error);
  process.exit(1);
});
