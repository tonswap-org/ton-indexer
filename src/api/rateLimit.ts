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

type Counter = { count: number; resetAt: number };
type RateLimitScope = 'client' | 'global' | 'capacity';

export class RateLimiter {
  private readonly counters = new Map<RateLimitBucketName, Map<string, Counter>>();
  private trackedKeys = 0;
  private nextExpiryAt = Infinity;
  private latestWindowStart = 0;
  private global: Counter = { count: 0, resetAt: 0 };

  constructor(private readonly config: Config) {}

  isEnabled() {
    return this.config.rateLimitEnabled;
  }

  getTrackedKeyCount() {
    return this.trackedKeys;
  }

  check(key: string, bucketName: RateLimitBucketName = 'default', now = Date.now()) {
    const { max, windowMs } = this.config.rateLimitBuckets[bucketName];
    const result = (scope: RateLimitScope, allowed: boolean, remaining: number, limit: number, resetAt: number) => ({
      scope, allowed, remaining, limit, resetAt, bucket: bucketName,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000))
    });

    if (!this.isEnabled()) return result('client', true, max, max, now + windowMs);

    if (now >= this.global.resetAt) {
      this.global = { count: 0, resetAt: now + this.config.rateLimitGlobalWindowMs };
    }
    if (this.global.count >= this.config.rateLimitGlobalMax) {
      return result('global', false, 0, this.config.rateLimitGlobalMax, this.global.resetAt);
    }

    if (now >= this.nextExpiryAt) this.pruneExpired(now);
    let clients = this.counters.get(bucketName);
    if (!clients) {
      clients = new Map();
      this.counters.set(bucketName, clients);
    }
    let counter = clients.get(key);
    if (!counter) {
      if (this.trackedKeys >= this.config.rateLimitMaxKeys) {
        return result('capacity', false, 0, this.config.rateLimitMaxKeys, this.nextExpiryAt);
      }
      // Keep windows in start order even if the wall clock moves backwards.
      this.latestWindowStart = Math.max(this.latestWindowStart, now);
      counter = { count: 0, resetAt: this.latestWindowStart + windowMs };
      clients.set(key, counter);
      this.trackedKeys++;
      this.nextExpiryAt = Math.min(this.nextExpiryAt, counter.resetAt);
    }

    if (counter.count >= max) return result('client', false, 0, max, counter.resetAt);
    counter.count++;
    this.global.count++;
    return result('client', true, max - counter.count, max, counter.resetAt);
  }

  private pruneExpired(now: number) {
    this.nextExpiryAt = Infinity;
    // Each route class has one window duration. Its map is in expiry order.
    for (const clients of this.counters.values()) {
      for (const [key, counter] of clients) {
        if (counter.resetAt > now) {
          this.nextExpiryAt = Math.min(this.nextExpiryAt, counter.resetAt);
          break;
        }
        clients.delete(key);
        this.trackedKeys--;
      }
    }
  }
}
