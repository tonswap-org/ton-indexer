import { Config } from '../config';

export class RateLimiter {
  private enabled: boolean;
  private windowMs: number;
  private max: number;
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastCleanup = 0;

  constructor(config: Config) {
    this.enabled = config.rateLimitEnabled;
    this.windowMs = config.rateLimitWindowMs;
    this.max = config.rateLimitMax;
  }

  isEnabled() {
    return this.enabled;
  }

  check(key: string) {
    if (!this.enabled) {
      return { allowed: true, remaining: this.max, resetAt: Date.now() + this.windowMs };
    }

    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, this.max - bucket.count);
    this.cleanup(now);
    return {
      allowed: bucket.count <= this.max,
      remaining,
      resetAt: bucket.resetAt,
    };
  }

  getConfig() {
    return { enabled: this.enabled, windowMs: this.windowMs, max: this.max };
  }

  private cleanup(now: number) {
    if (now - this.lastCleanup < this.windowMs) return;
    this.lastCleanup = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
