import assert from 'node:assert/strict';

type OpenApiSpec = {
  info?: {
    title?: string;
  };
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
  contracts?: unknown;
};

export type ProductionSmokeOptions = {
  expectedNetwork?: 'mainnet' | 'testnet' | 'localnet';
  expectedServiceId?: string;
  expectedPublicBaseUrl?: string;
  expectedRegistryHash?: string;
  expectedReleaseId?: string;
};

const DEFAULT_BASE_URL = 'https://ti.soramitsu.io';
const BODY_PREVIEW_LIMIT = 300;

export function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl.toString());
  url.pathname = `${baseUrl.pathname}${path}`.replace(/\/{2,}/g, '/');
  return url;
}

function bodyPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '<empty body>';
  return compact.length > BODY_PREVIEW_LIMIT ? `${compact.slice(0, BODY_PREVIEW_LIMIT)}...` : compact;
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

async function fetchJson(baseUrl: URL, path: string): Promise<unknown> {
  const response = await fetch(endpoint(baseUrl, path), {
    headers: { accept: 'application/json' }
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}. Body preview: ${bodyPreview(rawBody)}. ${deploymentHint(path)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${path} did not return JSON. Content-Type: ${contentType || '<missing>'}. Body preview: ${bodyPreview(rawBody)}. ${deploymentHint(path)}`);
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error(`${path} returned invalid JSON. Body preview: ${bodyPreview(rawBody)}. ${deploymentHint(path)}`);
  }
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

export async function runProductionSmoke(
  baseUrlInput = process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL,
  options: ProductionSmokeOptions = {}
) {
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const expectedNetwork = options.expectedNetwork ?? expectedNetworkFromEnv();
  const expectedServiceId =
    options.expectedServiceId ?? process.env.TON_INDEXER_EXPECTED_SERVICE_ID ?? 'ti.soramitsu.io';
  const expectedPublicBaseUrl =
    options.expectedPublicBaseUrl ??
    process.env.TON_INDEXER_EXPECTED_PUBLIC_BASE_URL ??
    'https://ti.soramitsu.io';
  const expectedRegistryHash =
    options.expectedRegistryHash ?? process.env.TON_INDEXER_EXPECTED_REGISTRY_HASH;
  const expectedReleaseId =
    options.expectedReleaseId ?? process.env.TON_INDEXER_EXPECTED_RELEASE_ID;
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
  if (expectedRegistryHash) {
    assert.equal(
      serviceInfo.release?.registryHash,
      expectedRegistryHash,
      `service-info registryHash must be ${expectedRegistryHash}`
    );
  }
  if (expectedReleaseId) {
    assert.equal(
      serviceInfo.release?.releaseId,
      expectedReleaseId,
      `service-info releaseId must be ${expectedReleaseId}`
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
  if (expectedRegistryHash) {
    assert.equal(
      contracts.registry_hash,
      expectedRegistryHash,
      `contracts registry_hash must be ${expectedRegistryHash}`
    );
  }
  if (expectedReleaseId) {
    assert.equal(
      contracts.release_id,
      expectedReleaseId,
      `contracts release_id must be ${expectedReleaseId}`
    );
  }

  const spec = await fetchJson(baseUrl, '/api/indexer/v1/openapi.json') as OpenApiSpec;
  assert.equal(spec.info?.title, 'TONSWAP Indexer API', 'OpenAPI title must be TONSWAP Indexer API');
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

  process.stdout.write(`ton production smoke ok: ${baseUrl.toString()}\n`);
}

if (require.main === module) {
  const baseUrlInput = process.argv[2] || process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL;
  const expectedNetwork = process.argv[3] as ProductionSmokeOptions['expectedNetwork'] | undefined;
  runProductionSmoke(baseUrlInput, { expectedNetwork }).catch((error) => {
    console.error(`ton production smoke failed for ${normalizeBaseUrl(baseUrlInput).toString()}`);
    console.error(error);
    process.exit(1);
  });
}
