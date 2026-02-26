import { Address, Cell } from '@ton/core';
import { getHttpEndpoints } from '@orbs-network/ton-access';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IndexerService } from '../indexerService';
import { MetricsService } from '../metrics';
import { SnapshotService } from '../snapshotService';
import { AdminGuard } from './admin';
import { DebugService } from '../debugService';
import { RateLimiter } from './rateLimit';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from './validation';
import {
  addressParamsSchema,
  coverSnapshotQuerySchema,
  debugQuerySchema,
  farmsSnapshotQuerySchema,
  governanceSnapshotQuerySchema,
  optionsSnapshotQuerySchema,
  perpsSnapshotQuerySchema,
  swapQuerySchema,
  txQuerySchema
} from './schemas';
import { buildOpenApi } from './openapi';
import { buildDocsHtml } from './docsHtml';
import { sendError } from './errors';

const BALANCE_STREAM_POLL_MS = 1_500;
const BALANCE_STREAM_KEEPALIVE_MS = 15_000;
const BALANCE_STREAM_MAX_ADDRESSES = 8;
const GET_METHOD_MAX_STACK_ITEMS = 16;
const GET_METHOD_MAX_BATCH_CALLS = 64;
const GET_METHOD_BATCH_CONCURRENCY = 10;
const GET_METHOD_CALL_TIMEOUT_MS = 6_000;
const RPC_PROXY_DEFAULT_TIMEOUT_MS = 30_000;
const RPC_PROXY_DEFAULT_RETRY_ATTEMPTS = 4;
const RPC_PROXY_DEFAULT_RETRY_DELAY_MS = 600;
const RPC_PROXY_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const TON_RPC_PROXY_METHODS = new Set(['sendBoc', 'sendBocReturnHash', 'estimateFee', 'getMasterchainInfo']);

type ToncenterStackEntry = [string, unknown];
type ToncenterRpcCompatResponse<T> = { ok: true; result: T } | { ok: false; error: string; code?: number };
type ToncenterRpcCompatRequest = {
  id?: number | string | null;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown> | null;
};

type RoutesConfig = {
  adminEnabled: boolean;
  network?: string;
  rpcProxyEndpoint?: string;
  rpcProxyEndpoints?: string[];
  rpcProxyApiKey?: string;
  rpcProxyTimeoutMs?: number;
  rpcProxyRetryAttempts?: number;
  rpcProxyRetryDelayMs?: number;
};

type IndexedTxMessageCompat = {
  source?: string;
  destination?: string;
  value?: string;
  op?: number;
  body?: string;
};

type IndexedTxCompat = {
  txId?: string;
  lt?: string;
  hash?: string;
  utime?: number;
  status?: 'success' | 'failed' | 'pending';
  reason?: string;
  inMessage?: IndexedTxMessageCompat;
  outMessages?: IndexedTxMessageCompat[];
};

const normalizeBase64 = (input: string) => {
  let value = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = value.length % 4;
  if (pad === 2) value += '==';
  if (pad === 3) value += '=';
  if (pad === 1) return null;
  return value;
};

const parseBigIntLike = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const signedHexMatch = trimmed.match(/^([+-]?)0x([0-9a-fA-F]+)$/);
  if (signedHexMatch) {
    const sign = signedHexMatch[1] === '-' ? -1n : 1n;
    try {
      const parsed = BigInt(`0x${signedHexMatch[2]}`);
      return sign < 0n ? -parsed : parsed;
    } catch {
      return null;
    }
  }
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
};

const parseStackArgs = (stack: unknown): { ok: boolean; args?: any[]; error?: string } => {
  if (stack === undefined || stack === null) return { ok: true, args: [] };
  if (!Array.isArray(stack)) return { ok: false, error: 'stack must be an array' };
  if (stack.length > GET_METHOD_MAX_STACK_ITEMS) return { ok: false, error: 'stack too large' };
  const args: any[] = [];
  for (const entry of stack) {
    if (!Array.isArray(entry) || entry.length < 1) {
      return { ok: false, error: 'invalid stack entry' };
    }
    const typeRaw = entry[0];
    const value = entry[1];
    if (typeof typeRaw !== 'string') {
      return { ok: false, error: 'invalid stack entry type' };
    }
    const type = typeRaw.trim();
    if (type === 'null') {
      args.push({ type: 'null' });
      continue;
    }
    if (type === 'num' || type === 'int') {
      const parsed = parseBigIntLike(value);
      if (parsed === null) {
        return { ok: false, error: 'invalid int stack value' };
      }
      args.push({ type: 'int', value: parsed });
      continue;
    }
    const normalized = type.toLowerCase();
    if (normalized.includes('cell') || normalized.includes('slice') || normalized.includes('builder')) {
      if (typeof value !== 'string') {
        return { ok: false, error: 'invalid cell stack value' };
      }
      const normalizedB64 = normalizeBase64(value);
      if (!normalizedB64) return { ok: false, error: 'invalid base64 stack value' };
      let cell: Cell;
      try {
        cell = Cell.fromBoc(Buffer.from(normalizedB64, 'base64'))[0];
      } catch {
        return { ok: false, error: 'invalid boc stack value' };
      }
      if (normalized.includes('slice')) {
        args.push({ type: 'slice', cell });
      } else if (normalized.includes('builder')) {
        args.push({ type: 'builder', cell });
      } else {
        args.push({ type: 'cell', cell });
      }
      continue;
    }
    return { ok: false, error: `unsupported stack type: ${type}` };
  }
  return { ok: true, args };
};

const parseStreamAddresses = (query: { address?: string; wallet?: string; addresses?: string }) => {
  const fromCsv = query.addresses
    ? query.addresses
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  const candidates = [query.address, query.wallet, ...fromCsv]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const normalized: string[] = [];
  for (const candidate of candidates) {
    if (!isValidAddress(candidate)) continue;
    let raw = candidate;
    try {
      raw = Address.parse(candidate).toRawString();
    } catch {
      // fall back to original value when parse unexpectedly fails
    }
    if (!normalized.includes(raw)) {
      normalized.push(raw);
    }
  }
  return normalized.slice(0, BALANCE_STREAM_MAX_ADDRESSES);
};

const parseBooleanQuery = (value?: string) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const parsePositiveIntQuery = (value?: string | number) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const next = Math.trunc(value);
    return next > 0 ? next : null;
  }
  return parsePositiveInt(value);
};

const parseNonNegativeIntQuery = (value?: string | number) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const next = Math.trunc(value);
    return next >= 0 ? next : null;
  }
  if (value === undefined) return null;
  const text = String(value).trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeRpcEndpoint = (value: string) => value.trim().replace(/\/+$/, '');

const rankRpcEndpoint = (endpoint: string) => {
  const normalized = endpoint.toLowerCase();
  if (normalized.includes('toncenter')) return 2;
  if (normalized.includes('tonapi')) return 1;
  return 0;
};

const uniqueRpcEndpoints = (endpoints: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const endpoint of endpoints) {
    const normalized = normalizeRpcEndpoint(endpoint);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort((left, right) => rankRpcEndpoint(left) - rankRpcEndpoint(right));
  return out;
};

const mapIndexerMessageToToncenter = (message?: IndexedTxMessageCompat | null) => {
  if (!message || typeof message !== 'object') return null;
  const mapped: Record<string, unknown> = {};
  if (typeof message.source === 'string' && message.source) mapped.source = message.source;
  if (typeof message.destination === 'string' && message.destination) mapped.destination = message.destination;
  if (typeof message.value === 'string' && message.value) mapped.value = message.value;
  if (typeof message.body === 'string' && message.body) {
    mapped.msg_data = { body: message.body };
  }
  return mapped;
};

const mapIndexerStatusToToncenterDescription = (status?: string, reason?: string) => {
  if (status === 'success') {
    return {
      aborted: false,
      compute_ph: { success: true, exit_code: 0 },
      action: { success: true, valid: true, result_code: 0 }
    };
  }
  if (status === 'failed') {
    return {
      aborted: false,
      compute_ph: { type: 'skipped', reason: reason ?? 'Transaction failed.' },
      action: { success: false, valid: false, result_code: 1 }
    };
  }
  return undefined;
};

const mapIndexerTxToToncenterTransaction = (entry: IndexedTxCompat) => {
  const txIdRaw = typeof entry.txId === 'string' ? entry.txId : null;
  const split = txIdRaw && txIdRaw.includes(':') ? txIdRaw.split(':') : null;
  const lt = readString(entry.lt) ?? (split ? readString(split[0]) : null) ?? '';
  const hash = readString(entry.hash) ?? (split ? readString(split[1]) : null) ?? '';
  const inMsg = mapIndexerMessageToToncenter(entry.inMessage ?? null) ?? undefined;
  const outMsgs = Array.isArray(entry.outMessages)
    ? entry.outMessages
        .map((message) => mapIndexerMessageToToncenter(message))
        .filter((message): message is Record<string, unknown> => Boolean(message))
    : [];

  return {
    transaction_id: { lt, hash },
    utime: typeof entry.utime === 'number' ? entry.utime : undefined,
    in_msg: inMsg,
    out_msgs: outMsgs,
    description: mapIndexerStatusToToncenterDescription(entry.status, entry.reason)
  };
};

const mapConcurrent = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const safeConcurrency = Math.max(1, Math.trunc(concurrency));
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(items.length, safeConcurrency) }, () =>
    (async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) return;
        results[current] = await fn(items[current], current);
      }
    })()
  );
  await Promise.all(workers);
  return results;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const ms = Math.max(1, Math.trunc(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const registerRoutes = (
  app: FastifyInstance,
  config: RoutesConfig,
  service: IndexerService,
  metrics?: MetricsService,
  snapshots?: SnapshotService,
  adminGuard?: AdminGuard,
  debug?: DebugService,
  rateLimiter?: RateLimiter,
  contracts?: Record<string, string>
) => {
  const contractEntries = Object.entries(contracts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const contractMap = Object.fromEntries(contractEntries);

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!adminGuard || !adminGuard.isEnabled()) return true;
    if (!adminGuard.authorize(request as any)) {
      sendError(reply, 401, 'unauthorized', 'unauthorized');
      return false;
    }
    return true;
  };

  if (rateLimiter?.isEnabled()) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const url = request.url ?? '';
      if (!url.startsWith('/api/indexer/v1/accounts')) return;
      const ip =
        request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
        request.ip ||
        'unknown';
      const result = rateLimiter.check(ip);
      reply.header('x-ratelimit-limit', rateLimiter.getConfig().max);
      reply.header('x-ratelimit-remaining', result.remaining);
      reply.header('x-ratelimit-reset', result.resetAt);
      if (!result.allowed) {
        return sendError(reply, 429, 'rate_limited', 'rate limit exceeded');
      }
    });
  }
  app.get('/', async () => ({ status: 'ok' }));

  app.get('/api/indexer/v1/health', async () => {
    return service.getHealth();
  });

  app.get('/api/indexer/v1/contracts', async () => {
    return {
      network: config.network ?? null,
      count: contractEntries.length,
      contracts: contractMap
    };
  });

  const sendToncenterCompat = <T>(
    reply: FastifyReply,
    payload: ToncenterRpcCompatResponse<T>,
    id?: number | string | null
  ) => {
    reply.code(200);
    return reply.send({
      id: id ?? 1,
      jsonrpc: '2.0',
      ...payload
    });
  };

  let discoveredRpcProxyEndpoints: string[] | null = null;
  let rpcEndpointDiscoveryPromise: Promise<string[]> | null = null;

  const resolveRpcProxyEndpoints = async (): Promise<string[]> => {
    const configured = uniqueRpcEndpoints([
      ...(Array.isArray(config.rpcProxyEndpoints) ? config.rpcProxyEndpoints : []),
      ...(config.rpcProxyEndpoint ? [config.rpcProxyEndpoint] : [])
    ]);
    if (configured.length > 0) return configured;

    if (discoveredRpcProxyEndpoints) return discoveredRpcProxyEndpoints;
    if (rpcEndpointDiscoveryPromise) return rpcEndpointDiscoveryPromise;

    const network = String(config.network || 'testnet').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
    rpcEndpointDiscoveryPromise = getHttpEndpoints({ network })
      .then((endpoints) => uniqueRpcEndpoints(endpoints ?? []))
      .catch(() => [])
      .then((endpoints) => {
        discoveredRpcProxyEndpoints = endpoints;
        return endpoints;
      })
      .finally(() => {
        rpcEndpointDiscoveryPromise = null;
      });
    return rpcEndpointDiscoveryPromise;
  };

  const normalizeRpcProxyPayload = (payload: unknown): ToncenterRpcCompatResponse<unknown> => {
    const record = asRecord(payload);
    if (!record) {
      return { ok: false, code: 502, error: 'Invalid upstream RPC payload.' };
    }

    if (typeof record.ok === 'boolean') {
      if (record.ok) {
        return { ok: true, result: record.result };
      }
      const errorMessage = readString(record.error) ?? 'Upstream RPC returned an error.';
      const errorCode =
        typeof record.code === 'number' && Number.isFinite(record.code) ? Math.trunc(record.code) : 500;
      return { ok: false, code: errorCode, error: errorMessage };
    }

    if ('result' in record) {
      return { ok: true, result: record.result };
    }

    const rpcError = asRecord(record.error);
    if (rpcError) {
      const errorCode =
        typeof rpcError.code === 'number' && Number.isFinite(rpcError.code) ? Math.trunc(rpcError.code) : 500;
      const errorMessage = readString(rpcError.message) ?? readString(rpcError.error) ?? 'Upstream RPC error.';
      return { ok: false, code: errorCode, error: errorMessage };
    }

    return { ok: false, code: 502, error: 'Unsupported upstream RPC payload.' };
  };

  const isRetryableRpcFailure = (result: ToncenterRpcCompatResponse<unknown>) => {
    if (result.ok) return false;
    const status = typeof result.code === 'number' ? result.code : null;
    if (status !== null && RPC_PROXY_RETRYABLE_STATUS_CODES.has(status)) return true;
    const message = String(result.error || '').toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('service unavailable') ||
      message.includes('bad gateway') ||
      message.includes('connection reset') ||
      message.includes('econnreset') ||
      message.includes('eai_again')
    );
  };

  const normalizeSendBocCompat = (
    method: string,
    result: ToncenterRpcCompatResponse<unknown>
  ): ToncenterRpcCompatResponse<unknown> => {
    if (
      result.ok &&
      method === 'sendBoc' &&
      (!asRecord(result.result) || readString(asRecord(result.result)?.['@type']) !== 'ok')
    ) {
      // Some JSON-RPC providers return hash/string for sendBoc.
      // TonClient expects toncenter's {"@type":"ok"} shape.
      return { ok: true, result: { '@type': 'ok' } };
    }
    return result;
  };

  const callRpcEndpoint = async (
    endpoint: string,
    method: string,
    params: Record<string, unknown>,
    id?: number | string | null
  ): Promise<ToncenterRpcCompatResponse<unknown>> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };
    const apiKey = config.rpcProxyApiKey?.trim();
    if (apiKey) headers['x-api-key'] = apiKey;

    const timeoutMs =
      typeof config.rpcProxyTimeoutMs === 'number' &&
      Number.isFinite(config.rpcProxyTimeoutMs) &&
      config.rpcProxyTimeoutMs > 0
        ? Math.trunc(config.rpcProxyTimeoutMs)
        : RPC_PROXY_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: id ?? 1,
          jsonrpc: '2.0',
          method,
          params
        }),
        signal: controller.signal
      });

      const text = await response.text();
      let payload: unknown = null;
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch (_error) {
          if (!response.ok) {
            return {
              ok: false,
              code: response.status,
              error: `Upstream RPC HTTP ${response.status}: ${text.slice(0, 160)}`
            };
          }
          return { ok: false, code: 502, error: 'Invalid upstream RPC JSON payload.' };
        }
      }

      if (!response.ok) {
        const normalized = normalizeRpcProxyPayload(payload);
        if (!normalized.ok) {
          return {
            ok: false,
            code: normalized.code ?? response.status,
            error: normalized.error
          };
        }
        return {
          ok: false,
          code: response.status,
          error: `Upstream RPC HTTP ${response.status}.`
        };
      }

      return normalizeSendBocCompat(method, normalizeRpcProxyPayload(payload));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, code: 504, error: `Upstream RPC timed out for method ${method}.` };
      }
      return {
        ok: false,
        code: 502,
        error: `Upstream RPC request failed: ${error instanceof Error ? error.message : String(error)}`
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const proxyTonRpcMethod = async (
    method: string,
    params: Record<string, unknown>,
    id?: number | string | null
  ): Promise<ToncenterRpcCompatResponse<unknown> | null> => {
    if (!TON_RPC_PROXY_METHODS.has(method)) return null;

    const endpoints = await resolveRpcProxyEndpoints();
    if (endpoints.length === 0) return null;

    const retryAttempts =
      typeof config.rpcProxyRetryAttempts === 'number' &&
      Number.isFinite(config.rpcProxyRetryAttempts) &&
      config.rpcProxyRetryAttempts > 0
        ? Math.trunc(config.rpcProxyRetryAttempts)
        : RPC_PROXY_DEFAULT_RETRY_ATTEMPTS;
    const retryDelayMs =
      typeof config.rpcProxyRetryDelayMs === 'number' &&
      Number.isFinite(config.rpcProxyRetryDelayMs) &&
      config.rpcProxyRetryDelayMs >= 0
        ? Math.trunc(config.rpcProxyRetryDelayMs)
        : RPC_PROXY_DEFAULT_RETRY_DELAY_MS;

    let lastError: ToncenterRpcCompatResponse<unknown> = {
      ok: false,
      code: 502,
      error: `Upstream RPC unavailable for method ${method}.`
    };

    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      for (const endpoint of endpoints) {
        const result = await callRpcEndpoint(endpoint, method, params, id);
        if (result.ok) return result;
        lastError = result;
        if (!isRetryableRpcFailure(result)) {
          return result;
        }
      }
      if (attempt < retryAttempts - 1 && retryDelayMs > 0) {
        // Linear backoff to keep submit latency bounded but robust to short provider outages.
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
    return lastError;
  };

  const handleToncenterCompat = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? null) as ToncenterRpcCompatRequest | null;
    const method = body?.method?.trim();
    const id = body?.id ?? 1;
    const params = asRecord(body?.params ?? null) ?? {};

    if (!method) {
      return sendToncenterCompat(reply, { ok: false, code: 400, error: 'missing method' }, id);
    }

    try {
      if (method === 'runGetMethod') {
        const address = readString(params.address);
        const getter = readString(params.method);
        if (!address || !isValidAddress(address)) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid address' }, id);
        }
        if (!getter || !/^[a-zA-Z0-9_]{1,64}$/.test(getter)) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid method' }, id);
        }
        const argsResult = parseStackArgs(params.stack);
        if (!argsResult.ok) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: argsResult.error ?? 'invalid stack' }, id);
        }
        const result = await service.runGetMethod(address, getter, argsResult.args ?? []);
        return sendToncenterCompat(reply, { ok: true, result }, id);
      }

      if (method === 'getAddressBalance') {
        const address = readString(params.address);
        if (!address || !isValidAddress(address)) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid address' }, id);
        }
        const balances = await service.getBalances(address);
        return sendToncenterCompat(reply, { ok: true, result: balances.ton_raw ?? '0' }, id);
      }

      if (method === 'getAddressInformation') {
        const address = readString(params.address);
        if (!address || !isValidAddress(address)) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid address' }, id);
        }
        const [state, balances] = await Promise.all([service.getState(address), service.getBalances(address)]);
        const normalizedState =
          state.account_state === 'active' ||
          state.account_state === 'uninitialized' ||
          state.account_state === 'frozen'
            ? state.account_state
            : 'uninitialized';
        const zeroHashB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
        const lastTxLt =
          typeof state.last_tx_lt === 'string' && state.last_tx_lt.trim() ? state.last_tx_lt.trim() : '0';
        const lastTxHash =
          typeof state.last_tx_hash === 'string' && state.last_tx_hash.trim()
            ? state.last_tx_hash.trim()
            : zeroHashB64;
        const lastSeqno =
          typeof state.last_confirmed_seqno === 'number' && Number.isFinite(state.last_confirmed_seqno)
            ? Math.max(0, Math.trunc(state.last_confirmed_seqno))
            : 0;
        const syncUtime =
          typeof state.last_seen_utime === 'number' && Number.isFinite(state.last_seen_utime)
            ? Math.max(0, Math.trunc(state.last_seen_utime))
            : Math.floor(Date.now() / 1000);
        return sendToncenterCompat(
          reply,
          {
            ok: true,
            result: {
              state: normalizedState,
              balance: balances.ton_raw ?? '0',
              code: typeof state.code_boc === 'string' ? state.code_boc : '',
              data: typeof state.data_boc === 'string' ? state.data_boc : '',
              extra_currencies: [],
              last_transaction_id: {
                '@type': 'internal.transactionId',
                lt: lastTxLt,
                hash: lastTxHash
              },
              block_id: {
                '@type': 'ton.blockIdExt',
                workchain: -1,
                shard: '-9223372036854775808',
                seqno: lastSeqno,
                root_hash: zeroHashB64,
                file_hash: zeroHashB64
              },
              sync_utime: syncUtime
            }
          },
          id
        );
      }

      if (method === 'getTransactions') {
        const address = readString(params.address);
        if (!address || !isValidAddress(address)) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid address' }, id);
        }
        const limitParsed = parsePositiveIntQuery(params.limit as string | number | undefined);
        const limit = Math.max(1, Math.min(50, limitParsed ?? 5));
        const lt = readString(params.lt);
        const hash = readString(params.hash);
        if ((lt && !hash) || (!lt && hash)) {
          return sendToncenterCompat(
            reply,
            { ok: false, code: 400, error: 'lt and hash must be provided together' },
            id
          );
        }
        if (lt && hash && (!isValidLt(lt) || !isValidHashBase64(hash))) {
          return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid cursor' }, id);
        }

        const response =
          lt && hash ? await service.getTransactionsByCursor(address, lt, hash) : await service.getTransactions(address, 1);
        const txs = (response?.txs ?? [])
          .slice(0, limit)
          .map((entry: IndexedTxCompat) => mapIndexerTxToToncenterTransaction(entry));
        return sendToncenterCompat(reply, { ok: true, result: txs }, id);
      }

      const proxied = await proxyTonRpcMethod(method, params, id);
      if (proxied) {
        return sendToncenterCompat(reply, proxied, id);
      }

      return sendToncenterCompat(reply, { ok: false, code: 404, error: `unsupported method: ${method}` }, id);
    } catch (error) {
      return sendToncenterCompat(reply, { ok: false, code: 500, error: (error as Error).message }, id);
    }
  };

  app.post('/jsonRPC', handleToncenterCompat);
  app.post('/api/v2/jsonRPC', handleToncenterCompat);

  app.post('/api/indexer/v1/runGetMethod', async (request, reply) => {
    const body = request.body as { address?: string; method?: string; stack?: ToncenterStackEntry[] } | null;
    const address = body?.address?.trim();
    const method = body?.method?.trim();
    if (!address || !isValidAddress(address)) {
      return sendError(reply, 400, 'invalid_address', 'invalid address');
    }
    if (!method || !/^[a-zA-Z0-9_]{1,64}$/.test(method)) {
      return sendError(reply, 400, 'invalid_method', 'invalid method');
    }
    const argsResult = parseStackArgs(body?.stack);
    if (!argsResult.ok) {
      return sendError(reply, 400, 'invalid_stack', argsResult.error ?? 'invalid stack');
    }
    try {
      return await service.runGetMethod(address, method, argsResult.args ?? []);
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message);
    }
  });

  app.post('/api/indexer/v1/runGetMethods', async (request, reply) => {
    const body = request.body as
      | { calls?: Array<{ address?: string; method?: string; stack?: ToncenterStackEntry[] }> }
      | null;
    const calls = body?.calls;
    if (!Array.isArray(calls)) {
      return sendError(reply, 400, 'bad_request', 'calls must be an array');
    }
    if (calls.length > GET_METHOD_MAX_BATCH_CALLS) {
      return sendError(reply, 400, 'bad_request', 'calls too large');
    }

    type BatchResult =
      | { ok: true; stack: ToncenterStackEntry[]; exit_code: number; gas_used: number }
      | { ok: false; code: string; error: string };

    const results = await mapConcurrent(calls, GET_METHOD_BATCH_CONCURRENCY, async (call) => {
      const address = call.address?.trim();
      const method = call.method?.trim();
      if (!address || !isValidAddress(address)) {
        return { ok: false, code: 'invalid_address', error: 'invalid address' } satisfies BatchResult;
      }
      if (!method || !/^[a-zA-Z0-9_]{1,64}$/.test(method)) {
        return { ok: false, code: 'invalid_method', error: 'invalid method' } satisfies BatchResult;
      }
      const argsResult = parseStackArgs(call.stack);
      if (!argsResult.ok) {
        return {
          ok: false,
          code: 'invalid_stack',
          error: argsResult.error ?? 'invalid stack'
        } satisfies BatchResult;
      }
      try {
        const response = await withTimeout(
          service.runGetMethod(address, method, argsResult.args ?? []),
          GET_METHOD_CALL_TIMEOUT_MS
        );
        return { ok: true, ...response } satisfies BatchResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'bad request';
        if (message === 'timeout') {
          return { ok: false, code: 'timeout', error: 'get method timed out' } satisfies BatchResult;
        }
        return { ok: false, code: 'bad_request', error: message } satisfies BatchResult;
      }
    });

    return { results };
  });

  app.get('/api/indexer/v1/openapi.json', async () => {
    return buildOpenApi(config as any);
  });

  app.get('/api/indexer/v1/docs', async (_request, reply) => {
    const html = buildDocsHtml();
    reply.type('text/html');
    return html;
  });

  app.get('/api/indexer/v1/metrics', async () => {
    if (!metrics) return { error: 'metrics disabled', code: 'metrics_disabled' };
    return metrics.getMetrics();
  });

  app.get('/api/indexer/v1/metrics/prometheus', async (_request, reply) => {
    if (!metrics) return sendError(reply, 400, 'metrics_disabled', 'metrics disabled');
    reply.type('text/plain');
    return metrics.getPrometheus();
  });
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url ?? '';
    if (
      url.startsWith('/api/indexer/v1/metrics/prometheus') ||
      url.startsWith('/api/indexer/v1/snapshot') ||
      url.startsWith('/api/indexer/v1/debug')
    ) {
      const ok = await requireAdmin(request, reply);
      if (!ok) return reply;
    }
  });

  app.get(
    '/api/indexer/v1/accounts/:addr/balance',
    { schema: { params: addressParamsSchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      try {
        return await service.getBalance(addr);
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/accounts/:addr/balances',
    { schema: { params: addressParamsSchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      try {
        return await service.getBalances(addr);
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/accounts/:addr/assets',
    { schema: { params: addressParamsSchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      try {
        return await service.getBalances(addr);
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/perps/:engine/snapshot',
    { schema: { params: { type: 'object', properties: { engine: { type: 'string' } }, required: ['engine'] }, querystring: perpsSnapshotQuerySchema } },
    async (request, reply) => {
      const engine = (request.params as { engine: string }).engine;
      if (!isValidAddress(engine)) {
        return sendError(reply, 400, 'invalid_address', 'invalid engine address');
      }

      const query = request.query as { market_ids?: string; max_markets?: string | number };
      const marketIds = (query.market_ids ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => /^\d+$/.test(value))
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value) && value > 0);
      const maxMarketsParsed =
        typeof query.max_markets === 'number'
          ? (Number.isInteger(query.max_markets) && query.max_markets > 0 ? query.max_markets : null)
          : parsePositiveInt(query.max_markets);
      const maxMarkets = maxMarketsParsed ? Math.min(128, maxMarketsParsed) : undefined;

      try {
        return await service.getPerpsSnapshot(engine, {
          marketIds: marketIds.length ? marketIds : undefined,
          maxMarkets
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/governance/:voting/snapshot',
    {
      schema: {
        params: { type: 'object', properties: { voting: { type: 'string' } }, required: ['voting'] },
        querystring: governanceSnapshotQuerySchema
      }
    },
    async (request, reply) => {
      const voting = (request.params as { voting: string }).voting;
      if (!isValidAddress(voting)) {
        return sendError(reply, 400, 'invalid_address', 'invalid voting address');
      }

      const query = request.query as {
        owner?: string;
        max_scan?: string | number;
        max_misses?: string | number;
      };
      const owner = query.owner?.trim() ? query.owner.trim() : undefined;
      if (owner && !isValidAddress(owner)) {
        return sendError(reply, 400, 'invalid_address', 'invalid owner address');
      }
      const maxScanParsed =
        typeof query.max_scan === 'number'
          ? (Number.isInteger(query.max_scan) && query.max_scan > 0 ? query.max_scan : null)
          : parsePositiveInt(query.max_scan);
      const maxScan = maxScanParsed ? Math.min(64, maxScanParsed) : undefined;

      const maxMissesParsed =
        typeof query.max_misses === 'number'
          ? (Number.isInteger(query.max_misses) && query.max_misses > 0 ? query.max_misses : null)
          : parsePositiveInt(query.max_misses);
      const maxConsecutiveMisses = maxMissesParsed ? Math.min(8, maxMissesParsed) : undefined;

      try {
        return await service.getGovernanceSnapshot(voting, {
          owner,
          maxScan,
          maxConsecutiveMisses
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/farms/:factory/snapshot',
    {
      schema: {
        params: { type: 'object', properties: { factory: { type: 'string' } }, required: ['factory'] },
        querystring: farmsSnapshotQuerySchema
      }
    },
    async (request, reply) => {
      const factory = (request.params as { factory: string }).factory;
      if (!isValidAddress(factory)) {
        return sendError(reply, 400, 'invalid_address', 'invalid factory address');
      }

      const query = request.query as {
        max_scan?: string | number;
        max_misses?: string | number;
      };
      const maxScanParsed =
        typeof query.max_scan === 'number'
          ? (Number.isInteger(query.max_scan) && query.max_scan > 0 ? query.max_scan : null)
          : parsePositiveInt(query.max_scan);
      const maxScan = maxScanParsed ? Math.min(64, maxScanParsed) : undefined;

      const maxMissesParsed =
        typeof query.max_misses === 'number'
          ? (Number.isInteger(query.max_misses) && query.max_misses > 0 ? query.max_misses : null)
          : parsePositiveInt(query.max_misses);
      const maxConsecutiveMisses = maxMissesParsed ? Math.min(8, maxMissesParsed) : undefined;

      try {
        return await service.getFarmSnapshot(factory, {
          maxScan,
          maxConsecutiveMisses
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/options/:factory/snapshot',
    {
      schema: {
        params: { type: 'object', properties: { factory: { type: 'string' } }, required: ['factory'] },
        querystring: optionsSnapshotQuerySchema
      }
    },
    async (request, reply) => {
      const factory = (request.params as { factory: string }).factory;
      if (!isValidAddress(factory)) {
        return sendError(reply, 400, 'invalid_address', 'invalid options factory address');
      }

      const query = request.query as {
        start_id?: string | number;
        max_series_id?: string | number;
        window_size?: string | number;
        max_empty_windows?: string | number;
        min_probe_windows?: string | number;
      };
      const startIdParsed = parseNonNegativeIntQuery(query.start_id);
      const startId = startIdParsed !== null ? Math.min(1_000_000, startIdParsed) : undefined;
      const maxSeriesIdParsed = parsePositiveIntQuery(query.max_series_id);
      const maxSeriesId = maxSeriesIdParsed !== null ? Math.min(1_000_000, maxSeriesIdParsed) : undefined;
      const windowSizeParsed = parsePositiveIntQuery(query.window_size);
      const windowSize = windowSizeParsed !== null ? Math.min(256, windowSizeParsed) : undefined;
      const maxEmptyWindowsParsed = parsePositiveIntQuery(query.max_empty_windows);
      const maxEmptyWindows = maxEmptyWindowsParsed !== null ? Math.min(64, maxEmptyWindowsParsed) : undefined;
      const minProbeWindowsParsed = parseNonNegativeIntQuery(query.min_probe_windows);
      const minProbeWindows = minProbeWindowsParsed !== null ? Math.min(4096, minProbeWindowsParsed) : undefined;

      try {
        return await service.getOptionsSnapshot(factory, {
          startId,
          maxSeriesId,
          windowSize,
          maxEmptyWindows,
          minProbeWindows
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/cover/:manager/snapshot',
    {
      schema: {
        params: { type: 'object', properties: { manager: { type: 'string' } }, required: ['manager'] },
        querystring: coverSnapshotQuerySchema
      }
    },
    async (request, reply) => {
      const manager = (request.params as { manager: string }).manager;
      if (!isValidAddress(manager)) {
        return sendError(reply, 400, 'invalid_address', 'invalid cover manager address');
      }

      const query = request.query as {
        owner?: string;
        max_scan?: string | number;
        max_misses?: string | number;
      };
      const owner = query.owner?.trim() ? query.owner.trim() : undefined;
      if (owner && !isValidAddress(owner)) {
        return sendError(reply, 400, 'invalid_address', 'invalid owner address');
      }

      const maxScanParsed =
        typeof query.max_scan === 'number'
          ? (Number.isInteger(query.max_scan) && query.max_scan > 0 ? query.max_scan : null)
          : parsePositiveInt(query.max_scan);
      const maxScan = maxScanParsed ? Math.min(64, maxScanParsed) : undefined;

      const maxMissesParsed =
        typeof query.max_misses === 'number'
          ? (Number.isInteger(query.max_misses) && query.max_misses > 0 ? query.max_misses : null)
          : parsePositiveInt(query.max_misses);
      const maxConsecutiveMisses = maxMissesParsed ? Math.min(8, maxMissesParsed) : undefined;

      try {
        return await service.getCoverSnapshot(manager, {
          owner,
          maxScan,
          maxConsecutiveMisses
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.post(
    '/api/indexer/v1/defi/snapshot',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            owner: { type: ['string', 'null'] },
            include: { type: 'object', additionalProperties: true },
            options: { type: 'object', additionalProperties: true },
            contracts: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
            modules: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  address: { type: 'string' },
                  enabledGetter: { type: ['string', 'null'] },
                  governanceGetter: { type: ['string', 'null'] }
                },
                required: ['key', 'address']
              }
            }
          },
          required: ['contracts']
        }
      }
    },
    async (request, reply) => {
      const body = request.body as any;
      const owner = typeof body?.owner === 'string' ? body.owner.trim() : null;
      if (owner && !isValidAddress(owner)) {
        return sendError(reply, 400, 'invalid_address', 'invalid owner address');
      }
      const contracts = body?.contracts ?? null;
      if (!contracts || typeof contracts !== 'object') {
        return sendError(reply, 400, 'bad_request', 'contracts object is required');
      }
      const contractKeys = [
        'activationGate',
        'dlmmRegistry',
        't3Hub',
        'controlMesh',
        'riskVault',
        'feeRouter',
        'buybackExecutor',
        'automationRegistry',
        'anchorGuard',
        'clusterGuard',
        'voting',
        'farmFactory',
        'coverManager'
      ] as const;
      for (const key of contractKeys) {
        const value = contracts[key];
        if (typeof value === 'string' && value.trim() && !isValidAddress(value.trim())) {
          return sendError(reply, 400, 'invalid_address', `invalid contract address for ${key}`);
        }
      }
      const modules = Array.isArray(body?.modules) ? body.modules : [];
      if (modules.length > 64) {
        return sendError(reply, 400, 'bad_request', 'too many modules');
      }
      for (const entry of modules) {
        const address = typeof entry?.address === 'string' ? entry.address.trim() : '';
        if (!address || !isValidAddress(address)) {
          return sendError(reply, 400, 'invalid_address', 'invalid module address');
        }
      }
      try {
        return await service.getDefiSnapshot({
          owner,
          include: typeof body?.include === 'object' && body.include ? body.include : undefined,
          options: typeof body?.options === 'object' && body.options ? body.options : undefined,
          contracts,
          modules
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.post(
    '/api/indexer/v1/dlmm/pools/snapshot',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            t3Root: { type: 'string' },
            dlmmRegistry: { type: ['string', 'null'] },
            dlmmFactory: { type: ['string', 'null'] },
            tokens: { type: 'array', items: { type: 'string' } }
          },
          required: ['t3Root', 'tokens']
        }
      }
    },
    async (request, reply) => {
      const body = request.body as any;
      const t3Root = typeof body?.t3Root === 'string' ? body.t3Root.trim() : '';
      if (!t3Root || !isValidAddress(t3Root)) {
        return sendError(reply, 400, 'invalid_address', 'invalid t3Root address');
      }
      const registry = typeof body?.dlmmRegistry === 'string' ? body.dlmmRegistry.trim() : null;
      if (registry && !isValidAddress(registry)) {
        return sendError(reply, 400, 'invalid_address', 'invalid dlmmRegistry address');
      }
      const factory = typeof body?.dlmmFactory === 'string' ? body.dlmmFactory.trim() : null;
      if (factory && !isValidAddress(factory)) {
        return sendError(reply, 400, 'invalid_address', 'invalid dlmmFactory address');
      }
      const tokens = Array.isArray(body?.tokens) ? body.tokens : [];
      if (!tokens.length) {
        return sendError(reply, 400, 'bad_request', 'tokens array is required');
      }
      if (tokens.length > 64) {
        return sendError(reply, 400, 'bad_request', 'too many tokens');
      }
      for (const token of tokens) {
        const value = typeof token === 'string' ? token.trim() : '';
        if (!value || !isValidAddress(value)) {
          return sendError(reply, 400, 'invalid_address', 'invalid token address');
        }
      }
      try {
        return await service.getDlmmPoolsSnapshot({
          t3Root,
          dlmmRegistry: registry,
          dlmmFactory: factory,
          tokens
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  const handleBalanceStream = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { address?: string; wallet?: string; addresses?: string };
    const addresses = parseStreamAddresses(query);
    if (addresses.length === 0) {
      return sendError(reply, 400, 'invalid_address', 'at least one valid address is required');
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    let seq = 0;
    let inFlight = false;
    const signatures = new Map<string, string>();

    const writeEvent = (payload: unknown, eventName?: string) => {
      if (closed) return;
      if (eventName) {
        reply.raw.write(`event: ${eventName}\n`);
      }
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const pollSnapshots = async (targets: string[]) => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        for (const address of targets) {
          const balances = await service.getBalances(address);
          const signature = service.getBalancesSignature(balances);
          const previous = signatures.get(address);
          const changed = previous !== undefined && previous !== signature;
          signatures.set(address, signature);

          const jettons = balances.assets
            .filter((asset) => asset.kind === 'jetton' && typeof asset.address === 'string' && asset.address.length > 0)
            .map((asset) => asset.address as string);
          const ts = Date.now();

          if (changed) {
            writeEvent({
              type: 'balances_changed',
              address,
              seq: ++seq,
              ts,
              hints: {
                ton: true,
                jettons: jettons.length > 0 ? jettons : null,
              },
            });
          }

          if (previous === undefined || changed) {
            writeEvent({
              type: 'balances_snapshot',
              address,
              seq: ++seq,
              ts,
              balances,
            });
          }
        }
      } catch (error) {
        writeEvent(
          {
            type: 'error',
            address: null,
            seq: ++seq,
            ts: Date.now(),
            message: (error as Error).message,
          },
          'error'
        );
      } finally {
        inFlight = false;
      }
    };

    const unsubscribe = service.subscribeBalanceChanges(addresses, (event) => {
      if (closed) return;
      void pollSnapshots([event.address]);
    });

    const pollTimer = setInterval(() => {
      void pollSnapshots(addresses);
    }, BALANCE_STREAM_POLL_MS);

    const keepAliveTimer = setInterval(() => {
      if (closed) return;
      reply.raw.write(': keepalive\n\n');
    }, BALANCE_STREAM_KEEPALIVE_MS);

    const closeStream = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(keepAliveTimer);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        // ignore close errors
      }
    };

    request.raw.on('close', closeStream);
    reply.raw.on('close', closeStream);
    writeEvent({
      type: 'subscribed',
      addresses,
      seq: ++seq,
      ts: Date.now(),
    });
    void pollSnapshots(addresses);
    return reply;
  };

  app.get('/api/indexer/v1/stream/balances', handleBalanceStream);
  app.get('/api/indexer/v1/stream', handleBalanceStream);

  app.get(
    '/api/indexer/v1/accounts/:addr/txs',
    { schema: { params: addressParamsSchema, querystring: txQuerySchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      const query = request.query as { page?: string; cursor_lt?: string; cursor_hash?: string };
      const page = parsePositiveInt(query.page) ?? 1;
      const cursorLt = query.cursor_lt;
      const cursorHash = query.cursor_hash;

      try {
        if ((cursorLt && !cursorHash) || (!cursorLt && cursorHash)) {
          return sendError(reply, 400, 'cursor_mismatch', 'cursor_lt and cursor_hash must be provided together');
        }
        if (cursorLt && cursorHash) {
          if (!isValidLt(cursorLt) || !isValidHashBase64(cursorHash)) {
            return sendError(reply, 400, 'invalid_cursor', 'invalid cursor');
          }
        }
        if (cursorLt && cursorHash) {
          return await service.getTransactionsByCursor(addr, cursorLt, cursorHash);
        }
        return await service.getTransactions(addr, page);
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/accounts/:addr/swaps',
    { schema: { params: addressParamsSchema, querystring: swapQuerySchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      const query = request.query as {
        limit?: number | string;
        from_utime?: number | string;
        to_utime?: number | string;
        pay_token?: string;
        receive_token?: string;
        execution_type?: 'market' | 'limit' | 'twap' | 'unknown';
        status?: 'success' | 'failed' | 'pending';
        include_reverse?: string;
      };
      const limitRaw = query.limit;
      const limitFromString = typeof limitRaw === 'string' ? parsePositiveInt(limitRaw) : null;
      const limit =
        typeof limitRaw === 'number' && Number.isFinite(limitRaw)
          ? Math.max(1, Math.min(500, Math.trunc(limitRaw)))
          : limitFromString !== null
            ? Math.max(1, Math.min(500, limitFromString))
            : 100;
      const hasFromUtime = query.from_utime !== undefined;
      const hasToUtime = query.to_utime !== undefined;
      const fromUtime = parsePositiveIntQuery(query.from_utime);
      const toUtime = parsePositiveIntQuery(query.to_utime);
      if (hasFromUtime && fromUtime === null) {
        return sendError(reply, 400, 'bad_request', 'from_utime must be a positive integer');
      }
      if (hasToUtime && toUtime === null) {
        return sendError(reply, 400, 'bad_request', 'to_utime must be a positive integer');
      }
      if (fromUtime !== null && toUtime !== null && fromUtime > toUtime) {
        return sendError(reply, 400, 'bad_request', 'from_utime must be less than or equal to to_utime');
      }
      try {
        return await service.getSwapExecutions(addr, {
          limit,
          fromUtime: fromUtime ?? undefined,
          toUtime: toUtime ?? undefined,
          payToken: query.pay_token,
          receiveToken: query.receive_token,
          executionType: query.execution_type,
          status: query.status,
          includeReverse: parseBooleanQuery(query.include_reverse),
        });
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.get(
    '/api/indexer/v1/accounts/:addr/state',
    { schema: { params: addressParamsSchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      try {
        return await service.getState(addr);
      } catch (error) {
        return sendError(reply, 400, 'bad_request', (error as Error).message);
      }
    }
  );

  app.post('/api/indexer/v1/snapshot/save', async (_request, reply) => {
    if (!snapshots) return sendError(reply, 400, 'snapshot_disabled', 'snapshot disabled');
    try {
      return { ok: true, ...(snapshots.save() as object) };
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message);
    }
  });

  app.post('/api/indexer/v1/snapshot/load', async (_request, reply) => {
    if (!snapshots) return sendError(reply, 400, 'snapshot_disabled', 'snapshot disabled');
    try {
      return { ok: true, ...(snapshots.load() as object) };
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message);
    }
  });

  app.get(
    '/api/indexer/v1/debug',
    { schema: { querystring: debugQuerySchema } },
    async (request, reply) => {
      if (!debug) return sendError(reply, 400, 'debug_disabled', 'debug disabled');
      const query = request.query as { limit?: string };
      const limit = Math.max(1, Math.min(500, Number(query.limit ?? 100)));
      return debug.getStatus(limit);
    }
  );
};
