import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import type { Store } from '../src/store.js';
import type { Providers } from '../src/providers.js';
import { createServer } from '../src/server.js';
import { apiConfig } from './releaseRequests.js';
import { address } from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture(config = apiConfig()) {
  const query = vi.fn(async () => ({ rows: [{ count: '0' }] }));
  const transaction = vi.fn(async () => { throw Error('Unexpected persistence'); });
  const db = { query, transaction, close: async () => {} } as unknown as Database;
  const session = vi.fn(async () => null), createChallenge = vi.fn(async () => ({ payload: 'current-only' }));
  const currencies = vi.fn(async () => ({ currencies: ['USD'] }));
  const fetcher = vi.fn(async () => { throw Error('Unexpected provider fetch'); });
  const app = await createServer(config, db, { logger: false, fetcher,
    store: { session, createChallenge } as unknown as Store, providers: { currencies } as unknown as Providers });
  apps.push(app);
  return { app, config, query, transaction, session, createChallenge, currencies, fetcher };
}
const routes = [
  '/v1/capabilities', '/v1/currencies', '/v1/assets/search?network=testnet',
  '/v1/asset-valuations?network=testnet&assets=native', '/v1/dex-prices?network=testnet&assets=native',
  '/v1/rates?symbols=JPY', '/v1/prices?ids=bitcoin', '/v1/historical-anchor?network=mainnet&asset=native',
  '/v1/historical-anchor/revisions/invalid', '/v1/rates/revisions/invalid', '/v1/prices/revisions/invalid',
  '/v1/ptax?currency=USD&date=2025-01-01', '/v1/ptax/revisions/invalid',
  '/v1/receita-work-rates?month=2025-06', '/v1/receita-work-rates/revisions/invalid',
  '/v1/auth/session', '/v1/notifications/preferences', '/v1/notifications/inbox',
  '/v1/notifications/price-rules', '/v1/push/config', '/v1/push/subscriptions',
];

describe('mandatory current platform request identity', () => {
  it.each([undefined, '', 'old', '0'.repeat(64)])('refuses every data/read route for header %j before any work', async header => {
    const f = await fixture();
    for (const url of routes) {
      const response = await f.app.inject({ url, headers: header === undefined ? {} : { 'x-tonswap-release': header } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'release_mismatch' } });
      expect(response.headers['x-tonswap-release']).toBe(f.config.dexRelease!.manifestHash);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const call of [f.query, f.transaction, f.session, f.createChallenge, f.currencies, f.fetcher]) expect(call).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('refuses %s before body parsing, session lookup or mutation', async method => {
    const f = await fixture();
    const response = await f.app.inject({ method, url: '/v1/auth/challenge', payload: '{',
      headers: { origin: f.config.appOrigins[0], 'content-type': 'application/json' } });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('release_mismatch');
    for (const call of [f.query, f.transaction, f.session, f.createChallenge, f.fetcher]) expect(call).not.toHaveBeenCalled();
  });
  it('admits the exact release through existing parser, origin and authentication checks', async () => {
    const f = await fixture(), headers = { 'x-tonswap-release': f.config.dexRelease!.manifestHash };
    expect((await f.app.inject({ url: '/v1/currencies', headers })).json()).toEqual({ currencies: ['USD'] });
    expect(f.currencies).toHaveBeenCalledOnce();
    const session = await f.app.inject({ url: '/v1/auth/session', headers });
    expect(session.statusCode).toBe(401); expect(session.json().error.code).toBe('authentication_required');
    expect(session.headers['x-tonswap-release']).toBe(headers['x-tonswap-release']);
    const malformed = await f.app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: '{',
      headers: { ...headers, origin: f.config.appOrigins[0], 'content-type': 'application/json' } });
    expect(malformed.statusCode).toBe(400);
    const challenge = await f.app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { address, network: 'testnet' },
      headers: { ...headers, origin: f.config.appOrigins[0] } });
    expect(challenge.statusCode).toBe(200); expect(f.createChallenge).toHaveBeenCalledOnce();
  });
  it('rejects duplicate and noncanonical values and retains the startup hash', async () => {
    const f = await fixture(), original = f.config.dexRelease!.manifestHash;
    for (const value of [`${original}, ${original}`, original.toUpperCase(), `${original}extra`]) {
      expect((await f.app.inject({ url: '/v1/currencies', headers: { 'x-tonswap-release': value } })).statusCode).toBe(409);
    }
    f.config.dexRelease = { ...f.config.dexRelease!, manifestHash: '0'.repeat(64) };
    const response = await f.app.inject({ url: '/v1/currencies', headers: { 'x-tonswap-release': original } });
    expect(response.statusCode).toBe(200); expect(response.headers['x-tonswap-release']).toBe(original);
    expect((await f.app.inject({ url: '/v1/currencies', headers: { 'x-tonswap-release': '0'.repeat(64) } })).statusCode).toBe(409);
  });
  it.each([undefined, 'bad'])('keeps API unavailable with absent/invalid configured identity %j', async hash => {
    const config = apiConfig(); config.dexRelease = hash === undefined ? undefined : { ...config.dexRelease!, manifestHash: hash };
    const f = await fixture(config);
    for (const url of ['/v1/capabilities', '/v1/auth/session', '/v1/currencies']) {
      const response = await f.app.inject({ url, headers: { 'x-tonswap-release': '0'.repeat(64) } });
      expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('release_unavailable');
      expect(response.headers['x-tonswap-release']).toBeUndefined();
    }
    expect(f.currencies).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
    expect((await f.app.inject('/v1/health')).statusCode).toBe(200);
  });
  it('allows only canonical GET/HEAD health probes independently of request identity', async () => {
    const f = await fixture();
    for (const method of ['GET', 'HEAD'] as const) {
      expect((await f.app.inject({ method, url: '/v1/health' })).statusCode).toBe(200);
      expect((await f.app.inject({ method, url: '/v1/health?probe=ready' })).statusCode).toBe(200);
    }
    for (const url of ['/v1/health/', '/v1/%68ealth', '/v1/health/../capabilities', '/v1/healthiness'])
      expect((await f.app.inject({ url })).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'POST', url: '/v1/health' })).statusCode).toBe(409);
  });
  it('permits real allowed-origin preflight and exposes release identity without exempting arbitrary OPTIONS', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'OPTIONS', url: '/v1/auth/challenge', headers: {
      origin: f.config.appOrigins[0], 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-tonswap-release,x-wallet-address',
    } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toMatch(/x-tonswap-release/i);
    expect(response.headers['access-control-expose-headers']).toMatch(/x-tonswap-release/i);
    expect(response.headers['access-control-allow-origin']).toBe(f.config.appOrigins[0]);
    expect((await f.app.inject({ method: 'OPTIONS', url: '/v1/currencies' })).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'OPTIONS', url: '/v1/currencies', headers: { origin: f.config.appOrigins[0] } })).statusCode).toBe(400);
    const old = await f.app.inject({ url: '/v1/currencies', headers: { origin: f.config.appOrigins[0] } });
    expect(old.statusCode).toBe(409); expect(old.headers['access-control-expose-headers']).toMatch(/x-tonswap-release/i);
    expect(f.currencies).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
});
