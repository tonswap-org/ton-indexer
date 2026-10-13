import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface RuntimeMetrics {
  count(name: string, by?: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  snapshot(): unknown;
  prometheus(): string;
}

type Labels = Record<string, string>;
type Series = { name: string; labels: Labels } & (
  | { kind: 'counter' | 'gauge'; value: number }
  | { kind: 'histogram'; count: number; sum: number; buckets: number[] }
);
// Fixed buckets and a capped registry keep runtime instrumentation bounded even
// when a caller accidentally supplies an account or a request ID as a label.
const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];
const MAX_SERIES = 512;
const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function createRuntimeMetrics(): RuntimeMetrics & { startEventLoopMonitor(): () => void } {
  const series = new Map<string, Series>();
  const kinds = new Map<string, Series['kind']>();
  let droppedSeries = 0;
  let monitor: { users: number; stop(): void } | undefined;

  function get(name: string, kind: Series['kind'], labels: Labels = {}): Series | undefined {
    if (typeof name !== 'string' || name.length > 100 || !/^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/.test(name)) return undefined;
    name = name.replace(/[.-]/g, '_');
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 8 || entries.some(([key, value]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
      || key.length > 64 || key === 'le' || typeof value !== 'string' || value.length > 160)) return undefined;
    if (kinds.has(name) && kinds.get(name) !== kind) return undefined;
    const key = JSON.stringify([name, entries]);
    const existing = series.get(key);
    if (existing) return existing;
    if (series.size >= MAX_SERIES) { droppedSeries += 1; return undefined; }
    const row: Series = kind === 'histogram'
      ? { name, labels: Object.fromEntries(entries), kind, count: 0, sum: 0, buckets: BOUNDS.map(() => 0) }
      : { name, labels: Object.fromEntries(entries), kind, value: 0 };
    kinds.set(name, kind);
    series.set(key, row);
    return row;
  }

  const metrics: RuntimeMetrics & { startEventLoopMonitor(): () => void } = {
    count(name, by = 1, labels) {
      if (!Number.isFinite(by) || by < 0) return;
      const row = get(name, 'counter', labels);
      if (row?.kind === 'counter' && Number.isFinite(row.value + by)) row.value += by;
    },
    gauge(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const row = get(name, 'gauge', labels);
      if (row?.kind === 'gauge') row.value = value;
    },
    observe(name, value, labels) {
      if (!Number.isFinite(value) || value < 0) return;
      const row = get(name, 'histogram', labels);
      if (row?.kind !== 'histogram' || !Number.isFinite(row.sum + value)) return;
      row.count += 1;
      row.sum += value;
      BOUNDS.forEach((bound, index) => { if (value <= bound) row.buckets[index] += 1; });
    },
    snapshot() {
      return {
        droppedSeries,
        series: [...series.values()].map(row => row.kind === 'histogram'
          ? { ...row, labels: { ...row.labels }, buckets: BOUNDS.map((le, index) => ({ le, count: row.buckets[index] })), overflow: row.count }
          : { ...row, labels: { ...row.labels } }),
      };
    },
    prometheus() {
      const lines: string[] = [];
      const described = new Set<string>();
      const labelText = (labels: Labels) => {
        const values = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
        return values.length ? `{${values.join(',')}}` : '';
      };
      for (const row of series.values()) {
        const name = `indexer_runtime_${row.name}`;
        if (!described.has(name)) { lines.push(`# TYPE ${name} ${row.kind}`); described.add(name); }
        if (row.kind === 'histogram') {
          BOUNDS.forEach((bound, index) => lines.push(`${name}_bucket${labelText({ ...row.labels, le: String(bound) })} ${row.buckets[index]}`));
          lines.push(`${name}_bucket${labelText({ ...row.labels, le: '+Inf' })} ${row.count}`);
          lines.push(`${name}_sum${labelText(row.labels)} ${row.sum}`);
          lines.push(`${name}_count${labelText(row.labels)} ${row.count}`);
        } else lines.push(`${name}${labelText(row.labels)} ${row.value}`);
      }
      lines.push('# TYPE indexer_runtime_dropped_series_total counter', `indexer_runtime_dropped_series_total ${droppedSeries}`);
      return `${lines.join('\n')}\n`;
    },
    startEventLoopMonitor() {
      if (!monitor) {
        const delay = monitorEventLoopDelay({ resolution: 20 });
        delay.enable();
        metrics.gauge('event_loop_delay_p95_ms', 0);
        metrics.gauge('event_loop_delay_max_ms', 0);
        const timer = setInterval(() => {
          metrics.gauge('event_loop_delay_p95_ms', delay.count ? delay.percentile(95) / 1e6 : 0);
          metrics.gauge('event_loop_delay_max_ms', delay.count ? delay.max / 1e6 : 0);
          delay.reset();
        }, 1_000);
        timer.unref();
        monitor = { users: 0, stop: () => { clearInterval(timer); delay.disable(); } };
      }
      const current = monitor;
      current.users += 1;
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        if (--current.users === 0) {
          current.stop();
          if (monitor === current) monitor = undefined;
        }
      };
    },
  };
  return metrics;
}
