import assert from 'node:assert/strict';

type OpenApiSpec = {
  info?: {
    title?: string;
  };
  paths?: Record<string, unknown>;
};

type ServiceInfo = {
  serviceId?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
  publicBaseUrl?: unknown;
  readOnly?: unknown;
  endpoints?: {
    openapi?: unknown;
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

export async function runProductionSmoke(baseUrlInput = process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL) {
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const health = await fetchJson(baseUrl, '/api/indexer/v1/health') as HealthInfo;
  if ('ok' in health) {
    throw new Error('TI production routing points at a Solswap indexer contract: health contains ok. Route ti.soramitsu.io to the TON indexer deployment.');
  }
  if (health.lastMasterSeqno === undefined) {
    throw new Error(`TI production routing does not expose the TON health contract: expected lastMasterSeqno, received keys ${objectKeys(health)}.`);
  }
  assert.equal(health.serviceId, 'ti.soramitsu.io', 'health serviceId must be ti.soramitsu.io');
  assert.equal(health.ecosystem, 'ton', 'health ecosystem must be ton');
  assert.equal(health.chainId, 'ton:mainnet', 'health chainId must be ton:mainnet');
  assert.equal(health.network, 'mainnet', 'health network must be mainnet');

  const serviceInfo = await fetchJson(baseUrl, '/api/indexer/v1/service-info') as ServiceInfo;
  assert.equal(serviceInfo.serviceId, 'ti.soramitsu.io', 'service-info serviceId must be ti.soramitsu.io');
  assert.equal(serviceInfo.ecosystem, 'ton', 'service-info ecosystem must be ton');
  assert.equal(serviceInfo.chainId, 'ton:mainnet', 'service-info chainId must be ton:mainnet');
  assert.equal(serviceInfo.network, 'mainnet', 'service-info network must be mainnet');
  assert.equal(
    serviceInfo.publicBaseUrl,
    'https://ti.soramitsu.io',
    'service-info publicBaseUrl must be https://ti.soramitsu.io',
  );
  assert.equal(serviceInfo.readOnly, true, 'service-info readOnly must be true');
  assert.equal(
    serviceInfo.endpoints?.openapi,
    '/api/indexer/v1/openapi.json',
    'service-info openapi endpoint must be /api/indexer/v1/openapi.json',
  );

  const spec = await fetchJson(baseUrl, '/api/indexer/v1/openapi.json') as OpenApiSpec;
  assert.equal(spec.info?.title, 'TONSWAP Indexer API', 'OpenAPI title must be TONSWAP Indexer API');
  assertPath(spec, '/api/indexer/v1/service-info');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/balance');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/balances');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/assets');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/txs');
  assertPath(spec, '/api/indexer/v1/accounts/{addr}/state');
  assertPath(spec, '/api/indexer/v1/runGetMethod');
  assertPath(spec, '/api/indexer/v1/runGetMethods');

  process.stdout.write(`ton production smoke ok: ${baseUrl.toString()}\n`);
}

if (require.main === module) {
  const baseUrlInput = process.argv[2] || process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL;
  runProductionSmoke(baseUrlInput).catch((error) => {
    console.error(`ton production smoke failed for ${normalizeBaseUrl(baseUrlInput).toString()}`);
    console.error(error);
    process.exit(1);
  });
}
