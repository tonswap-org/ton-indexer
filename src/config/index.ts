import {parseAdmissionArtifacts, type AdmissionArtifactConfig} from './admission';
import { readDatabaseUrl } from './database';
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
  perpsAdmissionArtifacts?: AdmissionArtifactConfig;
  ledgerMaxWatchedAccounts: number;
  ledgerMaxPagesPerSync: number;
  ledgerMaxRelatedAccounts: number;
  snapshotOnExit: boolean;
  snapshotAutosaveEnabled: boolean;
  snapshotAutosaveIntervalMs: number;
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  rateLimitMax: number;
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

const numberFromEnv = (
  key: string,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean } = {}
) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const value = options.integer ? Math.trunc(parsed) : parsed;
  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;
  return value;
};

const strictBoundedIntegerFromEnv = (
  key: string,
  fallback: number,
  options: { min: number; max: number }
) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${key} must be a canonical integer between ${options.min} and ${options.max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new Error(`${key} must be a canonical integer between ${options.min} and ${options.max}`);
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
  const value = raw.toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return fallback;
};

const enumFromEnv = <T extends string>(key: string, fallback: T, allowed: readonly T[]): T => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.toLowerCase();
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

export const loadConfig = (): Config => {
  const mode = modeFromEnv();
  const network = networkFromEnv();
  const edgeKey = stringFromEnv('INDEXER_EDGE_KEY');
  if (edgeKey !== undefined && edgeKey.length < 32) throw new Error('INDEXER_EDGE_KEY must have at least 32 characters');
  const diskSoftFloorBytes = strictBoundedIntegerFromEnv('INDEXER_DISK_SOFT_FLOOR_BYTES', 2 * 1024 ** 3, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const diskHardFloorBytes = strictBoundedIntegerFromEnv('INDEXER_DISK_HARD_FLOOR_BYTES', 512 * 1024 ** 2, { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (diskHardFloorBytes > diskSoftFloorBytes) throw new Error('INDEXER_DISK_HARD_FLOOR_BYTES must not exceed INDEXER_DISK_SOFT_FLOOR_BYTES');

  const defaultRateLimitWindowMs = 60_000;
  const defaultRateLimitMax = mode === 'production' ? 2_000 : 10_000;
  const rateLimitWindowMs = numberFromEnv('RATE_LIMIT_WINDOW_MS', defaultRateLimitWindowMs, {
    min: 1,
    integer: true
  });
  const rateLimitMax = numberFromEnv('RATE_LIMIT_MAX', defaultRateLimitMax, { min: 1, integer: true });
  const defaultBuckets: RateLimitBuckets = {
    accounts: { windowMs: rateLimitWindowMs, max: rateLimitMax },
    stream: { windowMs: 10_000, max: mode === 'production' ? 200 : 1_000 },
    snapshot: { windowMs: 60_000, max: mode === 'production' ? 120 : 1_000 },
    rpc: { windowMs: 10_000, max: mode === 'production' ? 240 : 1_500 },
    docs: { windowMs: 60_000, max: mode === 'production' ? 600 : 2_000 },
    default: { windowMs: rateLimitWindowMs, max: rateLimitMax }
  };
  const rateLimitBucketsRaw = stringFromEnv('RATE_LIMIT_BUCKETS_JSON');
  const rateLimitBuckets = (() => {
    if (!rateLimitBucketsRaw) return defaultBuckets;
    try {
      const parsed = JSON.parse(rateLimitBucketsRaw) as Record<string, { windowMs?: number; max?: number }>;
      const merged = { ...defaultBuckets };
      for (const key of Object.keys(defaultBuckets) as RateLimitBucketName[]) {
        const candidate = parsed[key];
        if (!candidate || typeof candidate !== 'object') continue;
        const candidateWindowMs =
          typeof candidate.windowMs === 'number' && Number.isFinite(candidate.windowMs)
            ? Math.trunc(candidate.windowMs)
            : Number.NaN;
        const candidateMax =
          typeof candidate.max === 'number' && Number.isFinite(candidate.max)
            ? Math.trunc(candidate.max)
            : Number.NaN;
        const windowMs =
          Number.isSafeInteger(candidateWindowMs) && candidateWindowMs > 0
            ? candidateWindowMs
            : merged[key].windowMs;
        const max =
          Number.isSafeInteger(candidateMax) && candidateMax > 0
            ? candidateMax
            : merged[key].max;
        merged[key] = { windowMs, max };
      }
      return merged;
    } catch {
      return defaultBuckets;
    }
  })();

  return {
    port: numberFromEnv('PORT', 8787, { min: 0, max: 65_535, integer: true }),
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
    corsMaxAge: numberFromEnv('CORS_MAX_AGE', 600, { min: 0, integer: true }),
    snapshotPath: stringFromEnv('SNAPSHOT_PATH'),
    databaseUrl: readDatabaseUrl(),
    perpsAdmissionArtifacts: parseAdmissionArtifacts(process.env),
    ledgerMaxWatchedAccounts: strictBoundedIntegerFromEnv('INDEXER_MAX_WATCHED_ACCOUNTS', 1000, {min:1,max:100000}),
    ledgerMaxPagesPerSync: strictBoundedIntegerFromEnv('INDEXER_MAX_PAGES_PER_SYNC',20,{min:1,max:100}),
    ledgerMaxRelatedAccounts: strictBoundedIntegerFromEnv('INDEXER_MAX_RELATED_ACCOUNTS',256,{min:1,max:1024}),
    snapshotOnExit: booleanFromEnv('SNAPSHOT_ON_EXIT', false),
    snapshotAutosaveEnabled: booleanFromEnv(
      'SNAPSHOT_AUTOSAVE_ENABLED',
      mode === 'production' && Boolean(stringFromEnv('SNAPSHOT_PATH'))
    ),
    snapshotAutosaveIntervalMs: numberFromEnv('SNAPSHOT_AUTOSAVE_INTERVAL_MS', 30_000, { min: 1, integer: true }),
    rateLimitEnabled: booleanFromEnv('RATE_LIMIT_ENABLED', true),
    rateLimitWindowMs,
    rateLimitMax,
    rateLimitBuckets,
    responseCacheEnabled: booleanFromEnv('RESPONSE_CACHE_ENABLED', true),
    initialHistoryTimeoutMs: strictBoundedIntegerFromEnv('INITIAL_HISTORY_TIMEOUT_MS', 10_000, {
      min: 1,
      max: 120_000
    }),
    txCacheTtlMs: numberFromEnv('TX_CACHE_TTL_MS', 1_000, { min: 0, integer: true }),
    healthCacheTtlMs: numberFromEnv('HEALTH_CACHE_TTL_MS', 1_000, { min: 0, integer: true }),
    metricsCacheTtlMs: numberFromEnv('METRICS_CACHE_TTL_MS', 1_000, { min: 0, integer: true }),
    pageSize: numberFromEnv('PAGE_SIZE', 10, { min: 1, integer: true }),
    maxPagesPerAddress: numberFromEnv('MAX_PAGES_PER_ADDRESS', 150, { min: 1, integer: true }),
    maxAddresses: numberFromEnv('MAX_ADDRESSES', 5_000, { min: 1, integer: true }),
    idleTtlMs: numberFromEnv('IDLE_TTL_MS', 2 * 60 * 60 * 1000, { min: 1, integer: true }),
    globalMaxPages: numberFromEnv('GLOBAL_MAX_PAGES', 200_000, { min: 1, integer: true }),
    backfillPageBatch: numberFromEnv('BACKFILL_PAGE_BATCH', 5, { min: 1, integer: true }),
    backfillMaxPagesPerAddress: numberFromEnv('BACKFILL_MAX_PAGES_PER_ADDRESS', 150, { min: 1, integer: true }),
    backfillConcurrency: numberFromEnv('BACKFILL_CONCURRENCY', 2, { min: 1, integer: true }),
    watchlistRefreshMs: numberFromEnv('WATCHLIST_REFRESH_MS', 5_000, { min: 1, integer: true }),
    blockPollMs: numberFromEnv('BLOCK_POLL_MS', 5_000, { min: 1, integer: true }),
    enableWriteRpc: booleanFromEnv('INDEXER_ENABLE_WRITE_RPC', false),
    liteserverPool: stringFromEnv(
      network === 'mainnet'
        ? 'LITESERVER_POOL_MAINNET'
        : network === 'testnet'
          ? 'LITESERVER_POOL_TESTNET'
          : 'LITESERVER_POOL_LOCALNET'
    ),
    logLevel: stringFromEnv('LOG_LEVEL', 'info')!,
    adminToken: stringFromEnv('INDEXER_ADMIN_TOKEN'),
    releaseManifestSource: stringFromEnv('INDEXER_RELEASE_MANIFEST'),
    edgeKey,
    ledgerWorkers: strictBoundedIntegerFromEnv('INDEXER_LEDGER_WORKERS', 3, { min: 2, max: 8 }),
    diskGuardPath: stringFromEnv('INDEXER_DISK_GUARD_PATH', dirname(resolve(stringFromEnv('SNAPSHOT_PATH', './snapshot.json')!)))!,
    diskSoftFloorBytes,
    diskHardFloorBytes,
  };
};
