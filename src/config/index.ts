import { readDatabaseUrl } from './database';
import { readSecretText } from './secrets';
import { dirname, resolve } from 'node:path';

export type Network = 'mainnet' | 'testnet' | 'localnet';
export type IndexerMode = 'dev' | 'production';
export type RateLimitBucketName = 'accounts' | 'stream' | 'snapshot' | 'rpc' | 'docs' | 'default';
export type RateLimitBucketConfig = { windowMs: number; max: number };
export type RateLimitBuckets = Record<RateLimitBucketName, RateLimitBucketConfig>;

export type Config = {
  port: number;
  host: string;
  mode: IndexerMode;
  network: Network;
  corsEnabled: boolean;
  corsAllowOrigin: string;
  corsAllowOrigins: string[];
  corsAllowMethods: string;
  corsAllowHeaders: string;
  corsExposeHeaders: string;
  corsMaxAge: number;
  snapshotPath?: string;
  databaseUrl?: string;
  ledgerMaxWatchedAccounts: number;
  ledgerMaxPagesPerSync: number;
  ledgerMaxRelatedAccounts: number;
  snapshotOnExit: boolean;
  snapshotAutosaveEnabled: boolean;
  snapshotAutosaveIntervalMs: number;
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitMaxKeys: number;
  rateLimitGlobalWindowMs: number;
  rateLimitGlobalMax: number;
  rateLimitBuckets: RateLimitBuckets;
  responseCacheEnabled: boolean;
  initialHistoryTimeoutMs: number;
  txCacheTtlMs: number;
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
  watchlistRefreshMs: number;
  blockPollMs: number;
  enableWriteRpc: boolean;
  liteserverPool?: string;
  logLevel: string;
  adminToken?: string;
  releaseManifestSource?: string;
  edgeKey?: string;
  ledgerWorkers: number;
  diskGuardPath: string;
  diskSoftFloorBytes: number;
  diskHardFloorBytes: number;
};

const integerFromEnv = (key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a canonical integer between ${min} and ${max}`);
  }
  return value;
};

const stringFromEnv = (key: string, fallback?: string) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
};

const listFromEnv = (keys: string[]): string[] => {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const raw = process.env[key];
    if (!raw) continue;
    const chunks = raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const chunk of chunks) {
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      values.push(chunk);
    }
  }
  return values;
};

const booleanFromEnv = (key: string, fallback: boolean) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  throw new Error(`${key} must be one of true, false, 1, 0, yes, or no.`);
};

const enumFromEnv = <T extends string>(key: string, fallback: T, allowed: readonly T[]): T => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T;
  throw new Error(`${key} must be one of ${allowed.join(', ')}, got ${raw}`);
};

const modeFromEnv = (): IndexerMode => {
  return enumFromEnv<IndexerMode>('INDEXER_MODE', 'dev', ['dev', 'production']);
};

const networkFromEnv = (): Network => {
  // The manifest must independently match this network at startup.
  return enumFromEnv<Network>('TON_NETWORK', 'testnet', ['mainnet', 'testnet', 'localnet']);
};

const rateLimitBucketsFromEnv = (defaultBuckets: RateLimitBuckets): RateLimitBuckets => {
  const raw = process.env.RATE_LIMIT_BUCKETS_JSON;
  if (raw === undefined) return defaultBuckets;
  if (!raw.trim()) {
    throw new Error('RATE_LIMIT_BUCKETS_JSON must be a non-empty JSON object.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('RATE_LIMIT_BUCKETS_JSON must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RATE_LIMIT_BUCKETS_JSON must be an object.');
  }

  const merged = { ...defaultBuckets };
  for (const [name, candidate] of Object.entries(parsed)) {
    if (!Object.hasOwn(defaultBuckets, name)) {
      throw new Error(`RATE_LIMIT_BUCKETS_JSON contains unsupported bucket ${JSON.stringify(name)}.`);
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`RATE_LIMIT_BUCKETS_JSON.${name} must be an object.`);
    }
    const key = name as RateLimitBucketName;
    const next = { ...defaultBuckets[key] };
    for (const [field, value] of Object.entries(candidate)) {
      if (field !== 'windowMs' && field !== 'max') {
        throw new Error(`RATE_LIMIT_BUCKETS_JSON.${name} contains unsupported field ${JSON.stringify(field)}.`);
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`RATE_LIMIT_BUCKETS_JSON.${name}.${field} must be a positive integer.`);
      }
      next[field] = value;
    }
    merged[key] = next;
  }
  return merged;
};

export const loadConfig = (): Config => {
  const mode = modeFromEnv();
  const network = networkFromEnv();
  const edgeKey = readSecretText(process.env, 'INDEXER_EDGE_KEY');
  if (edgeKey !== undefined && edgeKey.length < 32) throw new Error('INDEXER_EDGE_KEY must have at least 32 characters');
  const adminToken = readSecretText(process.env, 'INDEXER_ADMIN_TOKEN');
  if (adminToken !== undefined && (adminToken.length < 32 || adminToken.length > 256)) {
    throw new Error('INDEXER_ADMIN_TOKEN must contain 32–256 characters.');
  }
  const diskSoftFloorBytes = integerFromEnv('INDEXER_DISK_SOFT_FLOOR_BYTES', 2 * 1024 ** 3, 0);
  const diskHardFloorBytes = integerFromEnv('INDEXER_DISK_HARD_FLOOR_BYTES', 512 * 1024 ** 2, 0);
  if (diskHardFloorBytes > diskSoftFloorBytes) throw new Error('INDEXER_DISK_HARD_FLOOR_BYTES must not exceed INDEXER_DISK_SOFT_FLOOR_BYTES');

  const defaultRateLimitWindowMs = 60_000;
  const defaultRateLimitMax = mode === 'production' ? 2_000 : 10_000;
  const rateLimitWindowMs = integerFromEnv('RATE_LIMIT_WINDOW_MS', defaultRateLimitWindowMs, 1);
  const rateLimitMax = integerFromEnv('RATE_LIMIT_MAX', defaultRateLimitMax, 1);
  const defaultBuckets: RateLimitBuckets = {
    accounts: { windowMs: rateLimitWindowMs, max: rateLimitMax },
    stream: { windowMs: 10_000, max: mode === 'production' ? 200 : 1_000 },
    snapshot: { windowMs: 60_000, max: mode === 'production' ? 120 : 1_000 },
    rpc: { windowMs: 10_000, max: mode === 'production' ? 240 : 1_500 },
    docs: { windowMs: 60_000, max: mode === 'production' ? 600 : 2_000 },
    default: { windowMs: rateLimitWindowMs, max: rateLimitMax }
  };
  const rateLimitEnabled = booleanFromEnv('RATE_LIMIT_ENABLED', true);
  if (mode === 'production' && !rateLimitEnabled) {
    throw new Error('RATE_LIMIT_ENABLED must be true when INDEXER_MODE=production.');
  }
  const port = integerFromEnv('PORT', 8787, 0, 65_535);
  if (mode === 'production' && port === 0) throw new Error('PORT must be a fixed non-zero port in production.');

  return {
    port,
    host: stringFromEnv('HOST', '127.0.0.1')!,
    mode,
    network,
    corsEnabled: booleanFromEnv('CORS_ENABLED', true),
    corsAllowOrigin: stringFromEnv('CORS_ALLOW_ORIGIN', '*')!,
    corsAllowOrigins: listFromEnv(['CORS_ALLOW_ORIGINS']),
    corsAllowMethods: stringFromEnv('CORS_ALLOW_METHODS', 'GET,HEAD,POST,OPTIONS')!,
    corsAllowHeaders: stringFromEnv('CORS_ALLOW_HEADERS', 'content-type,accept')!,
    corsExposeHeaders: stringFromEnv(
      'CORS_EXPOSE_HEADERS',
      'x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,retry-after'
    )!,
    corsMaxAge: integerFromEnv('CORS_MAX_AGE', 600, 0),
    snapshotPath: stringFromEnv('SNAPSHOT_PATH'),
    databaseUrl: readDatabaseUrl(),
    ledgerMaxWatchedAccounts: integerFromEnv('INDEXER_MAX_WATCHED_ACCOUNTS', 1000, 1, 100000),
    ledgerMaxPagesPerSync: integerFromEnv('INDEXER_MAX_PAGES_PER_SYNC', 20, 1, 100),
    ledgerMaxRelatedAccounts: integerFromEnv('INDEXER_MAX_RELATED_ACCOUNTS', 256, 1, 1024),
    snapshotOnExit: booleanFromEnv('SNAPSHOT_ON_EXIT', false),
    snapshotAutosaveEnabled: booleanFromEnv(
      'SNAPSHOT_AUTOSAVE_ENABLED',
      mode === 'production' && Boolean(stringFromEnv('SNAPSHOT_PATH'))
    ),
    snapshotAutosaveIntervalMs: integerFromEnv('SNAPSHOT_AUTOSAVE_INTERVAL_MS', 30_000, 1),
    rateLimitEnabled,
    rateLimitWindowMs,
    rateLimitMax,
    rateLimitMaxKeys: integerFromEnv('RATE_LIMIT_MAX_KEYS', mode === 'production' ? 20_000 : 50_000, 1, 1_000_000),
    rateLimitGlobalWindowMs: integerFromEnv('RATE_LIMIT_GLOBAL_WINDOW_MS', rateLimitWindowMs, 1),
    rateLimitGlobalMax: integerFromEnv('RATE_LIMIT_GLOBAL_MAX', mode === 'production' ? 50_000 : 250_000, 1),
    rateLimitBuckets: rateLimitBucketsFromEnv(defaultBuckets),
    responseCacheEnabled: booleanFromEnv('RESPONSE_CACHE_ENABLED', true),
    initialHistoryTimeoutMs: integerFromEnv('INITIAL_HISTORY_TIMEOUT_MS', 10_000, 1, 120_000),
    txCacheTtlMs: integerFromEnv('TX_CACHE_TTL_MS', 1_000, 0),
    healthCacheTtlMs: integerFromEnv('HEALTH_CACHE_TTL_MS', 1_000, 0, 5_000),
    metricsCacheTtlMs: integerFromEnv('METRICS_CACHE_TTL_MS', 1_000, 0),
    pageSize: integerFromEnv('PAGE_SIZE', 10, 1),
    maxPagesPerAddress: integerFromEnv('MAX_PAGES_PER_ADDRESS', 150, 1),
    maxAddresses: integerFromEnv('MAX_ADDRESSES', 5_000, 1),
    idleTtlMs: integerFromEnv('IDLE_TTL_MS', 2 * 60 * 60 * 1000, 1),
    globalMaxPages: integerFromEnv('GLOBAL_MAX_PAGES', 200_000, 1),
    backfillPageBatch: integerFromEnv('BACKFILL_PAGE_BATCH', 5, 1),
    backfillMaxPagesPerAddress: integerFromEnv('BACKFILL_MAX_PAGES_PER_ADDRESS', 150, 1),
    backfillConcurrency: integerFromEnv('BACKFILL_CONCURRENCY', 2, 1),
    watchlistRefreshMs: integerFromEnv('WATCHLIST_REFRESH_MS', 5_000, 1),
    blockPollMs: integerFromEnv('BLOCK_POLL_MS', 5_000, 1),
    enableWriteRpc: booleanFromEnv('INDEXER_ENABLE_WRITE_RPC', false),
    liteserverPool: stringFromEnv(
      network === 'mainnet'
        ? 'LITESERVER_POOL_MAINNET'
        : network === 'testnet'
          ? 'LITESERVER_POOL_TESTNET'
          : 'LITESERVER_POOL_LOCALNET'
    ),
    logLevel: stringFromEnv('LOG_LEVEL', 'info')!,
    adminToken,
    releaseManifestSource: stringFromEnv('INDEXER_RELEASE_MANIFEST'),
    edgeKey,
    ledgerWorkers: integerFromEnv('INDEXER_LEDGER_WORKERS', 3, 2, 8),
    diskGuardPath: stringFromEnv('INDEXER_DISK_GUARD_PATH', dirname(resolve(stringFromEnv('SNAPSHOT_PATH', './snapshot.json')!)))!,
    diskSoftFloorBytes,
    diskHardFloorBytes,
  };
};
