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
    const entry = this.store.get(address);
    if (!entry) return;
    if (entry.stats.historyComplete) return;

    const knownPages = Math.ceil(entry.stats.txCount / this.config.pageSize);
    if (knownPages >= this.config.backfillMaxPagesPerAddress) {
      return;
    }

    const oldest = entry.txs[entry.txs.length - 1];
    if (!oldest) return;

    const limit = this.config.pageSize * this.config.backfillPageBatch;
    const rawTxs = await this.source.getTransactions(address, limit, oldest.lt, oldest.hash);
    const beforeCount = entry.stats.txCount;

    this.poolTracker?.observeTransactions(rawTxs);
    const indexed = rawTxs.map((tx) => classifyTransaction(address, tx, this.opcodes));
    this.store.addTransactions(address, indexed);
    this.metrics?.recordBackfillBatch(rawTxs.length);

    const updated = this.store.get(address);
    if (!updated) return;
    const newOldest = updated.txs[updated.txs.length - 1];
    this.store.setLastBackfillLt(address, newOldest?.lt);

    if (rawTxs.length < limit || updated.stats.txCount === beforeCount) {
      this.store.markHistoryComplete(address);
    } else {
      this.enqueue(address);
    }
  }
}
