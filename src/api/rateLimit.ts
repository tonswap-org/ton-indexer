import { Config, RateLimitBucketName } from '../config';

export class RateLimiter {
  private enabled: boolean;
  private defaults: { windowMs: number; max: number };
  private routeBuckets: Record<RateLimitBucketName, { windowMs: number; max: number }>;
  private counters = new Map<string, { count: number; resetAt: number }>();
  private globalCounter = { count: 0, resetAt: 0 };
  private lastCleanup = 0;
  private cleanupIntervalMs: number;
  private maxKeys: number;
  private global: { windowMs: number; max: number };

  constructor(config: Config) {
    this.enabled = config.rateLimitEnabled;
    this.defaults = { windowMs: config.rateLimitWindowMs, max: config.rateLimitMax };
    this.routeBuckets = config.rateLimitBuckets;
    this.maxKeys = config.rateLimitMaxKeys;
    this.global = { windowMs: config.rateLimitGlobalWindowMs, max: config.rateLimitGlobalMax };
    this.cleanupIntervalMs = Math.max(
      5_000,
      Math.min(...Object.values(this.routeBuckets).map((entry) => entry.windowMs), this.defaults.windowMs)
    );
  }

  isEnabled() {
    return this.enabled;
  }

  check(key: string, bucketName: RateLimitBucketName = 'default', now = Date.now()) {
    const bucketConfig = this.routeBuckets[bucketName] ?? this.defaults;
    const windowMs = bucketConfig.windowMs;
    const max = bucketConfig.max;
    if (!this.enabled) {
      return {
        allowed: true,
        remaining: max,
        resetAt: now + windowMs,
        bucket: bucketName,
        limit: max,
        scope: 'client' as const
      };
    }

    this.cleanup(now);
    if (this.globalCounter.resetAt <= now) {
      this.globalCounter = { count: 0, resetAt: now + this.global.windowMs };
    }
    this.globalCounter.count += 1;
    if (this.globalCounter.count > this.global.max) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: this.globalCounter.resetAt,
        bucket: bucketName,
        limit: this.global.max,
        scope: 'global' as const
      };
    }

    const cacheKey = `${bucketName}:${key}`;
    let bucket = this.counters.get(cacheKey);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.counters.size >= this.maxKeys) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: this.globalCounter.resetAt,
          bucket: bucketName,
          limit: max,
          scope: 'capacity' as const
        };
      }
      bucket = { count: 0, resetAt: now + windowMs };
      this.counters.set(cacheKey, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    return {
      allowed: bucket.count <= max,
      remaining,
      resetAt: bucket.resetAt,
      bucket: bucketName,
      limit: max,
      scope: 'client' as const
    };
  }

  getConfig() {
    return {
      enabled: this.enabled,
      windowMs: this.defaults.windowMs,
      max: this.defaults.max,
      maxKeys: this.maxKeys,
      global: this.global,
      buckets: this.routeBuckets
    };
  }

  getTrackedKeyCount() {
    return this.counters.size;
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
