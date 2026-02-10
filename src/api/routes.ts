import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IndexerService } from '../indexerService';
import { MetricsService } from '../metrics';
import { SnapshotService } from '../snapshotService';
import { AdminGuard } from './admin';
import { DebugService } from '../debugService';
import { RateLimiter } from './rateLimit';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from './validation';
import { addressParamsSchema, debugQuerySchema, txQuerySchema } from './schemas';
import { buildOpenApi } from './openapi';
import { buildDocsHtml } from './docsHtml';
import { sendError } from './errors';

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
