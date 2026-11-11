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
};

type HealthInfo = {
  lastMasterSeqno?: unknown;
  indexerLagSec?: unknown;
  ok?: unknown;
  serviceId?: unknown;
  ecosystem?: unknown;
  chainId?: unknown;
  network?: unknown;
};

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export type ProductionSmokeOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxHealthLagSec?: number;
};

const DEFAULT_BASE_URL = 'https://ti.soramitsu.io';
const BODY_PREVIEW_LIMIT = 300;
const DIAGNOSTIC_LIMIT = 300;
const DIAGNOSTIC_SCAN_LIMIT = 4_096;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 5_242_880;
const DEFAULT_MAX_HEALTH_LAG_SEC = 300;
const MAX_HEALTH_LAG_SEC = 3_600;
const JSON_CONTENT_TYPE = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;\s*[a-z0-9!#$%&'*+.^_`|~-]+\s*=\s*(?:[a-z0-9!#$%&'*+.^_`|~-]+|"[^"\r\n]*"))*\s*$/i;
const TON_HEALTH_DEPLOYMENT_HINT =
  'Production health must expose serviceId=ti.soramitsu.io, ecosystem=ton, chainId=ton:mainnet, network=mainnet, and lastMasterSeqno. Deploy the current ton-indexer image to ti.soramitsu.io.';
const TON_SERVICE_INFO_DEPLOYMENT_HINT =
  'Production service-info must expose schemaVersion=1, serviceId=ti.soramitsu.io, ecosystem=ton, chainId=ton:mainnet, network=mainnet, publicBaseUrl=https://ti.soramitsu.io, readOnly=true, and endpoints.openapi=/api/indexer/v1/openapi.json. Deploy the current ton-indexer image to ti.soramitsu.io.';
const TON_OPENAPI_DEPLOYMENT_HINT =
  'Production OpenAPI must expose title TONSWAP Indexer API and required TON wallet routes at /api/indexer/v1/openapi.json. Deploy the current ton-indexer image to ti.soramitsu.io.';

export function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('TON production smoke URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('TON production smoke URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new Error('TON production smoke URL must not contain query strings or fragments');
  }
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    throw new Error('TON production smoke URL must use HTTPS outside localhost smoke tests');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function baseUrlForFailureLog(value: string): string {
  try {
    return normalizeBaseUrl(value).toString();
  } catch {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '<invalid URL>';
    }
  }
}

function endpoint(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl.toString());
  url.pathname = `${baseUrl.pathname}${path}`.replace(/\/{2,}/g, '/');
  return url;
}

function redactSecrets(value: string): string {
  return value
    .replace(/("(?:access[_-]?token|refresh[_-]?token|token|password|passwd|api[-_]?key|secret|authorization|cookie|set-cookie)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|[^,}\]\s]+)/gi, '$1"<redacted>"')
    .replace(/(\b(?:bearer|basic)\s+)[A-Za-z0-9+/=_~.-]+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|token|password|passwd|api[-_]?key|secret|authorization|key)=)[^&#\s]*/gi, '$1<redacted>')
    .replace(/(\b(?:access[_-]?token|refresh[_-]?token|token|password|passwd|api[-_]?key|secret|authorization)\b\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,;&]+)/gi, '$1<redacted>');
}

function bodyPreview(value: string): string {
  const compact = redactSecrets(value.slice(0, DIAGNOSTIC_SCAN_LIMIT)).replace(/\s+/g, ' ').trim();
  if (!compact) return '<empty body>';
  return compact.length > BODY_PREVIEW_LIMIT ? `${compact.slice(0, BODY_PREVIEW_LIMIT)}...` : compact;
}

function diagnosticPreview(value: unknown): string {
  const compact = redactSecrets(String(value ?? '').slice(0, DIAGNOSTIC_SCAN_LIMIT))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '<empty>';
  return compact.length > DIAGNOSTIC_LIMIT ? `${compact.slice(0, DIAGNOSTIC_LIMIT)}...` : compact;
}

class RequestTimeoutError extends Error {}
class ResponseTooLargeError extends Error {}
class RedirectRejectedError extends Error {
  constructor(readonly status: number) {
    super(`redirect response HTTP ${status}`);
  }
}

function boundedInteger(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const candidate = typeof value === 'string' ? value : String(value);
  if (!/^[1-9][0-9]*$/.test(candidate)) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxResponseBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maxResponseBytes) {
      throw new ResponseTooLargeError(`declared ${declared} bytes`);
    }
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxResponseBytes) throw new ResponseTooLargeError(`received more than ${maxResponseBytes} bytes`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(`received more than ${maxResponseBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function isJsonContentType(value: string): boolean {
  return JSON_CONTENT_TYPE.test(value.trim());
}

function formatFailureCause(cause: unknown, depth = 0): string {
  if (depth >= 3) return '<nested cause omitted>';
  if (cause instanceof Error) {
    const details = [diagnosticPreview(cause.message || cause.name)];
    const metadata = cause as unknown as Record<string, unknown>;
    for (const key of ['code', 'errno', 'syscall', 'hostname', 'address', 'port']) {
      const value = metadata[key];
      if (value !== undefined) details.push(`${key}=${diagnosticPreview(value)}`);
    }
    if ('cause' in cause && cause.cause !== undefined) {
      details.push(`cause=${formatFailureCause(cause.cause, depth + 1)}`);
    }
    return diagnosticPreview(details.join('; '));
  }

  if (typeof cause === 'string') return diagnosticPreview(cause);
  try {
    return diagnosticPreview(JSON.stringify(cause));
  } catch {
    return diagnosticPreview(cause);
  }
}

function requestFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause !== undefined
      ? `; cause: ${formatFailureCause(error.cause)}`
      : '';
    return diagnosticPreview(`${error.message}${cause}`);
  }
  return diagnosticPreview(error);
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

async function fetchJson(
  baseUrl: URL,
  path: string,
  { fetchImpl, timeoutMs, maxResponseBytes }: Required<Pick<ProductionSmokeOptions, 'fetchImpl' | 'timeoutMs' | 'maxResponseBytes'>>,
): Promise<unknown> {
  const requestUrl = endpoint(baseUrl, path);
  const controller = new AbortController();
  let response: Response;
  let rawBody: string;
  try {
    ({ response, rawBody } = await withinDeadline(async () => {
      const received = await fetchImpl(requestUrl, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (received.status >= 300 && received.status < 400) {
        throw new RedirectRejectedError(received.status);
      }
      return { response: received, rawBody: await readBoundedBody(received, maxResponseBytes) };
    }, controller, timeoutMs));
  } catch (error) {
    if (error instanceof RedirectRejectedError) {
      throw new Error(`${path} refused redirect HTTP ${error.status}; production smoke redirects are forbidden. ${deploymentHint(path)}`);
    }
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`${path} response exceeded the ${maxResponseBytes}-byte limit. ${deploymentHint(path)}`);
    }
    throw new Error(`${path} request to ${requestUrl.toString()} failed: ${requestFailureReason(error)}. ${deploymentHint(path)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}. Body preview: ${bodyPreview(rawBody)}. ${deploymentHint(path)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!isJsonContentType(contentType)) {
    throw new Error(`${path} did not return JSON. Content-Type: ${contentType ? diagnosticPreview(contentType) : '<missing>'}. Body preview: ${bodyPreview(rawBody)}. ${deploymentHint(path)}`);
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error(`${path} returned invalid JSON. Body preview: ${bodyPreview(rawBody)}. ${deploymentHint(path)}`);
  }
}

function objectKeys(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '<non-object>';
  return Object.keys(value as Record<string, unknown>).sort().join(',') || '<empty object>';
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (typeof value === 'string') return diagnosticPreview(value);
  return diagnosticPreview(JSON.stringify(value));
}

function assertHealthField(value: unknown, expected: string, message: string) {
  if (value !== expected) {
    throw new Error(`${message}; received ${formatValue(value)}. ${TON_HEALTH_DEPLOYMENT_HINT}`);
  }
}

function assertServiceInfoField(value: unknown, expected: unknown, message: string) {
  if (value !== expected) {
    throw new Error(`${message}; received ${formatValue(value)}. ${TON_SERVICE_INFO_DEPLOYMENT_HINT}`);
  }
}

function assertOpenApiTitle(value: unknown) {
  if (value !== 'TONSWAP Indexer API') {
    throw new Error(`OpenAPI title must be TONSWAP Indexer API; received ${formatValue(value)}. ${TON_OPENAPI_DEPLOYMENT_HINT}`);
  }
}

function assertOpenApiPath(spec: OpenApiSpec, path: string) {
  if (!spec.paths?.[path]) {
    throw new Error(`OpenAPI is missing ${path}. ${TON_OPENAPI_DEPLOYMENT_HINT}`);
  }
}

export async function runProductionSmoke(
  baseUrlInput = process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL,
  options: ProductionSmokeOptions = {},
) {
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const requestOptions = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: boundedInteger(
      options.timeoutMs ?? process.env.TON_INDEXER_SMOKE_TIMEOUT_MS,
      'TON_INDEXER_SMOKE_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes ?? process.env.TON_INDEXER_SMOKE_MAX_RESPONSE_BYTES,
      'TON_INDEXER_SMOKE_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    ),
  };
  const maxHealthLagSec = boundedInteger(
    options.maxHealthLagSec ?? process.env.TON_INDEXER_SMOKE_MAX_HEALTH_LAG_SEC,
    'TON_INDEXER_SMOKE_MAX_HEALTH_LAG_SEC',
    DEFAULT_MAX_HEALTH_LAG_SEC,
    MAX_HEALTH_LAG_SEC,
  );
  const health = await fetchJson(baseUrl, '/api/indexer/v1/health', requestOptions) as HealthInfo;
  if ('ok' in health) {
    throw new Error('TI production routing points at a Solswap indexer contract: health contains ok. Route ti.soramitsu.io to the TON indexer deployment.');
  }
  if (health.lastMasterSeqno === undefined) {
    throw new Error(`TI production routing does not expose the TON health contract: expected lastMasterSeqno, received keys ${objectKeys(health)}. ${TON_HEALTH_DEPLOYMENT_HINT}`);
  }
  if (!Number.isSafeInteger(health.lastMasterSeqno) || Number(health.lastMasterSeqno) <= 0) {
    throw new Error(`health lastMasterSeqno must be a positive safe integer; received ${formatValue(health.lastMasterSeqno)}. ${TON_HEALTH_DEPLOYMENT_HINT}`);
  }
  if (typeof health.indexerLagSec !== 'number' || !Number.isFinite(health.indexerLagSec) || health.indexerLagSec < 0) {
    throw new Error(`health indexerLagSec must be a non-negative finite number; received ${formatValue(health.indexerLagSec)}. ${TON_HEALTH_DEPLOYMENT_HINT}`);
  }
  if (health.indexerLagSec > maxHealthLagSec) {
    throw new Error(`health indexerLagSec must be at most ${maxHealthLagSec}; received ${formatValue(health.indexerLagSec)}. ${TON_HEALTH_DEPLOYMENT_HINT}`);
  }
  assertHealthField(health.serviceId, 'ti.soramitsu.io', 'health serviceId must be ti.soramitsu.io');
  assertHealthField(health.ecosystem, 'ton', 'health ecosystem must be ton');
  assertHealthField(health.chainId, 'ton:mainnet', 'health chainId must be ton:mainnet');
  assertHealthField(health.network, 'mainnet', 'health network must be mainnet');

  const serviceInfo = await fetchJson(baseUrl, '/api/indexer/v1/service-info', requestOptions) as ServiceInfo;
  assertServiceInfoField(serviceInfo.serviceId, 'ti.soramitsu.io', 'service-info serviceId must be ti.soramitsu.io');
  assertServiceInfoField(serviceInfo.schemaVersion, 1, 'service-info schemaVersion must be 1');
  assertServiceInfoField(serviceInfo.ecosystem, 'ton', 'service-info ecosystem must be ton');
  assertServiceInfoField(serviceInfo.chainId, 'ton:mainnet', 'service-info chainId must be ton:mainnet');
  assertServiceInfoField(serviceInfo.network, 'mainnet', 'service-info network must be mainnet');
  assertServiceInfoField(
    serviceInfo.publicBaseUrl,
    'https://ti.soramitsu.io',
    'service-info publicBaseUrl must be https://ti.soramitsu.io',
  );
  assertServiceInfoField(serviceInfo.readOnly, true, 'service-info readOnly must be true');
  assertServiceInfoField(
    serviceInfo.endpoints?.openapi,
    '/api/indexer/v1/openapi.json',
    'service-info openapi endpoint must be /api/indexer/v1/openapi.json',
  );

  const spec = await fetchJson(baseUrl, '/api/indexer/v1/openapi.json', requestOptions) as OpenApiSpec;
  assertOpenApiTitle(spec.info?.title);
  assertOpenApiPath(spec, '/api/indexer/v1/service-info');
  assertOpenApiPath(spec, '/api/indexer/v1/accounts/{addr}/balance');
  assertOpenApiPath(spec, '/api/indexer/v1/accounts/{addr}/balances');
  assertOpenApiPath(spec, '/api/indexer/v1/accounts/{addr}/assets');
  assertOpenApiPath(spec, '/api/indexer/v1/accounts/{addr}/txs');
  assertOpenApiPath(spec, '/api/indexer/v1/accounts/{addr}/state');
  assertOpenApiPath(spec, '/api/indexer/v1/runGetMethod');
  assertOpenApiPath(spec, '/api/indexer/v1/runGetMethods');

  process.stdout.write(`ton production smoke ok: ${baseUrl.toString()}\n`);
}

if (require.main === module) {
  const baseUrlInput = process.argv[2] || process.env.TON_INDEXER_BASE_URL || DEFAULT_BASE_URL;
  runProductionSmoke(baseUrlInput).catch((error) => {
    console.error(`ton production smoke failed for ${baseUrlForFailureLog(baseUrlInput)}`);
    console.error(error);
    process.exit(1);
  });
}
