import { Address, Cell } from '@ton/core';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  IndexerService,
  MarketCandleInterval
} from '../indexerService';
import type { RegistryMetadata } from '../config/releaseManifest';
import type { Network } from '../config';
import { PUBLIC_RPC_ZERO_STATES } from './rpcNetwork';
import { MetricsService } from '../metrics';
import { SnapshotService } from '../snapshotService';
import { DebugService } from '../debugService';
import { RateLimiter, rateLimitKey } from './rateLimit';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from './validation';
import {
  addressParamsSchema,
  coverSnapshotQuerySchema,
  debugQuerySchema,
  farmsSnapshotQuerySchema,
  governanceSnapshotQuerySchema,
  marketCandleParamsSchema,
  marketCandleQuerySchema,
  volIndexSnapshotQuerySchema,
  txQuerySchema
} from './schemas';
import { buildOpenApi } from './openapi';
import { buildDocsHtml } from './docsHtml';
import { publicIndexerPath } from './publicMount';
import { installErrorHandlers, publicAdmissionError, sendError, sendFailure } from './errors';
import { requestDeadline, ROUTE_DEADLINE_MS } from './deadline';
import { ChainReadError, type ChainSource, type TonBlockIdExt } from '../data/dataSource';
import type { BalanceService } from '../balances/balanceService';
import type { BalanceStreamHub } from '../balances/balanceStream';
import type { RuntimeMetrics } from '../runtimeMetrics';
import { isAdmissionMethod } from '../data/admission/protocol';
import type { FreshReadCall } from '../data/freshRead';
import { currentNativeRuntime, resolveServiceMetadata, installReleaseIdentity } from './serviceMetadata';
import { errorDiagnostic, type Logger } from '../utils/logger';
import { OrderPageError, type CurrentOrdersRuntime } from '../runtime/ordersRuntime';
import { readT3OperationRequest, T3EvidenceError } from '../runtime/t3OperationRequest';
import { readT3WalletClaimRequest } from '../runtime/t3WalletClaimEvidence';
import { readAccountStorage } from '../runtime/accountStorage';
import { readOptionsOperationRequest } from '../runtime/optionsOperationEvidence';
import { readFaucetRecoveryRequest } from '../runtime/faucetRecoveryEvidence';
import { readOptionsWalletClaimRequest } from '../runtime/optionsWalletClaimEvidence';
import { readFaucetOperationRequest } from '../runtime/faucetOperationEvidence';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { readOrderWalletClaimRequest } from '../runtime/orderWalletClaimEvidence';
import { readSpotOperationRequest, SpotEvidenceError } from '../runtime/spotOperationRequest';
import { currentJettonConfigPrices } from '../data/configPrices';
import { assertFreshHeadTime } from '../data/freshHead';

const BALANCE_STREAM_KEEPALIVE_MS = 15_000;
const BALANCE_STREAM_MAX_ADDRESSES = 8;
const GET_METHOD_MAX_STACK_ITEMS = 16;
const FRESH_READ_MAX_CALLS = 32;

type ToncenterStackEntry = [string, unknown];
type ToncenterRpcCompatResponse<T> = { ok: true; result: T } | { ok: false; error: string; code?: number };

type RoutesConfig = {
  network: Network;
  pageSize?: number;
  enableWriteRpc?: boolean;
  edgeKey?: string;
  adminToken?: string;
};

const decodeCanonicalBase64 = (input: string): Buffer | null => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(input)) return null;
  if (/[+/]/.test(input) && /[-_]/.test(input)) return null;
  const standardInput = input.replace(/-/g, '+').replace(/_/g, '/');
  const unpadded = standardInput.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  try {
    const decoded = Buffer.from(padded, 'base64');
    const canonical = decoded.toString('base64');
    if (standardInput !== canonical && standardInput !== canonical.replace(/=+$/, '')) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
};

const parseBigIntLike = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
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
      const boc = decodeCanonicalBase64(value);
      if (!boc) return { ok: false, error: 'invalid base64 stack value' };
      let cell: Cell;
      try {
        cell = Cell.fromBoc(boc)[0];
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

const parseStreamAddresses = (query: { address?: unknown; addresses?: unknown }) => {
  const rawAddresses = query.addresses;
  const fromCsv = typeof rawAddresses === 'string'
    ? rawAddresses
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  const candidates = [query.address, ...fromCsv]
    .map((value) => (typeof value === 'string' ? value.trim() : undefined))
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

const readHeaderValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const getAdminToken = (request: FastifyRequest) => {
  const explicit = readHeaderValue(request.headers['x-indexer-admin-token']);
  if (explicit) return explicit;
  const authorization = readHeaderValue(request.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
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

const classifyRateLimitBucket = (url: string) => {
  const path = url.split('?')[0] || '';
  if (path === '/jsonRPC' || path === '/api/v2/jsonRPC' || path.startsWith('/api/indexer/v1/runGetMethod')
    || path === '/api/indexer/v1/readFresh') {
    return 'rpc' as const;
  }
  if (path.startsWith('/api/indexer/v1/stream')) return 'stream' as const;
  if (path.includes('/snapshot')) return 'snapshot' as const;
  if (
    path.startsWith('/api/indexer/v1/accounts') ||
    path.startsWith('/api/indexer/v1/markets')
  ) {
    return 'accounts' as const;
  }
  if (
    path.startsWith('/api/indexer/v1/docs') ||
    path.startsWith('/api/indexer/v1/openapi.json') ||
    path.startsWith('/api/indexer/v1/contracts') ||
    path.startsWith('/api/indexer/v1/service-info') ||
    path.startsWith('/api/indexer/v1/health') ||
    path.startsWith('/api/indexer/v1/metrics')
  ) {
    return 'docs' as const;
  }
  return 'default' as const;
};

export const registerRoutes = (
  app: FastifyInstance,
  config: RoutesConfig,
  service: IndexerService,
  metrics?: MetricsService,
  snapshots?: SnapshotService,
  debug?: DebugService,
  rateLimiter?: RateLimiter,
  contracts?: Record<string, string>,
  registryMetadata?: RegistryMetadata,
  runtime: { source?: ChainSource; orders?: Pick<CurrentOrdersRuntime, 'page'> & Partial<Pick<CurrentOrdersRuntime, 'operationEvidence' | 'walletClaimEvidence' | 'orderWalletClaimEvidence' | 'spotOperationEvidence' | 'optionsOperationEvidence' | 'faucetOperationEvidence' | 'optionsWalletClaimEvidence' | 'faucetRecoveryEvidence'>>; balances?: Pick<BalanceService, 'read'>; streams?: Pick<BalanceStreamHub, 'subscribe'>; metrics?: RuntimeMetrics; logger?: Logger } = {}
) => {
  installErrorHandlers(app);
  installReleaseIdentity(app, config.network, registryMetadata);
  const network = config.network;
  if (network !== 'mainnet' && network !== 'testnet' && network !== 'localnet') {
    throw new Error('Routes require an explicit mainnet, testnet, or localnet network.');
  }
  const activeBalanceStreams = new Set<() => void>();
  let closing = false;
  // Hijacked SSE responses must end before Fastify waits for HTTP connections.
  app.addHook('preClose', async () => {
    closing = true;
    for (const closeStream of activeBalanceStreams) closeStream();
  });

  const contractEntries = Object.entries(contracts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const contractMap = Object.fromEntries(contractEntries);
  const canonicalMarkets = registryMetadata?.markets ?? [];
  const canonicalCandleMarkets = [
    ...(registryMetadata?.spotMarkets ?? []),
    ...canonicalMarkets.map(market => ({ ...market, marketKey: market.perpsCandleMarketKey, marketAddress: market.perpsPool })),
  ];
  const rawAddress = (value: string) => {
    try {
      return Address.parse(value).toRawString();
    } catch {
      return null;
    }
  };
  const adminToken = typeof config.adminToken === 'string' && config.adminToken.length > 0 ? config.adminToken : null;
  const requireAdmin = (
    request: FastifyRequest,
    reply: FastifyReply,
    disabledCode: 'snapshot_disabled' | 'debug_disabled' | 'metrics_disabled',
    disabledMessage: string
  ) => {
    if (!adminToken) {
      return sendError(reply, 400, disabledCode, disabledMessage);
    }
    if (getAdminToken(request) !== adminToken) {
      return sendError(reply, 401, 'unauthorized', 'admin token required');
    }
    return null;
  };
  const { serviceId, publicBaseUrl, freshReads } = resolveServiceMetadata(config, registryMetadata);
  const nativeRuntime = currentNativeRuntime(config.network, registryMetadata);
  const indexer = nativeRuntime?.services.indexer;
  const serviceIdentity = {
    serviceId,
    ecosystem: 'ton',
    chainId: `ton:${network}`,
    network
  } as const;
  const serviceInfo = {
    schemaVersion: 1,
    ...serviceIdentity,
    serviceName: 'TON Indexer',
    publicBaseUrl,
    readOnly: !config.enableWriteRpc,
    capabilities: [
      'account-balances',
      'account-transactions',
      'account-state',
      'run-get-method',
      ...(freshReads ? ['fresh-read'] : []),
      ...(freshReads && runtime.orders ? ['open-orders'] : []),
      ...(freshReads && runtime.source ? ['config-prices'] : []),
      ...(freshReads && runtime.orders?.operationEvidence ? ['t3-operation-evidence'] : []),
      ...(freshReads && runtime.orders?.spotOperationEvidence ? ['spot-operation-evidence'] : []),
      'market-candles'
    ],
    endpoints: Object.fromEntries(Object.entries({
      health: '/api/indexer/v1/health',
      openapi: '/api/indexer/v1/openapi.json',
      balances: '/api/indexer/v1/accounts/{addr}/balances',
      transactions: '/api/indexer/v1/accounts/{addr}/txs',
      state: '/api/indexer/v1/accounts/{addr}/state',
      runGetMethod: '/api/indexer/v1/runGetMethod',
      ...(freshReads ? { readFresh: '/api/indexer/v1/readFresh' } : {}),
      ...(freshReads && runtime.orders ? { openOrders: '/api/indexer/v1/orders/open' } : {}),
      ...(freshReads && runtime.source ? { configPrices: '/api/indexer/v1/config-prices' } : {}),
      ...(freshReads && runtime.orders?.operationEvidence ? { t3OperationEvidence: '/api/indexer/v1/t3/operation-evidence' } : {}),
      ...(freshReads && runtime.orders?.walletClaimEvidence ? { t3WalletClaimEvidence: '/api/indexer/v1/t3/wallet-claim-evidence' } : {}),
      ...(freshReads && runtime.orders?.orderWalletClaimEvidence ? { orderWalletClaimEvidence: '/api/indexer/v1/spot/order-wallet-claim-evidence' } : {}),
      ...(freshReads ? { accountStorage: '/api/indexer/v1/account-storage' } : {}),
      ...(freshReads && runtime.orders?.spotOperationEvidence ? { spotOperationEvidence: '/api/indexer/v1/spot/operation-evidence' } : {}),
      ...(freshReads && runtime.orders?.optionsOperationEvidence ? { optionsOperationEvidence: '/api/indexer/v1/options/operation-evidence' } : {}),
      ...(freshReads && runtime.orders?.optionsWalletClaimEvidence ? { optionsWalletClaimEvidence: '/api/indexer/v1/options/wallet-claim-evidence' } : {}),
      ...(freshReads && runtime.orders?.faucetRecoveryEvidence ? { faucetRecoveryEvidence: '/api/indexer/v1/faucet/recovery-evidence' } : {}),
      ...(freshReads && runtime.orders?.faucetOperationEvidence ? { faucetOperationEvidence: '/api/indexer/v1/faucet/operation-evidence' } : {}),
      marketCandles: '/api/indexer/v1/markets/{market}/candles'
    }).map(([name, route]) => [name, publicIndexerPath(indexer, route)])),
    release: {
      releaseId: nativeRuntime?.releaseId ?? null,
      manifestHash: nativeRuntime?.manifestHash ?? null
    }
  };

  app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const url = request.url ?? '';
      const visitor = rateLimitKey(request.raw, config.edgeKey);
      runtime.metrics?.count('http_requests_total', 1, { identity: visitor.identity });
      if (!rateLimiter?.isEnabled()) return;
      const bucket = classifyRateLimitBucket(url);
      const result = rateLimiter.check(visitor.key, bucket);
      reply.header('x-ratelimit-bucket', bucket);
      reply.header('x-ratelimit-limit', result.limit);
      reply.header('x-ratelimit-remaining', result.remaining);
      reply.header('x-ratelimit-reset', result.resetAt);
      if (!result.allowed) {
        return sendError(reply, 429, 'rate_limited', 'rate limit exceeded', { retryAfterSeconds: result.retryAfterSeconds });
      }
  });

  app.get('/', async () => ({ status: 'ok' }));

  app.get('/api/indexer/v1/health', async (_request, reply) => {
    const admission = service.getAdmissionStatus();
    const health = service.getHealth();
    if (!health.chain.peersReady || health.disk === 'critical' || admission.configured && !admission.ready) reply.status(503);
    return {
      ...health,
      ...serviceIdentity,
      admission
    };
  });

  app.get('/api/indexer/v1/contracts', async () => {
    return {
      network: config.network ?? null,
      count: contractEntries.length,
      contracts: contractMap,
      release: serviceInfo.release,
      ...(nativeRuntime ? { templates: nativeRuntime.templates, tokens: nativeRuntime.tokens,
        spotMarkets: nativeRuntime.spotMarkets, perpsMarkets: nativeRuntime.perpsMarkets,
        options: nativeRuntime.options } : {})
    };
  });

  app.get('/api/indexer/v1/service-info', async () => serviceInfo);

  app.post('/api/indexer/v1/options/operation-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.optionsOperationEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current options evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The evidence endpoint has no query parameters.');
      const parsed = readOptionsOperationRequest(request.body, nativeRuntime);
      return await runtime.orders.optionsOperationEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof ProductEvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current options evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current options evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current options evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/faucet/operation-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.faucetOperationEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current faucet evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The evidence endpoint has no query parameters.');
      const parsed = readFaucetOperationRequest(request.body, nativeRuntime);
      return await runtime.orders.faucetOperationEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof ProductEvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current faucet evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current faucet evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current faucet evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/faucet/recovery-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.faucetRecoveryEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current faucet recovery evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The evidence endpoint has no query parameters.');
      const parsed = readFaucetRecoveryRequest(request.body, nativeRuntime);
      return await runtime.orders.faucetRecoveryEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof ProductEvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current faucet recovery evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current faucet recovery evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current faucet recovery evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/options/wallet-claim-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.optionsWalletClaimEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current Options wallet claim evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The evidence endpoint has no query parameters.');
      const parsed = readOptionsWalletClaimRequest(request.body, nativeRuntime);
      return await runtime.orders.optionsWalletClaimEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof ProductEvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current Options wallet claim evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current Options wallet claim evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current Options wallet claim evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/t3/operation-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.operationEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current T3 evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The T3 evidence endpoint has no query parameters.');
      const parsed = readT3OperationRequest(request.body, nativeRuntime);
      return await runtime.orders.operationEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof T3EvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current T3 evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current T3 evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current T3 evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/t3/wallet-claim-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.walletClaimEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current T3 wallet claim evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The T3 wallet claim endpoint has no query parameters.');
      const parsed = readT3WalletClaimRequest(request.body, nativeRuntime);
      return await runtime.orders.walletClaimEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof T3EvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current T3 wallet claim evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current T3 wallet claim evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current T3 wallet claim evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/spot/order-wallet-claim-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.orderWalletClaimEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current order wallet claim evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The order wallet claim endpoint has no query parameters.');
      const parsed = readOrderWalletClaimRequest(request.body, nativeRuntime);
      return await runtime.orders.orderWalletClaimEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof SpotEvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current order wallet claim evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current order wallet claim evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current order wallet claim evidence is unavailable.');
    }
  });
  app.post('/api/indexer/v1/spot/operation-evidence', { bodyLimit: 192 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!nativeRuntime || !runtime.orders?.spotOperationEvidence) return sendError(reply, 503, 'upstream_unavailable', 'Current Spot evidence is unavailable.');
    try {
      if (Object.keys(asRecord(request.query) ?? {}).length) return sendError(reply, 400, 'bad_request', 'The Spot evidence endpoint has no query parameters.');
      const parsed = readSpotOperationRequest(request.body, nativeRuntime);
      return await runtime.orders.spotOperationEvidence(parsed, requestDeadline(request, ROUTE_DEADLINE_MS.fresh));
    } catch (error) {
      if (error instanceof SpotEvidenceError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current Spot evidence unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current Spot evidence is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current Spot evidence is unavailable.');
    }
  });

  app.get('/api/indexer/v1/orders/open', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const query = asRecord(request.query) ?? {};
    if (Object.keys(query).some(key => !['cursor', 'limit'].includes(key))
      || (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 1024))
      || (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(query.limit) || Number(query.limit) > 100)))
      return sendError(reply, 400, 'invalid_cursor', 'Use an optional cursor and a limit from 1 to 100.');
    if (!nativeRuntime || !runtime.orders) return sendError(reply, 503, 'upstream_unavailable', 'Current order evidence is unavailable.');
    try {
      const page = await runtime.orders.page({ cursor: query.cursor as string | undefined,
        limit: query.limit === undefined ? undefined : Number(query.limit) });
      for (const [name, value] of Object.entries(page.headers)) reply.header(name, value);
      return page.body;
    } catch (error) {
      if (error instanceof OrderPageError) return sendError(reply, error.status, error.code, error.message);
      runtime.logger?.warn('current order page unavailable', { error: errorDiagnostic(error) });
      return sendError(reply, 503, 'upstream_unavailable', 'Current order evidence is unavailable.');
    }
  });

  app.get('/api/indexer/v1/account-storage', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const query = asRecord(request.query) ?? {};
    if (Object.keys(query).sort().join(',') !== 'address,blockRootHash,masterchainSeqno'
      || typeof query.address !== 'string' || !/^0:[0-9a-f]{64}$/.test(query.address)
      || typeof query.masterchainSeqno !== 'string' || !/^[1-9][0-9]{0,9}$/.test(query.masterchainSeqno)
      || Number(query.masterchainSeqno) > 0xffffffff || typeof query.blockRootHash !== 'string' || !/^[0-9a-f]{64}$/.test(query.blockRootHash))
      return sendError(reply, 400, 'bad_request', 'Supply the raw basechain address and exact current masterchainSeqno and blockRootHash.');
    if (!nativeRuntime || !runtime.source) return sendError(reply, 503, 'upstream_unavailable', 'Current account storage is unavailable.');
    const signal = requestDeadline(request, ROUTE_DEADLINE_MS.fresh);
    try {
      const head = await runtime.source.head({ signal }); assertFreshHeadTime(head.utime);
      if (head.seqno !== Number(query.masterchainSeqno) || head.rootHashHex !== query.blockRootHash)
        return sendError(reply, 409, 'head_mismatch', 'The chain head changed. Refresh the current read.');
      return await readAccountStorage(nativeRuntime, runtime.source, query.address, head, signal);
    } catch (error) {
      runtime.logger?.warn('current account storage unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current account storage is unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current account storage is unavailable.');
    }
  });

  app.get('/api/indexer/v1/config-prices', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const query = asRecord(request.query) ?? {};
    if (Object.keys(query).sort().join(',') !== 'blockRootHash,masterchainSeqno'
      || typeof query.masterchainSeqno !== 'string' || !/^[1-9][0-9]{0,9}$/.test(query.masterchainSeqno)
      || Number(query.masterchainSeqno) > 0xffffffff || typeof query.blockRootHash !== 'string' || !/^[0-9a-f]{64}$/.test(query.blockRootHash))
      return sendError(reply, 400, 'bad_request', 'Supply the exact masterchainSeqno and blockRootHash from the current read.');
    if (!nativeRuntime || !runtime.source) return sendError(reply, 503, 'upstream_unavailable', 'Current network prices are unavailable.');
    const signal = requestDeadline(request, ROUTE_DEADLINE_MS.fresh);
    try {
      const head = await runtime.source.head({ signal }); assertFreshHeadTime(head.utime);
      if (head.seqno !== Number(query.masterchainSeqno) || head.rootHashHex !== query.blockRootHash)
        return sendError(reply, 409, 'head_mismatch', 'The chain head changed. Refresh the current read.');
      const config = await runtime.source.getConfig({ at: head, signal });
      if ((['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex', 'utime'] as const).some(key => config.head[key] !== head[key]))
        throw new ChainReadError('upstream_unavailable');
      const basechain = currentJettonConfigPrices(config.configBoc, head.utime); assertFreshHeadTime(head.utime);
      return { schema: 'tonswap-config-prices-v1', releaseId: nativeRuntime.releaseId, manifestHash: nativeRuntime.manifestHash,
        asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex }, basechain };
    } catch (error) {
      runtime.logger?.warn('current config prices unavailable', { error: errorDiagnostic(error) });
      if (error instanceof ChainReadError) return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Current network prices are unavailable.' });
      return sendError(reply, 503, 'upstream_unavailable', 'Current network prices are unavailable.');
    }
  });

  const sendToncenterCompat = <T>(
    reply: FastifyReply,
    payload: ToncenterRpcCompatResponse<T>,
    id?: number | string | null,
    status = payload.ok ? 200 : payload.code ?? 500
  ) => {
    reply.code(status);
    if (!payload.ok) { reply.header('cache-control', 'no-store'); if ([429, 503, 504].includes(status)) reply.header('retry-after', status === 503 ? 2 : 1); }
    return reply.send({
      id: id ?? 1,
      jsonrpc: '2.0',
      ...payload
    });
  };

  const blockId = (block: TonBlockIdExt) => ({ '@type': 'ton.blockIdExt', workchain: block.workchain,
    shard: block.shard, seqno: block.seqno, root_hash: Buffer.from(block.rootHashHex, 'hex').toString('base64'),
    file_hash: Buffer.from(block.fileHashHex, 'hex').toString('base64') });

  const handleToncenterCompat = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = asRecord(request.body);
    const method = readString(body?.method);
    const rawId = body?.id;
    const id =
      typeof rawId === 'number' || typeof rawId === 'string' || rawId === null
        ? rawId
        : 1;
    const params = asRecord(body?.params ?? null) ?? {};

    if (!method) {
      return sendToncenterCompat(reply, { ok: false, code: 400, error: 'missing method' }, id);
    }

    const signal = requestDeadline(request, ROUTE_DEADLINE_MS.rpc);
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
        const result = await service.runGetMethod(address, getter, argsResult.args ?? [], { signal });
        return sendToncenterCompat(reply, { ok: true, result }, id);
      }

      if (method === 'getAddressBalance' || method === 'getAddressInformation') {
        const address = readString(params.address);
        if (!address || !isValidAddress(address)) return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid address' }, id);
        const { state, head, anchor } = await service.getAccountAnchor(address, { signal });
        if (method === 'getAddressBalance') return sendToncenterCompat(reply, { ok: true, result: state.balance }, id);
        return sendToncenterCompat(reply, { ok: true, result: {
          state: state.accountState, balance: state.balance, code: state.codeBoc ?? '', data: state.dataBoc ?? '', extra_currencies: [],
          last_transaction_id: { '@type': 'internal.transactionId', lt: state.lastTxLt ?? '0',
            hash: state.lastTxHash && /^[a-f0-9]{64}$/i.test(state.lastTxHash) ? Buffer.from(state.lastTxHash, 'hex').toString('base64') : state.lastTxHash ?? Buffer.alloc(32).toString('base64') }, block_id: blockId(head), sync_utime: anchor.genUtime
        } }, id);
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

        const txs = await service.getTransactionEvidence(address, limit, lt ?? undefined, hash ?? undefined, { signal });
        return sendToncenterCompat(reply, { ok: true, result: txs }, id);
      }

      if (method === 'getMasterchainInfo') {
        if (!runtime.source) throw new ChainReadError('upstream_unavailable');
        const head = await runtime.source.head({ signal });
        return sendToncenterCompat(reply, { ok: true, result: { last: blockId(head),
          ...(network === 'localnet' ? {} : { init: PUBLIC_RPC_ZERO_STATES[network] }) } }, id);
      }
      if ((method === 'sendBoc' || method === 'sendBocReturnHash') && config.enableWriteRpc) {
        const bytes = typeof params.boc === 'string' ? decodeCanonicalBase64(params.boc) : null;
        let cell: Cell | undefined;
        try { if (bytes) { const cells = Cell.fromBoc(bytes); if (cells.length === 1) cell = cells[0]; } } catch { /* Invalid input is a client error. */ }
        if (!bytes || !cell) return sendToncenterCompat(reply, { ok: false, code: 400, error: 'invalid message BOC' }, id);
        if (!runtime.source) throw new ChainReadError('upstream_unavailable');
        await runtime.source.sendMessage(bytes, { signal });
        return sendToncenterCompat(reply, { ok: true, result: method === 'sendBocReturnHash' ? { '@type': 'raw.extMessageInfo', hash: cell.hash().toString('hex') } : { '@type': 'ok' } }, id);
      }

      return sendToncenterCompat(reply, { ok: false, code: 404, error: `unsupported method: ${method}` }, id);
    } catch (error) {
      const admission = publicAdmissionError(error);
      if (admission) return sendToncenterCompat(reply, { ok: false, code: admission.status, error: admission.code }, id, admission.status);
      const status = error instanceof ChainReadError ? error.code === 'upstream_timeout' ? 504 : 503 : 500;
      return sendToncenterCompat(reply, { ok: false, code: status, error: status === 500 ? 'JSON-RPC request failed' : error instanceof ChainReadError ? error.code : 'upstream_unavailable' }, id, status);
    }
  };

  app.post('/jsonRPC', handleToncenterCompat);
  app.post('/api/v2/jsonRPC', handleToncenterCompat);

  app.post('/api/indexer/v1/readFresh', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body);
    const rawCalls = body?.calls;
    if (!body || Object.keys(body).some(key => key !== 'calls') || !Array.isArray(rawCalls)
      || rawCalls.length < 1 || rawCalls.length > FRESH_READ_MAX_CALLS)
      return sendError(reply, 400, 'invalid_fresh_read', 'Use 1 to 32 current chain read calls.');
    const calls: FreshReadCall[] = [];
    for (const raw of rawCalls) {
      const call = asRecord(raw);
      const address = readString(call?.address);
      if (!call || !address || !isValidAddress(address))
        return sendError(reply, 400, 'invalid_fresh_read', 'Invalid fresh read address.');
      if (call.kind === 'account' && Object.keys(call).every(key => ['kind', 'address'].includes(key))) {
        calls.push({ kind: 'account', address: Address.parse(address).toRawString() });
      } else if (call.kind === 'getter' && Object.keys(call).every(key => ['kind', 'address', 'method', 'stack'].includes(key))) {
        const method = readString(call.method);
        if (!method || !/^[a-zA-Z0-9_]{1,64}$/.test(method) || isAdmissionMethod(method))
          return sendError(reply, 400, 'invalid_fresh_read', 'Invalid fresh getter method.');
        const parsed = parseStackArgs(call.stack);
        if (!parsed.ok) return sendError(reply, 400, 'invalid_fresh_read', parsed.error ?? 'Invalid fresh getter stack.');
        calls.push({ kind: 'getter', address: Address.parse(address).toRawString(), method, args: parsed.args ?? [] });
      } else return sendError(reply, 400, 'invalid_fresh_read', 'Use an account or getter read.');
    }
    // Only the active native manifest may describe this fresh runtime. Old
    // registry metadata or a configured URL cannot establish release identity.
    const manifest = currentNativeRuntime(network, registryMetadata);
    if (!manifest)
      return sendError(reply, 503, 'upstream_unavailable', 'Fresh chain read unavailable.');
    const startedAt = Date.now();
    try {
      const response = await service.readFresh(calls, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.fresh) });
      return { ...response, release: { releaseId: manifest.releaseId, manifestHash: manifest.manifestHash } };
    } catch (error) {
      runtime.logger?.warn('fresh chain read unavailable', { elapsedMs: Date.now() - startedAt, calls: calls.length,
        releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, error: errorDiagnostic(error) });
      return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Fresh chain read unavailable.' });
    }
  });

  app.post('/api/indexer/v1/runGetMethod', async (request, reply) => {
    const body = asRecord(request.body);
    const address = readString(body?.address);
    const method = readString(body?.method);
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
      return await service.runGetMethod(address, method, argsResult.args ?? [], { signal: requestDeadline(request, ROUTE_DEADLINE_MS.getter) });
    } catch (error) {
      const admission = publicAdmissionError(error);
      if (admission) return sendError(reply, admission.status, admission.code, admission.message);
      return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'get method call failed' });
    }
  });

  app.get('/api/indexer/v1/openapi.json', async () => {
    return buildOpenApi(config, registryMetadata);
  });

  app.get('/api/indexer/v1/docs', async (_request, reply) => {
    const nonce = randomBytes(16).toString('base64');
    const html = buildDocsHtml(nonce, indexer);
    reply.header(
      'content-security-policy',
      [
        "default-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "form-action 'none'",
        "img-src 'self' data:"
      ].join('; ')
    );
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.type('text/html');
    return html;
  });

  app.get('/api/indexer/v1/metrics', async (request, reply) => {
    const denied = requireAdmin(request, reply, 'metrics_disabled', 'metrics disabled');
    if (denied) return denied;
    if (!metrics) return sendError(reply, 400, 'metrics_disabled', 'metrics disabled');
    return metrics.getMetrics();
  });

  app.get('/api/indexer/v1/metrics/prometheus', async (request, reply) => {
    const denied = requireAdmin(request, reply, 'metrics_disabled', 'metrics disabled');
    if (denied) return denied;
    if (!metrics) return sendError(reply, 400, 'metrics_disabled', 'metrics disabled');
    reply.type('text/plain');
    return metrics.getPrometheus();
  });

  app.get(
    '/api/indexer/v1/accounts/:addr/balances',
    { schema: { params: addressParamsSchema } },
    async (request, reply) => {
      const addr = (request.params as { addr: string }).addr;
      if (!isValidAddress(addr)) {
        return sendError(reply, 400, 'invalid_address', 'invalid address');
      }
      try {
        if (!runtime.balances) throw new ChainReadError('upstream_unavailable');
        return await runtime.balances.read(addr, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.balances) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'Balance source is temporarily unavailable.' });
      }
    }
  );

  app.get(
    '/api/indexer/v1/vol-index/:volIndex/snapshot',
    {
      schema: {
        params: { type: 'object', properties: { volIndex: { type: 'string' } }, required: ['volIndex'] },
        querystring: volIndexSnapshotQuerySchema
      }
    },
    async (request, reply) => {
      const volIndex = (request.params as { volIndex: string }).volIndex;
      if (!isValidAddress(volIndex)) {
        return sendError(reply, 400, 'invalid_address', 'invalid VolIndex address');
      }

      const query = request.query as { pool?: string; route_ids?: string };
      const pool = query.pool?.trim() ? query.pool.trim() : undefined;
      if (pool && !isValidAddress(pool)) {
        return sendError(reply, 400, 'invalid_address', 'invalid pool address');
      }
      const routeIds = query.route_ids?.split(',').map((value) => Number(value));
      if (routeIds?.some(id => !Number.isSafeInteger(id) || id < 0 || id > 0xffffffff)) return sendError(reply, 400, 'bad_request', 'Invalid route ID.');

      try {
        return await service.getVolIndexSnapshot(volIndex, {
          sourcePool: pool,
          routeIds
        }, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.snapshot) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'vol-index snapshot request failed' });
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
        start_id?: string;
      };
      const owner = query.owner?.trim() ? query.owner.trim() : undefined;
      if (owner && !isValidAddress(owner)) {
        return sendError(reply, 400, 'invalid_address', 'invalid owner address');
      }
      if (query.start_id !== undefined && (!/^\d+$/.test(query.start_id) || BigInt(query.start_id) >= (1n << 64n))) return sendError(reply, 400, 'bad_request', 'Invalid proposal start ID.');
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
          startId: query.start_id,
          maxScan,
          maxConsecutiveMisses
        }, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.snapshot) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'governance snapshot request failed' });
      }
    }
  );

  app.get(
    '/api/indexer/v1/pools/:pool/farms',
    { schema: { params: { type: 'object', properties: { pool: { type: 'string' } }, required: ['pool'] },
      querystring: farmsSnapshotQuerySchema } },
    async (request, reply) => {
      const pool = (request.params as { pool: string }).pool;
      const query = request.query as { owner?: string; start_id?: string; limit?: number };
      if (!isValidAddress(pool) || (query.owner !== undefined && !isValidAddress(query.owner))) {
        return sendError(reply, 400, 'invalid_address', 'invalid pool or owner address');
      }
      if (query.start_id !== undefined && BigInt(query.start_id) >= (1n << 64n)) {
        return sendError(reply, 400, 'bad_request', 'campaign start ID exceeds uint64');
      }
      try {
        return await service.getFarmSnapshot(pool, { owner: query.owner, startId: query.start_id, limit: query.limit }, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.snapshot) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'native DLMM farming snapshot unavailable' });
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

      const query = request.query as { owner?: string; after_slot?: number; limit?: number; revision?: string };
      const owner = query.owner?.trim() ? query.owner.trim() : undefined;
      if (owner && !isValidAddress(owner)) {
        return sendError(reply, 400, 'invalid_address', 'invalid owner address');
      }

      try {
        return await service.getCoverSnapshot(manager, {
          owner,
          afterSlot: query.after_slot,
          limit: query.limit,
          revision: query.revision
        }, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.snapshot) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'cover snapshot request failed' });
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
        }, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.snapshot) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'DLMM pools snapshot request failed' });
      }
    }
  );

  const handleBalanceStream = async (request: FastifyRequest, reply: FastifyReply) => {
    if (closing) return sendError(reply, 503, 'shutting_down', 'server is shutting down');
    const query = asRecord(request.query) ?? {};
    const addresses = parseStreamAddresses(query);
    if (addresses.length === 0) {
      return sendError(reply, 400, 'invalid_address', 'at least one valid address is required');
    }

    if (!runtime.streams) return sendError(reply, 503, 'upstream_unavailable', 'Balance stream unavailable.');
    const inheritedHeaders = reply.getHeaders();
    reply.hijack();
    for (const [name, value] of Object.entries(inheritedHeaders)) {
      if (value !== undefined) {
        reply.raw.setHeader(name, value);
      }
    }
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    let seq = 0;
    const writeEvent = (payload: unknown) => {
      if (!closed) reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    let unsubscribe = () => {};

    const keepAliveTimer = setInterval(() => {
      if (closed) return;
      reply.raw.write(': keepalive\n\n');
    }, BALANCE_STREAM_KEEPALIVE_MS);

    const closeStream = () => {
      if (closed) return;
      closed = true;
      activeBalanceStreams.delete(closeStream);
      clearInterval(keepAliveTimer);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        // ignore close errors
      }
    };

    activeBalanceStreams.add(closeStream);
    request.raw.on('close', closeStream);
    reply.raw.on('close', closeStream);
    writeEvent({
      type: 'subscribed',
      addresses,
      seq: ++seq,
      ts: Date.now(),
    });
    unsubscribe = runtime.streams!.subscribe(addresses, writeEvent);
    return reply;
  };

  app.get('/api/indexer/v1/stream/balances', handleBalanceStream);

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
        if (query.page !== undefined && (cursorLt !== undefined || cursorHash !== undefined)) {
          return sendError(reply, 400, 'cursor_mismatch', 'page and cursor fields are mutually exclusive');
        }
        if ((cursorLt !== undefined) !== (cursorHash !== undefined)) {
          return sendError(reply, 400, 'cursor_mismatch', 'cursor_lt and cursor_hash must be provided together');
        }
        if (cursorLt !== undefined && cursorHash !== undefined) {
          if (!isValidLt(cursorLt) || !isValidHashBase64(cursorHash)) {
            return sendError(reply, 400, 'invalid_cursor', 'invalid cursor');
          }
        }
        if (cursorLt !== undefined && cursorHash !== undefined) {
          return await service.getTransactionsByCursor(addr, cursorLt, cursorHash, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.rpc) });
        }
        return await service.getTransactions(addr, page, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.rpc) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'transaction request failed' });
      }
    }
  );

  app.get(
    '/api/indexer/v1/markets/:market/candles',
    { schema: { params: marketCandleParamsSchema, querystring: marketCandleQuerySchema } },
    async (request, reply) => {
      const marketKey = (request.params as { market: string }).market.trim();
      const query = request.query as {
        market_address: string;
        asset_symbol: string;
        quote_symbol: string;
        asset_decimals?: number | string;
        quote_decimals?: number | string;
        interval?: MarketCandleInterval;
        from_utime?: number | string;
        to_utime?: number | string;
        limit?: number | string;
      };
      if (!marketKey) {
        return sendError(reply, 400, 'bad_request', 'market must not be empty');
      }
      if (!isValidAddress(query.market_address)) {
        return sendError(reply, 400, 'invalid_address', 'invalid market_address');
      }
      const assetSymbol = query.asset_symbol?.trim().toUpperCase();
      const quoteSymbol = query.quote_symbol?.trim().toUpperCase();
      if (!assetSymbol || !quoteSymbol || assetSymbol === quoteSymbol) {
        return sendError(reply, 400, 'bad_request', 'asset_symbol and quote_symbol must be distinct');
      }
      const canonicalMarket =
        canonicalCandleMarkets.length > 0
          ? canonicalCandleMarkets.find((market) => market.marketKey === marketKey)
          : undefined;
      if (registryMetadata?.manifestHash && !canonicalMarket) {
        return sendError(reply, 404, 'not_found', 'market is absent from the canonical release manifest');
      }
      if (
        canonicalMarket &&
        (rawAddress(query.market_address) !== rawAddress(canonicalMarket.marketAddress) ||
          assetSymbol !== canonicalMarket.assetSymbol ||
          quoteSymbol !== canonicalMarket.quoteSymbol)
      ) {
        return sendError(
          reply,
          400,
          'bad_request',
          'market address and symbols must match the canonical release manifest'
        );
      }

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

      const hasAssetDecimals = query.asset_decimals !== undefined;
      const hasQuoteDecimals = query.quote_decimals !== undefined;
      const assetDecimals = parseNonNegativeIntQuery(query.asset_decimals);
      const quoteDecimals = parseNonNegativeIntQuery(query.quote_decimals);
      if (hasAssetDecimals && (assetDecimals === null || assetDecimals > 30)) {
        return sendError(reply, 400, 'bad_request', 'asset_decimals must be an integer from 0 to 30');
      }
      if (hasQuoteDecimals && (quoteDecimals === null || quoteDecimals > 30)) {
        return sendError(reply, 400, 'bad_request', 'quote_decimals must be an integer from 0 to 30');
      }
      if (
        canonicalMarket &&
        ((hasAssetDecimals && assetDecimals !== canonicalMarket.assetDecimals) ||
          (hasQuoteDecimals && quoteDecimals !== canonicalMarket.quoteDecimals))
      ) {
        return sendError(reply, 400, 'bad_request', 'market decimals must match the canonical release manifest');
      }
      const limitRaw = parsePositiveIntQuery(query.limit);
      const limit = Math.min(1_000, limitRaw ?? 320);

      try {
        const history = await service.getMarketCandles(
          canonicalMarket?.marketKey ?? marketKey,
          canonicalMarket?.marketAddress ?? query.market_address,
          {
          assetSymbol: canonicalMarket?.assetSymbol ?? assetSymbol,
          quoteSymbol: canonicalMarket?.quoteSymbol ?? quoteSymbol,
          assetDecimals: canonicalMarket?.assetDecimals ?? assetDecimals ?? undefined,
          quoteDecimals: canonicalMarket?.quoteDecimals ?? quoteDecimals ?? undefined,
          interval: query.interval,
          fromUtime: fromUtime ?? undefined,
          toUtime: toUtime ?? undefined,
          limit,
          }, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.snapshot) }
        );
        return {...history,
          token_root: canonicalMarket?.tokenRoot ?? null,
          asset_symbol: canonicalMarket?.assetSymbol ?? assetSymbol,
          quote_symbol: canonicalMarket?.quoteSymbol ?? quoteSymbol,
          asset_decimals: canonicalMarket?.assetDecimals ?? assetDecimals ?? null,
          quote_decimals: canonicalMarket?.quoteDecimals ?? quoteDecimals ?? null,
        };
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'candles request failed' });
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
        return await service.getState(addr, { signal: requestDeadline(request, ROUTE_DEADLINE_MS.rpc) });
      } catch (error) {
        return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'state request failed' });
      }
    }
  );

  app.post('/api/indexer/v1/snapshot/save', async (request, reply) => {
    if (!snapshots) return sendError(reply, 400, 'snapshot_disabled', 'snapshot disabled');
    const denied = requireAdmin(request, reply, 'snapshot_disabled', 'snapshot disabled');
    if (denied) return denied;
    try {
      return { ok: true, ...(await snapshots.save()) };
    } catch (error) {
      return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'snapshot save failed' });
    }
  });

  app.post('/api/indexer/v1/snapshot/load', async (request, reply) => {
    if (!snapshots) return sendError(reply, 400, 'snapshot_disabled', 'snapshot disabled');
    const denied = requireAdmin(request, reply, 'snapshot_disabled', 'snapshot disabled');
    if (denied) return denied;
    try {
      return { ok: true, ...(snapshots.load() as object) };
    } catch (error) {
      return sendFailure(reply, error, { code: 'upstream_unavailable', message: 'snapshot load failed' });
    }
  });

  app.get(
    '/api/indexer/v1/debug',
    { schema: { querystring: debugQuerySchema } },
    async (request, reply) => {
      if (!debug) return sendError(reply, 400, 'debug_disabled', 'debug disabled');
      const denied = requireAdmin(request, reply, 'debug_disabled', 'debug disabled');
      if (denied) return denied;
      const query = request.query as { limit?: string };
      const limit = Math.max(1, Math.min(500, Number(query.limit ?? 100)));
      return debug.getStatus(limit);
    }
  );
};
