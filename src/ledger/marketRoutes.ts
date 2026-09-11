import type { FastifyInstance } from 'fastify';
import { canonicalLedgerAddress } from './normalize';
import { MarketCursorError } from './marketStore';
import type { DlmmMarketService } from './marketService';

export function registerMarketLedgerRoutes(app: FastifyInstance, service?: DlmmMarketService) {
  for (const list of ['observations', 'candidates'] as const) app.get(`/api/indexer/v1/markets/:pool/${list}`, {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['pool'], properties: { pool: { type: 'string', maxLength: 100 } } },
      querystring: { type: 'object', additionalProperties: false, properties: {
        from_utime: { type: 'integer', minimum: 0, maximum: 253402300799 }, to_utime: { type: 'integer', minimum: 0, maximum: 253402300799 },
        limit: { type: 'integer', minimum: 1, maximum: 500 }, cursor: { type: 'string', maxLength: 2048 }, generation: { type: 'string', format: 'uuid' },
      } },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!service) return reply.code(503).send({ code: 'historical_market_unavailable', error: 'Durable historical market storage is not configured.' });
    let pool: string; try { pool = canonicalLedgerAddress((request.params as { pool: string }).pool); }
    catch { return reply.code(400).send({ code: 'invalid_address' }); }
    if (!service.configured(pool)) return reply.code(404).send({ code: 'market_binding_unconfigured', error: 'This pool has no qualified historical market binding.' });
    const query = request.query as { from_utime?: number; to_utime?: number; limit?: number; cursor?: string; generation?: string };
    if (query.from_utime !== undefined && query.to_utime !== undefined && query.from_utime >= query.to_utime) return reply.code(400).send({ code: 'invalid_range' });
    try {
      return await service.page(pool, { from: query.from_utime, to: query.to_utime, limit: query.limit, cursor: query.cursor, generation: query.generation }, list === 'candidates');
    } catch (error) {
      if (error instanceof MarketCursorError) return reply.code(400).send({ code: 'invalid_market_cursor' });
      return reply.code(503).send({ code: 'historical_market_unavailable', error: 'Historical market evidence is temporarily unavailable.' });
    }
  });
}
