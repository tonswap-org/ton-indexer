import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export type Network = 'mainnet' | 'testnet';
export type IndexerMode = 'dev' | 'production';
export type RateLimitBucketName = 'accounts' | 'stream' | 'snapshot' | 'rpc' | 'docs' | 'default';
export type RateLimitBucketConfig = { windowMs: number; max: number };
export type RateLimitBuckets = Record<RateLimitBucketName, RateLimitBucketConfig>;

export type Config = {
  port: number;
  host: string;
  trustProxy: boolean | string[];
  mode: IndexerMode;
  network: Network;
  dataSource: 'http' | 'lite';
  corsEnabled: boolean;
  corsAllowOrigin: string;
  corsAllowOrigins: string[];
  corsAllowMethods: string;
  corsAllowHeaders: string;
  corsExposeHeaders: string;
  corsMaxAge: number;
  snapshotPath?: string;
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
  balanceCacheTtlMs: number;
  jettonBalanceTimeoutMs: number;
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
  rpcProxyEndpoint?: string;
  rpcProxyEndpoints: string[];
  enableWriteRpc: boolean;
  rpcProxyApiKey?: string;
  rpcProxyTimeoutMs: number;
  rpcProxyRetryAttempts: number;
  rpcProxyRetryDelayMs: number;
  liteserverPool?: string;
  soraRpcEndpoint?: string;
  soraRpcTimeoutMs: number;
  soraCheckpointCacheTtlMs: number;
  soraTonTrustedCheckpointSeqno?: number;
  soraTonTrustedCheckpointHash?: string;
  logLevel: string;
  registryPath: string;
  opcodesPath?: string;
};

const CANONICAL_INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;

const numberFromEnv = (
  key: string,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean } = {}
) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const normalized = raw.trim();
  const parsed = Number(normalized);
  const invalid =
    normalized.length === 0 ||
    !Number.isFinite(parsed) ||
    (options.integer === true &&
      (!CANONICAL_INTEGER_PATTERN.test(normalized) || !Number.isSafeInteger(parsed))) ||
    (options.min !== undefined && parsed < options.min) ||
    (options.max !== undefined && parsed > options.max);
  if (invalid) {
    const type = options.integer ? 'an integer' : 'a finite number';
    const range = [
      options.min === undefined ? null : `>= ${options.min}`,
      options.max === undefined ? null : `<= ${options.max}`,
    ].filter(Boolean).join(' and ');
    throw new Error(`${key} must be ${type}${range ? ` (${range})` : ''}.`);
  }
  return parsed;
};

const optionalIntegerFromEnv = (key: string, options: { min?: number; max?: number } = {}) => {
  if (process.env[key] === undefined) return undefined;
  return numberFromEnv(key, 0, { ...options, integer: true });
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

type ParsedTrustedProxy = {
  value: string;
  family: 4 | 6;
  prefix: number;
  bytes: number[];
};

const ipBytes = (address: string, family: 4 | 6): number[] => {
  if (family === 4) return address.split('.').map(Number);
  const [left = '', right = ''] = address.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const zeroCount = 8 - leftParts.length - rightParts.length;
  const parts = [...leftParts, ...Array.from({ length: zeroCount }, () => '0'), ...rightParts];
  return parts.flatMap((part) => {
    const value = Number.parseInt(part, 16);
    return [value >>> 8, value & 0xff];
  });
};

const hasHostBits = (bytes: number[], prefix: number): boolean => {
  const fullBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  if (remainingBits > 0 && (bytes[fullBytes] & (0xff >>> remainingBits)) !== 0) return true;
  const firstHostByte = fullBytes + (remainingBits > 0 ? 1 : 0);
  return bytes.slice(firstHostByte).some((byte) => byte !== 0);
};

const validateTrustedProxy = (value: string): ParsedTrustedProxy => {
  const [address, prefix, ...extra] = value.split('/');
  const family = isIP(address);
  if (extra.length > 0 || family === 0) {
    throw new Error(`TRUSTED_PROXY_CIDRS contains invalid IP or CIDR ${JSON.stringify(value)}.`);
  }
  const ipFamily = family as 4 | 6;
  const maximum = ipFamily === 4 ? 32 : 128;
  let parsedPrefix = maximum;
  if (prefix !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(prefix)) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains invalid IP or CIDR ${JSON.stringify(value)}.`);
    }
    parsedPrefix = Number(prefix);
    if (!Number.isSafeInteger(parsedPrefix) || parsedPrefix < 0 || parsedPrefix > maximum) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains invalid IP or CIDR ${JSON.stringify(value)}.`);
    }
    const minimum = ipFamily === 4 ? 8 : 32;
    if (parsedPrefix < minimum) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains an overbroad CIDR ${JSON.stringify(value)}.`);
    }
  }
  const canonical =
    ipFamily === 4
      ? address.split('.').map(Number).join('.')
      : new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (canonical !== address || (ipFamily === 6 && address.startsWith('::ffff:'))) {
    throw new Error(`TRUSTED_PROXY_CIDRS contains non-canonical IP or CIDR ${JSON.stringify(value)}.`);
  }
  const bytes = ipBytes(address, ipFamily);
  if (prefix !== undefined && hasHostBits(bytes, parsedPrefix)) {
    throw new Error(`TRUSTED_PROXY_CIDRS contains CIDR host bits ${JSON.stringify(value)}.`);
  }
  return { value, family: ipFamily, prefix: parsedPrefix, bytes };
};

const proxiesOverlap = (left: ParsedTrustedProxy, right: ParsedTrustedProxy): boolean => {
  if (left.family !== right.family) return false;
  const prefix = Math.min(left.prefix, right.prefix);
  const fullBytes = Math.floor(prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (left.bytes[index] !== right.bytes[index]) return false;
  }
  const remainingBits = prefix % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (left.bytes[fullBytes] & mask) === (right.bytes[fullBytes] & mask);
};

const trustProxyFromEnv = (mode: IndexerMode): boolean | string[] => {
  const configured = process.env.TRUSTED_PROXY_CIDRS;
  const entries = configured?.split(/[,\s]+/).filter(Boolean) ?? [];
  if (configured !== undefined && entries.length === 0) {
    throw new Error('TRUSTED_PROXY_CIDRS must be a non-empty list of canonical, non-overlapping IPs or CIDRs.');
  }
  const parsed = entries.map(validateTrustedProxy);
  const seen = new Set<string>();
  for (const proxy of parsed) {
    if (seen.has(proxy.value)) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains duplicate entry ${JSON.stringify(proxy.value)}.`);
    }
    seen.add(proxy.value);
  }
  for (let left = 0; left < parsed.length; left += 1) {
    for (let right = left + 1; right < parsed.length; right += 1) {
      if (proxiesOverlap(parsed[left], parsed[right])) {
        throw new Error(
          `TRUSTED_PROXY_CIDRS contains overlapping entries ${JSON.stringify(parsed[left].value)} and ${JSON.stringify(parsed[right].value)}.`
        );
      }
    }
  }
  const trustedProxyCidrs = parsed.map((entry) => entry.value);
  const legacyTrustProxy = booleanFromEnv('TRUST_PROXY', booleanFromEnv('FASTIFY_TRUST_PROXY', false));
  if (trustedProxyCidrs.length > 0) return trustedProxyCidrs;
  if (legacyTrustProxy && mode === 'production') {
    throw new Error('TRUSTED_PROXY_CIDRS is required when proxy trust is enabled in production.');
  }
  return legacyTrustProxy;
};

const modeFromEnv = (): IndexerMode => {
  const configured = process.env.INDEXER_MODE;
  if (configured === undefined) return 'dev';
  const raw = configured.trim().toLowerCase();
  if (raw === 'production' || raw === 'dev') return raw;
  throw new Error('INDEXER_MODE must be dev or production.');
};

const networkFromEnv = (mode: IndexerMode): Network => {
  // Default to testnet for current TONSWAP deployments; mainnet requires real registry addresses.
  const configured = process.env.TON_NETWORK;
  if (configured === undefined) {
    if (mode === 'production') {
      throw new Error('TON_NETWORK is required when INDEXER_MODE=production.');
    }
    return 'testnet';
  }
  const raw = configured.trim().toLowerCase();
  if (raw === 'mainnet' || raw === 'testnet') {
    if (mode === 'production' && raw !== 'mainnet') {
      throw new Error('TON_NETWORK must be mainnet when INDEXER_MODE=production.');
    }
    return raw;
  }
  throw new Error('TON_NETWORK must be mainnet or testnet.');
};

const dataSourceFromEnv = (mode: IndexerMode): 'http' | 'lite' => {
  const configured = process.env.TON_DATASOURCE;
  if (configured === undefined) {
    if (mode === 'production') {
      throw new Error('TON_DATASOURCE is required when INDEXER_MODE=production.');
    }
    return 'http';
  }
  const raw = configured.trim().toLowerCase();
  if (raw === 'lite' || raw === 'http') {
    if (mode === 'production' && raw !== 'lite') {
      throw new Error('TON_DATASOURCE must be lite when INDEXER_MODE=production.');
    }
    return raw;
  }
  throw new Error('TON_DATASOURCE must be http or lite.');
};

export const loadConfig = (): Config => {
  const mode = modeFromEnv();
  const network = networkFromEnv(mode);
  const registryPath = resolve(process.cwd(), 'registry', `${network}.json`);
  const opcodesPath = stringFromEnv(
    'OPCODES_PATH',
    resolve(process.cwd(), '..', 'tonswap_tolk', 'config', 'opcodes.json')
  );

  const configuredProxyEndpoints = listFromEnv([
    'INDEXER_WRITE_RPC_ENDPOINTS',
    'TON_WRITE_RPC_ENDPOINTS',
    'TONSWAP_WRITE_RPC_ENDPOINTS',
    'BLUEPRINT_WRITE_ENDPOINTS',
    'TON_RPC_ENDPOINTS',
    'BLUEPRINT_ENDPOINTS'
  ]);
  const singleProxyEndpoint =
    stringFromEnv('INDEXER_WRITE_RPC_ENDPOINT') ||
    stringFromEnv('TON_WRITE_RPC_ENDPOINT') ||
    stringFromEnv('TONSWAP_WRITE_RPC_ENDPOINT') ||
    stringFromEnv('BLUEPRINT_WRITE_ENDPOINT') ||
    stringFromEnv('TON_RPC_ENDPOINT') ||
    stringFromEnv('BLUEPRINT_ENDPOINT');
  const rpcProxyEndpoints = singleProxyEndpoint
    ? [...configuredProxyEndpoints, singleProxyEndpoint].filter(
        (endpoint, index, list) => list.indexOf(endpoint) === index
      )
    : configuredProxyEndpoints;
  const defaultRateLimitWindowMs = 60_000;
  const defaultRateLimitMax = mode === 'production' ? 2_000 : 10_000;
  const rateLimitEnabled = booleanFromEnv('RATE_LIMIT_ENABLED', true);
  if (mode === 'production' && !rateLimitEnabled) {
    throw new Error('RATE_LIMIT_ENABLED must be true when INDEXER_MODE=production.');
  }
  const rateLimitWindowMs = numberFromEnv('RATE_LIMIT_WINDOW_MS', defaultRateLimitWindowMs, {
    min: 1,
    integer: true
  });
  const rateLimitMax = numberFromEnv('RATE_LIMIT_MAX', defaultRateLimitMax, { min: 1, integer: true });
  const rateLimitMaxKeys = numberFromEnv('RATE_LIMIT_MAX_KEYS', mode === 'production' ? 20_000 : 50_000, {
    min: 1,
    max: 1_000_000,
    integer: true
  });
  const rateLimitGlobalWindowMs = numberFromEnv('RATE_LIMIT_GLOBAL_WINDOW_MS', rateLimitWindowMs, {
    min: 1,
    integer: true
  });
  const rateLimitGlobalMax = numberFromEnv(
    'RATE_LIMIT_GLOBAL_MAX',
    mode === 'production' ? 50_000 : 250_000,
    { min: 1, integer: true }
  );
  const defaultBuckets: RateLimitBuckets = {
    accounts: { windowMs: rateLimitWindowMs, max: rateLimitMax },
    stream: { windowMs: 10_000, max: mode === 'production' ? 200 : 1_000 },
    snapshot: { windowMs: 60_000, max: mode === 'production' ? 120 : 1_000 },
    rpc: { windowMs: 10_000, max: mode === 'production' ? 240 : 1_500 },
    docs: { windowMs: 60_000, max: mode === 'production' ? 600 : 2_000 },
    default: { windowMs: rateLimitWindowMs, max: rateLimitMax }
  };
  const configuredRateLimitBuckets = process.env.RATE_LIMIT_BUCKETS_JSON;
  const rateLimitBucketsRaw = configuredRateLimitBuckets?.trim();
  const rateLimitBuckets = (() => {
    if (configuredRateLimitBuckets === undefined) return defaultBuckets;
    if (!rateLimitBucketsRaw) {
      throw new Error('RATE_LIMIT_BUCKETS_JSON must be a non-empty JSON object.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rateLimitBucketsRaw);
    } catch {
      throw new Error('RATE_LIMIT_BUCKETS_JSON must be valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('RATE_LIMIT_BUCKETS_JSON must be an object.');
    }

    const bucketRecord = parsed as Record<string, unknown>;
    const allowedBuckets = new Set(Object.keys(defaultBuckets));
    const unknownBucket = Object.keys(bucketRecord).find((key) => !allowedBuckets.has(key));
    if (unknownBucket) {
      throw new Error(`RATE_LIMIT_BUCKETS_JSON contains unsupported bucket ${JSON.stringify(unknownBucket)}.`);
    }

    const merged = { ...defaultBuckets };
    for (const key of Object.keys(defaultBuckets) as RateLimitBucketName[]) {
      if (!Object.prototype.hasOwnProperty.call(bucketRecord, key)) continue;
      const candidate = bucketRecord[key];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error(`RATE_LIMIT_BUCKETS_JSON.${key} must be an object.`);
      }
      const fields = candidate as Record<string, unknown>;
      const unknownField = Object.keys(fields).find((field) => field !== 'windowMs' && field !== 'max');
      if (unknownField) {
        throw new Error(`RATE_LIMIT_BUCKETS_JSON.${key} contains unsupported field ${JSON.stringify(unknownField)}.`);
      }
      const next = { ...merged[key] };
      for (const field of ['windowMs', 'max'] as const) {
        if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
        const value = fields[field];
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`RATE_LIMIT_BUCKETS_JSON.${key}.${field} must be a positive integer.`);
        }
        next[field] = value;
      }
      merged[key] = next;
    }
    return merged;
  })();

  const port = numberFromEnv('PORT', 8787, { min: 0, max: 65_535, integer: true });
  if (mode === 'production' && port === 0) {
    throw new Error('PORT must be a fixed non-zero port in production.');
  }

  return {
    port,
    host: stringFromEnv('HOST', '127.0.0.1')!,
    trustProxy: trustProxyFromEnv(mode),
    mode,
    network,
    dataSource: dataSourceFromEnv(mode),
    corsEnabled: booleanFromEnv('CORS_ENABLED', true),
    corsAllowOrigin: stringFromEnv('CORS_ALLOW_ORIGIN', '*')!,
    corsAllowOrigins: listFromEnv(['CORS_ALLOW_ORIGINS']),
    corsAllowMethods: stringFromEnv('CORS_ALLOW_METHODS', 'GET,HEAD,POST,OPTIONS')!,
    corsAllowHeaders: stringFromEnv('CORS_ALLOW_HEADERS', 'content-type,accept')!,
    corsExposeHeaders: stringFromEnv(
      'CORS_EXPOSE_HEADERS',
      'x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset'
    )!,
    corsMaxAge: numberFromEnv('CORS_MAX_AGE', 600, { min: 0, integer: true }),
    snapshotPath: stringFromEnv('SNAPSHOT_PATH'),
    snapshotOnExit: booleanFromEnv('SNAPSHOT_ON_EXIT', false),
    snapshotAutosaveEnabled: booleanFromEnv(
      'SNAPSHOT_AUTOSAVE_ENABLED',
      mode === 'production' && Boolean(stringFromEnv('SNAPSHOT_PATH'))
    ),
    snapshotAutosaveIntervalMs: numberFromEnv('SNAPSHOT_AUTOSAVE_INTERVAL_MS', 30_000, { min: 1, integer: true }),
    rateLimitEnabled,
    rateLimitWindowMs,
    rateLimitMax,
    rateLimitMaxKeys,
    rateLimitGlobalWindowMs,
    rateLimitGlobalMax,
    rateLimitBuckets,
    responseCacheEnabled: booleanFromEnv('RESPONSE_CACHE_ENABLED', true),
    balanceCacheTtlMs: numberFromEnv('BALANCE_CACHE_TTL_MS', 2_000, { min: 0, integer: true }),
    jettonBalanceTimeoutMs: numberFromEnv('JETTON_BALANCE_TIMEOUT_MS', 2_000, { min: 0, integer: true }),
    txCacheTtlMs: numberFromEnv('TX_CACHE_TTL_MS', 1_000, { min: 0, integer: true }),
    stateCacheTtlMs: numberFromEnv('STATE_CACHE_TTL_MS', 1_000, { min: 0, integer: true }),
    healthCacheTtlMs: numberFromEnv('HEALTH_CACHE_TTL_MS', 1_000, { min: 0, max: 5_000, integer: true }),
    metricsCacheTtlMs: numberFromEnv('METRICS_CACHE_TTL_MS', 1_000, { min: 0, integer: true }),
    pageSize: numberFromEnv('PAGE_SIZE', 10, { min: 1, integer: true }),
    maxPagesPerAddress: numberFromEnv('MAX_PAGES_PER_ADDRESS', 150, { min: 1, integer: true }),
    maxAddresses: numberFromEnv('MAX_ADDRESSES', 5_000, { min: 1, integer: true }),
    idleTtlMs: numberFromEnv('IDLE_TTL_MS', 2 * 60 * 60 * 1000, { min: 1, integer: true }),
    globalMaxPages: numberFromEnv('GLOBAL_MAX_PAGES', 200_000, { min: 1, integer: true }),
    backfillPageBatch: numberFromEnv('BACKFILL_PAGE_BATCH', 5, { min: 1, integer: true }),
    backfillMaxPagesPerAddress: numberFromEnv('BACKFILL_MAX_PAGES_PER_ADDRESS', 150, { min: 1, integer: true }),
    backfillConcurrency: numberFromEnv('BACKFILL_CONCURRENCY', 2, { min: 1, integer: true }),
    jettonMetadataTtlMs: numberFromEnv('JETTON_METADATA_TTL_MS', 24 * 60 * 60 * 1000, { min: 0, integer: true }),
    watchlistRefreshMs: numberFromEnv('WATCHLIST_REFRESH_MS', 5_000, { min: 1, integer: true }),
    blockPollMs: numberFromEnv('BLOCK_POLL_MS', 5_000, { min: 1, integer: true }),
    httpEndpoint: stringFromEnv('TON_HTTP_ENDPOINT'),
    rpcProxyEndpoint: singleProxyEndpoint,
    rpcProxyEndpoints,
    enableWriteRpc: booleanFromEnv('INDEXER_ENABLE_WRITE_RPC', false),
    rpcProxyApiKey:
      stringFromEnv('INDEXER_WRITE_RPC_API_KEY') ||
      stringFromEnv('TON_WRITE_RPC_API_KEY') ||
      stringFromEnv('TONSWAP_WRITE_RPC_API_KEY') ||
      stringFromEnv('BLUEPRINT_WRITE_API_KEY') ||
      stringFromEnv('TON_RPC_API_KEY') ||
      stringFromEnv('BLUEPRINT_API_KEY'),
    rpcProxyTimeoutMs: numberFromEnv('INDEXER_RPC_PROXY_TIMEOUT_MS', 30_000, { min: 1, integer: true }),
    rpcProxyRetryAttempts: numberFromEnv('INDEXER_RPC_PROXY_RETRY_ATTEMPTS', 4, { min: 1, integer: true }),
    rpcProxyRetryDelayMs: numberFromEnv('INDEXER_RPC_PROXY_RETRY_DELAY_MS', 600, { min: 0, integer: true }),
    liteserverPool: stringFromEnv(
      network === 'mainnet' ? 'LITESERVER_POOL_MAINNET' : 'LITESERVER_POOL_TESTNET'
    ),
    soraRpcEndpoint:
      stringFromEnv('SORA_RPC_HTTP_ENDPOINT') ||
      stringFromEnv('SORA_HTTP_ENDPOINT') ||
      stringFromEnv('SORA_RPC_ENDPOINT'),
    soraRpcTimeoutMs: numberFromEnv('SORA_RPC_TIMEOUT_MS', 10_000, { min: 1, integer: true }),
    soraCheckpointCacheTtlMs: numberFromEnv('SORA_TON_TRUSTED_CHECKPOINT_CACHE_TTL_MS', 10_000, {
      min: 1,
      integer: true
    }),
    soraTonTrustedCheckpointSeqno: optionalIntegerFromEnv('SORA_TON_TRUSTED_CHECKPOINT_SEQNO', { min: 0 }),
    soraTonTrustedCheckpointHash: stringFromEnv('SORA_TON_TRUSTED_CHECKPOINT_HASH'),
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
