import assert from 'node:assert/strict';
import { Address, beginCell } from '@ton/core';
import { loadConfig } from '../config';
import { RawTransaction, TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { PoolTracker } from '../poolTracker';
import { MemoryStore } from '../store/memoryStore';
import { createLogger } from '../utils/logger';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { BackfillWorker } from '../workers/backfillWorker';
import { BlockFollower } from '../workers/blockFollower';

const address = `0:${'1'.repeat(64)}`;
const hash = (lt: number) =>
  Buffer.from(BigInt(lt).toString(16).padStart(64, '0'), 'hex').toString('base64');

const linkedTx = (lt: number): RawTransaction => ({
  lt: String(lt),
  hash: hash(lt),
  prevTransactionLt: String(lt - 1),
  prevTransactionHash: hash(lt - 1),
  utime: lt,
  success: true,
  status: 'success',
  outMessages: [],
});

const linkedRange = (newest: number, oldest: number) =>
  Array.from({ length: newest - oldest + 1 }, (_, index) => linkedTx(newest - index));

const forkHash = (fork: string, lt: number) => {
  if (lt === 0) return hash(0);
  const value = Buffer.alloc(32);
  value.write(fork.slice(0, 8), 0, 'utf8');
  value.writeBigUInt64BE(BigInt(lt), 24);
  return value.toString('base64');
};

const forkTx = (fork: string, lt: number): RawTransaction => ({
  ...linkedTx(lt),
  hash: forkHash(fork, lt),
  prevTransactionHash: forkHash(fork, lt - 1),
});

const forkRange = (fork: string, newest: number, oldest: number) =>
  Array.from(
    { length: newest - oldest + 1 },
    (_, index) => forkTx(fork, newest - index)
  );

const makeSource = (overrides: Partial<TonDataSource> = {}): TonDataSource => ({
  network: 'testnet',
  async getMasterchainInfo() {
    return { seqno: 1 };
  },
  async getAccountState() {
    return { balance: '1', lastTxLt: '7', lastTxHash: hash(7) };
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
  ...overrides,
});

const config = {
  ...loadConfig(),
  pageSize: 10,
  backfillPageBatch: 5,
  backfillMaxPagesPerAddress: 20,
  maxPagesPerAddress: 20,
  globalMaxPages: 100,
};
const opcodes = loadOpcodes(undefined);

const makeWorker = (store: MemoryStore, source: TonDataSource) =>
  new BackfillWorker(config, store, source, opcodes, createLogger('fatal'));

const testEmptyInitialPageCanResumeFromStoredHead = async () => {
  let reads = 0;
  const store = new MemoryStore(config);
  const source = makeSource({
    async getTransactions(_address, _limit, lt, hashValue) {
      reads += 1;
      if (reads === 1) {
        assert.equal(lt, undefined);
        assert.equal(hashValue, undefined);
        return [];
      }
      assert.equal(lt, '7');
      assert.equal(hashValue, hash(7));
      return linkedRange(7, 1);
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);
  service.setBackfillEnqueue(() => undefined);

  await service.ensureInitialTransactions(address);
  assert.equal(store.get(address)?.txs.length, 0);
  assert.equal(store.get(address)?.stats.historyComplete, false);

  await (makeWorker(store, source) as any).processAddress(address);
  const entry = store.get(address);
  assert.equal(reads, 2);
  assert.equal(entry?.txs.length, 7);
  assert.equal(entry?.txs[0]?.prevTransactionLt, '6');
  assert.equal(entry?.stats.historyComplete, true);
};

const testBackfillPersistsTheStateUsedForCertification = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(address, [classifyTransaction(address, linkedTx(3), opcodes)]);
  const source = makeSource({
    async getTransactions() {
      return linkedRange(3, 1);
    },
    async getAccountState() {
      return {
        balance: '123',
        lastTxLt: '3',
        lastTxHash: hash(3),
        accountState: 'active',
        codeBoc: 'code',
        dataBoc: 'data',
      };
    },
  });

  await (makeWorker(store, source) as any).processAddress(address);

  const entry = store.get(address);
  assert.equal(entry?.stats.historyComplete, true);
  assert.equal(entry?.balance?.balance, '123');
  assert.equal(entry?.balance?.lastTxLt, '3');
  assert.equal(entry?.balance?.lastTxHash, hash(3));
  assert.equal(entry?.balance?.codeBoc, 'code');
};

const testBackfillTruncatesOversizedResponsesAtConfiguredCapacity = async () => {
  const cappedConfig = {
    ...config,
    pageSize: 2,
    backfillPageBatch: 5,
    backfillMaxPagesPerAddress: 1,
    maxPagesPerAddress: 10,
  };
  const store = new MemoryStore(cappedConfig);
  store.addTransactions(address, [classifyTransaction(address, linkedTx(10), opcodes)]);
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '10',
    lastTxHash: hash(10),
    updatedAt: Date.now(),
  });
  let requestedLimit = 0;
  let accountReads = 0;
  const source = makeSource({
    async getTransactions(_address, limit) {
      requestedLimit = limit;
      return linkedRange(10, 1);
    },
    async getAccountState() {
      accountReads += 1;
      return { balance: '1', lastTxLt: '10', lastTxHash: hash(10) };
    },
  });
  const worker = new BackfillWorker(
    cappedConfig,
    store,
    source,
    opcodes,
    createLogger('fatal')
  );

  await (worker as any).processAddress(address);

  assert.equal(requestedLimit, 2);
  assert.deepEqual(store.get(address)?.txs.map((transaction) => transaction.lt), ['10', '9']);
  assert.equal(store.get(address)?.stats.historyComplete, false);
  assert.equal(accountReads, 0);
};

const testUnlinkedInclusivePageIsRejected = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(address, [classifyTransaction(address, linkedTx(3), opcodes)]);
  const brokenHead = { ...linkedTx(3), prevTransactionHash: hash(99) };
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '3', lastTxHash: hash(3) };
    },
    async getTransactions() {
      return [brokenHead, linkedTx(1)];
    },
  });

  await (makeWorker(store, source) as any).processAddress(address);
  const entry = store.get(address);
  assert.deepEqual(entry?.txs.map((tx) => tx.lt), ['3']);
  assert.equal(entry?.stats.historyComplete, false);
};

const testPreexistingGapCannotBeCertifiedComplete = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(
    address,
    [linkedTx(100), linkedTx(98)].map((tx) => classifyTransaction(address, tx, opcodes))
  );
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '100', lastTxHash: hash(100) };
    },
    async getTransactions(_address, _limit, lt) {
      assert.equal(lt, '98');
      return linkedRange(98, 1);
    },
  });

  await (makeWorker(store, source) as any).processAddress(address);
  const entry = store.get(address);
  assert.equal(entry?.txs.some((tx) => tx.lt === '99'), false);
  assert.equal(entry?.stats.historyComplete, false);
};

const testStaleAccountReadCannotOverwriteNewerStoredHead = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(address, [classifyTransaction(address, linkedTx(2), opcodes)]);
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '2',
    lastTxHash: hash(2),
    updatedAt: Date.now(),
  });

  let releaseState!: () => void;
  let stateReadStarted!: () => void;
  const stateRead = new Promise<void>((resolve) => {
    stateReadStarted = resolve;
  });
  const stateRelease = new Promise<void>((resolve) => {
    releaseState = resolve;
  });
  const source = makeSource({
    async getTransactions() {
      return linkedRange(2, 1);
    },
    async getAccountState() {
      stateReadStarted();
      await stateRelease;
      return { balance: '1', lastTxLt: '2', lastTxHash: hash(2) };
    },
  });

  const pending = (makeWorker(store, source) as any).processAddress(address);
  await stateRead;
  store.setBalance(address, {
    address,
    balance: '2',
    lastTxLt: '3',
    lastTxHash: hash(3),
    updatedAt: Date.now(),
  });
  releaseState();
  await pending;

  assert.equal(store.get(address)?.balance?.lastTxLt, '3');
  assert.equal(store.get(address)?.stats.historyComplete, false);
};

const testConcurrentInitialReadsAreCoalesced = async () => {
  const store = new MemoryStore(config);
  let transactionReads = 0;
  let signalReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    signalReadStarted = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const source = makeSource({
    async getTransactions() {
      transactionReads += 1;
      signalReadStarted();
      await readGate;
      return linkedRange(3, 1);
    },
    async getAccountState() {
      return { balance: '1', lastTxLt: '3', lastTxHash: hash(3) };
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);

  const first = service.ensureInitialTransactions(address);
  await readStarted;
  const second = service.ensureInitialTransactions(address);
  releaseRead();
  await Promise.all([first, second]);

  assert.equal(transactionReads, 1);
  assert.deepEqual(store.get(address)?.txs.map((tx) => tx.lt), ['3', '2', '1']);
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testConcurrentStateRefreshesCommitInInvocationOrder = async () => {
  const store = new MemoryStore(config);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let signalFirstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const source = makeSource({
    async getAccountState() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        signalFirstStarted();
        await firstGate;
        active -= 1;
        return { balance: '2', lastTxLt: '2', lastTxHash: hash(2) };
      }
      active -= 1;
      return { balance: '3', lastTxLt: '3', lastTxHash: hash(3) };
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);

  const first = service.refreshAccountState(address);
  await firstStarted;
  const second = service.refreshAccountState(address);
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(store.get(address)?.balance?.lastTxLt, '3');
};

const testReorgReplacesOrphanedHistory = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(
    address,
    forkRange('old', 3, 1).map((tx) => classifyTransaction(address, tx, opcodes))
  );
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '3',
    lastTxHash: forkHash('old', 3),
    updatedAt: Date.now(),
  });
  store.markHistoryComplete(address);

  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '3', lastTxHash: forkHash('new', 3) };
    },
    async getTransactions() {
      return forkRange('new', 3, 1);
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(
    config,
    store,
    source,
    opcodes,
    createLogger('fatal'),
    service
  );

  await (follower as any).refreshAddress(address, 9);

  assert.deepEqual(
    store.get(address)?.txs.map((tx) => tx.hash),
    [forkHash('new', 3), forkHash('new', 2), forkHash('new', 1)]
  );
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testCachedForkContradictedByBalanceIsRefetched = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(
    address,
    forkRange('stale', 3, 1).map((tx) => classifyTransaction(address, tx, opcodes))
  );
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '3',
    lastTxHash: forkHash('current', 3),
    updatedAt: Date.now(),
  });
  const source = makeSource({
    async getTransactions() {
      return forkRange('current', 3, 1);
    },
    async getAccountState() {
      return { balance: '1', lastTxLt: '3', lastTxHash: forkHash('current', 3) };
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);

  await service.ensureInitialTransactions(address);

  assert.deepEqual(
    store.get(address)?.txs.map((tx) => tx.hash),
    [forkHash('current', 3), forkHash('current', 2), forkHash('current', 1)]
  );
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testFailedReplacementReadPreservesContradictedRetainedHistory = async () => {
  const store = new MemoryStore(config);
  const retained = forkRange('stale', 3, 1).map((tx) =>
    classifyTransaction(address, tx, opcodes)
  );
  store.addTransactions(address, retained);
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '3',
    lastTxHash: forkHash('current', 3),
    updatedAt: Date.now(),
  });
  store.markHistoryComplete(address);
  const source = makeSource({
    async getTransactions() {
      throw new Error('transient replacement history read failure');
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);

  await assert.rejects(
    service.ensureInitialTransactions(address),
    /transient replacement history read failure/
  );

  assert.deepEqual(
    store.get(address)?.txs.map((tx) => `${tx.lt}:${tx.hash}`),
    retained.map((tx) => `${tx.lt}:${tx.hash}`)
  );
  assert.equal(store.get(address)?.stats.historyComplete, false);
};

const testPartiallyFilledFinalPageCanStillBackfill = async () => {
  const cappedConfig = {
    ...config,
    pageSize: 2,
    backfillPageBatch: 1,
    backfillMaxPagesPerAddress: 1,
    maxPagesPerAddress: 1,
  };
  const store = new MemoryStore(cappedConfig);
  store.addTransactions(address, [classifyTransaction(address, linkedTx(2), opcodes)]);
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '2',
    lastTxHash: hash(2),
    updatedAt: Date.now(),
  });
  let reads = 0;
  const source = makeSource({
    async getTransactions() {
      reads += 1;
      return linkedRange(2, 1);
    },
    async getAccountState() {
      return { balance: '1', lastTxLt: '2', lastTxHash: hash(2) };
    },
  });
  const worker = new BackfillWorker(
    cappedConfig,
    store,
    source,
    opcodes,
    createLogger('fatal')
  );

  await (worker as any).processAddress(address);

  assert.equal(reads, 1);
  assert.deepEqual(store.get(address)?.txs.map((tx) => tx.lt), ['2', '1']);
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testFollowerPromotesFullyProvenConservativeHistory = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(
    address,
    linkedRange(2, 1).map((tx) => classifyTransaction(address, tx, opcodes))
  );
  store.markHistoryIncomplete(address);
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '3', lastTxHash: hash(3) };
    },
    async getTransactions() {
      return linkedRange(3, 2);
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(
    config,
    store,
    source,
    opcodes,
    createLogger('fatal'),
    service
  );

  await (follower as any).refreshAddress(address, 10);

  assert.deepEqual(store.get(address)?.txs.map((tx) => tx.lt), ['3', '2', '1']);
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testFollowerRefreshAndCatchUpAreAtomicAgainstQueuedInitialRead = async () => {
  const store = new MemoryStore(config);
  store.addTransactions(
    address,
    linkedRange(3, 1).map((tx) => classifyTransaction(address, tx, opcodes))
  );
  store.setBalance(address, {
    address,
    balance: '1',
    lastTxLt: '3',
    lastTxHash: hash(3),
    updatedAt: Date.now(),
  });
  store.markHistoryComplete(address);

  let signalStateReadStarted!: () => void;
  let releaseStateRead!: () => void;
  const stateReadStarted = new Promise<void>((resolve) => {
    signalStateReadStarted = resolve;
  });
  const stateReadGate = new Promise<void>((resolve) => {
    releaseStateRead = resolve;
  });
  let uncursoredReads = 0;
  const cursors: string[] = [];
  const source = makeSource({
    async getAccountState() {
      signalStateReadStarted();
      await stateReadGate;
      return { balance: '1', lastTxLt: '4', lastTxHash: hash(4) };
    },
    async getTransactions(_address, _limit, lt, hashValue) {
      if (lt === undefined) {
        uncursoredReads += 1;
        throw new Error('transient initial history read failure');
      }
      cursors.push(lt);
      assert.equal(lt, '4');
      assert.equal(hashValue, hash(4));
      return linkedRange(4, 3);
    },
  });
  const service = new IndexerService(config, store, source, opcodes, []);
  const follower = new BlockFollower(
    config,
    store,
    source,
    opcodes,
    createLogger('fatal'),
    service
  );

  const followerRefresh = (follower as any).refreshAddress(address, 12);
  await stateReadStarted;
  const queuedInitialRead = service.ensureInitialTransactions(address);
  releaseStateRead();
  await Promise.all([followerRefresh, queuedInitialRead]);

  assert.equal(uncursoredReads, 0);
  assert.deepEqual(cursors, ['4']);
  assert.deepEqual(store.get(address)?.txs.map((tx) => tx.lt), ['4', '3', '2', '1']);
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testFollowerCountsActualProgressAcrossShortPages = async () => {
  const shortPageConfig = {
    ...config,
    pageSize: 10,
    backfillPageBatch: 5,
    backfillMaxPagesPerAddress: 10,
    maxPagesPerAddress: 20,
  };
  const store = new MemoryStore(shortPageConfig);
  const first = {
    ...linkedTx(100),
    prevTransactionLt: '0',
    prevTransactionHash: hash(0),
  };
  store.addTransactions(address, [classifyTransaction(address, first, opcodes)]);
  store.markHistoryComplete(address);
  const cursors: string[] = [];
  const source = makeSource({
    async getAccountState() {
      return { balance: '1', lastTxLt: '158', lastTxHash: hash(158) };
    },
    async getTransactions(_address, _limit, lt) {
      cursors.push(lt ?? '');
      if (lt === '158') return linkedRange(158, 141);
      if (lt === '141') return linkedRange(141, 124);
      if (lt === '124') return linkedRange(124, 107);
      if (lt === '107') return linkedRange(107, 100);
      return [];
    },
  });
  const service = new IndexerService(shortPageConfig, store, source, opcodes, []);
  const follower = new BlockFollower(
    shortPageConfig,
    store,
    source,
    opcodes,
    createLogger('fatal'),
    service
  );

  await (follower as any).refreshAddress(address, 11);

  assert.deepEqual(cursors, ['158', '141', '124', '107']);
  assert.equal(store.get(address)?.txs.length, 59);
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testSnapshotGenerationInvalidatesCapturedFollowerBatches = async () => {
  const followerConfig = {
    ...config,
    maxAddresses: 20,
    idleTtlMs: 60_000,
  };
  const store = new MemoryStore(followerConfig);
  const oldAddresses = Array.from(
    { length: 11 },
    (_, index) => `0:${(index + 1).toString(16).padStart(64, '0')}`
  );
  for (const oldAddress of oldAddresses) store.touch(oldAddress);
  const replacementAddress = `0:${'f'.repeat(64)}`;
  const source = makeSource({
    async getMasterchainInfo() {
      return { seqno: 12 };
    },
    async getAccountState() {
      return { balance: '0' };
    },
  });
  const service = new IndexerService(followerConfig, store, source, opcodes, []);
  const follower = new BlockFollower(
    followerConfig,
    store,
    source,
    opcodes,
    createLogger('fatal'),
    service
  );
  const originalRefreshAddress = (follower as any).refreshAddress.bind(follower);
  let refreshCalls = 0;
  (follower as any).refreshAddress = async (
    capturedAddress: string,
    seqno: number,
    workflowGeneration: number
  ) => {
    refreshCalls += 1;
    if (refreshCalls === 11) {
      store.importSnapshot({
        version: 1,
        createdAt: Date.now(),
        entries: [{
          address: replacementAddress,
          txs: [],
          stats: {
            txCount: 0,
            historyComplete: false,
            totalPagesMin: 0,
            lastRequestAt: Date.now(),
          },
          balance: {
            address: replacementAddress,
            balance: '0',
            updatedAt: Date.now(),
          },
        }],
      });
    }
    return originalRefreshAddress(capturedAddress, seqno, workflowGeneration);
  };

  await (follower as any).poll();

  assert.equal(refreshCalls, 11);
  assert.deepEqual(store.listWatchlist().map((entry) => entry.address), [replacementAddress]);
};

const testRejectedInitialForkDoesNotMutatePoolTracker = async () => {
  const factory = `0:${'2'.repeat(64)}`;
  const discoveredPool = `0:${'3'.repeat(64)}`;
  const tracker = new PoolTracker({ DlmmPoolFactory: factory });
  const stale = forkRange('stale', 3, 1);
  stale[0] = {
    ...stale[0]!,
    inMessage: { destination: factory, op: 0x444c4350 },
    outMessages: [{ destination: discoveredPool }],
  };
  const store = new MemoryStore(config);
  const queued: string[] = [];
  const source = makeSource({
    async getTransactions() {
      return stale;
    },
    async getAccountState() {
      return { balance: '1', lastTxLt: '3', lastTxHash: forkHash('current', 3) };
    },
  });
  const service = new IndexerService(
    config,
    store,
    source,
    opcodes,
    [],
    undefined,
    tracker
  );
  service.setBackfillEnqueue((queuedAddress) => queued.push(queuedAddress));

  await service.ensureInitialTransactions(address);

  assert.equal(tracker.getPoolCount(), 0);
  assert.equal(store.get(address)?.txs.length, 0);
  assert.deepEqual(queued, [address]);
};

const testPoolTrackerNormalizesAndFiltersFactoryMessages = () => {
  const factory = `0:${'4'.repeat(64)}`;
  const registry = `0:${'5'.repeat(64)}`;
  const pool = `0:${'6'.repeat(64)}`;
  const secondPool = `0:${'7'.repeat(64)}`;
  const friendlyFactory = Address.parse(factory).toString({ urlSafe: true, bounceable: true });
  const friendlyPool = Address.parse(pool).toString({ urlSafe: true, bounceable: false });
  const friendlySecondPool = Address.parse(secondPool).toString({ urlSafe: true, bounceable: true });
  const tracker = new PoolTracker({ DlmmPoolFactory: factory, DlmmRegistry: registry });

  tracker.observeTransactions([{
    ...linkedTx(1),
    inMessage: { destination: friendlyFactory, op: 0x444c4350 },
    outMessages: [
      { destination: registry, op: 0x53504f4c },
      { destination: friendlyPool },
      { destination: `0:${'8'.repeat(64)}`, op: 0x12345678 },
    ],
  }]);
  tracker.observeTransactions([{
    ...linkedTx(1),
    inMessage: {
      source: friendlySecondPool,
      destination: friendlyFactory,
      op: 0x4c50000a,
    },
    outMessages: [],
  }]);
  tracker.observeTransactions([{
    ...linkedTx(1),
    success: false,
    status: 'failed',
    inMessage: {
      source: `0:${'9'.repeat(64)}`,
      destination: friendlyFactory,
      op: 0x4c50000a,
    },
    outMessages: [],
  }]);

  assert.equal(tracker.getFactoryCount(), 1);
  assert.equal(tracker.getPoolCount(), 2);

  const clmmFactory = `0:${'a'.repeat(64)}`;
  const clmmPool = `0:${'b'.repeat(64)}`;
  const collection = `0:${'c'.repeat(64)}`;
  const queue = `0:${'d'.repeat(64)}`;
  const token0 = `0:${'e'.repeat(64)}`;
  const token1 = `0:${'f'.repeat(64)}`;
  const wallet0 = `0:${'1'.repeat(64)}`;
  const wallet1 = `0:${'2'.repeat(64)}`;
  const addressRef = (value: string) => beginCell().storeAddress(Address.parse(value)).endCell();
  const ackPrimary = beginCell()
    .storeRef(addressRef(clmmPool))
    .storeRef(addressRef(collection))
    .storeRef(addressRef(queue))
    .endCell();
  const ackTokens = beginCell()
    .storeRef(addressRef(token0))
    .storeRef(addressRef(token1))
    .endCell();
  const ackWallets = beginCell()
    .storeRef(addressRef(wallet0))
    .storeRef(addressRef(wallet1))
    .endCell();
  const deployedAck = beginCell()
    .storeUint(0x50444c59, 32)
    .storeUint(11n, 64)
    .storeUint(3n, 64)
    .storeRef(ackPrimary)
    .storeRef(ackTokens)
    .storeRef(ackWallets)
    .storeUint(4, 8)
    .endCell()
    .toBoc({ idx: false })
    .toString('base64');
  const clmmTracker = new PoolTracker({ ClmmPoolFactory: clmmFactory });
  const clmmDeployments = [
    { destination: clmmPool },
    { destination: collection },
    { destination: queue },
  ];

  clmmTracker.observeTransactions([{
    ...linkedTx(2),
    inMessage: { destination: clmmFactory, op: 0x44504f4c },
    outMessages: clmmDeployments,
  }]);
  assert.equal(clmmTracker.getPoolCount(), 0);

  clmmTracker.observeTransactions([{
    ...linkedTx(3),
    inMessage: { destination: clmmFactory, op: 0x44504f4c },
    outMessages: [
      ...clmmDeployments,
      { destination: `0:${'3'.repeat(64)}`, op: 0x50444c59, body: deployedAck },
    ],
  }]);
  assert.equal(clmmTracker.getPoolCount(), 1);
};

const run = async () => {
  await testEmptyInitialPageCanResumeFromStoredHead();
  await testBackfillPersistsTheStateUsedForCertification();
  await testBackfillTruncatesOversizedResponsesAtConfiguredCapacity();
  await testUnlinkedInclusivePageIsRejected();
  await testPreexistingGapCannotBeCertifiedComplete();
  await testStaleAccountReadCannotOverwriteNewerStoredHead();
  await testConcurrentInitialReadsAreCoalesced();
  await testConcurrentStateRefreshesCommitInInvocationOrder();
  await testReorgReplacesOrphanedHistory();
  await testCachedForkContradictedByBalanceIsRefetched();
  await testFailedReplacementReadPreservesContradictedRetainedHistory();
  await testPartiallyFilledFinalPageCanStillBackfill();
  await testFollowerPromotesFullyProvenConservativeHistory();
  await testFollowerRefreshAndCatchUpAreAtomicAgainstQueuedInitialRead();
  await testFollowerCountsActualProgressAcrossShortPages();
  await testSnapshotGenerationInvalidatesCapturedFollowerBatches();
  await testRejectedInitialForkDoesNotMutatePoolTracker();
  testPoolTrackerNormalizesAndFiltersFactoryMessages();
  process.stdout.write('history integrity ok\n');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
