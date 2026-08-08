import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  readCanonicalReleaseManifest,
  type RegistryMarketMetadata,
} from '../config/releaseManifest';

type OpenApiSpec = {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
  };
  servers?: Array<{ url?: unknown }>;
  paths?: Record<string, unknown>;
};

type ServiceInfo = {
  schemaVersion?: unknown;
  serviceId?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
  publicBaseUrl?: unknown;
  readOnly?: unknown;
  endpoints?: {
    openapi?: unknown;
  };
  release?: {
    releaseId?: unknown;
    registryHash?: unknown;
    releaseManifestHash?: unknown;
  };
};

type HealthInfo = {
  lastMasterSeqno?: unknown;
  ok?: unknown;
  serviceId?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
};

type ContractsInfo = {
  network?: unknown;
  count?: unknown;
  registry_hash?: unknown;
  release_id?: unknown;
  release_manifest_hash?: unknown;
  contracts?: unknown;
};

type MarketCandle = {
  ts?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volumeBase?: unknown;
  volumeQuote?: unknown;
  tradeCount?: unknown;
  sourceTxIds?: unknown;
};

type MarketCandlesInfo = {
  market_key?: unknown;
  market_address?: unknown;
  interval?: unknown;
  from_utime?: unknown;
  to_utime?: unknown;
  candle_count?: unknown;
  history_complete?: unknown;
  synced_at?: unknown;
  network?: unknown;
  candles?: unknown;
};

export type ProductionSmokeOptions = {
  expectedNetwork?: 'mainnet' | 'testnet' | 'localnet';
  expectedServiceId?: string;
  expectedPublicBaseUrl?: string;
  expectedRegistryHash?: string;
  expectedReleaseId?: string;
  expectedReleaseManifestHash?: string;
  expectedReleaseManifestPath?: string;
  expectedCorsOrigin?: string;
  hostileCorsOrigin?: string;
  /** Programmatic-only compatibility escape hatch. The production CLI never enables it. */
  allowUnboundRelease?: boolean;
};

const DEFAULT_BASE_URL = 'https://ti.soramitsu.io';
export const CANONICAL_RELEASE_CONTRACT_COUNT = 62;
const DEFAULT_HOSTILE_CORS_ORIGIN = 'https://hostile.tonswap.invalid';
const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_DISCOVERY_ROOT_PAIRS = [
  ['KusdDiscovery', 'KusdRoot'],
  ['UsdcDiscovery', 'UsdcRoot'],
  ['UsdtDiscovery', 'UsdtRoot'],
] as const;

type StrictReleaseExpectation = {
  releaseId: string;
  registryHash: string;
  releaseManifestHash: string;
  contracts: Record<string, string>;
  markets: RegistryMarketMetadata[];
  expectedCorsOrigin: string;
  hostileCorsOrigin: string;
};

export function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TON indexer base URL must be a canonical public HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'TON indexer base URL must be HTTP(S) and must not contain credentials, query parameters, or fragments.'
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function redactedBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '<invalid public base URL>';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return '<invalid public base URL>';
  }
}

function endpoint(baseUrl: URL, path: string, searchParams?: URLSearchParams): URL {
  const url = new URL(baseUrl.toString());
  url.pathname = `${baseUrl.pathname}${path}`.replace(/\/{2,}/g, '/');
  if (searchParams) url.search = searchParams.toString();
  return url;
}

function bodyEvidence(value: string): string {
  const bytes = Buffer.byteLength(value);
  const digest = createHash('sha256').update(value).digest('hex');
  return `${bytes} bytes, sha256=${digest}`;
}

function deploymentHint(path: string): string {
  if (path === '/api/indexer/v1/service-info') {
    return 'Production routing must serve the TON v1 wallet API; deploy the current ton-indexer image to ti.soramitsu.io and expose /api/indexer/v1/service-info.';
  }
  if (path === '/api/indexer/v1/openapi.json') {
    return 'Production routing must serve the TON OpenAPI contract at /api/indexer/v1/openapi.json.';
  }
  return 'Production routing must serve the TON indexer contract at ti.soramitsu.io.';
}

async function fetchJsonResponse(
  baseUrl: URL,
  path: string,
  options: { headers?: Record<string, string>; searchParams?: URLSearchParams } = {}
): Promise<{ body: unknown; headers: Headers }> {
  const response = await fetch(endpoint(baseUrl, path, options.searchParams), {
    headers: { accept: 'application/json', ...options.headers },
    redirect: 'error',
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}. Body evidence: ${bodyEvidence(rawBody)}. ${deploymentHint(path)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${path} did not return JSON. Content-Type: ${contentType || '<missing>'}. Body evidence: ${bodyEvidence(rawBody)}. ${deploymentHint(path)}`);
  }

  try {
    return { body: JSON.parse(rawBody), headers: response.headers };
  } catch {
    throw new Error(`${path} returned invalid JSON. Body evidence: ${bodyEvidence(rawBody)}. ${deploymentHint(path)}`);
  }
}

async function fetchCorsPreflight(
  baseUrl: URL,
  path: string,
  origin: string
): Promise<{ ok: boolean; status: number; headers: Headers }> {
  const response = await fetch(endpoint(baseUrl, path), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,accept',
    },
    redirect: 'error',
  });
  await response.arrayBuffer();
  return { ok: response.ok, status: response.status, headers: response.headers };
}

async function fetchJson(
  baseUrl: URL,
  path: string,
  options: { headers?: Record<string, string>; searchParams?: URLSearchParams } = {}
): Promise<unknown> {
  return (await fetchJsonResponse(baseUrl, path, options)).body;
}

function assertPath(spec: OpenApiSpec, path: string) {
  assert.ok(spec.paths?.[path], `OpenAPI is missing ${path}`);
}

function objectKeys(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '<non-object>';
  return Object.keys(value as Record<string, unknown>).sort().join(',') || '<empty object>';
}

const expectedNetworkFromEnv = (): 'mainnet' | 'testnet' | 'localnet' => {
  const raw = (process.env.TON_INDEXER_EXPECTED_NETWORK || 'mainnet').trim().toLowerCase();
  if (raw === 'mainnet' || raw === 'testnet' || raw === 'localnet') return raw;
  throw new Error(`TON_INDEXER_EXPECTED_NETWORK must be mainnet, testnet, or localnet; got ${raw}`);
};

const optionalTrimmed = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const optionOrEnv = (option: string | undefined, envName: string): string | undefined =>
  optionalTrimmed(option) ?? optionalTrimmed(process.env[envName]);

const headerTokens = (headers: Headers, name: string): string[] =>
  (headers.get(name) ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

const canonicalPublicBaseUrl = (value: string): string => {
  const parsed = normalizeBaseUrl(value);
  const serialized = parsed.toString();
  return parsed.pathname === '/' ? serialized.replace(/\/$/, '') : serialized;
};

const requireSha256 = (value: string | undefined, label: string): string => {
  if (!value || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be an explicit lowercase 64-character SHA-256 digest.`);
  }
  return value;
};

const requireCanonicalOrigin = (value: string | undefined, label: string): string => {
  if (!value) throw new Error(`${label} must be explicitly set for a release-bound smoke.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical HTTP(S) origin.`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error(`${label} must be a canonical HTTP(S) origin.`);
  }
  return value;
};

const assertDiscoveryRootEqualities = (
  contracts: Record<string, unknown>,
  label: string
): void => {
  for (const [discovery, root] of RELEASE_DISCOVERY_ROOT_PAIRS) {
    if (
      typeof contracts[discovery] !== 'string' ||
      typeof contracts[root] !== 'string' ||
      contracts[discovery] !== contracts[root]
    ) {
      throw new Error(`${label} ${discovery} must exactly equal ${root}.`);
    }
  }
};

function resolveStrictReleaseExpectation(
  options: ProductionSmokeOptions,
  expectedNetwork: 'mainnet' | 'testnet' | 'localnet',
  expectedNetworkWasExplicit: boolean
): StrictReleaseExpectation | null {
  const releaseId = optionOrEnv(options.expectedReleaseId, 'TON_INDEXER_EXPECTED_RELEASE_ID');
  const registryHash = optionOrEnv(
    options.expectedRegistryHash,
    'TON_INDEXER_EXPECTED_REGISTRY_HASH'
  );
  const releaseManifestHash = optionOrEnv(
    options.expectedReleaseManifestHash,
    'TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH'
  );
  const releaseManifestPath = optionOrEnv(
    options.expectedReleaseManifestPath,
    'TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH'
  );
  const expectedCorsOrigin = optionOrEnv(
    options.expectedCorsOrigin,
    'TON_INDEXER_EXPECTED_CORS_ORIGIN'
  );
  const configuredHostileCorsOrigin = optionOrEnv(
    options.hostileCorsOrigin,
    'TON_INDEXER_HOSTILE_CORS_ORIGIN'
  );
  const hostileCorsOrigin = configuredHostileCorsOrigin ?? DEFAULT_HOSTILE_CORS_ORIGIN;
  const releaseInputPresent = [
    releaseId,
    registryHash,
    releaseManifestHash,
    releaseManifestPath,
    expectedCorsOrigin,
    configuredHostileCorsOrigin,
  ].some((value) => value !== undefined);
  if (!releaseInputPresent) {
    if (options.allowUnboundRelease === true) return null;
    throw new Error(
      'Release-bound production smoke requires explicit network, release ID, registry hash, manifest path/hash, and allowed CORS origin inputs.'
    );
  }
  if (!expectedNetworkWasExplicit) {
    throw new Error(
      'TON_INDEXER_EXPECTED_NETWORK must be explicitly set for a release-bound smoke.'
    );
  }
  if (!releaseId) {
    throw new Error('TON_INDEXER_EXPECTED_RELEASE_ID must be explicitly set for a release-bound smoke.');
  }
  const exactRegistryHash = requireSha256(
    registryHash,
    'TON_INDEXER_EXPECTED_REGISTRY_HASH'
  );
  const exactReleaseManifestHash = requireSha256(
    releaseManifestHash,
    'TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH'
  );
  if (!releaseManifestPath || !isAbsolute(releaseManifestPath)) {
    throw new Error(
      'TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH must be an explicit canonical absolute path for a release-bound smoke.'
    );
  }
  const exactExpectedCorsOrigin = requireCanonicalOrigin(
    expectedCorsOrigin,
    'TON_INDEXER_EXPECTED_CORS_ORIGIN'
  );
  const exactHostileCorsOrigin = requireCanonicalOrigin(
    hostileCorsOrigin,
    'TON_INDEXER_HOSTILE_CORS_ORIGIN'
  );
  if (exactExpectedCorsOrigin === exactHostileCorsOrigin) {
    throw new Error('Expected and hostile CORS origins must be distinct.');
  }

  const manifest = readCanonicalReleaseManifest(releaseManifestPath, expectedNetwork);
  assert.equal(
    manifest.releaseId,
    releaseId,
    `release manifest releaseId must be ${releaseId}`
  );
  assert.equal(
    manifest.registryHash,
    exactRegistryHash,
    `release manifest registryHash must be ${exactRegistryHash}`
  );
  assert.equal(
    manifest.releaseManifestHash,
    exactReleaseManifestHash,
    `release manifest manifestHash must be ${exactReleaseManifestHash}`
  );
  assert.equal(
    Object.keys(manifest.contracts).length,
    CANONICAL_RELEASE_CONTRACT_COUNT,
    `release manifest must contain exactly ${CANONICAL_RELEASE_CONTRACT_COUNT} contracts`
  );
  assertDiscoveryRootEqualities(manifest.contracts, 'release manifest');
  assert.equal(manifest.markets.length, 3, 'release manifest must contain exactly three markets');

  return {
    releaseId,
    registryHash: exactRegistryHash,
    releaseManifestHash: exactReleaseManifestHash,
    contracts: manifest.contracts,
    markets: manifest.markets,
    expectedCorsOrigin: exactExpectedCorsOrigin,
    hostileCorsOrigin: exactHostileCorsOrigin,
  };
}

function assertExactReleaseContracts(
  rawContracts: unknown,
  expected: StrictReleaseExpectation
): asserts rawContracts is Record<string, string> {
  assert.ok(
    rawContracts && typeof rawContracts === 'object' && !Array.isArray(rawContracts),
    'contracts payload must include a contracts object'
  );
  const contracts = rawContracts as Record<string, unknown>;
  assert.equal(
    Object.keys(contracts).length,
    CANONICAL_RELEASE_CONTRACT_COUNT,
    `contracts payload must contain exactly ${CANONICAL_RELEASE_CONTRACT_COUNT} contracts`
  );
  assert.deepEqual(contracts, expected.contracts, 'contracts payload must exactly match the release manifest');
  assertDiscoveryRootEqualities(contracts, 'contracts payload');
}

function assertTwoCandleHistory(
  raw: unknown,
  market: RegistryMarketMetadata,
  expectedNetwork: 'mainnet' | 'testnet' | 'localnet',
  allSeenTransactions: Set<string>
): void {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), `${market.marketKey} candles must be an object`);
  const history = raw as MarketCandlesInfo;
  assert.equal(history.market_key, market.marketKey, `${market.marketKey} market_key mismatch`);
  assert.equal(history.market_address, market.marketAddress, `${market.marketKey} market_address mismatch`);
  assert.equal(history.interval, '1m', `${market.marketKey} interval must be 1m`);
  assert.equal(history.from_utime, null, `${market.marketKey} from_utime must reflect the unbounded manifest query`);
  assert.equal(history.to_utime, null, `${market.marketKey} to_utime must reflect the unbounded manifest query`);
  assert.equal(history.network, expectedNetwork, `${market.marketKey} network must be ${expectedNetwork}`);
  assert.equal(history.history_complete, true, `${market.marketKey} history_complete must be true`);
  assert.ok(
    Number.isSafeInteger(history.synced_at) && Number(history.synced_at) > 0,
    `${market.marketKey} synced_at must be a positive safe integer`
  );
  assert.equal(history.candle_count, 2, `${market.marketKey} candle_count must be exactly 2`);
  assert.ok(Array.isArray(history.candles), `${market.marketKey} candles must be an array`);
  assert.equal(history.candles.length, 2, `${market.marketKey} candles must contain exactly 2 entries`);

  let previousTimestamp = -1;
  for (const [index, rawCandle] of history.candles.entries()) {
    assert.ok(
      rawCandle && typeof rawCandle === 'object' && !Array.isArray(rawCandle),
      `${market.marketKey} candle ${index} must be an object`
    );
    const candle = rawCandle as MarketCandle;
    assert.ok(
      Number.isSafeInteger(candle.ts) && Number(candle.ts) > previousTimestamp && Number(candle.ts) % 60 === 0,
      `${market.marketKey} candle ${index} must have a strictly increasing one-minute timestamp`
    );
    previousTimestamp = Number(candle.ts);
    for (const field of ['open', 'high', 'low', 'close', 'volumeBase', 'volumeQuote'] as const) {
      assert.ok(
        typeof candle[field] === 'number' && Number.isFinite(candle[field]) && candle[field] > 0,
        `${market.marketKey} candle ${index} ${field} must be a positive finite number`
      );
    }
    assert.equal(candle.open, candle.high, `${market.marketKey} single-trade candle open/high mismatch`);
    assert.equal(candle.open, candle.low, `${market.marketKey} single-trade candle open/low mismatch`);
    assert.equal(candle.open, candle.close, `${market.marketKey} single-trade candle open/close mismatch`);
    const derivedPrice = Number(candle.volumeQuote) / Number(candle.volumeBase);
    const priceDelta = Math.abs(derivedPrice - Number(candle.close));
    const priceScale = Math.max(1, Math.abs(derivedPrice), Math.abs(Number(candle.close)));
    assert.ok(
      priceDelta <= Number.EPSILON * 8 * priceScale,
      `${market.marketKey} single-trade candle price must match its volumes`
    );
    assert.equal(candle.tradeCount, 1, `${market.marketKey} candle ${index} must contain exactly one trade`);
    assert.ok(
      Array.isArray(candle.sourceTxIds) &&
        candle.sourceTxIds.length === 1 &&
        typeof candle.sourceTxIds[0] === 'string' &&
        candle.sourceTxIds[0].length > 0 &&
        candle.sourceTxIds[0].length <= 512 &&
        candle.sourceTxIds[0] === candle.sourceTxIds[0].trim() &&
        !/[\u0000-\u001f\u007f]/.test(candle.sourceTxIds[0]),
      `${market.marketKey} candle ${index} must bind exactly one source transaction`
    );
    const transactionId = candle.sourceTxIds[0] as string;
    assert.ok(
      !allSeenTransactions.has(transactionId),
      'all release-market candle source transactions must be distinct'
    );
    allSeenTransactions.add(transactionId);
  }
}

export async function runProductionSmoke(
  baseUrlInput = process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL,
  options: ProductionSmokeOptions = {}
) {
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const expectedNetworkWasExplicit =
    options.expectedNetwork !== undefined ||
    optionalTrimmed(process.env.TON_INDEXER_EXPECTED_NETWORK) !== undefined;
  const expectedNetwork = options.expectedNetwork ?? expectedNetworkFromEnv();
  const expectedServiceId =
    options.expectedServiceId ?? process.env.TON_INDEXER_EXPECTED_SERVICE_ID ?? 'ti.soramitsu.io';
  const expectedPublicBaseUrl = canonicalPublicBaseUrl(
    options.expectedPublicBaseUrl ??
      process.env.TON_INDEXER_EXPECTED_PUBLIC_BASE_URL ??
      'https://ti.soramitsu.io'
  );
  const strictRelease = resolveStrictReleaseExpectation(
    options,
    expectedNetwork,
    expectedNetworkWasExplicit
  );
  const expectedChainId = `ton:${expectedNetwork}`;
  const health = await fetchJson(baseUrl, '/api/indexer/v1/health') as HealthInfo;
  if ('ok' in health) {
    throw new Error('TI production routing points at a Solswap indexer contract: health contains ok. Route ti.soramitsu.io to the TON indexer deployment.');
  }
  if (health.lastMasterSeqno === undefined) {
    throw new Error(`TI production routing does not expose the TON health contract: expected lastMasterSeqno, received keys ${objectKeys(health)}.`);
  }
  assert.equal(health.serviceId, expectedServiceId, `health serviceId must be ${expectedServiceId}`);
  assert.equal(health.ecosystem, 'ton', 'health ecosystem must be ton');
  assert.equal(health.chainId, expectedChainId, `health chainId must be ${expectedChainId}`);
  assert.equal(health.network, expectedNetwork, `health network must be ${expectedNetwork}`);

  const serviceInfo = await fetchJson(baseUrl, '/api/indexer/v1/service-info') as ServiceInfo;
  assert.equal(serviceInfo.serviceId, expectedServiceId, `service-info serviceId must be ${expectedServiceId}`);
  assert.equal(serviceInfo.schemaVersion, 1, 'service-info schemaVersion must be 1');
  assert.equal(serviceInfo.ecosystem, 'ton', 'service-info ecosystem must be ton');
  assert.equal(serviceInfo.chainId, expectedChainId, `service-info chainId must be ${expectedChainId}`);
  assert.equal(serviceInfo.network, expectedNetwork, `service-info network must be ${expectedNetwork}`);
  assert.equal(
    serviceInfo.publicBaseUrl,
    expectedPublicBaseUrl,
    `service-info publicBaseUrl must be ${expectedPublicBaseUrl}`,
  );
  assert.equal(serviceInfo.readOnly, true, 'service-info readOnly must be true');
  assert.equal(
    serviceInfo.endpoints?.openapi,
    '/api/indexer/v1/openapi.json',
    'service-info openapi endpoint must be /api/indexer/v1/openapi.json',
  );
  if (strictRelease) {
    assert.equal(
      serviceInfo.release?.registryHash,
      strictRelease.registryHash,
      `service-info registryHash must be ${strictRelease.registryHash}`
    );
    assert.equal(
      serviceInfo.release?.releaseId,
      strictRelease.releaseId,
      `service-info releaseId must be ${strictRelease.releaseId}`
    );
    assert.equal(
      serviceInfo.release?.releaseManifestHash,
      strictRelease.releaseManifestHash,
      `service-info releaseManifestHash must be ${strictRelease.releaseManifestHash}`
    );
  }

  const contracts = await fetchJson(baseUrl, '/api/indexer/v1/contracts') as ContractsInfo;
  assert.equal(contracts.network, expectedNetwork, `contracts network must be ${expectedNetwork}`);
  assert.ok(
    contracts.contracts && typeof contracts.contracts === 'object' && !Array.isArray(contracts.contracts),
    'contracts payload must include a contracts object'
  );
  assert.equal(
    contracts.count,
    Object.keys(contracts.contracts as Record<string, unknown>).length,
    'contracts count must match the contract map'
  );
  if (strictRelease) {
    assertExactReleaseContracts(contracts.contracts, strictRelease);
    assert.equal(
      contracts.count,
      CANONICAL_RELEASE_CONTRACT_COUNT,
      `contracts count must be exactly ${CANONICAL_RELEASE_CONTRACT_COUNT}`
    );
    assert.equal(
      contracts.registry_hash,
      strictRelease.registryHash,
      `contracts registry_hash must be ${strictRelease.registryHash}`
    );
    assert.equal(
      contracts.release_id,
      strictRelease.releaseId,
      `contracts release_id must be ${strictRelease.releaseId}`
    );
    assert.equal(
      contracts.release_manifest_hash,
      strictRelease.releaseManifestHash,
      `contracts release_manifest_hash must be ${strictRelease.releaseManifestHash}`
    );
  }

  const spec = await fetchJson(baseUrl, '/api/indexer/v1/openapi.json') as OpenApiSpec;
  assert.equal(spec.openapi, '3.0.3', 'OpenAPI version must be 3.0.3');
  assert.equal(spec.info?.title, 'TONSWAP Indexer API', 'OpenAPI title must be TONSWAP Indexer API');
  assert.equal(spec.info?.version, '1.0.0', 'OpenAPI info.version must be 1.0.0');
  assert.equal(spec.servers?.[0]?.url, '/', 'OpenAPI primary server URL must be /');
  assertPath(spec, '/api/indexer/v1/service-info');
  assertPath(spec, '/api/indexer/v1/contracts');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/balance');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/balances');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/assets');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/txs');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/state');
  assertPath(spec, '/api/indexer/v1/markets/{market}/candles');
  assertPath(spec, '/api/indexer/v1/runGetMethod');
  assertPath(spec, '/api/indexer/v1/runGetMethods');

  if (strictRelease) {
    const allowedCors = await fetchJsonResponse(baseUrl, '/api/indexer/v1/service-info', {
      headers: { origin: strictRelease.expectedCorsOrigin },
    });
    assert.equal(
      allowedCors.headers.get('access-control-allow-origin'),
      strictRelease.expectedCorsOrigin,
      `allowed CORS origin must be ${strictRelease.expectedCorsOrigin}`
    );
    assert.equal(
      allowedCors.headers.get('access-control-allow-credentials'),
      'true',
      'allowed production CORS must enable credentials'
    );
    assert.ok(
      headerTokens(allowedCors.headers, 'vary').includes('origin'),
      'allowed production CORS must vary on Origin'
    );

    const hostileCors = await fetchJsonResponse(baseUrl, '/api/indexer/v1/service-info', {
      headers: { origin: strictRelease.hostileCorsOrigin },
    });
    assert.equal(
      hostileCors.headers.get('access-control-allow-origin'),
      null,
      `hostile CORS origin ${strictRelease.hostileCorsOrigin} must be denied`
    );
    assert.equal(
      hostileCors.headers.get('access-control-allow-credentials'),
      null,
      'hostile CORS origin must not receive credentials'
    );

    const allowedPreflight = await fetchCorsPreflight(
      baseUrl,
      '/api/indexer/v1/runGetMethod',
      strictRelease.expectedCorsOrigin
    );
    assert.ok(
      allowedPreflight.ok,
      `allowed production CORS preflight must succeed; got HTTP ${allowedPreflight.status}`
    );
    assert.equal(
      allowedPreflight.headers.get('access-control-allow-origin'),
      strictRelease.expectedCorsOrigin,
      `allowed preflight origin must be ${strictRelease.expectedCorsOrigin}`
    );
    assert.equal(
      allowedPreflight.headers.get('access-control-allow-credentials'),
      'true',
      'allowed production preflight must enable credentials'
    );
    assert.ok(
      headerTokens(allowedPreflight.headers, 'vary').includes('origin'),
      'allowed production preflight must vary on Origin'
    );
    assert.ok(
      headerTokens(allowedPreflight.headers, 'access-control-allow-methods').includes('post'),
      'allowed production preflight must permit POST'
    );
    const allowedHeaders = headerTokens(
      allowedPreflight.headers,
      'access-control-allow-headers'
    );
    for (const requiredHeader of ['content-type', 'accept']) {
      assert.ok(
        allowedHeaders.includes(requiredHeader),
        `allowed production preflight must permit ${requiredHeader}`
      );
    }

    const hostilePreflight = await fetchCorsPreflight(
      baseUrl,
      '/api/indexer/v1/runGetMethod',
      strictRelease.hostileCorsOrigin
    );
    assert.ok(
      hostilePreflight.status < 500,
      `hostile preflight denial must not be a server failure; got HTTP ${hostilePreflight.status}`
    );
    assert.equal(
      hostilePreflight.headers.get('access-control-allow-origin'),
      null,
      `hostile preflight origin ${strictRelease.hostileCorsOrigin} must be denied`
    );
    assert.equal(
      hostilePreflight.headers.get('access-control-allow-credentials'),
      null,
      'hostile preflight origin must not receive credentials'
    );

    // The canonical release manifest binds market identities and query metadata,
    // but does not carry the certified swap transaction IDs or time windows.
    // The canonical release wrapper verifies those proof-only values separately.
    const seenCandleTransactions = new Set<string>();
    for (const market of strictRelease.markets) {
      const history = await fetchJson(
        baseUrl,
        `/api/indexer/v1/markets/${encodeURIComponent(market.marketKey)}/candles`,
        {
          searchParams: new URLSearchParams({
            market_address: market.marketAddress,
            asset_symbol: market.assetSymbol,
            quote_symbol: market.quoteSymbol,
            asset_decimals: String(market.assetDecimals),
            quote_decimals: String(market.quoteDecimals),
            interval: '1m',
            limit: '2',
          }),
        }
      );
      assertTwoCandleHistory(history, market, expectedNetwork, seenCandleTransactions);
    }
    assert.equal(
      seenCandleTransactions.size,
      6,
      'three exact two-candle histories must bind six distinct transactions'
    );
  }

  process.stdout.write(`ton production smoke ok: ${baseUrl.toString()}\n`);
}

if (require.main === module) {
  const baseUrlInput = process.argv[2] || process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL;
  const expectedNetwork = process.argv[3] as ProductionSmokeOptions['expectedNetwork'] | undefined;
  const extraArguments = process.argv.slice(4);
  if (extraArguments.length > 0) {
    console.error(`ton production smoke failed for ${redactedBaseUrl(baseUrlInput)}`);
    console.error('Production smoke accepts only optional base URL and expected network positional arguments.');
    process.exit(1);
  }
  runProductionSmoke(baseUrlInput, { expectedNetwork }).catch((error) => {
    console.error(`ton production smoke failed for ${redactedBaseUrl(baseUrlInput)}`);
    console.error(error);
    process.exit(1);
  });
}
