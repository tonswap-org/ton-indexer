import { FreshReadUnavailableError } from './freshRead';

const unavailable = (): never => { throw new FreshReadUnavailableError(new Error('Fresh liteserver head has stale or invalid block time.')); };

export function assertFreshHeadTime(lastUtime: number, wallTimeMs = Date.now()): void {
  const wallTime = Math.floor(wallTimeMs / 1_000);
  if (!Number.isSafeInteger(lastUtime) || lastUtime < 0 || lastUtime < wallTime - 30 || lastUtime > wallTime + 5)
    unavailable();
}

/** lastUtime is block creation time; the peer's `now` alone is not freshness. */
export function assertFreshLiteHeadTime(master: { lastUtime: number; now: number }, wallTimeMs = Date.now()): void {
  assertFreshHeadTime(master.lastUtime, wallTimeMs);
  if (!Number.isSafeInteger(master.now) || master.now < master.lastUtime || Math.abs(master.now - Math.floor(wallTimeMs / 1_000)) > 30)
    unavailable();
}
