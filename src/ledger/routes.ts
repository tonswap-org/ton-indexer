import { LedgerDiscoveryCursorError } from './discovery';
import type { FastifyInstance } from 'fastify';
import { canonicalLedgerAddress } from './normalize';
import { LedgerCursorError } from './store';
import type { LedgerService } from './service';

export function registerLedgerRoutes(
  app: FastifyInstance,
  service?: LedgerService
) {
  app.get(
    '/api/indexer/v1/accounts/:addr/ledger',
    {
      schema: {
        params: {
          type: 'object',
          required: ['addr'],
          properties: { addr: { type: 'string', maxLength: 100 } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["perps"] },
            from_utime: {
              type: 'integer',
              minimum: 0,
              maximum: 8_640_000_000_000,
            },
            to_utime: {
              type: 'integer',
              minimum: 0,
              maximum: 8_640_000_000_000,
            },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            cursor: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!service)
        return reply
          .code(503)
          .send({
            code: 'ledger_unavailable',
            error: 'Durable ledger storage is not configured.',
          });
      let account: string;
      try {
        account = canonicalLedgerAddress(
          (request.params as { addr: string }).addr
        );
      } catch {
        return reply
          .code(400)
          .send({
            code: 'invalid_address',
            error: 'Invalid TON account address.',
          });
      }
      const query = request.query as {
        scope?: "perps";
        from_utime?: number;
        to_utime?: number;
        limit?: number;
        cursor?: string;
      };
      if (
        query.from_utime !== undefined &&
        query.to_utime !== undefined &&
        query.from_utime >= query.to_utime
      ) {
        return reply
          .code(400)
          .send({
            code: 'invalid_range',
            error: 'from_utime must precede to_utime.',
          });
      }
      if (query.scope === "perps" && (query.from_utime === undefined || query.to_utime === undefined ||
          query.to_utime > Math.floor(Date.now() / 1000) + 5))
        return reply.code(400).send({ code: "invalid_range", error: "Perps scope requires an exact interval ending no later than five seconds in the future." });
      try {
        return await service.page(account, {
          scope: query.scope,
          fromUtime: query.from_utime,
          toUtime: query.to_utime,
          limit: query.limit,
          cursor: query.cursor,
        });
      } catch (error) {
        if (error instanceof LedgerCursorError)
          return reply
            .code(400)
            .send({ code: 'invalid_cursor', error: error.message });
        return reply
          .code(503)
          .send({
            code: 'ledger_unavailable',
            error: 'Ledger storage is temporarily unavailable.',
          });
      }
    }
  );
  app.get('/api/indexer/v1/accounts/:addr/ledger/discoveries', {
    schema: {
      params: { type: 'object', required: ['addr'], properties: { addr: { type: 'string', maxLength: 100 } } },
      querystring: { type: 'object', additionalProperties: false, required: ['since'], properties: {
        since: { type: 'string', format: 'date-time', maxLength: 30 },
        after_revision: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$' },
        cursor: { type: 'string', maxLength: 2048 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
      } },
    },
  }, async (request, reply) => {
    if (!service) return reply.code(503).send({ code: 'ledger_unavailable', error: 'Durable ledger storage is not configured.' });
    let account: string;
    try { account = canonicalLedgerAddress((request.params as { addr: string }).addr); }
    catch { return reply.code(400).send({ code: 'invalid_address', error: 'Invalid TON account address.' }); }
    const query = request.query as { since: string; after_revision?: string; cursor?: string; limit?: number };
    try { return await service.discoveries(account, { since: query.since, afterRevision: query.after_revision, cursor: query.cursor, limit: query.limit }); }
    catch (error) {
      if (error instanceof LedgerDiscoveryCursorError || error instanceof LedgerCursorError)
        return reply.code(400).send({ code: 'invalid_cursor', error: error.message });
      return reply.code(503).send({ code: 'ledger_unavailable', error: 'Ledger discovery storage is temporarily unavailable.' });
    }
  });

}
