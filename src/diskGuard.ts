import { statfs as filesystemStats } from 'node:fs/promises';

export type DiskState = 'ok' | 'low' | 'critical';

type DiskGuardOptions = {
  paths: string[];
  softFloorBytes: number;
  hardFloorBytes: number;
  intervalMs?: number;
  statfs?: (path: string) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;
  onChange?: (state: DiskState, path: string, freeBytes: number) => void;
};

export function createDiskGuard(options: DiskGuardOptions): {
  state(): DiskState; freeBytes(): number | null; stop(): void;
} {
  const { softFloorBytes, hardFloorBytes } = options;
  const intervalMs = options.intervalMs ?? 30_000;
  if (!options.paths.length || options.paths.some(path => !path.trim())
    || !Number.isSafeInteger(softFloorBytes) || !Number.isSafeInteger(hardFloorBytes)
    || hardFloorBytes < 0 || softFloorBytes < hardFloorBytes
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid disk guard configuration');
  const paths = [...new Set(options.paths)];
  const statfs = options.statfs ?? (path => filesystemStats(path, { bigint: true }));
  // Unknown capacity is not permission to begin new durable work.
  let state: DiskState = 'critical';
  let free: number | null = null;
  let stopped = false;
  let sampling = false;
  let observed = false;

  async function sample(): Promise<void> {
    if (stopped || sampling) return;
    sampling = true;
    try {
      let minimum = Number.MAX_SAFE_INTEGER;
      let limitingPath = paths[0];
      let unavailable = false;
      for (const path of paths) {
        let available = 0;
        try {
          const stats = await statfs(path);
          const raw = BigInt(stats.bavail) * BigInt(stats.bsize);
          if (BigInt(stats.bavail) < 0n || BigInt(stats.bsize) <= 0n) throw new Error('Invalid filesystem capacity');
          available = Number(raw > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : raw);
        } catch {
          unavailable = true;
        }
        if (available < minimum) { minimum = available; limitingPath = path; }
      }
      if (stopped) return;
      free = unavailable ? null : minimum;
      const next: DiskState = unavailable || minimum < hardFloorBytes ? 'critical' : minimum < softFloorBytes ? 'low' : 'ok';
      const changed = !observed || next !== state;
      state = next;
      observed = true;
      if (changed) {
        // A monitoring callback must not leave an unhandled timer rejection.
        try { options.onChange?.(state, limitingPath, minimum); } catch { /* State remains queryable. */ }
      }
    } finally { sampling = false; }
  }

  const timer = setInterval(() => { void sample(); }, intervalMs);
  timer.unref();
  void sample();
  return {
    state: () => state,
    freeBytes: () => free,
    stop: () => { stopped = true; clearInterval(timer); },
  };
}
