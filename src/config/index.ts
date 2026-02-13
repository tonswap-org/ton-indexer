import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Network = 'mainnet' | 'testnet';

export type Config = {
  port: number;
  host: string;
  network: Network;
  dataSource: 'http' | 'lite';
  corsEnabled: boolean;
  corsAllowOrigin: string;
  corsAllowMethods: string;
  corsAllowHeaders: string;
  corsExposeHeaders: string;
  corsMaxAge: number;
  snapshotPath?: string;
  snapshotOnExit: boolean;
  adminToken?: string;
  adminEnabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  responseCacheEnabled: boolean;
  balanceCacheTtlMs: number;
  txCacheTtlMs: number;
  stateCacheTtlMs: number;
  healthCacheTtlMs: number;
  metricsCacheTtlMs: number;
  pageSize: number;
  maxPagesPerAddress: number;
  maxAddresses: number;
  idleTtlMs: number;
  globalMaxPages: number;
  backfillPageBatch: number;
  backfillMaxPagesPerAddress: number;
  backfillConcurrency: number;
  jettonMetadataTtlMs: number;
  watchlistRefreshMs: number;
  blockPollMs: number;
  httpEndpoint?: string;
  liteserverPool?: string;
  logLevel: string;
  registryPath: string;
  opcodesPath?: string;
};

const numberFromEnv = (key: string, fallback: number) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stringFromEnv = (key: string, fallback?: string) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
};

const booleanFromEnv = (key: string, fallback: boolean) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return fallback;
};

const networkFromEnv = (): Network => {
  // Default to testnet for current TONSWAP deployments; mainnet requires real registry addresses.
  const raw = (process.env.TON_NETWORK || 'testnet').toLowerCase();
  if (raw === 'mainnet' || raw === 'testnet') return raw;
  return 'testnet';
};

const dataSourceFromEnv = (): 'http' | 'lite' => {
  const raw = (process.env.TON_DATASOURCE || '').toLowerCase();
  if (raw === 'lite') return 'lite';
  return 'http';
};

export const loadConfig = (): Config => {
  const network = networkFromEnv();
  const registryPath = resolve(process.cwd(), 'registry', `${network}.json`);
  const opcodesPath = stringFromEnv(
    'OPCODES_PATH',
    resolve(process.cwd(), '..', 'tonswap_tolk', 'config', 'opcodes.json')
  );

  return {
    port: numberFromEnv('PORT', 8787),
    host: stringFromEnv('HOST', '0.0.0.0')!,
    network,
    dataSource: dataSourceFromEnv(),
    corsEnabled: booleanFromEnv('CORS_ENABLED', true),
    corsAllowOrigin: stringFromEnv('CORS_ALLOW_ORIGIN', '*')!,
    corsAllowMethods: stringFromEnv('CORS_ALLOW_METHODS', 'GET,HEAD,POST,OPTIONS')!,
    corsAllowHeaders: stringFromEnv('CORS_ALLOW_HEADERS', 'authorization,content-type,accept')!,
    corsExposeHeaders: stringFromEnv(
      'CORS_EXPOSE_HEADERS',
      'x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset'
    )!,
    corsMaxAge: numberFromEnv('CORS_MAX_AGE', 600),
    snapshotPath: stringFromEnv('SNAPSHOT_PATH'),
    snapshotOnExit: booleanFromEnv('SNAPSHOT_ON_EXIT', false),
    adminToken: stringFromEnv('ADMIN_TOKEN'),
    adminEnabled: booleanFromEnv('ADMIN_ENABLED', false),
    rateLimitEnabled: booleanFromEnv('RATE_LIMIT_ENABLED', true),
    rateLimitWindowMs: numberFromEnv('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMax: numberFromEnv('RATE_LIMIT_MAX', 10_000),
    responseCacheEnabled: booleanFromEnv('RESPONSE_CACHE_ENABLED', true),
    balanceCacheTtlMs: numberFromEnv('BALANCE_CACHE_TTL_MS', 2_000),
    txCacheTtlMs: numberFromEnv('TX_CACHE_TTL_MS', 1_000),
    stateCacheTtlMs: numberFromEnv('STATE_CACHE_TTL_MS', 1_000),
    healthCacheTtlMs: numberFromEnv('HEALTH_CACHE_TTL_MS', 1_000),
    metricsCacheTtlMs: numberFromEnv('METRICS_CACHE_TTL_MS', 1_000),
    pageSize: numberFromEnv('PAGE_SIZE', 10),
    maxPagesPerAddress: numberFromEnv('MAX_PAGES_PER_ADDRESS', 150),
    maxAddresses: numberFromEnv('MAX_ADDRESSES', 5_000),
    idleTtlMs: numberFromEnv('IDLE_TTL_MS', 2 * 60 * 60 * 1000),
    globalMaxPages: numberFromEnv('GLOBAL_MAX_PAGES', 200_000),
    backfillPageBatch: numberFromEnv('BACKFILL_PAGE_BATCH', 5),
    backfillMaxPagesPerAddress: numberFromEnv('BACKFILL_MAX_PAGES_PER_ADDRESS', 150),
    backfillConcurrency: numberFromEnv('BACKFILL_CONCURRENCY', 2),
    jettonMetadataTtlMs: numberFromEnv('JETTON_METADATA_TTL_MS', 24 * 60 * 60 * 1000),
    watchlistRefreshMs: numberFromEnv('WATCHLIST_REFRESH_MS', 5_000),
    blockPollMs: numberFromEnv('BLOCK_POLL_MS', 5_000),
    httpEndpoint: stringFromEnv('TON_HTTP_ENDPOINT'),
    liteserverPool: stringFromEnv(
      network === 'mainnet' ? 'LITESERVER_POOL_MAINNET' : 'LITESERVER_POOL_TESTNET'
    ),
    logLevel: stringFromEnv('LOG_LEVEL', 'info')!,
    registryPath,
    opcodesPath,
  };
};

export const readRegistryFile = (path: string) => {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch (error) {
    throw new Error(`Failed to read registry at ${path}: ${(error as Error).message}`);
  }
};
