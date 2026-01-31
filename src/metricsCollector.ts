export class MetricsCollector {
  private maxSamples: number;
  private durations: number[];
  private index = 0;
  private count = 0;
  private sum = 0;
  private max = 0;
  private requestCount = 0;

  private balanceHits = 0;
  private balanceMisses = 0;
  private txHits = 0;
  private txMisses = 0;
  private backfillBatches = 0;
  private backfillTxs = 0;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
    this.durations = new Array(maxSamples).fill(0);
  }

  recordRequest(durationMs: number) {
    const value = Math.max(0, durationMs);
    this.requestCount += 1;
    this.sum += value;
    if (value > this.max) this.max = value;

    if (this.count < this.maxSamples) {
      this.durations[this.count] = value;
      this.count += 1;
    } else {
      this.sum -= this.durations[this.index];
      this.durations[this.index] = value;
      this.index = (this.index + 1) % this.maxSamples;
    }
  }

  recordBalanceCache(hit: boolean) {
    if (hit) this.balanceHits += 1;
    else this.balanceMisses += 1;
  }

  recordTxCache(hit: boolean) {
    if (hit) this.txHits += 1;
    else this.txMisses += 1;
  }

  recordBackfillBatch(txCount: number) {
    this.backfillBatches += 1;
    this.backfillTxs += Math.max(0, txCount);
  }

  getRequestStats() {
    if (this.count === 0) {
      return {
        count: 0,
        avg_ms: 0,
        p50_ms: 0,
        p95_ms: 0,
        max_ms: 0,
      };
    }

    const values = this.durations.slice(0, this.count).slice().sort((a, b) => a - b);
    const p50 = values[Math.floor(values.length * 0.5)];
    const p95 = values[Math.floor(values.length * 0.95)];

    return {
      count: this.requestCount,
      avg_ms: this.sum / this.count,
      p50_ms: p50,
      p95_ms: p95,
      max_ms: this.max,
    };
  }

  getCacheStats() {
    const balanceTotal = this.balanceHits + this.balanceMisses;
    const txTotal = this.txHits + this.txMisses;
    return {
      balance_hits: this.balanceHits,
      balance_misses: this.balanceMisses,
      balance_hit_rate: balanceTotal ? this.balanceHits / balanceTotal : null,
      tx_hits: this.txHits,
      tx_misses: this.txMisses,
      tx_hit_rate: txTotal ? this.txHits / txTotal : null,
    };
  }

  getBackfillStats() {
    return {
      batches: this.backfillBatches,
      txs: this.backfillTxs,
    };
  }
}
