import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { createServer } from '../src/server.js';
import { config, database } from './helpers.js';
let app: FastifyInstance; let db: Database;
beforeAll(async () => { db = await database(); app = await createServer(config({ trustLoopbackProxy: true }), db, { logger: false });
  app.get('/test-peer', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async request => ({ ip: request.ip })); });
afterAll(async () => { await app.close(); await db.close(); });
describe('explicit loopback proxy trust', () => {
  it('uses the nearest untrusted client address and ignores a forged earlier chain entry', async () => {
    const result = await app.inject({ url: '/test-peer', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.10' } });
    expect(result.json().ip).toBe('203.0.113.10');
  });
  it('cannot spoof client identity from a directly connected non-proxy address', async () => {
    const response = await app.inject({ url: '/test-peer', remoteAddress: '203.0.113.20', headers: { 'x-forwarded-for': '1.1.1.1' } });
    expect(response.json().ip).toBe('203.0.113.20');
  });
  it('keeps proxied client rate limits separate and cannot evade a limit with earlier spoofed addresses', async () => {
    const request = { url: '/test-peer', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.30' } };
    expect((await app.inject(request)).statusCode).toBe(200); expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject({ ...request, headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.30' } })).statusCode).toBe(429);
    expect((await app.inject({ ...request, headers: { 'x-forwarded-for': '203.0.113.31' } })).statusCode).toBe(200);
  });
});
