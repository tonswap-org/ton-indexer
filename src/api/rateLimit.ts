import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { Config, RateLimitBucketName } from '../config';

export const EDGE_KEY_HEADER = 'x-tonswap-edge-key', EDGE_CLIENT_HEADER = 'x-tonswap-client-ip';
export function rateLimitKey(request: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } }, edgeKey: string | undefined): { key: string; identity: 'edge' | 'socket' } {
  const candidate = request.headers[EDGE_KEY_HEADER], client = request.headers[EDGE_CLIENT_HEADER];
  if (edgeKey && typeof candidate === 'string' && typeof client === 'string' && isIP(client)) {
    const expected = Buffer.from(edgeKey), supplied = Buffer.from(candidate);
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return { key: client, identity: 'edge' };
  }
  return { key: request.socket.remoteAddress ?? 'unknown', identity: 'socket' };
}
const MAX_COUNTERS = 50_000;

export class RateLimiter {
  private enabled: boolean;
  private defaults: { windowMs: number; max: number };
  private routeBuckets: Record<RateLimitBucketName, { windowMs: number; max: number }>;
  private counters = new Map<string, { count: number; resetAt: number }>();
  private lastCleanup = 0;
  private nextExpiryAt = Infinity;
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
      return { allowed: true, remaining: max, resetAt: Date.now() + windowMs, bucket: bucketName, limit: max, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
    }

    const cacheKey = `${bucketName}:${key}`;
    const now = Date.now();
    let bucket = this.counters.get(cacheKey);
    if (!bucket || bucket.resetAt <= now) {
      this.counters.delete(cacheKey);
      this.cleanup(now, this.counters.size >= MAX_COUNTERS);
      bucket = { count: 0, resetAt: now + windowMs };
      this.counters.set(cacheKey, bucket);
      this.nextExpiryAt = Math.min(this.nextExpiryAt, bucket.resetAt);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    this.cleanup(now);
    return {
      allowed: bucket.count <= max,
      remaining,
      resetAt: bucket.resetAt,
      bucket: bucketName,
      limit: max,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
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

  private cleanup(now: number, atCapacity = false) {
    if (!atCapacity && now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    if (now >= this.nextExpiryAt) {
      this.nextExpiryAt = Infinity;
      for (const [key, bucket] of this.counters) {
        if (bucket.resetAt <= now) this.counters.delete(key);
        else this.nextExpiryAt = Math.min(this.nextExpiryAt, bucket.resetAt);
      }
    }
    // Map order is the start order of the windows, including a restarted expired window.
    if (atCapacity && this.counters.size >= MAX_COUNTERS) this.counters.delete(this.counters.keys().next().value!);
  }
}
