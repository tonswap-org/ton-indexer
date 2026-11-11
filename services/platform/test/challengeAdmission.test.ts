import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { apiConfig, createReleaseTestServer, injectRelease } from './releaseRequests.js';
import { address, database, proof, secondAddress, wallet } from './helpers.js';

let app: FastifyInstance, db: Database;
const origin = 'https://app.example.test', requesterA = '192.0.2.10', requesterB = '192.0.2.11';
beforeAll(async () => {
  db = await database();
  // The ordinary server creates its real Store; requests traverse release, origin
  // and requester rate-limit hooks before writing challenges to the database.
  app = await createReleaseTestServer(apiConfig(), db, { logger: false });
});
afterAll(async () => { await app.close(); await db.close(); });

describe('challenge admission belongs to the requester', () => {
  it('keeps release and origin admission before challenge issuance', async () => {
    const request = { method: 'POST' as const, url: '/v1/auth/challenge', remoteAddress: '192.0.2.12', payload: { address, network: 'testnet' } };
    expect((await app.inject({ ...request, headers: { origin } })).statusCode).toBe(409);
    expect((await injectRelease(app, request)).statusCode).toBe(403);
    expect((await injectRelease(app, { ...request, headers: { origin: 'https://untrusted.example.test' } })).statusCode).toBe(403);
    expect(Number((await db.query<{ count: string | number }>('SELECT count(*) FROM platform_challenges')).rows[0]?.count)).toBe(0);
  });
  it('allows B to prove the same wallet after A issues twenty challenges, while A remains throttled', async () => {
    const challenges = new Set<string>(); let first = '';
    for (let i = 0; i < 20; i++) {
      const result = await injectRelease(app, { method: 'POST', url: '/v1/auth/challenge', remoteAddress: requesterA,
        headers: { origin, 'x-forwarded-for': `198.51.100.${i + 1}` },
        payload: { address: i % 2 ? wallet.address.toString() : address, network: i % 2 ? '-3' : 'testnet' } });
      expect(result.statusCode).toBe(200);
      const challenge = result.json(); challenges.add(challenge.payload); first ||= challenge.payload;
      expect(challenge.domain).toBe('app.example.test');
      expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now());
      expect(Date.parse(challenge.expiresAt)).toBeLessThanOrEqual(Date.now() + 300_000);
    }
    expect(challenges.size).toBe(20);
    const issued = await injectRelease(app, { method: 'POST', url: '/v1/auth/challenge', remoteAddress: requesterB,
      headers: { origin }, payload: { address, network: 'testnet' } });
    expect(issued.statusCode).toBe(200);
    expect(challenges.has(issued.json().payload)).toBe(false);

    const blocked = await injectRelease(app, { method: 'POST', url: '/v1/auth/challenge', remoteAddress: requesterA,
      headers: { origin, 'x-forwarded-for': requesterB }, payload: { address: secondAddress, network: 'testnet' } });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number((await db.query<{ count: string | number }>('SELECT count(*) FROM platform_challenges')).rows[0]?.count)).toBe(21);

    const verify = (payload: string) => injectRelease(app, { method: 'POST', url: '/v1/auth/verify', remoteAddress: requesterB,
      headers: { origin }, payload: { ...proof(payload), network: 'testnet' } });
    const verified = await verify(issued.json().payload);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ walletAddress: address, network: 'testnet' });
    expect(verified.headers['set-cookie']).toMatch(/^__Host-tonswap_session=.*HttpOnly; Secure; SameSite=Lax/);
    expect((await verify(issued.json().payload)).statusCode).toBe(401);
    // Later issuance neither revokes a pending nonce nor binds proof to an IP.
    expect((await verify(first)).statusCode).toBe(200);
    expect((await verify(first)).statusCode).toBe(401);
  });
});
