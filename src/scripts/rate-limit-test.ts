import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { RateLimiter } from '../api/rateLimit';

const config = { ...loadConfig(), rateLimitEnabled: true, rateLimitWindowMs: 1000, rateLimitMax: 2 };
const limiter = new RateLimiter(config);

const key = '127.0.0.1';
const first = limiter.check(key);
assert.equal(first.allowed, true);
const second = limiter.check(key);
assert.equal(second.allowed, true);
const third = limiter.check(key);
assert.equal(third.allowed, false);

console.log('rate limit ok');
