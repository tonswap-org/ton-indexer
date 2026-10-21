import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import type { Config } from '../src/config.js';
import { createServer, type ServerDependencies } from '../src/server.js';
import type { Database } from '../src/db.js';
import { parseDexReleaseManifest } from '../src/dexPrices.js';
import { runtimeManifestFixture } from '../../../src/scripts/fixtures/runtimeManifest.js';
import { config } from './helpers.js';

/** Synthetic current schema authority; no deployed or public-consensus evidence. */
export function apiConfig(overrides: Partial<Config> = {}): Config {
  return config({ dexRelease: parseDexReleaseManifest(runtimeManifestFixture()), indexerUrls: {}, ...overrides });
}
const releases = new WeakMap<FastifyInstance, string | undefined>();
export async function createReleaseTestServer(config: Config, db: Database, dependencies: ServerDependencies = {}) {
  const app = await createServer(config, db, dependencies);
  releases.set(app, config.dexRelease?.manifestHash);
  return app;
}
/** Ordinary API assertions send a current-client request through the real hooks.
 * Fence-negative tests use raw createServer/inject and never call this helper. */
export function injectRelease(app: FastifyInstance, options: InjectOptions | string) {
  if (!releases.has(app)) throw new Error('Explicit current-client server fixture required.');
  const hash = releases.get(app), request = typeof options === 'string' ? { url: options } : options;
  return app.inject({ ...request, headers: { ...(hash ? { 'x-tonswap-release': hash } : {}), ...request.headers } });
}
