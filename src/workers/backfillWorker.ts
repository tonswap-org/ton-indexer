import { Config } from '../config';
import { MemoryStore } from '../store/memoryStore';
import {
  RawTransaction,
  TonDataSource,
  transactionPageIsLinkedInclusiveSegment,
  transactionPageReachesHistoryStart
} from '../data/dataSource';
import { classifyTransaction } from '../utils/txClassifier';
import { OpcodeSets } from '../utils/opcodes';
import { Logger } from '../utils/logger';
import { MetricsCollector } from '../metricsCollector';
import { PoolTracker } from '../poolTracker';

const transactionIdentity = (transaction: { lt: string; hash: string }) =>
  `${transaction.lt}:${transaction.hash}`;

const retainedExactInclusiveBackfillPage = (
  raw: readonly RawTransaction[],
  before: readonly { lt: string; hash: string }[],
  after: readonly { lt: string; hash: string }[]
) => {
  if (raw.length === 0) return false;
  const rawIdentities = raw.map(transactionIdentity);
  const rawIdentitySet = new Set(rawIdentities);
  const beforeIdentities = new Set(before.map(transactionIdentity));
  const afterIdentities = new Set(after.map(transactionIdentity));
  if (
    rawIdentitySet.size !== raw.length ||
    beforeIdentities.size !== before.length ||
    afterIdentities.size !== after.length ||
    (before.length > 0 && !beforeIdentities.has(rawIdentities[0])) ||
    rawIdentities.slice(before.length > 0 ? 1 : 0).some((identity) => beforeIdentities.has(identity)) ||
    after.length !== before.length + raw.length - (before.length > 0 ? 1 : 0)
  ) {
    return false;
  }
  return rawIdentities.every((identity) => afterIdentities.has(identity));
};

export class BackfillWorker {
  private config: Config;
  private store: MemoryStore;
  private source: TonDataSource;
  private opcodes: OpcodeSets;
  private logger: Logger;
  private metrics?: MetricsCollector;
  private poolTracker?: PoolTracker;
  private timer?: NodeJS.Timeout;
  private pending: string[] = [];
  private pendingSet = new Set<string>();
  private inFlight = new Set<string>();

  constructor(
    config: Config,
    store: MemoryStore,
    source: TonDataSource,
    opcodes: OpcodeSets,
    logger: Logger,
    metrics?: MetricsCollector,
    poolTracker?: PoolTracker
  ) {
    this.config = config;
    this.store = store;
    this.source = source;
    this.opcodes = opcodes;
    this.logger = logger;
    this.metrics = metrics;
    this.poolTracker = poolTracker;
  }

  enqueue(address: string) {
    if (this.pendingSet.has(address) || this.inFlight.has(address)) return;
    this.pending.push(address);
    this.pendingSet.add(address);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.watchlistRefreshMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStats() {
    return {
      pending: this.pending.length,
      inflight: this.inFlight.size,
    };
  }

  private async tick() {
    if (this.pending.length === 0) return;
    const limit = this.config.backfillConcurrency;

    while (this.inFlight.size < limit && this.pending.length > 0) {
      const address = this.pending.shift();
      if (!address) break;
      this.pendingSet.delete(address);
      this.inFlight.add(address);
      this.processAddress(address)
        .catch((error) => {
          this.logger.error('backfill failed', { address, error: (error as Error).message });
        })
        .finally(() => {
          this.inFlight.delete(address);
        });
    }
  }

  private async processAddress(address: string) {
    return this.store.withAddressLock(address, () => this.processAddressLocked(address));
  }

  private async processAddressLocked(address: string) {
    let entry = this.store.get(address);
    if (!entry) return;
    if (entry.stats.historyComplete) return;

    const limit = this.config.pageSize * this.config.backfillPageBatch;
    const maxPages = Math.min(
      this.config.backfillMaxPagesPerAddress,
      this.config.maxPagesPerAddress
    );
    const maxTransactions = this.config.pageSize * maxPages;
    const maxRequests = Math.max(1, maxPages);
    const seenCursors = new Set<string>();
    const pendingPoolTransactions: RawTransaction[] = [];
    const pendingPoolTransactionKeys = new Set<string>();

    for (let requestIndex = 0; requestIndex < maxRequests; requestIndex += 1) {
      entry = this.store.get(address);
      if (!entry || entry.stats.historyComplete) return;
      if (entry.stats.txCount >= maxTransactions) {
        this.store.markHistoryIncomplete(address);
        return;
      }

      const oldest = entry.txs[entry.txs.length - 1];
      const cursor = oldest ?? (
        entry.balance?.lastTxLt && entry.balance.lastTxHash
          ? { lt: entry.balance.lastTxLt, hash: entry.balance.lastTxHash }
          : undefined
      );
      if (!cursor) return;
      const cursorKey = `${cursor.lt}:${cursor.hash}`;
      if (seenCursors.has(cursorKey)) {
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill cursor stalled before history exhaustion', {
          address,
          cursorLt: cursor.lt
        });
        return;
      }
      seenCursors.add(cursorKey);

      const remainingCapacity = maxTransactions - entry.stats.txCount;
      const requestLimit = Math.max(
        1,
        Math.min(limit, remainingCapacity + (oldest ? 1 : 0))
      );
      const receivedRawTxs = await this.source.getTransactions(
        address,
        requestLimit,
        cursor.lt,
        cursor.hash
      );
      this.metrics?.recordBackfillBatch(receivedRawTxs.length);
      const responseTruncated = receivedRawTxs.length > requestLimit;
      const rawTxs = receivedRawTxs.slice(0, requestLimit);
      if (rawTxs.length === 0) {
        this.store.setLastBackfillLt(address, cursor.lt);
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill returned empty inclusive page without history-start proof', {
          address,
          cursorLt: cursor.lt
        });
        return;
      }

      const rawOldest = rawTxs[rawTxs.length - 1];
      if (
        !rawOldest ||
        !transactionPageIsLinkedInclusiveSegment(rawTxs, cursor, rawOldest)
      ) {
        this.store.setLastBackfillLt(address, cursor.lt);
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill rejected an unlinked inclusive transaction page', {
          address,
          cursorLt: cursor.lt
        });
        return;
      }

      const reachesHistoryStart = transactionPageReachesHistoryStart(rawTxs, cursor);
      const beforeTransactions = entry.txs.map((transaction) => ({
        lt: transaction.lt,
        hash: transaction.hash,
      }));
      const beforeCount = entry.stats.txCount;
      for (const transaction of rawTxs) {
        const identity = transactionIdentity(transaction);
        if (pendingPoolTransactionKeys.has(identity)) continue;
        pendingPoolTransactionKeys.add(identity);
        pendingPoolTransactions.push(transaction);
      }
      const indexed = rawTxs.map((tx) => classifyTransaction(address, tx, this.opcodes));
      this.store.addTransactions(address, indexed);

      const updated = this.store.get(address);
      if (!updated) return;
      const newOldest = updated.txs[updated.txs.length - 1];
      this.store.setLastBackfillLt(address, newOldest?.lt);
      if (
        !responseTruncated &&
        reachesHistoryStart &&
        retainedExactInclusiveBackfillPage(rawTxs, beforeTransactions, updated.txs)
      ) {
        const balanceBeforeAccountRead = this.store.get(address)?.balance;
        const accountState = await this.source.getAccountState(address);
        const previousBalance = this.store.get(address)?.balance;
        if (previousBalance !== balanceBeforeAccountRead) {
          this.store.markHistoryIncomplete(address);
          return;
        }
        this.store.setBalance(address, {
          address,
          balance: accountState.balance,
          lastTxLt: accountState.lastTxLt,
          lastTxHash: accountState.lastTxHash,
          accountState: accountState.accountState ?? null,
          codeBoc: accountState.codeBoc ?? previousBalance?.codeBoc ?? null,
          dataBoc: accountState.dataBoc ?? previousBalance?.dataBoc ?? null,
          updatedAt: Date.now(),
        });
        const finalEntry = this.store.get(address);
        const newest = finalEntry?.txs[0];
        const retainedHistoryIsLinked = Boolean(
          finalEntry &&
          newest &&
          transactionPageReachesHistoryStart(finalEntry.txs, {
            lt: newest.lt,
            hash: newest.hash
          })
        );
        if (
          finalEntry &&
          newest &&
          accountState.lastTxLt === newest.lt &&
          accountState.lastTxHash === newest.hash &&
          finalEntry.balance?.lastTxLt === newest.lt &&
          finalEntry.balance?.lastTxHash === newest.hash &&
          retainedHistoryIsLinked &&
          retainedExactInclusiveBackfillPage(rawTxs, beforeTransactions, finalEntry.txs)
        ) {
          this.poolTracker?.observeTransactions(pendingPoolTransactions);
          this.store.markHistoryComplete(address);
          return;
        }
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill reached history start but retained head does not match account state', {
          address,
          retainedHeadLt: newest?.lt,
          accountHeadLt: accountState.lastTxLt
        });
        return;
      }
      if (responseTruncated) {
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill response exceeded remaining address capacity', {
          address,
          received: receivedRawTxs.length,
          retained: rawTxs.length,
          maxTransactions,
        });
        return;
      }
      const progressed =
        updated.stats.txCount > beforeCount &&
        newOldest !== undefined &&
        (newOldest.lt !== cursor.lt || newOldest.hash !== cursor.hash);
      if (!progressed) {
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill cursor stalled before history exhaustion', {
          address,
          cursorLt: cursor.lt
        });
        return;
      }
    }

    this.store.markHistoryIncomplete(address);
    this.logger.warn('backfill request cap reached before history exhaustion', {
      address,
      maxRequests
    });
  }
}
