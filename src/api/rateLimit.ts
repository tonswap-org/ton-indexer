import { Config, RateLimitBucketName } from '../config';

export class RateLimiter {
  private enabled: boolean;
  private defaults: { windowMs: number; max: number };
  private routeBuckets: Record<RateLimitBucketName, { windowMs: number; max: number }>;
  private counters = new Map<string, { count: number; resetAt: number }>();
  private lastCleanup = 0;
  private cleanupIntervalMs: number;

  constructor(config: Config) {
    this.enabled = config.rateLimitEnabled;
    this.defaults = { windowMs: config.rateLimitWindowMs, max: config.rateLimitMax };
    this.routeBuckets = config.rateLimitBuckets;
    this.cleanupIntervalMs = Math.max(
      5_000,
      Math.min(...Object.values(this.routeBuckets).map((entry) => entry.windowMs), this.defaults.windowMs)
    );
  }

  isEnabled() {
    return this.enabled;
  }

  check(key: string, bucketName: RateLimitBucketName = 'default') {
    const bucketConfig = this.routeBuckets[bucketName] ?? this.defaults;
    const windowMs = bucketConfig.windowMs;
    const max = bucketConfig.max;
    if (!this.enabled) {
      return { allowed: true, remaining: max, resetAt: Date.now() + windowMs, bucket: bucketName, limit: max };
    }

    const cacheKey = `${bucketName}:${key}`;
    const now = Date.now();
    let bucket = this.counters.get(cacheKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.counters.set(cacheKey, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    this.cleanup(now);
    return {
      allowed: bucket.count <= max,
      remaining,
      resetAt: bucket.resetAt,
      bucket: bucketName,
      limit: max
    };
  }

  getConfig() {
    return {
      enabled: this.enabled,
      windowMs: this.defaults.windowMs,
      max: this.defaults.max,
      buckets: this.routeBuckets
    };
  }

  private cleanup(now: number) {
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    for (const [key, bucket] of this.counters) {
      if (bucket.resetAt <= now) {
        this.counters.delete(key);
      }
    }
  }
}
