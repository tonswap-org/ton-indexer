import { z } from 'zod';
import { createECDH } from 'node:crypto';
import { validateApplicationServerKey } from './push.js';
import type { Network } from './types.js';
import { valuationPathsSchema, type ValuationPath } from './valuations.js';
import { loadDexReleaseManifest, type DexReleaseBinding } from './dexPrices.js';

export interface Config {
  host: string; port: number; mode: 'api' | 'worker' | 'all'; databaseUrl: string;
  appOrigins: string[]; platformUrl: string; cookieSecure: boolean; cookieSameSite: 'lax' | 'none';
  encryptionKey: Buffer; networks: Network[]; sessionHours: number;
  indexerUrls: Partial<Record<Network, string>>; indexerApiKey?: string;
  dexRelease?: DexReleaseBinding;
  tonRpcUrls: Partial<Record<Network, string>>; tonRpcApiKey?: string;
  coingeckoKey?: string; coingeckoTier: 'demo' | 'pro';
  vapidPublicKey?: string; vapidPrivateKey?: string; vapidSubject?: string;
  governanceContracts: Partial<Record<Network, string>>;
  pollSeconds: number; priceSeconds: number; workerConcurrency: number;
  retentionDays: number; allowInsecureLocal: boolean;
  assetValuationPaths: ValuationPath[];
  trustLoopbackProxy: boolean;
  instanceId?: string;
}
function url(value: string, allowLocal: boolean): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hash) throw new Error('Service URLs cannot contain credentials or fragments.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowLocal && parsed.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS for public service URLs. HTTP is limited to explicit localhost development.');
  }
  return parsed.toString().replace(/\/$/, '');
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowInsecureLocal = env.ALLOW_INSECURE_LOCAL === '1';
  const appOrigins = (env.APP_ORIGIN ?? 'http://localhost:3000').split(',').map(s => {
    const parsed = new URL(url(s.trim(), allowInsecureLocal));
    if (parsed.pathname !== '/' || parsed.search) throw new Error('APP_ORIGIN must contain origins, not paths.');
    return parsed.origin;
  });
  const encryptionKey = Buffer.from(env.DATA_ENCRYPTION_KEY ?? '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  const networks = z.array(z.enum(['mainnet', 'testnet'])).min(1).parse((env.NETWORKS ?? 'testnet').split(','));
  const map = (key: string): Partial<Record<Network, string>> => Object.fromEntries(networks.flatMap(network => {
    const value = env[`${key}_${network.toUpperCase()}`];
    return value ? [[network, url(value, allowInsecureLocal)]] : [];
  }));
  const cookieSameSite = z.enum(['lax', 'none']).parse(env.COOKIE_SAME_SITE ?? 'lax');
  if (cookieSameSite === 'none' && allowInsecureLocal) throw new Error('SameSite=None requires secure HTTPS cookies.');
  if (allowInsecureLocal && [...appOrigins, env.PLATFORM_URL ?? 'http://localhost:8787'].some(value =>
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname))) {
    throw new Error('Insecure development cookies are limited to localhost app and platform URLs.');
  }
  const integer = (name: string, fallback: number, min: number, max: number) =>
    z.coerce.number().int().min(min).max(max).parse(env[name] ?? fallback);
  const config: Config = {
    host: env.HOST ?? '0.0.0.0', port: integer('PORT', 8787, 1, 65535),
    mode: z.enum(['api', 'worker', 'all']).parse(env.PLATFORM_MODE ?? 'all'),
    databaseUrl: z.string().min(1).parse(env.DATABASE_URL), appOrigins,
    platformUrl: url(env.PLATFORM_URL ?? 'http://localhost:8787', allowInsecureLocal),
    cookieSecure: !allowInsecureLocal, cookieSameSite, encryptionKey, networks,
    sessionHours: integer('SESSION_HOURS', 24 * 7, 1, 24 * 30),
    indexerUrls: map('INDEXER_URL'), indexerApiKey: env.INDEXER_API_KEY,
    tonRpcUrls: map('TON_RPC_URL'), tonRpcApiKey: env.TON_RPC_API_KEY,
    coingeckoKey: env.COINGECKO_API_KEY, coingeckoTier: z.enum(['demo', 'pro']).parse(env.COINGECKO_TIER ?? 'demo'),
    vapidPublicKey: env.VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT,
    governanceContracts: Object.fromEntries(networks.flatMap(network => {
      const value = env[`GOVERNANCE_CONTRACT_${network.toUpperCase()}`];
      return value ? [[network, value]] : [];
    })),
    pollSeconds: integer('POLL_SECONDS', 30, 10, 3600),
    priceSeconds: integer('PRICE_SECONDS', 120, 60, 3600),
    workerConcurrency: integer('WORKER_CONCURRENCY', 4, 1, 16),
    retentionDays: integer('RETENTION_DAYS', 90, 7, 730), allowInsecureLocal,
    assetValuationPaths: valuationPathsSchema.parse(JSON.parse(env.ASSET_VALUATION_PATHS_JSON ?? '[]')),
    trustLoopbackProxy: env.TRUST_LOOPBACK_PROXY === '1',
    instanceId: env.PLATFORM_INSTANCE_ID ? z.string().uuid().parse(env.PLATFORM_INSTANCE_ID) : undefined,
  };
  if (env.INDEXER_RELEASE_MANIFEST) {
    config.dexRelease = loadDexReleaseManifest(env.INDEXER_RELEASE_MANIFEST);
    if (!networks.includes(config.dexRelease.network) || config.indexerUrls[config.dexRelease.network] !== config.dexRelease.indexerUrl) {
      throw new Error('INDEXER_RELEASE_MANIFEST must match the configured network and INDEXER_URL release endpoint.');
    }
  }
  const pushKeys = [config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject].filter(Boolean);
  if (pushKeys.length && pushKeys.length !== 3) throw new Error('Configure all three VAPID values, or omit them all.');
  if (config.vapidPublicKey) validateApplicationServerKey(config.vapidPublicKey);
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    // A public-key shape check alone can advertise unusable push enrollment.
    // Verify the configured signing pair before API or worker startup, without
    // including either supplied key in diagnostics or contacting a provider.
    try {
      const privateKey = Buffer.from(config.vapidPrivateKey, 'base64url');
      if (!/^[A-Za-z0-9_-]{43}$/.test(config.vapidPrivateKey) || privateKey.length !== 32 ||
        privateKey.toString('base64url') !== config.vapidPrivateKey) throw new Error();
      const pair = createECDH('prime256v1');
      pair.setPrivateKey(privateKey);
      if (pair.getPublicKey().toString('base64url') !== config.vapidPublicKey) throw new Error();
    } catch {
      throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must form one valid canonical P-256 signing key pair.');
    }
  }
  if (config.vapidSubject && !/^(mailto:|https:\/\/)/.test(config.vapidSubject)) throw new Error('Invalid VAPID_SUBJECT.');
  return config;
}
