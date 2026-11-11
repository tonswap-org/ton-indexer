import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeMetrics } from '../runtimeMetrics';
import { MetricsService } from '../metrics';
import { MetricsCollector } from '../metricsCollector';
import { MemoryStore } from '../store/memoryStore';
import { loadConfig } from '../config';
import type { BackfillWorker } from '../workers/backfillWorker';
import type { IndexerService } from '../indexerService';

async function main() {
  const metrics = createRuntimeMetrics();
  metrics.count('queries_total', 2, { result: 'ok', peer: '1' });
  metrics.count('queries_total', 3, { peer: '1', result: 'ok' });
  metrics.count('queries_total', -1);
  metrics.gauge('chain.peersReady', 2);
  metrics.gauge('chain.peersReady', 1);
  metrics.gauge('escaped', 1, { text: 'quote"slash\\line\n' });
  [0, 5, 6, 100, 50_000].forEach(value => metrics.observe('read_ms', value, { method: 'get_wallet_data' }));
  metrics.observe('read_ms', Infinity);
  metrics.observe('read_ms', -1);
  const snapshot = metrics.snapshot() as { series: Array<any>; droppedSeries: number };
  const histogram = snapshot.series.find(row => row.name === 'read_ms');
  assert.equal(histogram.count, 5);
  assert.equal(histogram.sum, 50_111);
  assert.equal(histogram.buckets.find((row: any) => row.le === 5).count, 2);
  assert.equal(histogram.buckets.find((row: any) => row.le === 100).count, 4);
  assert.equal(histogram.overflow, 5);
  assert.equal(snapshot.series.find(row => row.name === 'queries_total').value, 5);
  assert.equal(snapshot.series.find(row => row.name === 'chain_peersReady').value, 1);
  histogram.buckets[0].count = -1;
  assert.notEqual((metrics.snapshot() as any).series.find((row: any) => row.name === 'read_ms').buckets[0].count, -1, 'snapshots are detached');
  const text = metrics.prometheus();
  assert.match(text, /indexer_runtime_queries_total\{peer="1",result="ok"\} 5/);
  assert.ok(text.includes('text="quote\\"slash\\\\line\\n"'));
  assert.match(text, /indexer_runtime_read_ms_bucket\{method="get_wallet_data",le="\+Inf"\} 5/);
  assert.equal((text.match(/# TYPE indexer_runtime_queries_total counter/g) ?? []).length, 1);

  const stop = metrics.startEventLoopMonitor();
  const stopSecond = metrics.startEventLoopMonitor();
  stop(); stop();
  await delay(1_050);
  assert.match(metrics.prometheus(), /indexer_runtime_event_loop_delay_p95_ms [\d.]+/);
  assert.match(metrics.prometheus(), /indexer_runtime_event_loop_delay_max_ms [\d.]+/);
  stopSecond();

  const config = { ...loadConfig(), responseCacheEnabled: false };
  const service = new MetricsService(config, new MemoryStore(config),
    { getStats: () => ({ pending: 0, inflight: 0 }) } as BackfillWorker,
    { getHealth: () => ({}) } as IndexerService, new MetricsCollector(), metrics);
  assert.deepEqual(service.getMetrics().runtime, metrics.snapshot());
  assert.ok(service.getPrometheus().includes(metrics.prometheus()));
  const oldService = new MetricsService(config, new MemoryStore(config),
    { getStats: () => ({ pending: 0, inflight: 0 }) } as BackfillWorker,
    { getHealth: () => ({}) } as IndexerService, new MetricsCollector());
  assert.equal(oldService.getMetrics().runtime, null);

  for (let i = 0; i < 1_000; i += 1) metrics.count('bounded_total', 1, { accidentalId: String(i) });
  const bounded = metrics.snapshot() as { series: Array<any>; droppedSeries: number };
  assert.equal(bounded.series.length, 512);
  assert.ok(bounded.droppedSeries > 0);
  assert.ok(bounded.series.filter(row => row.kind === 'histogram').every(row => row.buckets.length === 13));
  console.log('Runtime metrics preserve labels and bounds, expose event-loop delay, and integrate with admin metrics');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
