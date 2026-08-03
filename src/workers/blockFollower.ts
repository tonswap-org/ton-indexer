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

const retainedExactTransactionUnion = (
  raw: readonly RawTransaction[],
  before: readonly { lt: string; hash: string }[],
  after: readonly { lt: string; hash: string }[]
) => {
  if (raw.length === 0) return false;
  const rawIdentities = raw.map(transactionIdentity);
  const beforeIdentities = before.map(transactionIdentity);
  const afterIdentities = after.map(transactionIdentity);
  const expectedIdentities = new Set([...beforeIdentities, ...rawIdentities]);
  if (
    new Set(rawIdentities).size !== rawIdentities.length ||
    new Set(beforeIdentities).size !== beforeIdentities.length ||
    new Set(afterIdentities).size !== afterIdentities.length ||
    afterIdentities.length !== expectedIdentities.size
  ) {
    return false;
  }
  const retained = new Set(afterIdentities);
  return [...expectedIdentities].every((identity) => retained.has(identity));
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
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const master = await this.source.getMasterchainInfo();
      if (this.lastSeqno && master.seqno <= this.lastSeqno) return;
      this.lastSeqno = master.seqno;
      this.service.setMasterchainInfo(master.seqno, master.timestamp);

      const watchlist = this.store.listWatchlist();
      if (watchlist.length === 0) return;

      const batchSize = 10;
      for (let i = 0; i < watchlist.length; i += batchSize) {
        const batch = watchlist.slice(i, i + batchSize);
        await Promise.all(
          batch.map((entry) =>
            this.refreshAddress(entry.address, master.seqno).catch((error) => {
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

  private async refreshAddress(address: string, seqno: number) {
    const previousEntry = this.store.get(address);
    const previousLatest = previousEntry?.txs[0];
    const previousHistoryComplete = previousEntry?.stats.historyComplete === true;
    const previousTransactions = (previousEntry?.txs ?? []).map((transaction) => ({
      lt: transaction.lt,
      hash: transaction.hash,
    }));
    await this.service.refreshAccountState(address);
    const entry = this.store.get(address);
    if (!entry?.balance) return;

    const headLt = entry.balance.lastTxLt;
    const headHash = entry.balance.lastTxHash;
    const hasHeadLt = typeof headLt === 'string' && headLt.length > 0;
    const hasHeadHash = typeof headHash === 'string' && headHash.length > 0;
    if (!hasHeadLt || !hasHeadHash) {
      if (hasHeadLt !== hasHeadHash || previousLatest || !previousHistoryComplete) {
        this.store.markHistoryIncomplete(address);
      }
      this.store.setLastUpdateSeqno(address, seqno);
      return;
    }

    if (
      previousLatest &&
      previousLatest.lt === headLt &&
      previousLatest.hash === headHash
    ) {
      this.store.setLastUpdateSeqno(address, seqno);
      return;
    }

    // Once a fresh account head differs from the retained head, the cached
    // history is incomplete until continuity and exact retention are proven.
    this.store.markHistoryIncomplete(address);

    const batchSize = Math.max(1, this.config.pageSize * this.config.backfillPageBatch);
    const maxBatches = Math.max(
      1,
      Math.ceil(this.config.backfillMaxPagesPerAddress / this.config.backfillPageBatch)
    );
    const raw: RawTransaction[] = [];
    const seen = new Set<string>();
    let cursorLt = headLt;
    let cursorHash = headHash;
    let reachedPreviousLatest = false;
    let reachedHistoryStart = false;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const batch = await this.source.getTransactions(address, batchSize, cursorLt, cursorHash);
      if (batch.length === 0) break;

      let added = 0;
      for (const tx of batch) {
        const key = `${tx.lt}:${tx.hash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push(tx);
        added += 1;
        if (previousLatest && tx.lt === previousLatest.lt && tx.hash === previousLatest.hash) {
          reachedPreviousLatest = true;
          break;
        }
      }

      const oldest = batch[batch.length - 1];
      // Lite servers may return a proof-size-capped short page before the requested
      // limit. Only the prior head, an empty page, or a stalled cursor proves that
      // catch-up cannot continue.
      if (!oldest || reachedPreviousLatest) break;
      if (
        !previousLatest &&
        transactionPageReachesHistoryStart(raw, { lt: headLt, hash: headHash })
      ) {
        reachedHistoryStart = true;
        break;
      }
      if (oldest.lt === cursorLt && oldest.hash === cursorHash) break;
      if (added === 0) break;
      cursorLt = oldest.lt;
      cursorHash = oldest.hash;
    }

    const continuityProven = previousLatest
      ? reachedPreviousLatest &&
        transactionPageIsLinkedInclusiveSegment(
          raw,
          { lt: headLt, hash: headHash },
          previousLatest
        )
      : reachedHistoryStart ||
        transactionPageReachesHistoryStart(raw, { lt: headLt, hash: headHash });

    let retainedExactly = false;
    if (continuityProven) {
      this.poolTracker?.observeTransactions(raw);
      const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
      this.store.addTransactions(address, indexed);
      const updated = this.store.get(address);
      retainedExactly = Boolean(
        updated && retainedExactTransactionUnion(raw, previousTransactions, updated.txs)
      );
      if (retainedExactly && (!previousLatest || previousHistoryComplete)) {
        this.store.markHistoryComplete(address);
      }
    }

    if (!continuityProven || !retainedExactly) {
      this.logger.warn('watchlist catch-up did not preserve one exact complete history segment', {
        address,
        fetched: raw.length,
        previousLt: previousLatest?.lt,
        reachedPreviousLatest,
        reachedHistoryStart,
        continuityProven,
        retainedExactly
      });
    }
    this.store.setLastUpdateSeqno(address, seqno);
  }
}
