import type { RegistryMetadata } from '../config/releaseManifest';
import { ledgerPaths, ledgerSchemas } from '../ledger/openapi';
import { currentNativeRuntime, resolveServiceMetadata, type ServiceMetadataConfig } from './serviceMetadata';
import { publicIndexerPath } from './publicMount';
import { currentReleasePaths, currentReleaseSchemas } from './currentReleaseOpenapi';

export const buildOpenApi = (config: ServiceMetadataConfig, metadata?: RegistryMetadata) => {
  const { serviceId } = resolveServiceMetadata(config, metadata);
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'TONSWAP Indexer API',
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        AdminToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Indexer-Admin-Token',
        },
        AdminBearer: {
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
        jetton: {
          name: 'jetton',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        owner: {
          name: 'owner',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      },
      schemas: {
        ...ledgerSchemas,
        ...currentReleaseSchemas,
        ErrorResponse: {
          type: 'object',
          additionalProperties: false, properties: { error: { type: 'string' }, code: { type: 'string' } },
          required: ['error', 'code'],
        },
        TonBlockId: { type: 'object', required: ['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex'], properties: {
          workchain: {type:'integer'}, shard: {type:'string'}, seqno: {type:'integer',minimum:0},
          rootHashHex: {type:'string',pattern:'^[a-f0-9]{64}$'}, fileHashHex: {type:'string',pattern:'^[a-f0-9]{64}$'} } },
        HealthStatus: {
          type: 'object', properties: {
            serviceId: {type:serviceId === null ? 'null' : 'string',enum:[serviceId],description:'Exact current manifest service identity; null without current release bindings.'}, ecosystem: {type:'string',enum:['ton']}, chainId: {type:'string'}, network: {type:'string'},
            chain: {type:'object',required:['peersConfigured','peersReady','headSeqno','headAgeSec'],properties:{
              peersConfigured:{type:'integer',minimum:0},peersReady:{type:'integer',minimum:0},headSeqno:{type:['integer','null']},headAgeSec:{type:['number','null']} }},
            ledger: {type:'string',enum:['disabled','connecting','ready','unavailable']},disk:{type:'string',enum:['ok','low','critical']},
            admission: {type:'object',required:['configured','ready'],properties:{configured:{type:'boolean'},ready:{type:'boolean'}}}
          }, required:['serviceId','ecosystem','chainId','network','chain','ledger','disk','admission']
        },
        ContractsResponse: {
          type: 'object',
          properties: {
            network: { type: ['string', 'null'] },
            count: { type: 'integer' },
            contracts: { type: 'object', additionalProperties: { type: 'string' } },
            release: { type: 'object', additionalProperties: false, properties: { releaseId: { type: ['string', 'null'] }, manifestHash: { type: ['string', 'null'] } }, required: ['releaseId', 'manifestHash'] },
          },
          required: ['count', 'contracts', 'release'],
        },
        ServiceInfoResponse: {
          type: 'object',
          properties: {
            schemaVersion: { type: 'integer', enum: [1] },
            serviceId: { type: serviceId === null ? 'null' : 'string', enum: [serviceId], description: 'Exact current manifest service identity; null without current release bindings.' },
            serviceName: { type: 'string' },
            ecosystem: { type: 'string', enum: ['ton'] },
            chainId: { type: 'string' },
            network: { type: 'string' },
            publicBaseUrl: { type: serviceId === null ? 'null' : 'string', format: 'uri', description: 'The current manifest services.indexer URL, including its public mount.' },
            readOnly: { type: 'boolean' },
            capabilities: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } },
            release: {
              type: 'object',
              properties: {
                releaseId: { type: ['string', 'null'] },
                manifestHash: { type: ['string', 'null'] },
              },
              required: ['releaseId', 'manifestHash'],
            },
          },
          required: [
            'schemaVersion',
            'serviceId',
            'serviceName',
            'ecosystem',
            'chainId',
            'network',
            'publicBaseUrl',
            'readOnly',
            'capabilities',
            'endpoints',
            'release'
          ],
        },
        FreshReadRequest: {
          type: 'object', additionalProperties: false, required: ['calls'],
          properties: { calls: { type: 'array', minItems: 1, maxItems: 32, items: { oneOf: [
            { type: 'object', additionalProperties: false, required: ['kind', 'address'],
              properties: { kind: { const: 'account' }, address: { type: 'string' } } },
            { type: 'object', additionalProperties: false, required: ['kind', 'address', 'method'],
              properties: { kind: { const: 'getter' }, address: { type: 'string' }, method: { type: 'string', pattern: '^[a-zA-Z0-9_]{1,64}$' },
                stack: { type: 'array', items: { type: 'array', items: {} } } } }
          ] } } }
        },
        FreshReadResponse: {
          type: 'object', required: ['network', 'release', 'readContext', 'results'],
          properties: {
            network: { type: 'string', enum: ['testnet', 'mainnet', 'localnet'] },
            release: { type: 'object', required: ['releaseId', 'manifestHash'], properties: {
              releaseId: { type: 'string' }, manifestHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
            readContext: { type: 'object', required: ['source', 'head', 'queriedAt'], properties: {
              source: { type: 'string', enum: ['lite'] },
              queriedAt: { type: 'integer', description: 'Uncached masterchain query start in epoch milliseconds; not block creation time.' },
              head: { type: 'object', required: ['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex', 'utime'], properties: {
                utime: {type:'integer',minimum:1}, workchain: { const: -1 }, shard: { const: '-9223372036854775808' }, seqno: { type: 'integer', minimum: 0 },
                rootHashHex: { type: 'string', pattern: '^[a-f0-9]{64}$' }, fileHashHex: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }
            } },
            results: { type: 'array', items: { oneOf: [
              { type: 'object', required: ['kind', 'address', 'balance_raw', 'account_state', 'code_boc', 'data_boc', 'last_tx_lt', 'last_tx_hash', 'shard_block', 'shard_utime'],
                properties: { kind: { const: 'account' }, address: { type: 'string' }, balance_raw: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
                  account_state: { type: 'string', enum: ['active', 'uninitialized', 'frozen'] },
                  code_boc: { type: ['string', 'null'] }, data_boc: { type: ['string', 'null'] },
                  last_tx_lt: { type: ['string', 'null'] }, last_tx_hash: { type: ['string', 'null'] }, shard_block: {oneOf:[{$ref:'#/components/schemas/TonBlockId'},{type:'null'}]}, shard_utime: {type:['integer','null'],minimum:1} } },
              { type: 'object', required: ['kind', 'address', 'stack', 'exit_code', 'gas_used'], properties: {
                kind: { const: 'getter' }, address: { type: 'string' }, stack: { type: 'array', items: { type: 'array', items: {} } },
                exit_code: { type: 'integer' }, gas_used: { type: 'null' } } }
            ] } }
          }
        },
        RunGetMethodRequest: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            method: { type: 'string' },
            stack: { type: 'array', items: { type: 'array', items: {} } },
          },
          required: ['address', 'method'],
        },
        RunGetMethodResponse: {
          type: 'object',
          properties: {
            exit_code: { type: 'integer' },
            gas_used: { type: ['integer', 'null'], description: 'Measured TVM gas for verified admission; null when the source does not report gas.' },
            stack: { type: 'array', items: { type: 'array', items: {} } },
          },
          required: ['exit_code', 'gas_used', 'stack'],
        },
        DlmmPoolsSnapshotRequest: {
          type: 'object',
          properties: {
            t3Root: { type: 'string' },
            dlmmRegistry: { type: ['string', 'null'] },
            dlmmFactory: { type: ['string', 'null'] },
            tokens: { type: 'array', items: { type: 'string' } },
          },
          required: ['t3Root', 'tokens'],
        },
        DlmmPoolsSnapshotResponse: {
          type: 'object',
          properties: {
            t3Root: { type: 'string' },
            registry: { type: ['string', 'null'] },
            factory: { type: ['string', 'null'] },
            pools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  pool: { type: ['string', 'null'] },
                  kind: { type: ['integer', 'null'] },
                  status: { type: ['integer', 'null'] },
                  activeBinId: { type: ['integer', 'null'] },
                  walletCodeHash: { type: ['string', 'null'] },
                  binReserves: {
                    type: ['object', 'null'],
                    properties: {
                      reserveT: { type: ['string', 'null'] },
                      reserveX: { type: ['string', 'null'] }
                    },
                    additionalProperties: false
                  }
                },
                required: ['token', 'pool', 'kind', 'status', 'activeBinId', 'walletCodeHash', 'binReserves'],
                additionalProperties: false
              }
            },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['t3Root', 'pools', 'network', 'updated_at'],
        },
        AssetBalanceResponse: {
          oneOf: [
            {type:'object',additionalProperties:false,required:['kind','symbol','status','balance_raw','decimals'],properties:{
              kind:{const:'native'},symbol:{const:'GRAM'},status:{const:'ok'},balance_raw:{type:'string',pattern:'^(0|[1-9][0-9]*)$'},decimals:{const:9}}},
            {type:'object',additionalProperties:false,required:['kind','symbol','root','wallet','status','balance_raw','decimals'],properties:{
              kind:{const:'jetton'},symbol:{type:'string'},root:{type:'string'},wallet:{type:['string','null']},status:{enum:['ok','not_deployed']},
              balance_raw:{type:'string',pattern:'^(0|[1-9][0-9]*)$'},decimals:{type:'integer',minimum:0,maximum:255}}},
            {type:'object',additionalProperties:false,required:['kind','symbol','root','wallet','status','balance_raw','decimals','reason'],properties:{
              kind:{const:'jetton'},symbol:{type:'string'},root:{type:'string'},wallet:{type:['string','null']},status:{const:'unavailable'},balance_raw:{type:'null'},
              decimals:{type:'integer',minimum:0,maximum:255},reason:{enum:['timeout','upstream','code_mismatch','root_unqualified']}}}
          ]
        },
        BalancesResponse: {
          type:'object',additionalProperties:false,required:['address','network','head_seqno','head_utime','complete','assets'],properties:{
            address:{type:'string'},network:{type:'string'},head_seqno:{type:'integer',minimum:0},head_utime:{type:'integer',minimum:1},
            complete:{type:'boolean',description:'Every release token has a verified amount; unavailable rows remain explicit.'},
            assets:{type:'array',items:{$ref:'#/components/schemas/AssetBalanceResponse'}}}
        },
        TxEntry: {
          type: 'object',
          properties: {
            totalFeesRaw: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            txId: { type: 'string' },
            utime: { type: 'integer' },
            status: { type: 'string' },
            reason: { type: 'string' },
            txType: { type: 'string' },
            inSource: { type: 'string' },
            inValue: { type: 'string' },
            outCount: { type: 'integer' },
            detail: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                payToken: { type: 'string' },
                receiveToken: { type: 'string' },
                payAmount: { type: 'string' },
                receiveAmount: { type: 'string' },
                minimumReceiveAmount: { type: 'string' },
                queryId: { type: 'string' },
                executionType: { type: 'string', enum: ['market', 'limit', 'twap', 'unknown'] },
                twapSlice: { type: 'integer' },
                twapTotal: { type: 'integer' },
                querySequence: { type: 'integer' },
                queryNonce: { type: 'integer' },
              },
            },
            kind: { type: 'string' },
            actions: { type: 'array', items: { type: 'object' } },
            lt: { type: 'string' },
            hash: { type: 'string' },
            inMessage: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                destination: { type: 'string' },
                value: { type: 'string' },
                op: { type: 'integer' },
                body: { type: 'string' },
              },
            },
            outMessages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  destination: { type: 'string' },
                  value: { type: 'string' },
                  op: { type: 'integer' },
                  body: { type: 'string' },
                },
              },
            },
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
        MarketCandle: {
          type: 'object',
          properties: {
            ts: { type: 'integer' },
            open: { type: 'number' },
            high: { type: 'number' },
            low: { type: 'number' },
            close: { type: 'number' },
            volumeBase: { type: 'number' },
            volumeQuote: { type: 'number' },
            tradeCount: { type: 'integer' },
            sourceTxIds: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'ts',
            'open',
            'high',
            'low',
            'close',
            'volumeBase',
            'volumeQuote',
            'tradeCount',
            'sourceTxIds',
          ],
        },
        MarketCandlesResponse: {
          type: 'object',
          properties: {
            market_key: { type: 'string' },
            market_address: { type: 'string' },
            token_root: { type: ['string', 'null'], description: 'Canonical release token root; null for an unbound ad-hoc query.' },
            asset_symbol: { type: 'string' },
            quote_symbol: { type: 'string' },
            asset_decimals: { type: ['integer', 'null'] },
            quote_decimals: { type: ['integer', 'null'] },
            interval: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'] },
            from_utime: { type: ['integer', 'null'] },
            to_utime: { type: ['integer', 'null'] },
            candle_count: { type: 'integer' },
            history_complete: { type: 'boolean' },
            synced_at: { type: 'integer' },
            network: { type: 'string' },
            candles: { type: 'array', items: { $ref: '#/components/schemas/MarketCandle' } },
          },
          required: [
            'market_key',
            'market_address',
            'token_root', 'asset_symbol', 'quote_symbol', 'asset_decimals', 'quote_decimals',
            'interval',
            'from_utime',
            'to_utime',
            'candle_count',
            'history_complete',
            'synced_at',
            'network',
            'candles',
          ],
        },
        StateResponse: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            balance_raw: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            last_tx_lt: { type: ['string', 'null'] },
            last_tx_hash: { type: ['string', 'null'] },
            last_seen_utime: { type: ['integer', 'null'] },
            last_confirmed_seqno: { type: ['integer', 'null'] },
            account_state: { type: ['string', 'null'] },
            code_boc: { type: ['string', 'null'] },
            data_boc: { type: ['string', 'null'] },
            network: { type: 'string' },
            shard_block: { $ref: '#/components/schemas/TonBlockId' },
            shard_utime: { type: 'integer', minimum: 1 },
          },
          required: ['address', 'network', 'balance_raw', 'shard_block', 'shard_utime'],
        },
        GovernanceLockResponse: {
          type: 'object',
          properties: {
            amount: { type: ['string', 'null'] },
            unlockTime: { type: ['string', 'null'] },
            tier: { type: ['string', 'null'] },
            activatedAt: { type: ['string', 'null'] },
            weight: { type: ['string', 'null'] },
          },
        },
        GovernanceProposalResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: ['string', 'null'] },
            passed: { type: ['string', 'null'] },
            yesWeight: { type: ['string', 'null'] },
            noWeight: { type: ['string', 'null'] },
            abstainWeight: { type: ['string', 'null'] },
            quorumWeight: { type: ['string', 'null'] },
            totalWeightSnapshot: { type: ['string', 'null'] },
            startTime: { type: ['string', 'null'] },
            minCloseTime: { type: ['string', 'null'] },
            maxCloseTime: { type: ['string', 'null'] },
            cooldownEnd: { type: ['string', 'null'] },
            target: { type: ['string', 'null'] },
            value: { type: ['string', 'null'] },
            descriptionHash: { type: ['string', 'null'] },
          },
          required: ['id'],
        },
        GovernanceSnapshotResponse: {
          type: 'object',
          properties: {
            voting: { type: 'string' },
            owner: { type: ['string', 'null'] },
            lock: {
              oneOf: [{ $ref: '#/components/schemas/GovernanceLockResponse' }, { type: 'null' }],
            },
            proposal_count: { type: 'integer' },
            scanned: { type: 'integer' },
            start_id: { type: 'string' },
            next_start_id: { type: ['string', 'null'] },
            coverage: { type: 'object', properties: {
              rangeKnown: { type: 'boolean' }, pageComplete: { type: 'boolean' }, scanComplete: { type: 'boolean' },
              nextProposalId: { type: ['string', 'null'] }, dataHash: { type: ['string', 'null'] }, issues: { type: 'array', items: { type: 'string' } },
            }, required: ['rangeKnown', 'pageComplete', 'scanComplete', 'nextProposalId', 'dataHash', 'issues'] },
            proposals: {
              type: 'array',
              items: { $ref: '#/components/schemas/GovernanceProposalResponse' },
            },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['voting', 'proposal_count', 'scanned', 'start_id', 'next_start_id', 'coverage', 'proposals', 'source', 'network', 'updated_at'],
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
      ...structuredClone(ledgerPaths),
      ...structuredClone(currentReleasePaths),
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
      '/api/indexer/v1/contracts': {
        get: {
          summary: 'Loaded contract registry',
          responses: {
            200: {
              description: 'Contract registry response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ContractsResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/service-info': {
        get: {
          summary: 'Wallet-facing service metadata',
          responses: {
            200: {
              description: 'Service metadata response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ServiceInfoResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/readFresh': {
        post: { summary: 'Read complete current account state and getters at one uncached masterchain head',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FreshReadRequest' } } } },
          responses: {
            200: { description: 'Same-head observations; Cache-Control: no-store', content: { 'application/json': { schema: { $ref: '#/components/schemas/FreshReadResponse' } } } },
            400: { description: 'Invalid fresh read request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            503: { description: 'Fresh current-network observation unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/api/indexer/v1/runGetMethod': {
        post: {
          summary: 'Run get method',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RunGetMethodRequest' } },
            },
          },
          responses: {
            200: {
              description: 'Run get method response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/RunGetMethodResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/dlmm/pools/snapshot': {
        post: {
          summary: 'DLMM pools snapshot',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DlmmPoolsSnapshotRequest' } },
            },
          },
          responses: {
            200: {
              description: 'DLMM pools snapshot response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/DlmmPoolsSnapshotResponse' } },
              },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/metrics': {
        get: {
          summary: 'Metrics snapshot (admin only)',
          security: [{ AdminToken: [] }, { AdminBearer: [] }],
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
          summary: 'Prometheus metrics (admin only)',
          security: [{ AdminToken: [] }, { AdminBearer: [] }],
          responses: {
            200: { description: 'Prometheus metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
          },
        },
      },
      '/api/indexer/v1/accounts/{addr}/balances': {
        get: {
          summary: 'Current atomic balances with explicit availability and release precision',
          parameters: [{ $ref: '#/components/parameters/addr' }],
          responses: {
            200: {
              description: 'Balances response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BalancesResponse' } } },
            },
            503: {
              description: 'Balance source temporarily unavailable; retry the read.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
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
            503: {
              description: 'Initial transaction history source timed out',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/markets/{market}/candles': {
        get: {
          summary: 'Confirmed DLMM swap-derived OHLCV candles',
          description:
            'Aggregates successful swaps with query-ID-matched outbound amounts. Reverse-direction swaps are normalized into quote-per-base prices; minimum-output fallbacks are excluded. When a release manifest is configured, the market key, pool, symbols, and decimals must exactly match its canonical market metadata.',
          parameters: [
            {
              name: 'market',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 160 },
            },
            { name: 'market_address', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'asset_symbol', in: 'query', required: true, schema: { type: 'string', maxLength: 32 } },
            { name: 'quote_symbol', in: 'query', required: true, schema: { type: 'string', maxLength: 32 } },
            { name: 'asset_decimals', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 30, default: 9 } },
            { name: 'quote_decimals', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 30, default: 9 } },
            {
              name: 'interval',
              in: 'query',
              schema: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1m' },
            },
            { name: 'from_utime', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'to_utime', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 320 } },
          ],
          responses: {
            200: {
              description: 'Market candle response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/MarketCandlesResponse' } } },
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
      '/api/indexer/v1/governance/{voting}/snapshot': {
        get: {
          summary: 'Governance snapshot',
          parameters: [
            { name: 'voting', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'owner', in: 'query', schema: { type: 'string' } },
            { name: 'start_id', in: 'query', schema: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' } },
            { name: 'max_scan', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 64 } },
            { name: 'max_misses', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 8 } },
          ],
          responses: {
            200: {
              description: 'Governance snapshot response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/GovernanceSnapshotResponse' } },
              },
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
          security: [{ AdminToken: [] }, { AdminBearer: [] }],
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
              description: 'Admin token required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/snapshot/load': {
        post: {
          summary: 'Load in-memory snapshot',
          security: [{ AdminToken: [] }, { AdminBearer: [] }],
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
              description: 'Admin token required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/debug': {
        get: {
          summary: 'Debug snapshot',
          security: [{ AdminToken: [] }, { AdminBearer: [] }],
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
              description: 'Admin token required',
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
  // Every overload/unavailable/deadline response exposes the same flat retry contract.
  for (const path of Object.values(spec.paths)) for (const operation of Object.values(path)) {
    if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
    const documented = operation as { parameters?: unknown[] };
    documented.parameters = [...(documented.parameters ?? []), { name: 'x-tonswap-release', in: 'header', required: false,
      description: 'Expected current manifest hash. A mismatch returns 409 before route work.', schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }];
    const responses = operation.responses as Record<string, unknown>;
    if (!responses[409]) responses[409] = { description: 'Release mismatch', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
    for (const [status, description] of [[429, 'Rate limit exceeded'], [503, 'Read unavailable'], [504, 'Read deadline exceeded']] as const) {
      if (status === 503 && path === spec.paths['/api/indexer/v1/health']) {
        responses[status] = {description:'Runtime dependency unavailable',headers:{'Retry-After':{schema:{type:'integer',minimum:1}}},content:{'application/json':{schema:{$ref:'#/components/schemas/HealthStatus'}}}};
      } else responses[status] = {description,headers:{'Retry-After':{schema:{type:'integer',minimum:1}}},content:{'application/json':{schema:{$ref:'#/components/schemas/ErrorResponse'}}}};
    }
  }
  const indexer = currentNativeRuntime(config.network, metadata)?.services.indexer;
  spec.paths = Object.fromEntries(Object.entries(spec.paths).map(([route, operation]) =>
    [publicIndexerPath(indexer, route), operation])) as typeof spec.paths;
  return spec;
};
