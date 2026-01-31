import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import { BackfillWorker } from './workers/backfillWorker';
import { PoolTracker } from './poolTracker';

export class DebugService {
  private config: Config;
  private store: MemoryStore;
  private backfill: BackfillWorker;
  private poolTracker?: PoolTracker;

  constructor(config: Config, store: MemoryStore, backfill: BackfillWorker, poolTracker?: PoolTracker) {
    this.config = config;
    this.store = store;
    this.backfill = backfill;
    this.poolTracker = poolTracker;
  }

  getStatus(limit = 100) {
    const entries = this.store
      .listWatchlist()
      .sort((a, b) => (b.stats.lastRequestAt ?? 0) - (a.stats.lastRequestAt ?? 0))
      .slice(0, limit)
      .map((entry) => ({
        address: entry.address,
        tx_count: entry.stats.txCount,
        history_complete: entry.stats.historyComplete,
        total_pages_min: entry.stats.totalPagesMin,
        last_backfill_lt: entry.stats.lastBackfillLt ?? null,
        last_request_at: entry.stats.lastRequestAt,
        last_update_seqno: entry.stats.lastUpdateSeqno ?? null,
        balance: entry.balance?.balance ?? null,
        last_tx_lt: entry.balance?.lastTxLt ?? null,
        last_tx_hash: entry.balance?.lastTxHash ?? null,
      }));

    const backfill = this.backfill.getStats();

    return {
      data_source: this.config.dataSource,
      network: this.config.network,
      snapshot_path: this.config.snapshotPath ?? null,
      snapshot_on_exit: this.config.snapshotOnExit,
      pool_count: this.poolTracker?.getPoolCount() ?? 0,
      pool_factory_count: this.poolTracker?.getFactoryCount() ?? 0,
      watchlist_size: this.store.getAddressCount(),
      backfill_pending: backfill.pending,
      backfill_inflight: backfill.inflight,
      entries,
    };
  }
}
