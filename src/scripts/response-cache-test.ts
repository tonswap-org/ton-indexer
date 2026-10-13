import { fixtureChainSource, fixtureHead, type FixtureChainSource } from './support/chainFixture';
import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { IndexerService } from '../indexerService';
import { loadOpcodes } from '../utils/opcodes';
import { AccountState } from '../models';
import { ChainReadError } from '../data/dataSource';

const config = {
  ...loadConfig(),
  responseCacheEnabled: true,
  txCacheTtlMs: 100000,
};

const store = new MemoryStore({ ...config, maxAddresses: 10 });
const opcodes = loadOpcodes();
const txHash = (lt: number) =>
  Buffer.from(BigInt(lt).toString(16).padStart(64, '0'), 'hex').toString('base64');

const dummySource: FixtureChainSource = fixtureChainSource({
  network: 'mainnet',
  async head() {
    return { seqno: 0 };
  },
  async getAccountState() {
    return { balance: '100', lastTxLt: '1', lastTxHash: 'hash1' };
  },
  async getTransactions() {
    return [];
  },
  async runGetMethod() {
    return null;
  },
  async walletBalance() {
    return null;
  },
  async jettonMetadata() {
    return null;
  },
  async close() {
    return;
  },
});

const service = new IndexerService(config, store, dummySource, opcodes, []);

const run = async () => {
  const addr = `0:${'1'.repeat(64)}`;
  let stateHeads = 0;
  let stateReads = 0;
  const unavailable = new ChainReadError('upstream_unavailable');
  const freshStateService = new IndexerService(config, new MemoryStore(config), fixtureChainSource({
    network: config.network,
    head: async () => ({ seqno: ++stateHeads }),
    getAccountState: async (_address, options) => {
      stateReads += 1;
      assert.equal(options?.at?.seqno, stateHeads, 'account state is pinned to this request\'s head');
      assert(options?.signal, 'the account read shares the service deadline');
      if (stateReads === 3) throw unavailable;
      return { balance: String(stateReads * 100), lastTxLt: String(stateReads), lastTxHash: txHash(stateReads),
        anchor: { shardBlock: { ...fixtureHead(stateReads + 100), workchain: 0 }, genUtime: 1_700_000_000 + stateReads } };
    },
  }), opcodes, []);
  const firstState = await freshStateService.getState(addr);
  const secondState = await freshStateService.getState(addr);
  assert.equal(firstState.balance_raw, '100');
  assert.equal(secondState.balance_raw, '200', 'state is refreshed even with response caching enabled');
  assert.equal(secondState.last_confirmed_seqno, 2);
  assert.equal(secondState.shard_block.seqno, 102);
  assert.equal(secondState.shard_utime, 1_700_000_002);
  await assert.rejects(freshStateService.getState(addr), error => error === unavailable,
    'a failed current read cannot return the previous successful state');
  assert.equal(stateHeads, 3);
  assert.equal(stateReads, 3);

  const updatedState: AccountState = {
    address: addr,
    balance: '200',
    lastTxLt: '10',
    lastTxHash: txHash(10),
    updatedAt: Date.now(),
  };
  store.setBalance(addr, updatedState);

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

  const original = store.get(addr)!.txs.find((tx) => tx.lt === '12')!;
  store.setBalance(addr, { ...updatedState, lastTxLt: '14', lastTxHash: txHash(14), updatedAt: Date.now() });
  store.addTransactions(addr, [{
    ...original, lt: '14', hash: txHash(14), prevTransactionLt: '13', prevTransactionHash: txHash(13), utime: 102,
    actions: [{ kind: 'swap', tokenIn: { kind: 'ton' }, tokenOut: { kind: 'jetton', master: addr, symbol: 'T3' },
      amountIn: '1000000000', amountOut: '2000000000' }],
    ui: { ...original.ui, txId: '14:native-swap', utime: 102, detail: { kind: 'swap' } },
  }]);
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
