import type { FastifyInstance } from 'fastify';
import { Address } from '@ton/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
import type { Database } from '../src/db.js';
import type { Providers } from '../src/providers.js';
import type { PushSender } from '../src/push.js';
import type { Store } from '../src/store.js';
import { ASSET, T3, dexConfig } from './dexFixtures.js';

const config = dexConfig({
  port: 0, mode: 'api', databaseUrl: 'unused',
  appOrigins: [], platformUrl: 'https://catalogue.invalid', cookieSecure: false, cookieSameSite: 'lax',
});
const denomination = { currency: 'T3', quoteAssetId: T3, releaseManifestHash: config.dexRelease!.manifestHash };
const usdt = {
  asset: { kind: 'ton', network: 'testnet', assetId: ASSET },
  name: 'USDT', symbol: 'USDT', ...denomination, capabilities: { target: true, percent: false },
};
const t3 = {
  asset: { kind: 'ton', network: 'testnet', assetId: T3 },
  name: 'T3', symbol: 'T3', ...denomination, capabilities: { target: false, percent: false },
};
const forbidden = async () => { throw new Error('Public catalogue search must not use the database or network.'); };
const query = vi.fn(forbidden), transaction = vi.fn(forbidden), fetcher = vi.fn(forbidden);
const session = vi.fn(forbidden);
const db: Database = { query, transaction, close: async () => {} };
const searchAssets = vi.fn(forbidden);
let app: FastifyInstance | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetcher);
  // Real route, Fastify query parsing, error handler and catalogue; no listener,
  // credentials, database connection, signing or external provider request.
  app = await createServer(config, db, {
    providers: { searchAssets } as unknown as Providers,
    store: { session } as unknown as Store,
    push: { available: false } as PushSender,
    fetcher, logger: false,
  });
  await app.ready();
});
afterEach(async () => {
  try {
    await app?.close();
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(searchAssets).not.toHaveBeenCalled();
  } finally { app = undefined; vi.unstubAllGlobals(); }
});

describe('public release-bound DEX catalogue route', () => {
  it('returns the exact unauthenticated release token and T3 denomination through the real server', async () => {
    const response = await app!.inject({ method: 'GET', url: '/v1/assets/search?network=testnet&q=USDT' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [usdt], issues: [] });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it.each(['usdt', 'uSdT', '  USDT  ', 'usd', ASSET, Address.parse(ASSET).toString({ testOnly: true })])('finds canonical release metadata for %j', async value => {
    const response = await app!.inject({ method: 'GET', url: `/v1/assets/search?network=testnet&q=${encodeURIComponent(value)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [usdt], issues: [] });
  });

  it('defaults an omitted query to the public catalogue', async () => {
    const response = await app!.inject({ method: 'GET', url: '/v1/assets/search?network=testnet' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [t3, usdt], issues: [] });
  });

  it('rejects unknown query keys before reading the catalogue', async () => {
    const response = await app!.inject({ method: 'GET', url: '/v1/assets/search?network=testnet&q=USDT&unexpected=true' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'invalid_request', fields: [''] });
    expect(searchAssets).not.toHaveBeenCalled();
  });

  it('rejects a valid but disabled network before reading the catalogue', async () => {
    const response = await app!.inject({ method: 'GET', url: '/v1/assets/search?network=mainnet&q=USDT' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_network');
    expect(searchAssets).not.toHaveBeenCalled();
  });

  it.each(['GRAM', 'TON', 'native', 'bitcoin'])('does not invent %j when absent from the release', async value => {
    const response = await app!.inject({ method: 'GET', url: `/v1/assets/search?network=testnet&q=${value}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [], issues: [] });
  });
});
