import { Config } from '../config';

export const buildOpenApi = (config: Config) => {
  const bearer = config.adminEnabled ? [{ bearerAuth: [] }] : [];

  return {
    openapi: '3.0.3',
    info: {
      title: 'TONSWAP Indexer API',
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
      parameters: {
        addr: {
          name: 'addr',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' }, code: { type: 'string' } },
          required: ['error', 'code'],
        },
        HealthStatus: {
          type: 'object',
          properties: {
            lastMasterSeqno: { type: ['integer', 'null'] },
            indexerLagSec: { type: ['number', 'null'] },
            liteserverPoolStatus: { type: ['string', 'null'] },
          },
        },
        BalanceResponse: {
          type: 'object',
          properties: {
            ton: {
              type: 'object',
              properties: {
                balance: { type: 'string' },
                last_tx_lt: { type: 'string' },
                last_tx_hash: { type: 'string' },
              },
              required: ['balance'],
            },
            jettons: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  master: { type: 'string' },
                  wallet: { type: 'string' },
                  balance: { type: 'string' },
                  decimals: { type: 'integer' },
                  symbol: { type: 'string' },
                },
                required: ['master', 'wallet', 'balance'],
              },
            },
            confirmed: { type: 'boolean' },
            updated_at: { type: 'integer' },
            network: { type: 'string' },
          },
          required: ['ton', 'jettons', 'confirmed', 'updated_at', 'network'],
        },
        AssetBalanceResponse: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['native', 'jetton'] },
            symbol: { type: ['string', 'null'] },
            address: { type: ['string', 'null'] },
            wallet: { type: ['string', 'null'] },
            balance_raw: { type: 'string' },
            balance: { type: 'string' },
            decimals: { type: 'integer' },
          },
          required: ['kind', 'balance_raw', 'balance', 'decimals'],
        },
        BalancesResponse: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            ton_raw: { type: 'string' },
            ton: { type: 'string' },
            assets: { type: 'array', items: { $ref: '#/components/schemas/AssetBalanceResponse' } },
            confirmed: { type: 'boolean' },
            updated_at: { type: 'integer' },
            network: { type: 'string' },
          },
          required: ['address', 'ton_raw', 'ton', 'assets', 'confirmed', 'updated_at', 'network'],
        },
        TxEntry: {
          type: 'object',
          properties: {
            txId: { type: 'string' },
            utime: { type: 'integer' },
            status: { type: 'string' },
            reason: { type: 'string' },
            txType: { type: 'string' },
            inSource: { type: 'string' },
            inValue: { type: 'string' },
            outCount: { type: 'integer' },
            detail: { type: 'object' },
            kind: { type: 'string' },
            actions: { type: 'array', items: { type: 'object' } },
            lt: { type: 'string' },
            hash: { type: 'string' },
          },
          required: ['txId', 'utime', 'status', 'txType', 'outCount', 'detail', 'kind', 'actions', 'lt', 'hash'],
        },
        TxResponse: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            page_size: { type: 'integer' },
            total_txs: { type: 'integer' },
            total_pages: { type: ['integer', 'null'] },
            total_pages_min: { type: 'integer' },
            history_complete: { type: 'boolean' },
            txs: { type: 'array', items: { $ref: '#/components/schemas/TxEntry' } },
            network: { type: 'string' },
          },
          required: ['page', 'page_size', 'total_txs', 'total_pages_min', 'history_complete', 'txs', 'network'],
        },
        StateResponse: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            last_tx_lt: { type: ['string', 'null'] },
            last_tx_hash: { type: ['string', 'null'] },
            last_seen_utime: { type: ['integer', 'null'] },
            last_confirmed_seqno: { type: ['integer', 'null'] },
            network: { type: 'string' },
          },
          required: ['address', 'network'],
        },
        SnapshotResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            entries: { type: 'integer' },
          },
          required: ['ok'],
        },
        DebugResponse: {
          type: 'object',
          properties: {
            data_source: { type: 'string' },
            network: { type: 'string' },
            snapshot_path: { type: ['string', 'null'] },
            snapshot_on_exit: { type: 'boolean' },
            watchlist_size: { type: 'integer' },
            backfill_pending: { type: 'integer' },
            backfill_inflight: { type: 'integer' },
            entries: { type: 'array', items: { type: 'object' } },
          },
        },
        MetricsResponse: {
          type: 'object',
          properties: {
            started_at: { type: 'integer' },
            uptime_ms: { type: 'integer' },
            network: { type: 'string' },
            data_source: { type: 'string' },
            addresses: { type: 'integer' },
            total_txs: { type: 'integer' },
            backfill_pending: { type: 'integer' },
            backfill_inflight: { type: 'integer' },
            backfill_batches: { type: 'integer' },
            backfill_txs: { type: 'integer' },
            request_stats: { type: 'object' },
            cache_stats: { type: 'object' },
            last_master_seqno: { type: ['integer', 'null'] },
            indexer_lag_sec: { type: ['number', 'null'] },
            liteserver_pool_status: { type: ['string', 'null'] },
          },
        },
      },
    },
    paths: {
      '/api/indexer/v1/health': {
        get: {
          summary: 'Health check',
          responses: {
            200: {
              description: 'Health status',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthStatus' } } },
            },
          },
        },
      },
      '/api/indexer/v1/metrics': {
        get: {
          summary: 'Metrics snapshot',
          responses: {
            200: {
              description: 'Metrics',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/MetricsResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/metrics/prometheus': {
        get: {
          summary: 'Prometheus metrics',
          security: bearer,
          responses: {
            200: { description: 'Prometheus metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
            401: { description: 'Unauthorized', content: { 'text/plain': { schema: { type: 'string' } } } },
          },
        },
      },
      '/api/indexer/v1/accounts/{addr}/balance': {
        get: {
          summary: 'Account balance',
          parameters: [{ $ref: '#/components/parameters/addr' }],
          responses: {
            200: {
              description: 'Balance response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BalanceResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/accounts/{addr}/balances': {
        get: {
          summary: 'Account balances (formatted)',
          parameters: [{ $ref: '#/components/parameters/addr' }],
          responses: {
            200: {
              description: 'Balances response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BalancesResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/accounts/{addr}/assets': {
        get: {
          summary: 'Account assets (alias of balances)',
          parameters: [{ $ref: '#/components/parameters/addr' }],
          responses: {
            200: {
              description: 'Balances response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BalancesResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/accounts/{addr}/txs': {
        get: {
          summary: 'Account transactions',
          parameters: [
            { $ref: '#/components/parameters/addr' },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', minimum: 1 },
            },
            { name: 'cursor_lt', in: 'query', schema: { type: 'string', pattern: '^\\d+$' } },
            { name: 'cursor_hash', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Tx response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/TxResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/accounts/{addr}/state': {
        get: {
          summary: 'Account state',
          parameters: [{ $ref: '#/components/parameters/addr' }],
          responses: {
            200: {
              description: 'State response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/StateResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/stream/balances': {
        get: {
          summary: 'Balance stream (SSE)',
          parameters: [
            { name: 'address', in: 'query', schema: { type: 'string' } },
            { name: 'wallet', in: 'query', schema: { type: 'string' } },
            { name: 'addresses', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'SSE event stream',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                },
              },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/stream': {
        get: {
          summary: 'Balance stream alias (SSE)',
          parameters: [
            { name: 'address', in: 'query', schema: { type: 'string' } },
            { name: 'wallet', in: 'query', schema: { type: 'string' } },
            { name: 'addresses', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'SSE event stream',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                },
              },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/snapshot/save': {
        post: {
          summary: 'Save in-memory snapshot',
          security: bearer,
          responses: {
            200: {
              description: 'Snapshot saved',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SnapshotResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            401: {
              description: 'Unauthorized',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/snapshot/load': {
        post: {
          summary: 'Load in-memory snapshot',
          security: bearer,
          responses: {
            200: {
              description: 'Snapshot loaded',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SnapshotResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            401: {
              description: 'Unauthorized',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/debug': {
        get: {
          summary: 'Debug snapshot',
          security: bearer,
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }],
          responses: {
            200: {
              description: 'Debug response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DebugResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            401: {
              description: 'Unauthorized',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/openapi.json': {
        get: {
          summary: 'OpenAPI spec',
          responses: { 200: { description: 'OpenAPI JSON' } },
        },
      },
      '/api/indexer/v1/docs': {
        get: {
          summary: 'Docs',
          responses: { 200: { description: 'Docs HTML' } },
        },
      },
    },
  };
};
