import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { EDGE_CLIENT_HEADER, EDGE_KEY_HEADER, rateLimitKey, RateLimiter } from '../api/rateLimit';

const config = {
  ...loadConfig(), rateLimitEnabled: true, rateLimitWindowMs: 1500, rateLimitMax: 2,
  rateLimitBuckets: Object.fromEntries(['accounts', 'stream', 'snapshot', 'rpc', 'docs', 'default'].map(name => [name, { windowMs: 1500, max: 2 }])) as ReturnType<typeof loadConfig>['rateLimitBuckets']
};
const key = 'e'.repeat(32), socket = { remoteAddress: '127.0.0.1' };
const request = (client: string | string[], supplied: string | string[] | undefined = key) => ({ socket,
  headers: { [EDGE_CLIENT_HEADER]: client, [EDGE_KEY_HEADER]: supplied, 'x-forwarded-for': '203.0.113.250' } });
assert.deepEqual(rateLimitKey(request('203.0.113.1'), key), { key: '203.0.113.1', identity: 'edge' });
assert.deepEqual(rateLimitKey(request('2001:db8::1'), key), { key: '2001:db8::1', identity: 'edge' });
for (const req of [request('203.0.113.1', ''), request('203.0.113.1', 'f'.repeat(32)), request('203.0.113.1', 'x'),
  request('not-an-ip'), request('203.0.113.1,203.0.113.2'), request(['203.0.113.1']), request('203.0.113.1', [key]),
  { socket, headers: { 'x-forwarded-for': '203.0.113.3' } }]) assert.deepEqual(rateLimitKey(req, key), { key: socket.remoteAddress, identity: 'socket' });
assert.equal(rateLimitKey(request('203.0.113.1'), undefined).identity, 'socket');
assert.equal(rateLimitKey(request('203.0.113.1'), '').identity, 'socket');

const originalNow = Date.now; let now = 10_000; Date.now = () => now;
try {
  const limiter = new RateLimiter(config);
  const a = rateLimitKey(request('203.0.113.1'), key), b = rateLimitKey(request('203.0.113.2'), key);
  assert(limiter.check(a.key).allowed); assert(limiter.check(a.key).allowed); assert(!limiter.check(a.key).allowed); assert(limiter.check(b.key).allowed);
  assert.equal(limiter.check(a.key).retryAfterSeconds, 2); now += 501; assert.equal(limiter.check(a.key).retryAfterSeconds, 1);
  now += 999; assert(limiter.check(a.key).allowed);
  const forged = new RateLimiter(config);
  for (let i = 0; i < 3; i++) assert.equal(forged.check(rateLimitKey(request(`203.0.113.${i + 1}`, 'wrong'), key).key).allowed, i < 2);
  const bounded = new RateLimiter(config), counters = (bounded as unknown as { counters: Map<string, unknown> }).counters;
  for (let i = 0; i < 50_000; i++) bounded.check(`client-${i}`);
  assert.equal(counters.size, 50_000); bounded.check('overflow'); assert.equal(counters.size, 50_000); assert(!counters.has('default:client-0'));
  now += 1500; bounded.check('fresh'); assert.equal(counters.size, 1); assert(counters.has('default:fresh'));
  const disabled = new RateLimiter({ ...config, rateLimitEnabled: false });
  for (let i = 0; i < 5; i++) assert(disabled.check('same').allowed);
  assert.equal(disabled.check('same').retryAfterSeconds, 2);
} finally { Date.now = originalNow; }
console.log('rate limit identities, retry windows and bounded counters ok');
