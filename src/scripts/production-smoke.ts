import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Address } from '@ton/core';
import { isAbsolute } from 'node:path';
import { publicIndexerPath, publicIndexerUrl } from '../api/publicMount';
import {
  readCanonicalReleaseManifest,
  type RegistrySpotMarketMetadata,
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
    manifestHash?: unknown;
  };
};

type HealthInfo = {
  chain?: {peersConfigured?: unknown; peersReady?: unknown; headSeqno?: unknown; headAgeSec?: unknown};
  ledger?: unknown;
  disk?: unknown;
  ok?: unknown;
  serviceId?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
};

type ContractsInfo = {
  network?: unknown;
  count?: unknown;
  release?: { releaseId?: unknown; manifestHash?: unknown };
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
  token_root?: unknown;
  asset_symbol?: unknown;
  quote_symbol?: unknown;
  asset_decimals?: unknown;
  quote_decimals?: unknown;
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
  expectedReleaseId?: string;
  expectedReleaseManifestHash?: string;
  expectedReleaseManifestPath?: string;
  expectedCorsOrigin?: string;
  hostileCorsOrigin?: string;
  /** Isolated transport-test seam. The production CLI always requires a manifest. */
  allowUnboundRelease?: boolean;
};

const DEFAULT_HOSTILE_CORS_ORIGIN = 'https://hostile.tonswap.invalid';
const SHA256_RE = /^[0-9a-f]{64}$/;
type StrictReleaseExpectation = {
  indexer: string;
  releaseId: string;
  releaseManifestHash: string;
  contracts: Record<string, string>;
  markets: RegistrySpotMarketMetadata[];
  tokens: Array<{root: string; symbol: string; decimals: number}>;
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

export function redactedBaseUrl(value: string | undefined): string {
  if (value === undefined) return '<native manifest indexer>';
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

export function productionSmokeBaseUrl(target: string | undefined, indexer?: string): URL {
  const selected = target ?? indexer;
  if (!selected) throw Error('Smoke requires the native manifest indexer URL or an explicit transport-test target.');
  const base = normalizeBaseUrl(selected);
  if (indexer === undefined) {
    // The explicitly unbound transport-test seam has an origin/prefix, not a native manifest.
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/indexer`;
    return base;
  }
  const mount = new URL(indexer).pathname.replace(/\/+$/, '');
  const requested = base.pathname.replace(/\/+$/, '');
  if (requested && requested !== mount) throw Error('Smoke target path differs from the native indexer mount');
  base.pathname = mount || '/';
  // Validate the complete mount using the same builder as discovery.
  publicIndexerPath(indexer, '/api/indexer/v1/health');
  return base;
}

function endpoint(baseUrl: URL, path: string, searchParams?: URLSearchParams): URL {
  return publicIndexerUrl(baseUrl.toString(), path, searchParams);
}

function bodyEvidence(value: string): string {
  const bytes = Buffer.byteLength(value);
  const digest = createHash('sha256').update(value).digest('hex');
  return `${bytes} bytes, sha256=${digest}`;
}

function deploymentHint(baseUrl: URL, path: string): string {
  return `Production routing must serve the manifest-bound TON API at ${endpoint(baseUrl, path).toString()}.`;
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
    throw new Error(`${path} returned HTTP ${response.status}. Body evidence: ${bodyEvidence(rawBody)}. ${deploymentHint(baseUrl, path)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${path} did not return JSON. Content-Type: ${contentType || '<missing>'}. Body evidence: ${bodyEvidence(rawBody)}. ${deploymentHint(baseUrl, path)}`);
  }

  try {
    return { body: JSON.parse(rawBody), headers: response.headers };
  } catch {
    throw new Error(`${path} returned invalid JSON. Body evidence: ${bodyEvidence(rawBody)}. ${deploymentHint(baseUrl, path)}`);
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

function resolveStrictReleaseExpectation(
  options: ProductionSmokeOptions,
  expectedNetwork: 'mainnet' | 'testnet' | 'localnet',
  expectedNetworkWasExplicit: boolean
): StrictReleaseExpectation | null {
  const releaseId = optionOrEnv(options.expectedReleaseId, 'TON_INDEXER_EXPECTED_RELEASE_ID');
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
    releaseManifestHash,
    releaseManifestPath,
    expectedCorsOrigin,
    configuredHostileCorsOrigin,
  ].some((value) => value !== undefined);
  if (!releaseInputPresent) {
    if (options.allowUnboundRelease === true) return null;
    throw new Error(
      'Release-bound production smoke requires explicit network, release ID, manifest path/hash, and allowed CORS origin inputs.'
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
    manifest.manifestHash,
    exactReleaseManifestHash,
    `release manifest manifestHash must be ${exactReleaseManifestHash}`
  );
  assert.ok(Object.keys(manifest.contracts).length > 0, 'release manifest must bind deployed contracts');
  if (expectedNetwork === 'testnet') assert.ok(manifest.contracts.TestnetFaucet, 'release manifest must include TestnetFaucet');
  assert.ok(manifest.spotMarkets.length > 0, 'release manifest must contain configured spot markets');

  return {
    indexer: manifest.runtime.services.indexer,
    releaseId,
    releaseManifestHash: exactReleaseManifestHash,
    contracts: manifest.contracts,
    markets: manifest.spotMarkets,
    tokens: manifest.runtime.tokens,
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
    Object.keys(expected.contracts).length,
    'contracts payload count must match the supplied release manifest'
  );
  assert.deepEqual(contracts, expected.contracts, 'contracts payload must exactly match the release manifest');
}

function assertCandleHistory(
  raw: unknown,
  market: RegistrySpotMarketMetadata,
  expectedNetwork: 'mainnet' | 'testnet' | 'localnet',
  allSeenTransactions: Set<string>,
): void {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), `${market.marketKey} candles must be an object`);
  const history = raw as MarketCandlesInfo;
  assert.equal(history.market_key, market.marketKey, `${market.marketKey} market_key mismatch`);
  assert.equal(history.market_address, market.marketAddress, `${market.marketKey} market_address mismatch`);
  assert.equal(history.token_root, market.tokenRoot, `${market.marketKey} token_root mismatch`);
  assert.equal(history.asset_symbol, market.assetSymbol, `${market.marketKey} asset_symbol mismatch`);
  assert.equal(history.quote_symbol, market.quoteSymbol, `${market.marketKey} quote_symbol mismatch`);
  assert.equal(history.asset_decimals, market.assetDecimals, `${market.marketKey} asset_decimals mismatch`);
  assert.equal(history.quote_decimals, market.quoteDecimals, `${market.marketKey} quote_decimals mismatch`);
  assert.equal(history.interval, '1m', `${market.marketKey} interval must be 1m`);
  assert.equal(history.from_utime, null, `${market.marketKey} from_utime must reflect the unbounded manifest query`);
  assert.equal(history.to_utime, null, `${market.marketKey} to_utime must reflect the unbounded manifest query`);
  assert.equal(history.network, expectedNetwork, `${market.marketKey} network must be ${expectedNetwork}`);
  assert.equal(history.history_complete, true, `${market.marketKey} history_complete must be true`);
  assert.ok(
    Number.isSafeInteger(history.synced_at) && Number(history.synced_at) > 0,
    `${market.marketKey} synced_at must be a positive safe integer`
  );
  assert.ok(Array.isArray(history.candles), `${market.marketKey} candles must be an array`);
  assert.equal(history.candle_count, history.candles.length, `${market.marketKey} candle_count must match its array`);
  assert.ok(history.candles.length <= 2, `${market.marketKey} candles exceed the requested limit`);

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
    assert.ok(Number.isSafeInteger(candle.tradeCount) && Number(candle.tradeCount) > 0,
      `${market.marketKey} candle ${index} must have positive tradeCount`);
    assert.ok(Number(candle.high) >= Math.max(Number(candle.open), Number(candle.close)) &&
      Number(candle.low) <= Math.min(Number(candle.open), Number(candle.close)), `${market.marketKey} invalid OHLC bounds`);
    if (candle.tradeCount === 1) {
      assert.equal(candle.open, candle.high, `${market.marketKey} single-trade candle open/high mismatch`);
      assert.equal(candle.open, candle.low, `${market.marketKey} single-trade candle open/low mismatch`);
      assert.equal(candle.open, candle.close, `${market.marketKey} single-trade candle open/close mismatch`);
      const derivedPrice = Number(candle.volumeQuote) / Number(candle.volumeBase),
        priceDelta = Math.abs(derivedPrice - Number(candle.close)),
        priceScale = Math.max(1, Math.abs(derivedPrice), Math.abs(Number(candle.close)));
      assert.ok(priceDelta <= Number.EPSILON * 8 * priceScale, `${market.marketKey} single-trade candle price must match its volumes`);
    }
    assert.ok(Array.isArray(candle.sourceTxIds) && candle.sourceTxIds.length > 0 &&
      candle.sourceTxIds.length <= Number(candle.tradeCount), `${market.marketKey} candle ${index} must bind source transactions`);
    for (const transactionId of candle.sourceTxIds) {
      assert.ok(typeof transactionId === 'string' && transactionId.length > 0 && transactionId.length <= 512 &&
        transactionId === transactionId.trim() && !/[\u0000-\u001f\u007f]/.test(transactionId), `${market.marketKey} invalid source transaction`);
      assert.ok(!allSeenTransactions.has(transactionId), 'all release-market candle source transactions must be distinct');
      allSeenTransactions.add(transactionId);
    }
  }
}

export async function runProductionSmoke(
  baseUrlInput?: string,
  options: ProductionSmokeOptions = {}
) {
  const expectedNetworkWasExplicit =
    options.expectedNetwork !== undefined ||
    optionalTrimmed(process.env.TON_INDEXER_EXPECTED_NETWORK) !== undefined;
  const expectedNetwork = options.expectedNetwork ?? expectedNetworkFromEnv();
  const strictRelease = resolveStrictReleaseExpectation(
    options,
    expectedNetwork,
    expectedNetworkWasExplicit
  );
  const baseUrl = productionSmokeBaseUrl(baseUrlInput ?? process.env.TON_INDEXER_BASE_URL, strictRelease?.indexer);
  const publicPath = (route: string) => publicIndexerPath(strictRelease?.indexer, route);
  const nativeUrl = strictRelease ? new URL(strictRelease.indexer) : undefined;
  const nativeServiceId = nativeUrl && `${nativeUrl.host}${nativeUrl.pathname.replace(/\/$/, '')}`;
  const expectedServiceId = options.expectedServiceId ?? process.env.TON_INDEXER_EXPECTED_SERVICE_ID ?? nativeServiceId;
  const publicBaseOverride = options.expectedPublicBaseUrl ?? process.env.TON_INDEXER_EXPECTED_PUBLIC_BASE_URL;
  if (!expectedServiceId || !strictRelease && !publicBaseOverride)
    throw Error('Unbound transport smoke requires an explicit expected service identity and public URL.');
  const expectedPublicBaseUrl = strictRelease?.indexer ?? canonicalPublicBaseUrl(publicBaseOverride!);
  if (strictRelease) {
    assert.equal(expectedServiceId, nativeServiceId, 'Expected service identity differs from the native manifest');
    if (publicBaseOverride !== undefined) {
      assert.equal(publicBaseOverride, strictRelease.indexer, 'Expected public URL differs from the native manifest');
    }
  }
  const expectedChainId = `ton:${expectedNetwork}`;
  const health = await fetchJson(baseUrl, '/api/indexer/v1/health') as HealthInfo;
  if ('ok' in health) {
    throw new Error('Production routing points at a Solswap indexer contract: health contains ok. Route the selected manifest mount to its TON indexer deployment.');
  }
  if (!health.chain || typeof health.chain !== 'object') {
    throw new Error(`Production routing does not expose the TON health contract: expected chain, received keys ${objectKeys(health)}.`);
  }
  assert.ok(Number.isInteger(health.chain.peersConfigured) && Number(health.chain.peersConfigured) > 0, 'health chain must configure peers');
  assert.ok(Number.isInteger(health.chain.peersReady) && Number(health.chain.peersReady) > 0, 'health chain must have ready peers');
  assert.ok(Number.isInteger(health.chain.headSeqno) && Number(health.chain.headSeqno) > 0, 'health chain must expose the observed head');
  assert.ok(typeof health.chain.headAgeSec === 'number' && health.chain.headAgeSec >= 0, 'health chain must expose head age');
  assert.ok(['disabled','connecting','ready','unavailable'].includes(String(health.ledger)), 'health ledger state is required');
  assert.ok(['ok','low','critical'].includes(String(health.disk)), 'health disk state is required');
  assert.equal('liteserverPoolStatus' in health, false, 'health must not expose the retired pool status');
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
    publicPath('/api/indexer/v1/openapi.json'),
    'service-info openapi endpoint must match the native indexer mount',
  );
  if (strictRelease) {
    assert.deepEqual(Object.keys(serviceInfo.release ?? {}).sort(), ['manifestHash', 'releaseId']);
    assert.equal(
      serviceInfo.release?.releaseId,
      strictRelease.releaseId,
      `service-info releaseId must be ${strictRelease.releaseId}`
    );
    assert.equal(
      serviceInfo.release?.manifestHash,
      strictRelease.releaseManifestHash,
      `service-info manifestHash must be ${strictRelease.releaseManifestHash}`
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
      Object.keys(strictRelease.contracts).length,
      'contracts count must match the supplied release manifest'
    );
    assert.deepEqual(Object.keys(contracts.release ?? {}).sort(), ['manifestHash', 'releaseId']);
    assert.equal(
      contracts.release?.releaseId,
      strictRelease.releaseId,
      `contracts releaseId must be ${strictRelease.releaseId}`
    );
    assert.equal(
      contracts.release?.manifestHash,
      strictRelease.releaseManifestHash,
      `contracts manifestHash must be ${strictRelease.releaseManifestHash}`
    );
  }

  const account = Address.parse(String((contracts.contracts as Record<string,string>).T3Root ?? Object.values(contracts.contracts as Record<string,string>)[0])).toRawString();
  const balances = await fetchJson(baseUrl, `/api/indexer/v1/accounts/${account}/balances`) as Record<string, any>;
  assert.deepEqual(Object.keys(balances).sort(), ['address','assets','complete','head_seqno','head_utime','network']);
  assert.equal(balances.address, account); assert.equal(balances.network, expectedNetwork);
  assert.ok(Number.isInteger(balances.head_seqno) && balances.head_seqno > 0, 'balances must expose a chain head');
  assert.ok(Number.isInteger(balances.head_utime) && balances.head_utime > 0, 'balances must expose chain time');
  assert.equal(typeof balances.complete, 'boolean'); assert.ok(Array.isArray(balances.assets));
  const native = balances.assets.filter((row: any) => row.kind === 'native');
  assert.equal(native.length, 1); assert.equal(native[0].symbol,'GRAM'); assert.equal(native[0].status,'ok'); assert.equal(native[0].decimals,9);
  assert.deepEqual(Object.keys(native[0]).sort(), ['balance_raw','decimals','kind','status','symbol']);
  const jettons = balances.assets.filter((row: any) => row.kind === 'jetton');
  assert.equal(native.length + jettons.length, balances.assets.length);
  if (strictRelease) assert.deepEqual(jettons.map((row: any) => [row.root,row.symbol,row.decimals]).sort(),
    strictRelease.tokens.map(row => [row.root,row.symbol,row.decimals]).sort(), 'balances must include every manifest token with explicit precision');
  for (const row of balances.assets) {
    assert.ok(Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 255);
    if (row.kind === 'jetton') {
      assert.equal(Address.parse(row.root).toRawString(),row.root);
      assert.ok(row.wallet === null || Address.parse(row.wallet).toRawString() === row.wallet);
      assert.ok(['ok','not_deployed','unavailable'].includes(row.status));
      assert.deepEqual(Object.keys(row).sort(), (row.status === 'unavailable'
        ? ['balance_raw','decimals','kind','reason','root','status','symbol','wallet']
        : ['balance_raw','decimals','kind','root','status','symbol','wallet']));
    }
    if (row.status === 'unavailable') { assert.equal(row.balance_raw,null); assert.ok(['timeout','upstream','code_mismatch','root_unqualified'].includes(row.reason)); }
    else { assert.match(row.balance_raw,/^(0|[1-9][0-9]*)$/); if (row.status === 'not_deployed') assert.equal(row.balance_raw,'0'); }
  }
  assert.equal(balances.complete, balances.assets.every((row: any) => row.status !== 'unavailable'));
  const unknown = await fetch(endpoint(baseUrl,'/api/indexer/v1/smoke-unknown-route'), {redirect:'error'});
  assert.equal(unknown.status,404); const missing = await unknown.json() as Record<string,unknown>;
  assert.deepEqual(Object.keys(missing).sort(),['code','error']); assert.equal(missing.code,'not_found');
  assert.equal(typeof missing.error,'string'); assert.equal(String(missing.error).includes('smoke-unknown-route'),false);

  const spec = await fetchJson(baseUrl, '/api/indexer/v1/openapi.json') as OpenApiSpec;
  assert.equal(spec.openapi, '3.1.0', 'OpenAPI version must be 3.1.0');
  assert.equal(spec.info?.title, 'TONSWAP Indexer API', 'OpenAPI title must be TONSWAP Indexer API');
  assert.equal(spec.info?.version, '1.0.0', 'OpenAPI info.version must be 1.0.0');
  assert.equal(spec.servers?.[0]?.url, '/', 'OpenAPI primary server URL must be /');
  assertPath(spec, publicPath('/api/indexer/v1/service-info'));
  assertPath(spec, publicPath('/api/indexer/v1/contracts'));
  assertPath(spec, publicPath('/api/indexer/v1/accounts/{addr}/balances'));
  assertPath(spec, publicPath('/api/indexer/v1/accounts/{addr}/txs'));
  assertPath(spec, publicPath('/api/indexer/v1/accounts/{addr}/state'));
  assertPath(spec, publicPath('/api/indexer/v1/markets/{market}/candles'));
  assertPath(spec, publicPath('/api/indexer/v1/runGetMethod'));

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
      assertCandleHistory(history, market, expectedNetwork, seenCandleTransactions);
    }

  }

  process.stdout.write(`ton production smoke ok: ${baseUrl.toString()}\n`);
}

if (require.main === module) {
  const baseUrlInput = process.argv[2] || process.env.TON_INDEXER_BASE_URL;
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
