import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { createServer } from '../src/server.js';
import { Providers } from '../src/providers.js';
import { address, config, database, proof } from './helpers.js';
let app: FastifyInstance; let db: Database; let cookie: string; let csrf: string;
const origin = 'https://app.example.test';
beforeAll(async () => { db = await database(); app = await createServer(config(), db, { logger: false }); });
afterAll(async () => { await app.close(); await db.close(); });
describe('credentialed API boundaries', () => {
  it('requires an allowed origin for challenges and rejects unsupported network', async () => {
    const request = { method: 'POST' as const, url: '/v1/auth/challenge', payload: { address, network: 'testnet' } };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect((await app.inject({ ...request, headers: { origin: 'https://evil.example.test' } })).statusCode).toBe(403);
    expect((await app.inject({ ...request, headers: { origin }, payload: { address, network: 'mainnet' } })).statusCode).toBe(400);
  });
  it('verifies proof, sets a secure host cookie, and rejects replay', async () => {
    const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', headers: { origin }, payload: { address, network: '-3' } })).json();
    const request = { method: 'POST' as const, url: '/v1/auth/verify', headers: { origin }, payload: { ...proof(challenge.payload), network: '-3' } };
    const response = await app.inject(request); expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toMatch(/^__Host-tonswap_session=.*; Path=\/; .*HttpOnly; Secure; SameSite=Lax/);
    cookie = String(response.headers['set-cookie']).split(';')[0]!; csrf = response.json().csrfToken;
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/auth/session', headers: { cookie } })).json()).toMatchObject({ walletAddress: address, network: 'testnet', csrfToken: csrf });
  });
  it('requires CSRF for preferences and cannot accept client activity events or tax records', async () => {
    const request = { method: 'PATCH' as const, url: '/v1/notifications/preferences', payload: { activity: true }, headers: { origin, cookie, 'x-wallet-address': address, 'x-wallet-network': 'testnet' } };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect((await app.inject({ ...request, headers: { ...request.headers, 'x-csrf-token': 'bad' } })).statusCode).toBe(403);
    const goodHeaders = { ...request.headers, 'x-csrf-token': csrf };
    expect((await app.inject({ ...request, headers: goodHeaders })).json().preferences.activity).toBe(true);
    expect((await app.inject({ ...request, headers: { ...goodHeaders, 'x-wallet-network': 'mainnet' } })).statusCode).toBe(409);
    expect((await app.inject({ ...request, headers: goodHeaders, payload: { taxRecords: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/events', headers: goodHeaders, payload: { kind: 'swap' } })).statusCode).toBe(404);
  });
  it('links a verified notification session event directly to notification settings', async () => {
    const headers = { origin, cookie, 'x-csrf-token': csrf, 'x-wallet-address': address, 'x-wallet-network': 'testnet' };
    expect((await app.inject({ method: 'PATCH', url: '/v1/notifications/preferences', headers, payload: { walletProtocol: true } })).statusCode).toBe(200);
    const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', headers: { origin }, payload: { address, network: 'testnet' } })).json();
    const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', headers: { origin }, payload: { ...proof(challenge.payload), network: 'testnet' } });
    expect(verified.statusCode).toBe(200);
    cookie = String(verified.headers['set-cookie']).split(';')[0]!; csrf = verified.json().csrfToken;
    const inbox = await app.inject({ url: '/v1/notifications/inbox', headers: { ...headers, cookie } });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().notifications).toEqual([expect.objectContaining({ href: '/settings/notifications',
      category: 'walletProtocol', evidence: { kind: 'wallet_proof_verified' } })]);
  });
  it('validates public date requests and rejects wallet fields on pricing routes', async () => {
    for (const date of ['2025-02-30', '2999-01-01']) expect((await app.inject({ url: `/v1/rates?symbols=JPY&date=${date}` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/prices?ids=bitcoin&wallet=${address}` })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/health' })).json()).toMatchObject({ status: 'ok', database: 'ready', prices: 'unavailable' });
  });
  it('does not use external native USD anchors for current denomination', async () => {
    const cfg = config({ networks: ['testnet', 'mainnet'], assetValuationPaths: [
      { kind: 'coingecko', network: 'testnet', assetId: 'native', coinGeckoId: 'test-observed-native' },
    ] });
    const providers = new Providers(db, cfg);
    vi.spyOn(providers, 'prices').mockResolvedValue({ currency: 'USD', requestedAt: new Date().toISOString(), issues: [],
      quotes: [{ assetId: 'test-observed-native', price: '2', source: 'coingecko', observedAt: new Date().toISOString(),
        observationDate: null, requestedDate: null, status: 'available', stale: false, precision: 'spot', change24h: null }] });
    const scoped = await createServer(cfg, db, { providers, logger: false });
    try {
      expect((await scoped.inject({ url: '/v1/rates?symbols=GRAM&network=testnet' })).json().quotes[0]).toMatchObject({ rate: null, status: 'unavailable' });
      for (const suffix of ['', '&network=mainnet', '&network=testnet&date=2026-01-01']) {
        expect((await scoped.inject({ url: `/v1/rates?symbols=GRAM${suffix}` })).json().quotes[0]).toMatchObject({ rate: null, status: 'unavailable' });
      }
    } finally { await scoped.close(); }
  });
  it('revokes session on logout without involving trading routes', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin, cookie, 'x-csrf-token': csrf, 'x-wallet-address': address, 'x-wallet-network': 'testnet' } })).json()).toEqual({ revoked: true });
    expect((await app.inject({ url: '/v1/auth/session', headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/push/config' })).json()).toEqual({ available: false, publicKey: null });
  });
});
