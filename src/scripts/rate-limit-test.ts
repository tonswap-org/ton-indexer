import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { RateLimiter } from '../api/rateLimit';

const config = {
  ...loadConfig(),
  rateLimitEnabled: true,
  rateLimitWindowMs: 1000,
  rateLimitMax: 2,
  rateLimitMaxKeys: 2,
  rateLimitGlobalWindowMs: 1000,
  rateLimitGlobalMax: 100,
  rateLimitBuckets: {
    accounts: { windowMs: 1000, max: 2 },
    stream: { windowMs: 1000, max: 2 },
    snapshot: { windowMs: 1000, max: 2 },
    rpc: { windowMs: 1000, max: 2 },
    docs: { windowMs: 1000, max: 2 },
    default: { windowMs: 1000, max: 2 }
  }
};
const limiter = new RateLimiter(config);

const key = '127.0.0.1';
const first = limiter.check(key);
assert.equal(first.allowed, true);
const second = limiter.check(key);
assert.equal(second.allowed, true);
const third = limiter.check(key);
assert.equal(third.allowed, false);

const bounded = new RateLimiter(config);
assert.equal(bounded.check('client-a', 'default', 1).allowed, true);
assert.equal(bounded.check('client-b', 'default', 1).allowed, true);
const capacity = bounded.check('client-c', 'default', 1);
assert.equal(capacity.allowed, false);
assert.equal(capacity.scope, 'capacity');
assert.equal(bounded.getTrackedKeyCount(), 2);
assert.equal(bounded.check('client-a', 'default', 2).allowed, true);
assert.equal(bounded.getTrackedKeyCount(), 2);

const global = new RateLimiter({
  ...config,
  rateLimitMaxKeys: 10,
  rateLimitMax: 100,
  rateLimitGlobalMax: 2
});
assert.equal(global.check('client-a', 'default', 1).allowed, true);
assert.equal(global.check('client-b', 'default', 1).allowed, true);
const globallyLimited = global.check('client-c', 'default', 1);
assert.equal(globallyLimited.allowed, false);
assert.equal(globallyLimited.scope, 'global');
assert.equal(global.getTrackedKeyCount(), 2);

const expiry = new RateLimiter({ ...config, rateLimitMaxKeys: 1 });
assert.equal(expiry.check('client-a', 'default', 1).allowed, true);
assert.equal(expiry.check('client-b', 'default', 2).scope, 'capacity');
assert.equal(expiry.check('client-b', 'default', 6_001).allowed, true);
assert.equal(expiry.getTrackedKeyCount(), 1);

console.log('rate limit ok');
