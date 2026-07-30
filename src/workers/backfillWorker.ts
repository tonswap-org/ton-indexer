import { Config } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { TonDataSource } from '../data/dataSource';
import { classifyTransaction } from '../utils/txClassifier';
import { OpcodeSets } from '../utils/opcodes';
import { Logger } from '../utils/logger';
import { MetricsCollector } from '../metricsCollector';
import { PoolTracker } from '../poolTracker';

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
    if (this.timer) clearInterval(this.timer);
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
    let entry = this.store.get(address);
    if (!entry) return;
    if (entry.stats.historyComplete) return;

    const limit = this.config.pageSize * this.config.backfillPageBatch;
    const maxPages = Math.min(
      this.config.backfillMaxPagesPerAddress,
      this.config.maxPagesPerAddress
    );
    const maxRequests = Math.max(1, maxPages);
    const seenCursors = new Set<string>();

    for (let requestIndex = 0; requestIndex < maxRequests; requestIndex += 1) {
      entry = this.store.get(address);
      if (!entry || entry.stats.historyComplete) return;
      if (entry.stats.totalPagesMin >= maxPages) {
        this.store.markHistoryIncomplete(address);
        return;
      }

      const oldest = entry.txs[entry.txs.length - 1];
      if (!oldest) return;
      const cursorKey = `${oldest.lt}:${oldest.hash}`;
      if (seenCursors.has(cursorKey)) {
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill cursor stalled before history exhaustion', {
          address,
          cursorLt: oldest.lt
        });
        return;
      }
      seenCursors.add(cursorKey);

      const rawTxs = await this.source.getTransactions(address, limit, oldest.lt, oldest.hash);
      this.metrics?.recordBackfillBatch(rawTxs.length);
      if (rawTxs.length === 0) {
        this.store.setLastBackfillLt(address, oldest.lt);
        this.store.markHistoryComplete(address);
        return;
      }

      const beforeCount = entry.stats.txCount;
      this.poolTracker?.observeTransactions(rawTxs);
      const indexed = rawTxs.map((tx) => classifyTransaction(address, tx, this.opcodes));
      this.store.addTransactions(address, indexed);

      const updated = this.store.get(address);
      if (!updated) return;
      const newOldest = updated.txs[updated.txs.length - 1];
      this.store.setLastBackfillLt(address, newOldest?.lt);
      const progressed =
        updated.stats.txCount > beforeCount &&
        newOldest !== undefined &&
        (newOldest.lt !== oldest.lt || newOldest.hash !== oldest.hash);
      if (!progressed) {
        this.store.markHistoryIncomplete(address);
        this.logger.warn('backfill cursor stalled before history exhaustion', {
          address,
          cursorLt: oldest.lt
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
