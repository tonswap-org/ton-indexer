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
      try {
        return await service.page(account, {
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
}
