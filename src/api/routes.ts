import { Address } from '@ton/core';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IndexerService } from '../indexerService';
import { MetricsService } from '../metrics';
import { SnapshotService } from '../snapshotService';
import { AdminGuard } from './admin';
import { DebugService } from '../debugService';
import { RateLimiter } from './rateLimit';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from './validation';
import { addressParamsSchema, debugQuerySchema, perpsSnapshotQuerySchema, txQuerySchema } from './schemas';
import { buildOpenApi } from './openapi';
import { buildDocsHtml } from './docsHtml';
import { sendError } from './errors';

const BALANCE_STREAM_POLL_MS = 1_500;
const BALANCE_STREAM_KEEPALIVE_MS = 15_000;
const BALANCE_STREAM_MAX_ADDRESSES = 8;

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

export const registerRoutes = (
  app: FastifyInstance,
  config: { adminEnabled: boolean },
  service: IndexerService,
  metrics?: MetricsService,
  snapshots?: SnapshotService,
  adminGuard?: AdminGuard,
  debug?: DebugService,
  rateLimiter?: RateLimiter
) => {
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
