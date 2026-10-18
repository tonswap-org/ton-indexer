import { setTimeout, clearTimeout } from 'node:timers';
export type LedgerPriority = 'foreground' | 'background';
type Entry = {
  account: string; priority: LedgerPriority; queuedAt: number; order: number; readyAt: number;
  attempts: number; running: boolean; followUpAt: number | null;
};
type Timer = ReturnType<typeof setTimeout> | number;
export type LedgerSchedulerOptions = {
  workers: number; now: () => number;
  run: (account: string, priority: LedgerPriority) => Promise<void | { retry?: boolean }>;
  setTimer?: (work: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

/** One account entry, foreground precedence, and one slot always available to
 * foreground work. The only timer wakes a deferred retry; callers own sweeps. */
export class LedgerScheduler {
  private entries = new Map<string, Entry>();
  private active = new Set<Promise<void>>();
  private backgroundRunning = 0;
  private order = 0;
  private stopped = false;
  private scheduled = false;
  private timer?: Timer;
  constructor(private options: LedgerSchedulerOptions) {
    if (!Number.isInteger(options.workers) || options.workers < 2) throw new Error('Ledger scheduler requires at least two workers');
  }
  request(account: string, priority: LedgerPriority): boolean {
    if (this.stopped) return false;
    const now = this.options.now(), existing = this.entries.get(account);
    if (existing) {
      if (priority === 'foreground' && existing.priority === 'background') {
        existing.priority = priority;
        existing.queuedAt = now;
        if (existing.followUpAt !== null) existing.followUpAt = now;
      }
      if (existing.running && existing.followUpAt === null) existing.followUpAt = now;
    } else {
      this.entries.set(account, { account, priority, queuedAt: now, order: this.order++, readyAt: now,
        attempts: 0, running: false, followUpAt: null });
    }
    this.schedule();
    return true;
  }
  depth(): number {
    return [...this.entries.values()].filter(entry => !entry.running || entry.followUpAt !== null).length;
  }
  oldestForegroundAgeMs(): number {
    const times = [...this.entries.values()].filter(entry => entry.priority === 'foreground' && (!entry.running || entry.followUpAt !== null))
      .map(entry => entry.running ? entry.followUpAt! : entry.queuedAt);
    return times.length ? Math.max(0, this.options.now() - Math.min(...times)) : 0;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    for (const [account, entry] of this.entries) {
      entry.followUpAt = null;
      if (!entry.running) this.entries.delete(account);
    }
    await Promise.allSettled([...this.active]);
  }
  private clearTimer() {
    if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }
  private drain() {
    if (this.stopped) return;
    this.clearTimer();
    const now = this.options.now();
    while (this.active.size < this.options.workers) {
      const ready = [...this.entries.values()].filter(entry => !entry.running && entry.readyAt <= now)
        .sort((a, b) => (a.priority === b.priority ? a.queuedAt - b.queuedAt || a.order - b.order : a.priority === 'foreground' ? -1 : 1));
      const entry = ready.find(row => row.priority === 'foreground' || this.backgroundRunning < this.options.workers - 1);
      if (!entry) break;
      entry.running = true;
      const priority = entry.priority;
      if (priority === 'background') this.backgroundRunning++;
      const work = Promise.resolve().then(() => this.options.run(entry.account, priority))
        .then(result => this.finish(entry, result?.retry === true), () => this.finish(entry, true))
        .finally(() => {
          this.active.delete(work);
          if (priority === 'background') this.backgroundRunning--;
          this.schedule();
        });
      this.active.add(work);
    }
    const due = [...this.entries.values()].filter(entry => !entry.running && entry.readyAt > now).map(entry => entry.readyAt);
    if (due.length) {
      this.timer = (this.options.setTimer ?? setTimeout)(() => { this.timer = undefined; this.schedule(); }, Math.max(1, Math.min(...due) - now));
      if (typeof this.timer === 'object') this.timer.unref?.();
    }
  }
  private finish(entry: Entry, retry: boolean) {
    entry.running = false;
    if (this.stopped) { this.entries.delete(entry.account); return; }
    const now = this.options.now();
    if (retry) {
      entry.attempts = Math.min(6, entry.attempts + 1);
      entry.readyAt = now + Math.min(60_000, 2000 * 2 ** (entry.attempts - 1));
      entry.queuedAt = entry.followUpAt ?? now;
      entry.followUpAt = null;
    } else if (entry.followUpAt !== null) {
      entry.attempts = 0; entry.queuedAt = entry.followUpAt; entry.followUpAt = null; entry.readyAt = now;
    } else this.entries.delete(entry.account);
  }
}
