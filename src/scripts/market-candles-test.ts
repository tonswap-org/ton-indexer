import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from '../config';
import { registerRoutes } from '../api/routes';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { IndexedTx } from '../models';
import { MemoryStore } from '../store/memoryStore';
import { OpcodeSets } from '../utils/opcodes';

const marketAddress = `0:${'1'.repeat(64)}`;

const source: TonDataSource = {
  network: 'localnet',
  async getMasterchainInfo() {
    return { seqno: 1 };
  },
  async getAccountState() {
    return { balance: '0' };
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

const opcodes: OpcodeSets = {
  swap: new Set(),
  lpDeposit: new Set(),
  lpWithdraw: new Set(),
  jettonTransfer: new Set(),
  jettonNotify: new Set(),
};

const makeSwap = (options: {
  lt: number;
  utime: number;
  payToken: string;
  receiveToken: string;
  payAmount: string;
  receiveAmount?: string;
  minOut?: string;
  status?: 'success' | 'failed' | 'pending';
}): IndexedTx => {
  const status = options.status ?? 'success';
  const txId = `${options.lt}:hash-${options.lt}`;
  const action = {
    kind: 'swap' as const,
    pool: marketAddress,
    tokenIn: { kind: 'jetton' as const, master: marketAddress, symbol: options.payToken },
    tokenOut: { kind: 'jetton' as const, master: marketAddress, symbol: options.receiveToken },
    amountIn: options.payAmount,
    amountOut: options.receiveAmount,
    minOut: options.minOut,
  };
  return {
    address: marketAddress,
    lt: String(options.lt),
    hash: `hash-${options.lt}`,
    utime: options.utime,
    success: status === 'success',
    outMessages: [],
    kind: 'swap',
    actions: [action],
    ui: {
      txId,
      utime: options.utime,
      status,
      txType: 'Swap',
      outCount: 0,
      detail: {
        kind: 'swap',
        payToken: options.payToken,
        receiveToken: options.receiveToken,
        payAmount: options.payAmount,
        receiveAmount: options.receiveAmount ?? options.minOut,
      },
      kind: 'swap',
      actions: [action],
    },
  };
};

async function main() {
  const config = {
    ...loadConfig(),
    network: 'localnet' as const,
    responseCacheEnabled: false,
  };
  const store = new MemoryStore(config);
  store.addTransactions(marketAddress, [
    makeSwap({
      lt: 1,
      utime: 121,
      payToken: 'X',
      receiveToken: 'T3',
      payAmount: '2',
      receiveAmount: '4',
    }),
    makeSwap({
      lt: 2,
      utime: 130,
      payToken: 'T3',
      receiveToken: 'X',
      payAmount: '3',
      receiveAmount: '1',
    }),
    makeSwap({
      lt: 3,
      utime: 190,
      payToken: 'TOKEN',
      receiveToken: 'T3',
      payAmount: '1',
      receiveAmount: '4',
    }),
    makeSwap({
      lt: 4,
      utime: 195,
      payToken: 'TOKEN',
      receiveToken: 'T3',
      payAmount: '100',
      receiveAmount: '100',
      status: 'failed',
    }),
    makeSwap({
      lt: 5,
      utime: 196,
      payToken: 'TOKEN',
      receiveToken: 'T3',
      payAmount: '100',
      minOut: '100',
    }),
    makeSwap({
      lt: 6,
      utime: 197,
      payToken: 'OTHER',
      receiveToken: 'T3',
      payAmount: '100',
      receiveAmount: '100',
    }),
  ]);
  store.markHistoryComplete(marketAddress);

  const service = new IndexerService(config, store, source, opcodes, []);
  const result = await service.getMarketCandles('spot:TOKEN-T3', marketAddress, {
    assetSymbol: 'TOKEN',
    quoteSymbol: 'T3',
    assetDecimals: 0,
    quoteDecimals: 0,
    interval: '1m',
  });

  assert.equal(result.network, 'localnet');
  assert.equal(result.history_complete, true);
  assert.equal(result.candle_count, 2);
  assert.deepEqual(result.candles[0], {
    ts: 120,
    open: 2,
    high: 3,
    low: 2,
    close: 3,
    volumeBase: 3,
    volumeQuote: 7,
    tradeCount: 2,
    sourceTxIds: ['1:hash-1', '2:hash-2'],
  });
  assert.deepEqual(result.candles[1], {
    ts: 180,
    open: 4,
    high: 4,
    low: 4,
    close: 4,
    volumeBase: 1,
    volumeQuote: 4,
    tradeCount: 1,
    sourceTxIds: ['3:hash-3'],
  });

  const lastOnly = await service.getMarketCandles('spot:TOKEN-T3', marketAddress, {
    assetSymbol: 'TOKEN',
    quoteSymbol: 'T3',
    assetDecimals: 0,
    quoteDecimals: 0,
    interval: '1m',
    limit: 1,
  });
  assert.deepEqual(lastOnly.candles.map((candle) => candle.ts), [180]);

  const swaps = await service.getSwapExecutions(marketAddress, { status: 'success' });
  assert.equal(swaps.swaps.find((swap) => swap.lt === '3')?.receiveAmountSource, 'actual');
  assert.equal(swaps.swaps.find((swap) => swap.lt === '5')?.receiveAmountSource, 'minimum');

  const app = Fastify();
  registerRoutes(app, config, service);
  const route = await app.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/markets/${encodeURIComponent('spot:TOKEN-T3')}/candles` +
      `?market_address=${encodeURIComponent(marketAddress)}` +
      '&asset_symbol=TOKEN&quote_symbol=T3&asset_decimals=0&quote_decimals=0&interval=1m',
  });
  assert.equal(route.statusCode, 200);
  assert.equal(route.json().candle_count, 2);

  const reverseWindow = await app.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/markets/${encodeURIComponent('spot:TOKEN-T3')}/candles` +
      `?market_address=${encodeURIComponent(marketAddress)}` +
      '&asset_symbol=TOKEN&quote_symbol=T3&from_utime=200&to_utime=100',
  });
  assert.equal(reverseWindow.statusCode, 400);

  const invalidMarket = await app.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/markets/${encodeURIComponent('spot:TOKEN-T3')}/candles` +
      '?market_address=invalid&asset_symbol=TOKEN&quote_symbol=T3',
  });
  assert.equal(invalidMarket.statusCode, 400);

  await app.close();

  const canonicalApp = Fastify();
  registerRoutes(
    canonicalApp,
    config,
    service,
    undefined,
    undefined,
    undefined,
    undefined,
    { LaunchpadFixedPool: marketAddress },
    {
      releaseId: 'local-run-1',
      registryHash: 'a'.repeat(64),
      releaseManifestHash: 'b'.repeat(64),
      markets: [
        {
          saleModel: 'fixed',
          marketKey: 'spot:TOKEN-T3',
          marketAddress,
          tokenRoot: marketAddress,
          sale: marketAddress,
          lpVault: marketAddress,
          optionAddress: marketAddress,
          perpsMarketId: 1,
          optionSeriesId: 'series-1',
          coverPolicyId: 'cover-1',
          assetSymbol: 'TOKEN',
          quoteSymbol: 'T3',
          assetDecimals: 0,
          quoteDecimals: 0,
        },
      ],
    }
  );
  const canonical = await canonicalApp.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/markets/${encodeURIComponent('spot:TOKEN-T3')}/candles` +
      `?market_address=${encodeURIComponent(marketAddress)}` +
      '&asset_symbol=TOKEN&quote_symbol=T3&asset_decimals=0&quote_decimals=0&interval=1m',
  });
  assert.equal(canonical.statusCode, 200);
  const spoofedMetadata = await canonicalApp.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/markets/${encodeURIComponent('spot:TOKEN-T3')}/candles` +
      `?market_address=${encodeURIComponent(marketAddress)}` +
      '&asset_symbol=SPOOF&quote_symbol=T3&asset_decimals=0&quote_decimals=0&interval=1m',
  });
  assert.equal(spoofedMetadata.statusCode, 400);
  const unregistered = await canonicalApp.inject({
    method: 'GET',
    url:
      `/api/indexer/v1/markets/${encodeURIComponent('spot:OTHER-T3')}/candles` +
      `?market_address=${encodeURIComponent(marketAddress)}` +
      '&asset_symbol=OTHER&quote_symbol=T3&asset_decimals=0&quote_decimals=0&interval=1m',
  });
  assert.equal(unregistered.statusCode, 404);
  await canonicalApp.close();

  const partialStore = new MemoryStore(config);
  partialStore.addTransactions(marketAddress, [
    makeSwap({
      lt: 99,
      utime: 300,
      payToken: 'TOKEN',
      receiveToken: 'T3',
      payAmount: '1',
      receiveAmount: '2',
    }),
  ]);
  const partialService = new IndexerService(config, partialStore, source, opcodes, []);
  const queued: string[] = [];
  partialService.setBackfillEnqueue((address) => queued.push(address));
  const partialCandles = await partialService.getMarketCandles(
    'spot:TOKEN-T3',
    marketAddress,
    {
      assetSymbol: 'TOKEN',
      quoteSymbol: 'T3',
      assetDecimals: 0,
      quoteDecimals: 0,
      interval: '1m',
    }
  );
  assert.equal(partialCandles.history_complete, false);
  assert.deepEqual(queued, [marketAddress]);

  process.stdout.write('market candles ok\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
