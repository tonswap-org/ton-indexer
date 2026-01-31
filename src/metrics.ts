import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import { BackfillWorker } from './workers/backfillWorker';
import { IndexerService } from './indexerService';
import { MetricsCollector } from './metricsCollector';

export class MetricsService {
  private config: Config;
  private store: MemoryStore;
  private backfill: BackfillWorker;
  private service: IndexerService;
  private collector: MetricsCollector;
  private startedAt: number;
  private metricsCache?: { value: ReturnType<MetricsService['buildMetrics']>; expiresAt: number };
  private prometheusCache?: { value: string; expiresAt: number };

  constructor(
    config: Config,
    store: MemoryStore,
    backfill: BackfillWorker,
    service: IndexerService,
    collector: MetricsCollector
  ) {
    this.config = config;
    this.store = store;
    this.backfill = backfill;
    this.service = service;
    this.collector = collector;
    this.startedAt = Date.now();
  }

  getMetrics() {
    if (this.config.responseCacheEnabled && this.config.metricsCacheTtlMs > 0) {
      if (this.metricsCache && this.metricsCache.expiresAt > Date.now()) {
        return this.metricsCache.value;
      }
    }
    const value = this.buildMetrics();
    if (this.config.responseCacheEnabled && this.config.metricsCacheTtlMs > 0) {
      this.metricsCache = { value, expiresAt: Date.now() + this.config.metricsCacheTtlMs };
    }
    return value;
  }

  private buildMetrics() {
    const backfillStats = this.backfill.getStats();
    const health = this.service.getHealth();

    return {
      started_at: this.startedAt,
      uptime_ms: Date.now() - this.startedAt,
      network: this.config.network,
      data_source: this.config.dataSource,
      addresses: this.store.getAddressCount(),
      total_txs: this.store.getTotalTxs(),
      backfill_pending: backfillStats.pending,
      backfill_inflight: backfillStats.inflight,
      backfill_batches: this.collector.getBackfillStats().batches,
      backfill_txs: this.collector.getBackfillStats().txs,
      request_stats: this.collector.getRequestStats(),
      cache_stats: this.collector.getCacheStats(),
      last_master_seqno: health.lastMasterSeqno ?? null,
      indexer_lag_sec: health.indexerLagSec ?? null,
      liteserver_pool_status: health.liteserverPoolStatus ?? null,
    };
  }

  getPrometheus() {
    if (this.config.responseCacheEnabled && this.config.metricsCacheTtlMs > 0) {
      if (this.prometheusCache && this.prometheusCache.expiresAt > Date.now()) {
        return this.prometheusCache.value;
      }
    }
    const health = this.service.getHealth();
    const requestStats = this.collector.getRequestStats();
    const cacheStats = this.collector.getCacheStats();
    const backfillStats = this.collector.getBackfillStats();

    const lines: string[] = [];
    const gauge = (name: string, value: number | null, help?: string) => {
      if (value === null || !Number.isFinite(value)) return;
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    };
    const counter = (name: string, value: number, help?: string) => {
      if (!Number.isFinite(value)) return;
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    };

    gauge('indexer_uptime_ms', Date.now() - this.startedAt, 'Uptime in milliseconds');
    gauge('indexer_addresses', this.store.getAddressCount(), 'Addresses tracked in memory');
    gauge('indexer_total_txs', this.store.getTotalTxs(), 'Total transactions stored in memory');
    gauge('indexer_backfill_pending', this.backfill.getStats().pending, 'Pending backfill queue size');
    gauge('indexer_backfill_inflight', this.backfill.getStats().inflight, 'Backfill in-flight count');
    counter('indexer_backfill_batches_total', backfillStats.batches, 'Backfill batches processed');
    counter('indexer_backfill_txs_total', backfillStats.txs, 'Backfill transactions processed');

    counter('indexer_request_total', requestStats.count, 'Total requests observed');
    gauge('indexer_request_avg_ms', requestStats.avg_ms, 'Average request duration ms');
    gauge('indexer_request_p50_ms', requestStats.p50_ms, 'P50 request duration ms');
    gauge('indexer_request_p95_ms', requestStats.p95_ms, 'P95 request duration ms');
    gauge('indexer_request_max_ms', requestStats.max_ms, 'Max request duration ms');

    counter('indexer_cache_balance_hits_total', cacheStats.balance_hits, 'Balance cache hits');
    counter('indexer_cache_balance_misses_total', cacheStats.balance_misses, 'Balance cache misses');
    gauge('indexer_cache_balance_hit_rate', cacheStats.balance_hit_rate, 'Balance cache hit rate');
    counter('indexer_cache_tx_hits_total', cacheStats.tx_hits, 'Tx cache hits');
    counter('indexer_cache_tx_misses_total', cacheStats.tx_misses, 'Tx cache misses');
    gauge('indexer_cache_tx_hit_rate', cacheStats.tx_hit_rate, 'Tx cache hit rate');

    gauge('indexer_last_master_seqno', health.lastMasterSeqno ?? null, 'Latest masterchain seqno seen');
    gauge('indexer_lag_sec', health.indexerLagSec ?? null, 'Indexer lag in seconds');

    const output = `${lines.join('\\n')}\\n`;
    if (this.config.responseCacheEnabled && this.config.metricsCacheTtlMs > 0) {
      this.prometheusCache = { value: output, expiresAt: Date.now() + this.config.metricsCacheTtlMs };
    }
    return output;
  }
}
