import { Config } from '../config';
import { MemoryStore } from '../store/memoryStore';
import {
  RawTransaction,
  TonDataSource,
  transactionPageIsLinkedInclusiveSegment,
  transactionPageReachesHistoryStart
} from '../data/dataSource';
import { OpcodeSets } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { Logger } from '../utils/logger';
import { IndexerService } from '../indexerService';
import { PoolTracker } from '../poolTracker';

const transactionIdentity = (transaction: { lt: string; hash: string }) =>
  `${transaction.lt}:${transaction.hash}`;

const retainedExactTransactions = (
  expected: readonly { lt: string; hash: string }[],
  actual: readonly { lt: string; hash: string }[]
) => {
  if (expected.length === 0 || expected.length !== actual.length) return false;
  const expectedIdentities = expected.map(transactionIdentity);
  const actualIdentities = actual.map(transactionIdentity);
  if (
    new Set(expectedIdentities).size !== expectedIdentities.length ||
    new Set(actualIdentities).size !== actualIdentities.length
  ) {
    return false;
  }
  return expectedIdentities.every((identity, index) => identity === actualIdentities[index]);
};

export class BlockFollower {
  private config: Config;
  private store: MemoryStore;
  private source: TonDataSource;
  private opcodes: OpcodeSets;
  private logger: Logger;
  private service: IndexerService;
  private poolTracker?: PoolTracker;
  private timer?: NodeJS.Timeout;
  private lastSeqno?: number;
  private inFlight = false;

  constructor(
    config: Config,
    store: MemoryStore,
    source: TonDataSource,
    opcodes: OpcodeSets,
    logger: Logger,
    service: IndexerService,
    poolTracker?: PoolTracker
  ) {
    this.config = config;
    this.store = store;
    this.source = source;
    this.opcodes = opcodes;
    this.logger = logger;
    this.service = service;
    this.poolTracker = poolTracker;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.config.blockPollMs);
    this.poll();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll() {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const master = await this.source.getMasterchainInfo();
      if (this.lastSeqno && master.seqno <= this.lastSeqno) return;
      this.lastSeqno = master.seqno;
      this.service.setMasterchainInfo(master.seqno, master.timestamp);

      this.store.purgeStale();
      const workflowGeneration = this.store.getWorkflowGeneration();
      const watchlist = this.store.listWatchlist();
      if (watchlist.length === 0) return;

      const batchSize = 10;
      for (let i = 0; i < watchlist.length; i += batchSize) {
        const batch = watchlist.slice(i, i + batchSize);
        await Promise.all(
          batch.map((entry) =>
            this.refreshAddress(entry.address, master.seqno, workflowGeneration).catch((error) => {
              this.logger.warn('watchlist refresh failed', {
                address: entry.address,
                error: (error as Error).message,
              });
            })
          )
        );
      }

      this.store.purgeStale();
    } catch (error) {
      this.logger.error('block follower error', { error: (error as Error).message });
    } finally {
      this.inFlight = false;
    }
  }

  private async refreshAddress(
    address: string,
    seqno: number,
    workflowGeneration = this.store.getWorkflowGeneration()
  ) {
    await this.store.withAddressLock(
      address,
      async () => {
        await this.service.refreshAccountStateWithinAddressLock(address);
        await this.refreshAddressLocked(address, seqno);
      },
      workflowGeneration
    );
  }

  private async refreshAddressLocked(address: string, seqno: number) {
    const previousEntry = this.store.get(address);
    const previousLatest = previousEntry?.txs[0];
    const previousTransactions = [...(previousEntry?.txs ?? [])];
    const entry = this.store.get(address);
    if (!entry?.balance) return;

    const headLt = entry.balance.lastTxLt;
    const headHash = entry.balance.lastTxHash;
    const hasHeadLt = typeof headLt === 'string' && headLt.length > 0;
    const hasHeadHash = typeof headHash === 'string' && headHash.length > 0;
    if (!hasHeadLt || !hasHeadHash) {
      if (hasHeadLt !== hasHeadHash || previousLatest) {
        this.store.markHistoryIncomplete(address);
      } else {
        this.store.markHistoryComplete(address);
      }
      this.store.setLastUpdateSeqno(address, seqno);
      return;
    }

    if (
      previousLatest &&
      previousLatest.lt === headLt &&
      previousLatest.hash === headHash
    ) {
      if (
        transactionPageReachesHistoryStart(previousTransactions, {
          lt: headLt,
          hash: headHash
        })
      ) {
        this.store.markHistoryComplete(address);
      } else {
        this.store.markHistoryIncomplete(address);
      }
      this.store.setLastUpdateSeqno(address, seqno);
      return;
    }

    // Once a fresh account head differs from the retained head, the cached
    // history is incomplete until continuity and exact retention are proven.
    this.store.markHistoryIncomplete(address);

    const batchSize = Math.max(1, this.config.pageSize * this.config.backfillPageBatch);
    const maxPages = Math.min(
      this.config.backfillMaxPagesPerAddress,
      this.config.maxPagesPerAddress
    );
    const maxFetchedTransactions = Math.max(1, this.config.pageSize * maxPages);
    // A lite-server proof can be much shorter than the requested batch. Bound
    // work by actual unique history progress rather than the requested size.
    const maxRequests = maxFetchedTransactions;
    const raw: RawTransaction[] = [];
    const seen = new Set<string>();
    const previousIndexByIdentity = new Map(
      previousTransactions.map((transaction, index) => [transactionIdentity(transaction), index])
    );
    let cursorLt = headLt;
    let cursorHash = headHash;
    let reachedCachedIndex: number | undefined;
    let reachedHistoryStart = false;
    let truncatedByCapacity = false;

    for (
      let requestIndex = 0;
      requestIndex < maxRequests && raw.length < maxFetchedTransactions;
      requestIndex += 1
    ) {
      const requestLimit = Math.min(
        batchSize,
        Math.max(1, maxFetchedTransactions - raw.length + (raw.length > 0 ? 1 : 0))
      );
      const batch = await this.source.getTransactions(
        address,
        requestLimit,
        cursorLt,
        cursorHash
      );
      if (batch.length === 0) break;

      let added = 0;
      for (const tx of batch) {
        const key = `${tx.lt}:${tx.hash}`;
        if (seen.has(key)) continue;
        if (raw.length >= maxFetchedTransactions) {
          truncatedByCapacity = true;
          break;
        }
        seen.add(key);
        raw.push(tx);
        added += 1;
        const cachedIndex = previousIndexByIdentity.get(key);
        if (cachedIndex !== undefined) {
          reachedCachedIndex = cachedIndex;
          break;
        }
      }

      const oldest = raw[raw.length - 1];
      // Lite servers may return a proof-size-capped short page before the requested
      // limit. Only the prior head, an empty page, or a stalled cursor proves that
      // catch-up cannot continue.
      if (!oldest || reachedCachedIndex !== undefined || truncatedByCapacity) break;
      if (transactionPageReachesHistoryStart(raw, { lt: headLt, hash: headHash })) {
        reachedHistoryStart = true;
        break;
      }
      if (oldest.lt === cursorLt && oldest.hash === cursorHash) break;
      if (added === 0) break;
      cursorLt = oldest.lt;
      cursorHash = oldest.hash;
    }

    const rawOldest = raw[raw.length - 1];
    const rawIsLinked = Boolean(
      rawOldest &&
      transactionPageIsLinkedInclusiveSegment(
        raw,
        { lt: headLt, hash: headHash },
        rawOldest
      )
    );
    reachedHistoryStart =
      reachedHistoryStart ||
      (rawIsLinked && transactionPageReachesHistoryStart(raw, { lt: headLt, hash: headHash }));

    let retainedExactly = false;
    let completeHistoryProven = false;
    if (rawIsLinked) {
      this.poolTracker?.observeTransactions(raw);
      const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
      let replacement = indexed;
      if (reachedCachedIndex !== undefined) {
        // The inclusive anchor is already part of the retained, certified
        // suffix. Keep that copy (and its predecessor proof) while replacing
        // only the prefix above it.
        const joined = [
          ...indexed.slice(0, -1),
          ...previousTransactions.slice(reachedCachedIndex)
        ];
        const joinedOldest = joined[joined.length - 1];
        if (
          joinedOldest &&
          transactionPageIsLinkedInclusiveSegment(
            joined,
            { lt: headLt, hash: headHash },
            joinedOldest
          )
        ) {
          replacement = joined;
        }
      }
      if (replacement.length > maxFetchedTransactions) {
        replacement = replacement.slice(0, maxFetchedTransactions);
        truncatedByCapacity = true;
      }

      // Replacing, rather than appending, removes orphaned prefixes after a
      // reorg. A linked head prefix is still useful when the configured work
      // budget cannot reach a cached ancestor in one poll; it remains incomplete.
      this.store.replaceTransactions(address, replacement);
      const updated = this.store.get(address);
      retainedExactly = Boolean(updated && retainedExactTransactions(replacement, updated.txs));
      const newest = updated?.txs[0];
      completeHistoryProven = Boolean(
        !truncatedByCapacity &&
        retainedExactly &&
        updated &&
        newest &&
        updated.balance?.lastTxLt === newest.lt &&
        updated.balance?.lastTxHash === newest.hash &&
        transactionPageReachesHistoryStart(updated.txs, {
          lt: newest.lt,
          hash: newest.hash
        })
      );
      this.store.setLastBackfillLt(address, updated?.txs[updated.txs.length - 1]?.lt);
      if (completeHistoryProven) {
        this.store.markHistoryComplete(address);
      }
    }

    if (!rawIsLinked || !retainedExactly || !completeHistoryProven) {
      this.logger.warn('watchlist catch-up retained only a partial canonical history segment', {
        address,
        fetched: raw.length,
        previousLt: previousLatest?.lt,
        reachedCachedLt:
          reachedCachedIndex === undefined ? undefined : previousTransactions[reachedCachedIndex]?.lt,
        reachedHistoryStart,
        truncatedByCapacity,
        rawIsLinked,
        retainedExactly,
        completeHistoryProven
      });
    }
    this.store.setLastUpdateSeqno(address, seqno);
  }
}
