import { Address, Cell } from '@ton/core';
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

type ToncenterStackEntry = [string, unknown];

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
  config: { adminEnabled: boolean; network?: string },
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
      try {
        return await service.getSwapExecutions(addr, {
          limit,
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
