import { createHash } from 'node:crypto';
import { assertPerpsProducerReceipt } from './perps-fixture-producer';
import assert from 'node:assert/strict';
import { Address, Cell, beginCell, loadTransaction, storeTransaction, storeMessage, loadShardAccount, Transaction } from '@ton/core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
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
import { assertCaptureBuildBinding, assertCaptureCode, assertCaptureTargetClosure, assertRetainedCaptureBinding, readCaptureBuildManifest } from './capture-build';

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
const opcodes = loadOpcodes();

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

type FactoryCapture = {
  name: string; factory: string; pool: string;
  accepted: { account: string; boc: string; hash: string; before: { originalShardAccount: string; codeBoc: string }; after: { originalShardAccount: string; codeBoc: string } };
  emitter: FactoryCapture['accepted']; attempt: FactoryCapture['accepted'];
};
// The capture's observed execution targets and the fixture's independent
// compiler inventory are separate facts. Authenticate every retained compiler
// role against its own reviewed pure-build closure without inventing execution.
const factoryNativeRoot = resolve(__dirname, '../../../tonswap_tolk');
const factoryCompilerRoles = [
  'DlmmPoolFactory', 'DlmmPool', 'DlmmRegistry', 'JettonWallet', 'DlmmSeedingExecutor',
  'GasVault', 'NativeReturnCollector', 'LpVault', 'JettonRoot',
] as const;
const factoryManifest = readCaptureBuildManifest();
const assertFactoryCompilerCodes = (compiler: unknown, nativeRoot = factoryNativeRoot) => {
  assert(compiler && typeof compiler === 'object' && !Array.isArray(compiler));
  assert.deepEqual(Object.keys(compiler).sort(), [...factoryCompilerRoles].sort(), 'Factory requires all nine independent compiler pins');
  for (const role of factoryCompilerRoles) {
    const target = assertCaptureTargetClosure(role, nativeRoot, factoryManifest);
    const code: { codeHash: string; boc: string } = (compiler as Record<string, { codeHash: string; boc: string }>)[role]!;
    assert(code && typeof code === 'object' && !Array.isArray(code));
    assert.deepEqual(Object.keys(code).sort(), ['boc', 'codeHash']);
    assert.equal(code.codeHash, target.codeHash, `${role}: current pure-build code pin`);
    assert.equal(typeof code.boc, 'string', `${role}: retained independent compiler BOC required`);
    assert.equal(Buffer.from(code.boc, 'base64').toString('base64'), code.boc, `${role}: canonical retained compiler BOC`);
    const cells = Cell.fromBoc(Buffer.from(code.boc, 'base64'));
    assert(cells.length === 1 && !cells[0]!.isExotic, `${role}: one ordinary compiler code Cell required`);
    assert.equal(cells[0]!.hash().toString('hex'), code.codeHash, `${role}: retained independent compiler BOC`);
  }
};
const assertFactoryBuild = (fixture: any, nativeRoot: string) => {
  assertRetainedCaptureBinding(fixture.buildBinding, 'factory');
  const binding = assertCaptureBuildBinding(fixture.buildBinding, 'factory', nativeRoot, { manifest: factoryManifest });
  assertFactoryCompilerCodes(fixture.compiler, nativeRoot);
  for (const role of Object.keys(binding.targets)) {
    assert(factoryCompilerRoles.includes(role as typeof factoryCompilerRoles[number]), 'Observed factory target must have an independent compiler pin');
    assertCaptureCode(role, fixture.compiler[role].boc, binding);
  }
  return binding;
};

const factoryEvidence = (nativeRoot = factoryNativeRoot) => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/pool-factory-current-transactions.json'), 'utf8'));
  assert.equal(fixture.schema, 'tonswap-pool-tracker-original-factory-v2');
  assert.equal(fixture.nativeSourceInventoryModel, 'pure-build-executed-target-closure-v1');
  assert.equal(fixture.nativeSuite, 'tests/dlmm/DlmmPoolFactory.spec.ts');
  assert.equal(fixture.tests, 29);
  const log = readFileSync(resolve(__dirname, 'fixtures/capture-build/factory/producer-log.txt'));
  assert.equal(createHash('sha256').update(log).digest('hex'), fixture.provenance.nativeLogSha256);
  assertPerpsProducerReceipt(fixture.provenance.producerReceipt, 'factory', nativeRoot,
    fixture.provenance.captureDirectory, log, fixture.buildBinding);
  assertFactoryBuild(fixture, nativeRoot);
  const original = (row: FactoryCapture['accepted'], codeHash: string) => {
    const cell = Cell.fromBase64(row.boc), parsed = loadTransaction(cell.beginParse());
    assert.equal(cell.hash().toString('hex'), row.hash);
    assert.equal(parsed.stateUpdate.oldHash.toString('hex'), Cell.fromBase64(row.before.originalShardAccount).refs[0]!.hash().toString('hex'));
    assert.equal(parsed.stateUpdate.newHash.toString('hex'), Cell.fromBase64(row.after.originalShardAccount).refs[0]!.hash().toString('hex'));
    for (const boundary of [row.before, row.after]) {
      const account = loadShardAccount(Cell.fromBase64(boundary.originalShardAccount).beginParse()).account;
      assert.equal(account?.storage.state.type, 'active');
      if (account?.storage.state.type !== 'active') throw new Error('Expected actual active contract boundary');
      assert.equal(account.storage.state.state.code?.hash().toString('hex'), codeHash);
    }
    assert.equal(Cell.fromBase64(row.before.codeBoc).hash().toString('hex'), codeHash);
    assert.equal(Cell.fromBase64(row.after.codeBoc).hash().toString('hex'), codeHash);
    return { cell, parsed, raw: decodeOriginalTransaction(cell, Address.parse(row.account)) };
  };
  const cases = (fixture.cases as FactoryCapture[]).map(capture => {
    const ack = original(capture.accepted, fixture.compiler.DlmmPoolFactory.codeHash);
    const emitter = original(capture.emitter, fixture.compiler.DlmmPool.codeHash);
    const attempt = original(capture.attempt, fixture.compiler.DlmmPoolFactory.codeHash);
    assert.equal(ack.raw.success, true);
    assert.equal(emitter.raw.success, true);
    assert.equal(ack.raw.inMessage!.source && Address.parse(ack.raw.inMessage!.source).toRawString(), capture.pool);
    const normalizedMessage = (message: NonNullable<Transaction['inMessage']>) => beginCell().store(storeMessage(message, { forceRef: true })).endCell();
    assert.ok([...emitter.parsed.outMessages.values()].some(message => normalizedMessage(message).equals(normalizedMessage(ack.parsed.inMessage!))), 'Actual Pool emitter and Factory receiver carry the same message fields');
    return { capture, ...ack, attempt: attempt.raw };
  });
  assert.deepEqual(cases.map(c => c.capture.name), ['direct', 'public', 'launch']);
  return { fixture, cases };
};

const testFactoryPureBuildTargetClosures = () => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/pool-factory-current-transactions.json'), 'utf8'));
  assertFactoryBuild(fixture, factoryNativeRoot);
  const sources = new Set<string>();
  for (const role of factoryCompilerRoles) {
    for (const filename of Object.keys(factoryManifest.manifest.targets[role]!.inputs)) sources.add(filename);
  }
  const cleanRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-factory-source-')));
  try {
    // Opcode modules are virtual compiler inputs derived from this reviewed
    // configuration, not retained generated files or native renderer modules.
    const opcodeConfig = 'config/opcodes.json';
    mkdirSync(join(cleanRoot, 'config'));
    copyFileSync(join(factoryNativeRoot, opcodeConfig), join(cleanRoot, opcodeConfig));
    for (const filename of sources) {
      if (filename.startsWith('contracts/generated/opcodes/')) continue;
      const target = join(cleanRoot, filename);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(factoryNativeRoot, filename), target);
    }
    assert.equal(existsSync(join(cleanRoot, 'wrappers')), false, 'Pure target verification needs no native TypeScript renderers');
    assert.equal(factoryEvidence(cleanRoot).cases.length, 3, 'Original accepted callbacks verify from the nine current source closures');
    mkdirSync(join(cleanRoot, 'wrappers'));
    const shadow = join(cleanRoot, 'wrappers/entrypointWriter.js');
    writeFileSync(shadow, 'globalThis.__factoryUnboundShadowExecuted = true; throw new Error("unbound renderer dependency");');
    assert.equal(factoryEvidence(cleanRoot).cases.length, 3);
    assert.equal((globalThis as Record<string, unknown>).__factoryUnboundShadowExecuted, undefined, 'Closure validation never executes ambient native modules');
    rmSync(shadow);
    let rejected = 0;
    const rejects = (fn: () => void) => { assert.throws(fn); rejected++; };
    for (const role of factoryCompilerRoles) {
      const omitted = { ...fixture.compiler }; delete omitted[role];
      rejects(() => assertFactoryCompilerCodes(omitted, cleanRoot));
      const target = factoryManifest.manifest.targets[role]!;
      const path = join(cleanRoot, target.source), original = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([original, Buffer.from('\n// tampered input\n')]));
        rejects(() => assertFactoryCompilerCodes(fixture.compiler, cleanRoot));
      } finally { writeFileSync(path, original); }
      try {
        rmSync(path);
        rejects(() => assertFactoryCompilerCodes(fixture.compiler, cleanRoot));
      } finally { writeFileSync(path, original); }
    }
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, UnknownCode: fixture.compiler.DlmmPoolFactory }, cleanRoot));
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: fixture.compiler.DlmmPool }, cleanRoot));
    const arbitraryCode = beginCell().storeUint(0, 1).endCell();
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: {
      codeHash: arbitraryCode.hash().toString('hex'), boc: arbitraryCode.toBoc().toString('base64'),
    } }, cleanRoot));
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: {
      ...fixture.compiler.DlmmPoolFactory, boc: arbitraryCode.toBoc().toString('base64'),
    } }, cleanRoot));
    const withoutBoc = { ...fixture.compiler.DlmmPoolFactory }; delete withoutBoc.boc;
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: withoutBoc }, cleanRoot));
    const mutatedBinding = () => JSON.parse(JSON.stringify(fixture.buildBinding));
    for (const role of Object.keys(fixture.buildBinding.targets)) {
      const omitted = mutatedBinding(); delete omitted.targets[role];
      rejects(() => assertCaptureBuildBinding(omitted, 'factory', cleanRoot, { manifest: factoryManifest }));
      const changed = mutatedBinding(); changed.targets[role].codeHash = '0'.repeat(64);
      rejects(() => assertCaptureBuildBinding(changed, 'factory', cleanRoot, { manifest: factoryManifest }));
      const missingInput = mutatedBinding(); delete missingInput.targets[role].inputs[missingInput.targets[role].source];
      rejects(() => assertCaptureBuildBinding(missingInput, 'factory', cleanRoot, { manifest: factoryManifest }));
      const traversal = mutatedBinding(); traversal.targets[role].inputs['../outside.tolk'] = '0'.repeat(64);
      rejects(() => assertCaptureBuildBinding(traversal, 'factory', cleanRoot, { manifest: factoryManifest }));
    }
    const unknown = mutatedBinding(); unknown.targets.UnknownCode = unknown.targets.DlmmPoolFactory;
    rejects(() => assertCaptureBuildBinding(unknown, 'factory', cleanRoot, { manifest: factoryManifest }));
    const physicalSource = join(cleanRoot, 'contracts/shared/math/integer.tolk');
    const retainedSource = readFileSync(physicalSource);
    rmSync(physicalSource);
    symlinkSync(join(factoryNativeRoot, 'contracts/shared/math/integer.tolk'), physicalSource);
    rejects(() => assertFactoryCompilerCodes(fixture.compiler, cleanRoot));
    rmSync(physicalSource); writeFileSync(physicalSource, retainedSource);
    // A changed closure map cannot be repaired by rehashing unrelated bytes.
    const missingTransitive = mutatedBinding();
    const transitive = Object.keys(missingTransitive.targets.DlmmPool.inputs).find(filename => filename !== missingTransitive.targets.DlmmPool.source)!;
    delete missingTransitive.targets.DlmmPool.inputs[transitive];
    rejects(() => assertCaptureBuildBinding(missingTransitive, 'factory', cleanRoot, { manifest: factoryManifest }));
    assertFactoryBuild(fixture, cleanRoot);
    console.log(`Factory provenance: nine pure-build target closures and ${rejected} tamper checks passed`);
  } finally { rmSync(cleanRoot, { recursive: true, force: true }); }
};

const testRejectedInitialForkDoesNotMutatePoolTracker = async () => {
  const { capture, raw } = factoryEvidence().cases[0]!;
  const factory = capture.factory;
  const positiveControl = new PoolTracker({ DlmmPoolFactory: factory });
  positiveControl.observeTransactions([raw]);
  assert.equal(positiveControl.getPoolCount(), 1, 'Rejected branch contains a genuinely discoverable accepted callback');
  const tracker = new PoolTracker({ DlmmPoolFactory: factory });
  const store = new MemoryStore(config), queued: string[] = [];
  const source = makeSource({
    async getTransactions() { return [raw]; },
    async getAccountState() { return { balance: '1', lastTxLt: raw.lt, lastTxHash: forkHash('current', 3) }; },
  });
  const service = new IndexerService(config, store, source, opcodes, [], undefined, tracker);
  service.setBackfillEnqueue((queuedAddress) => queued.push(queuedAddress));
  await service.ensureInitialTransactions(factory);
  assert.equal(tracker.getPoolCount(), 0);
  assert.equal(store.get(factory)?.txs.length, 0);
  assert.deepEqual(queued, [factory]);
};

const testPoolTrackerNormalizesAndFiltersFactoryMessages = () => {
  const { fixture, cases } = factoryEvidence();
  let checks = 0;
  const test = (name: string, fn: () => void) => { fn(); checks++; console.log('PASS PoolTracker:', name); };
  test('only current registry pool roles count, and friendly/raw aliases deduplicate', () => {
    const pool = cases[0]!.capture.pool, factory = cases[0]!.capture.factory;
    const alias = Address.parse(pool).toString({ bounceable: false });
    const tracker = new PoolTracker({ DlmmPoolFactory: factory, DlmmPool: pool, Market0Pool: alias, Market0PerpsPool: pool, Spot0Pool: alias, LaunchpadFixedPool: pool,
      UnrelatedPoolFactory: factory, PoolRegistry: factory, PoolHelper: factory, StrangePool: factory, Market01Pool: factory, Spot0PoolHelper: factory,
      Market1Pool: 'invalid', Market2Pool: 'REPLACE_WITH_POOL' });
    assert.equal(tracker.getFactoryCount(), 1); assert.equal(tracker.getPoolCount(), 1);
    tracker.observeTransactions([cases[0]!.raw]); assert.equal(tracker.getPoolCount(), 1);
  });
  for (const { capture, raw, attempt } of cases) {
    test(`${capture.name}: actual current Factory acceptance, normalized identity and duplicate delivery`, () => {
      const friendlyFactory = Address.parse(capture.factory).toString({ bounceable: false });
      const tracker = new PoolTracker({ DlmmPoolFactory: friendlyFactory });
      tracker.observeTransactions([attempt]);
      assert.equal(tracker.getPoolCount(), 0, 'Creation/public/retry or typed deployment attempt is not an accepted Pool');
      tracker.observeTransactions([{ ...raw, inMessage: { ...raw.inMessage, destination: friendlyFactory } }, raw, raw]);
      assert.equal(tracker.getPoolCount(), 1);
      assert.equal(tracker.getFactoryCount(), 1);
    });
  }
  const { capture, raw, parsed } = cases[0]!;
  const rejected = (candidate: RawTransaction, registry = { DlmmPoolFactory: capture.factory }) => {
    const tracker = new PoolTracker(registry); tracker.observeTransactions([candidate]); assert.equal(tracker.getPoolCount(), 0);
  };
  // These are deliberately synthetic negative transaction boundaries. Positive
  // cases above retain the actual native BOCs, account boundaries and emitter.
  const changed = (edit: (tx: Transaction) => void) => {
    const tx = loadTransaction(Cell.fromBase64(raw.rawBoc!).beginParse()); edit(tx);
    const cell = beginCell().store(storeTransaction(tx)).endCell();
    return decodeOriginalTransaction(cell, Address.parse(capture.factory));
  };
  test('missing original evidence and mismatched original transaction identities are unresolved', () => {
    for (const change of [{ rawBoc: undefined }, { rawBoc: 'invalid' }, { hash: hash(99) }, { lt: '1' }, { prevTransactionHash: hash(99) }]) rejected({ ...raw, ...change });
  });
  test('failed native Factory callbacks cannot be promoted by success summaries', () => {
    const failed = fixture.rejected.map((row: FactoryCapture['accepted']) => decodeOriginalTransaction(Cell.fromBase64(row.boc), Address.parse(row.account)));
    assert.ok(failed.length > 0);
    for (const tx of failed) { assert.equal(tx.success, false); rejected({ ...tx, success: true, status: 'success' }, { DlmmPoolFactory: Address.parse(tx.inMessage!.destination!).toRawString() }); }
  });
  test('actual VM and action failures remain failures despite successful summaries', () => {
    for (const field of ['compute', 'action']) {
      const failed = changed(tx => {
        if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm' || !tx.description.actionPhase) throw new Error('Expected VM/action boundary');
        if (field === 'compute') { tx.description.computePhase.success = false; tx.description.computePhase.exitCode = 3107; }
        else { tx.description.actionPhase.success = false; tx.description.actionPhase.resultCode = 37; }
      });
      rejected({ ...failed, success: true, status: 'success' });
    }
  });
  test('unregistered Factory and Factory-as-sender do not authenticate the receiver', () => {
    rejected(raw, { DlmmPoolFactory: `0:${'9'.repeat(64)}` });
    const unrelated = new PoolTracker({ UnrelatedPoolFactory: capture.factory });
    unrelated.observeTransactions([raw]); assert.equal(unrelated.getFactoryCount(), 0); assert.equal(unrelated.getPoolCount(), 0);
    const receiver = decodeOriginalTransaction(Cell.fromBase64(cases[0]!.capture.emitter.boc), Address.parse(capture.pool));
    rejected({ ...receiver, inMessage: { ...receiver.inMessage, source: capture.factory, destination: capture.factory } });
  });
  test('forged summary opcode, sender and body cannot alter the original callback', () => {
    const fake = { ...cases[0]!.attempt, inMessage: { ...raw.inMessage } };
    rejected(fake);
    const tracker = new PoolTracker({ DlmmPoolFactory: capture.factory });
    tracker.observeTransactions([{ ...raw, inMessage: { ...raw.inMessage, op: 0, source: `0:${'9'.repeat(64)}`, body: '' } }]);
    assert.equal(tracker.getPoolCount(), 1, 'Original message remains authoritative');
  });
  test('bounced, wrong actor/factory, noncanonical, missing and trailing current body fields fail closed', () => {
    rejected(changed(tx => { if (tx.inMessage!.info.type === 'internal') tx.inMessage!.info.bounced = true; }));
    const body = parsed.inMessage!.body;
    const actors = body.refs[1]!, stranger = Address.parse(`0:${'a'.repeat(64)}`);
    const wrongActors = [beginCell().storeAddress(stranger).storeAddress(Address.parse(capture.factory)).endCell(),
      beginCell().storeAddress(Address.parse(capture.pool)).storeAddress(stranger).endCell(),
      beginCell().storeAddress(null).storeAddress(Address.parse(capture.factory)).endCell()];
    const zeroQuery = beginCell().storeUint(0x44504441, 32).storeUint(0, 64).storeSlice(body.beginParse().skip(96)).endCell();
    const malformed = [zeroQuery, beginCell().endCell(), beginCell().storeUint(0x12345678,32).endCell(),
      beginCell().storeSlice(body.beginParse()).storeBit(true).endCell(),
      beginCell().storeBits(body.bits).storeRef(body.refs[0]!).endCell(),
      beginCell().storeSlice(body.beginParse()).storeRef(beginCell().endCell()).endCell(),
      ...wrongActors.map(actors => beginCell().storeBits(body.bits).storeRef(body.refs[0]!).storeRef(actors).endCell()),
      beginCell().storeBits(body.bits).storeRef(beginCell().storeAddress(stranger).storeAddress(stranger).endCell()).storeRef(actors).endCell()];
    for (const body of malformed) rejected(changed(tx => { tx.inMessage!.body = body; }));
  });
  test('an obsolete empty-body or ambiguous deployment attempt never increases inventory', () => {
    for (const op of [0x444c4350, 0x444c5043, 0x4c500001, 0x44504f4c]) {
      rejected({ ...linkedTx(3), inMessage: { destination: capture.factory, op },
        outMessages: [{ destination: `0:${'b'.repeat(64)}` }, { destination: `0:${'c'.repeat(64)}` }] });
    }
  });
  console.log(`PoolTracker: ${checks} boundary checks passed`);
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
  testFactoryPureBuildTargetClosures();
  await testRejectedInitialForkDoesNotMutatePoolTracker();
  testPoolTrackerNormalizesAndFiltersFactoryMessages();
  process.stdout.write('history integrity ok\n');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
