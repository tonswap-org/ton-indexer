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
  publicBaseUrl?: unknown;
  readOnly?: unknown;
};

const DEFAULT_BASE_URL = 'https://ti.soramitsu.io';

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

async function fetchJson(baseUrl: URL, path: string): Promise<unknown> {
  const response = await fetch(endpoint(baseUrl, path), {
    headers: { accept: 'application/json' }
  });
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  assert.match(contentType, /application\/json/i, `${path} did not return JSON`);
  return response.json();
}

function assertPath(spec: OpenApiSpec, path: string) {
  assert.ok(spec.paths?.[path], `OpenAPI is missing ${path}`);
}

export async function runProductionSmoke(baseUrlInput = process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL) {
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const health = await fetchJson(baseUrl, '/api/indexer/v1/health') as { lastMasterSeqno?: unknown; ok?: unknown };
  assert.notEqual(
    health.lastMasterSeqno,
    undefined,
    'TON health response must include lastMasterSeqno',
  );
  assert.equal('ok' in health, false, 'TON health response looks like the Solswap indexer contract');

  const serviceInfo = await fetchJson(baseUrl, '/api/indexer/v1/service-info') as ServiceInfo;
  assert.equal(serviceInfo.serviceId, 'ti.soramitsu.io', 'service-info serviceId must be ti.soramitsu.io');
  assert.equal(serviceInfo.ecosystem, 'ton', 'service-info ecosystem must be ton');
  assert.equal(serviceInfo.chainId, 'ton:mainnet', 'service-info chainId must be ton:mainnet');
  assert.equal(
    serviceInfo.publicBaseUrl,
    'https://ti.soramitsu.io',
    'service-info publicBaseUrl must be https://ti.soramitsu.io',
  );
  assert.equal(serviceInfo.readOnly, true, 'service-info readOnly must be true');

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
