import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { AccountState, IndexedTx } from '../models';
import { MemoryStore, StoreSnapshot } from '../store/memoryStore';

const hash32 = (value: number) =>
  Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex').toString('base64');

const hash32Hex = (value: number) =>
  Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex').toString('hex');

const makeTx = (address: string, lt: number, hash = hash32(lt)): IndexedTx => ({
  address,
  lt: String(lt),
  hash,
  utime: lt,
  success: true,
  outMessages: [],
  kind: 'unknown',
  actions: [],
  ui: {
    txId: `${lt}:${hash}`,
    utime: lt,
    status: 'success',
    txType: 'Unknown',
    outCount: 0,
    detail: { kind: 'unknown' },
    kind: 'unknown',
    actions: [],
  },
});

const makeLinkedTx = (address: string, lt: number): IndexedTx => ({
  ...makeTx(address, lt, hash32(lt)),
  prevTransactionLt: String(lt - 1),
  prevTransactionHash: hash32(lt - 1),
});

const makeSnapshotEntry = (
  address: string,
  txs: IndexedTx[],
  historyComplete = true,
  balance?: AccountState
) => ({
  address,
  txs,
  stats: {
    txCount: txs.length,
    historyComplete,
    totalPagesMin: txs.length,
    lastRequestAt: 1,
  },
  ...(balance ? { balance } : {}),
});

const testMalformedImportIsAtomic = () => {
  const config = { ...loadConfig(), maxAddresses: 10, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  store.addTransactions('live', [makeTx('live', 9)]);
  const liveEntry = store.get('live');

  const malformed = {
    version: 1,
    createdAt: Date.now(),
    entries: [
      makeSnapshotEntry('would-have-loaded', [makeTx('would-have-loaded', 8)]),
      makeSnapshotEntry('malformed', [
        { ...makeTx('malformed', 7), lt: 'not-a-number' },
        makeTx('malformed', 6),
      ]),
    ],
  } as unknown as StoreSnapshot;

  assert.throws(() => store.importSnapshot(malformed), /Invalid transaction/);
  assert.equal(store.get('live'), liveEntry);
  assert.equal(store.get('would-have-loaded'), undefined);
  assert.equal(store.getTotalTxs(), 1);
  assert.equal(store.getAddressCount(), 1);
};

const testDuplicateAddressesAreRejectedAtomically = () => {
  const config = { ...loadConfig(), maxAddresses: 10, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  store.addTransactions('live', [makeTx('live', 9)]);

  const duplicateAddressSnapshot: StoreSnapshot = {
    version: 1,
    createdAt: Date.now(),
    entries: [
      makeSnapshotEntry('duplicate', [makeTx('duplicate', 3)]),
      makeSnapshotEntry('duplicate', [makeTx('duplicate', 2)]),
    ],
  };

  assert.throws(
    () => store.importSnapshot(duplicateAddressSnapshot),
    /Duplicate store snapshot address/
  );
  assert.deepEqual(store.get('live')?.txs.map((tx) => tx.lt), ['9']);
  assert.equal(store.getTotalTxs(), 1);
  assert.equal(store.getAddressCount(), 1);
};

const testImportDeduplicatesAndCapsPerAddress = () => {
  const config = {
    ...loadConfig(),
    pageSize: 2,
    maxPagesPerAddress: 1,
    maxAddresses: 10,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  const inputTxs = [
    makeTx('capped', 1),
    makeTx('capped', 3),
    makeTx('capped', 3),
    makeTx('capped', 2),
  ];
  const snapshot: StoreSnapshot = {
    version: 1,
    createdAt: Date.now(),
    entries: [makeSnapshotEntry('capped', inputTxs)],
  };

  store.importSnapshot(snapshot);
  const entry = store.get('capped');
  assert.deepEqual(entry?.txs.map((tx) => tx.lt), ['3', '2']);
  assert.equal(entry?.stats.txCount, 2);
  assert.equal(entry?.stats.totalPagesMin, 1);
  assert.equal(entry?.stats.historyComplete, false);
  assert.equal(store.getTotalTxs(), 2);

  store.addTransactions('capped', [makeTx('capped', 3)]);
  assert.equal(store.get('capped')?.txs.length, 2);
  assert.equal(store.getTotalTxs(), 2);
  assert.deepEqual(inputTxs.map((tx) => tx.lt), ['1', '3', '3', '2']);
};

const testImportOnlyPreservesCertifiedCompleteness = () => {
  const config = { ...loadConfig(), maxAddresses: 10, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  const completeAddress = 'complete';
  const emptyAddress = 'empty';
  const legacyAddress = 'legacy';
  const mismatchedHeadAddress = 'mismatched-head';
  const brokenChainAddress = 'broken-chain';
  const brokenTailAddress = 'broken-tail';
  const linkedHistory = [3, 2, 1].map((lt) => makeLinkedTx(completeAddress, lt));

  store.importSnapshot({
    version: 1,
    createdAt: Date.now(),
    entries: [
      makeSnapshotEntry(completeAddress, linkedHistory, true, {
        address: completeAddress,
        balance: '1',
        lastTxLt: '3',
        lastTxHash: hash32(3),
        updatedAt: 1,
      }),
      makeSnapshotEntry(emptyAddress, [], true, {
        address: emptyAddress,
        balance: '0',
        updatedAt: 1,
      }),
      makeSnapshotEntry(legacyAddress, [makeTx(legacyAddress, 1)], true, {
        address: legacyAddress,
        balance: '1',
        lastTxLt: '1',
        lastTxHash: hash32(1),
        updatedAt: 1,
      }),
      makeSnapshotEntry(
        mismatchedHeadAddress,
        [makeLinkedTx(mismatchedHeadAddress, 1)],
        true,
        {
          address: mismatchedHeadAddress,
          balance: '1',
          lastTxLt: '2',
          lastTxHash: hash32(2),
          updatedAt: 1,
        }
      ),
      makeSnapshotEntry(
        brokenChainAddress,
        [
          { ...makeLinkedTx(brokenChainAddress, 2), prevTransactionHash: hash32(9) },
          makeLinkedTx(brokenChainAddress, 1),
        ],
        true,
        {
          address: brokenChainAddress,
          balance: '1',
          lastTxLt: '2',
          lastTxHash: hash32(2),
          updatedAt: 1,
        }
      ),
      makeSnapshotEntry(
        brokenTailAddress,
        [{ ...makeLinkedTx(brokenTailAddress, 1), prevTransactionHash: hash32(9) }],
        true,
        {
          address: brokenTailAddress,
          balance: '1',
          lastTxLt: '1',
          lastTxHash: hash32(1),
          updatedAt: 1,
        }
      ),
    ],
  });

  assert.equal(store.get(completeAddress)?.stats.historyComplete, true);
  assert.equal(store.get(emptyAddress)?.stats.historyComplete, true);
  assert.equal(store.get(legacyAddress)?.stats.historyComplete, false);
  assert.equal(store.get(mismatchedHeadAddress)?.stats.historyComplete, false);
  assert.equal(store.get(brokenChainAddress)?.stats.historyComplete, false);
  assert.equal(store.get(brokenTailAddress)?.stats.historyComplete, false);
};

const testSnapshotHashesAreValidatedAndCanonicalized = () => {
  const config = { ...loadConfig(), maxAddresses: 10, globalMaxPages: 100 };
  const store = new MemoryStore(config);
  const address = 'alternate-hashes';
  const txs = [2, 1].map((lt) => {
    const transaction = makeLinkedTx(address, lt);
    return {
      ...transaction,
      hash: hash32Hex(lt),
      prevTransactionHash: hash32Hex(lt - 1),
      ui: { ...transaction.ui, txId: `legacy:${lt}` },
    };
  });

  store.importSnapshot({
    version: 1,
    createdAt: Date.now(),
    entries: [makeSnapshotEntry(address, txs, true, {
      address,
      balance: '1',
      lastTxLt: '2',
      lastTxHash: hash32Hex(2),
      updatedAt: 1,
    })],
  });

  const imported = store.get(address);
  assert.equal(imported?.stats.historyComplete, true);
  assert.deepEqual(imported?.txs.map((transaction) => transaction.hash), [hash32(2), hash32(1)]);
  assert.deepEqual(
    imported?.txs.map((transaction) => transaction.prevTransactionHash),
    [hash32(1), hash32(0)]
  );
  assert.equal(imported?.txs[0]?.ui.txId, `2:${hash32(2)}`);
  assert.equal(imported?.balance?.lastTxHash, hash32(2));

  const malformedHash = {
    version: 1,
    createdAt: Date.now(),
    entries: [makeSnapshotEntry('bad-hash', [{ ...makeTx('bad-hash', 1), hash: 'bad' }])],
  } as StoreSnapshot;
  assert.throws(() => store.importSnapshot(malformedHash), /Invalid transaction hash chain/);

  const missingPredecessorHash = makeLinkedTx('bad-link', 1);
  delete missingPredecessorHash.prevTransactionHash;
  assert.throws(
    () => store.importSnapshot({
      version: 1,
      createdAt: Date.now(),
      entries: [makeSnapshotEntry('bad-link', [missingPredecessorHash])],
    }),
    /Invalid transaction hash chain/
  );

  assert.throws(
    () => store.importSnapshot({
      version: 1,
      createdAt: Date.now(),
      entries: [makeSnapshotEntry('bad-balance', [], false, {
        address: 'bad-balance',
        balance: '0',
        lastTxLt: '1',
        updatedAt: 1,
      })],
    }),
    /Invalid account balance/
  );
  assert.equal(store.get(address)?.stats.historyComplete, true);
};

const testReplaceTransactionsRebuildsIndexesAndAccounting = () => {
  const config = {
    ...loadConfig(),
    pageSize: 2,
    maxPagesPerAddress: 2,
    maxAddresses: 10,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  store.addTransactions('replaced', [makeTx('replaced', 10), makeTx('replaced', 9)]);
  store.markHistoryComplete('replaced');
  store.addTransactions('other', [makeTx('other', 7)]);

  store.replaceTransactions('replaced', [
    makeTx('replaced', 3),
    makeTx('replaced', 5),
    makeTx('replaced', 5),
    makeTx('replaced', 4),
    makeTx('replaced', 2),
    makeTx('replaced', 1),
  ]);

  const entry = store.get('replaced');
  assert.deepEqual(entry?.txs.map((tx) => tx.lt), ['5', '4', '3', '2']);
  assert.deepEqual(entry?.pageIndex.map((cursor) => cursor.lt), ['5', '3']);
  assert.equal(entry?.txIndex.size, 4);
  assert.equal(entry?.stats.txCount, 4);
  assert.equal(entry?.stats.totalPagesMin, 2);
  assert.equal(entry?.stats.historyComplete, false);
  assert.equal(store.getTotalTxs(), 5);

  store.markHistoryComplete('replaced');
  store.replaceTransactions('replaced', [makeTx('replaced', 2), makeTx('replaced', 1)]);
  assert.equal(store.get('replaced')?.stats.historyComplete, false);
  assert.equal(store.getTotalTxs(), 3);

  store.replaceTransactions('replaced', []);
  assert.equal(store.get('replaced')?.txs.length, 0);
  assert.equal(store.get('replaced')?.pageIndex.length, 0);
  assert.equal(store.getTotalTxs(), 1);
};

const testWorkerMutationsDoNotTouchIdleAge = async () => {
  const config = {
    ...loadConfig(),
    idleTtlMs: 10_000,
    maxAddresses: 10,
    globalMaxPages: 100,
  };
  const store = new MemoryStore(config);
  store.touch('idle');
  const requestedAt = store.get('idle')?.stats.lastRequestAt;
  store.setBalance('idle', {
    address: 'idle',
    balance: '1',
    lastTxLt: '1',
    lastTxHash: 'hash-1',
    updatedAt: Date.now(),
  });
  store.setLastUpdateSeqno('idle', 1);
  store.markHistoryIncomplete('idle');
  store.setLastBackfillLt('idle', '1');
  store.addTransactions('idle', [makeTx('idle', 1)]);

  assert.equal(store.get('idle')?.stats.lastRequestAt, requestedAt);
  const idleEntry = store.get('idle');
  assert.ok(idleEntry);
  idleEntry.stats.lastRequestAt = Date.now() - config.idleTtlMs - 1;

  let signalEntered!: () => void;
  let releaseWorkflow!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseWorkflow = resolve;
  });
  const workflow = store.withAddressLock('idle', async () => {
    signalEntered();
    await gate;
  });
  await entered;
  store.purgeStale();
  assert.ok(store.get('idle'));

  releaseWorkflow();
  await workflow;
  store.purgeStale();
  assert.equal(store.get('idle'), undefined);

  store.touch('renewed');
  const renewed = store.get('renewed');
  assert.ok(renewed);
  renewed.stats.lastRequestAt = Date.now() - config.idleTtlMs - 1;
  store.touch('renewed');
  store.purgeStale();
  assert.ok(store.get('renewed'));
};

const testAddressLockSerializesOnlyMatchingAddresses = async () => {
  const store = new MemoryStore({ ...loadConfig(), maxAddresses: 10 });
  const events: string[] = [];
  let releaseFirst!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = store.withAddressLock('same', async () => {
    events.push('first:start');
    signalEntered();
    await gate;
    events.push('first:end');
  });
  await entered;
  const second = store.withAddressLock('same', async () => {
    events.push('second:start');
    events.push('second:end');
  });
  await store.withAddressLock('other', async () => {
    events.push('other');
  });
  assert.deepEqual(events, ['first:start', 'other']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    'first:start',
    'other',
    'first:end',
    'second:start',
    'second:end',
  ]);

  await assert.rejects(
    store.withAddressLock('failure', async () => {
      throw new Error('expected lock failure');
    }),
    /expected lock failure/
  );
  assert.equal(await store.withAddressLock('failure', () => 7), 7);
};

const testActiveAddressWorkflowIsPinnedFromCapacityEviction = async () => {
  const globalStore = new MemoryStore({
    ...loadConfig(),
    pageSize: 1,
    maxPagesPerAddress: 10,
    maxAddresses: 2,
    globalMaxPages: 1,
  });
  globalStore.addTransactions('locked', [makeTx('locked', 2)]);
  let signalEntered!: () => void;
  let releaseWorkflow!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseWorkflow = resolve;
  });
  const workflow = globalStore.withAddressLock('locked', async () => {
    signalEntered();
    await gate;
    globalStore.addTransactions('locked', [makeTx('locked', 1)]);
  });
  await entered;

  globalStore.addTransactions('other', [makeTx('other', 1)]);
  assert.ok(globalStore.get('locked'));

  releaseWorkflow();
  await workflow;
  assert.ok(globalStore.getTotalTxs() <= 1);

  const addressStore = new MemoryStore({
    ...loadConfig(),
    maxAddresses: 1,
    globalMaxPages: 100,
  });
  addressStore.touch('locked');
  let releaseAddressWorkflow!: () => void;
  let signalAddressWorkflow!: () => void;
  const addressWorkflowEntered = new Promise<void>((resolve) => {
    signalAddressWorkflow = resolve;
  });
  const addressGate = new Promise<void>((resolve) => {
    releaseAddressWorkflow = resolve;
  });
  const addressWorkflow = addressStore.withAddressLock('locked', async () => {
    signalAddressWorkflow();
    await addressGate;
  });
  await addressWorkflowEntered;
  addressStore.touch('other');
  assert.ok(addressStore.get('locked'));

  releaseAddressWorkflow();
  await addressWorkflow;
  assert.ok(addressStore.getAddressCount() <= 1);
};

const testSnapshotImportRejectsInFlightAddressUpdates = async () => {
  const store = new MemoryStore({ ...loadConfig(), maxAddresses: 10 });
  store.addTransactions('live', [makeTx('live', 9)]);
  let signalEntered!: () => void;
  let releaseUpdate!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const pending = store.withAddressLock('live', async () => {
    signalEntered();
    await gate;
  });
  await entered;

  const replacement: StoreSnapshot = {
    version: 1,
    createdAt: Date.now(),
    entries: [makeSnapshotEntry('replacement', [makeTx('replacement', 1)], false)],
  };
  assert.throws(
    () => store.importSnapshot(replacement),
    /address updates are in flight/
  );
  assert.deepEqual(store.get('live')?.txs.map((tx) => tx.lt), ['9']);
  assert.equal(store.get('replacement'), undefined);

  releaseUpdate();
  await pending;
  store.importSnapshot(replacement);
  assert.equal(store.get('live'), undefined);
  assert.deepEqual(store.get('replacement')?.txs.map((tx) => tx.lt), ['1']);
};

const run = async () => {
  testMalformedImportIsAtomic();
  testDuplicateAddressesAreRejectedAtomically();
  testImportDeduplicatesAndCapsPerAddress();
  testImportOnlyPreservesCertifiedCompleteness();
  testSnapshotHashesAreValidatedAndCanonicalized();
  testReplaceTransactionsRebuildsIndexesAndAccounting();
  await testWorkerMutationsDoNotTouchIdleAge();
  await testAddressLockSerializesOnlyMatchingAddresses();
  await testActiveAddressWorkflowIsPinnedFromCapacityEviction();
  await testSnapshotImportRejectsInFlightAddressUpdates();
  console.log('memory store integrity ok');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
