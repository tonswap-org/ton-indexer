import { Config } from '../config';
import { ledgerPaths, ledgerSchemas } from '../ledger/openapi';

export const buildOpenApi = (config: Config) => {
  const serviceId = config.serviceId?.trim() || 'ti.soramitsu.io';
  return {
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
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' }, code: { type: 'string' } },
          required: ['error', 'code'],
        },
        HealthStatus: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', enum: [serviceId] },
            ecosystem: { type: 'string', enum: ['ton'] },
            chainId: { type: 'string' },
            network: { type: 'string' },
            lastMasterSeqno: { type: ['integer', 'null'] },
            indexerLagSec: { type: ['number', 'null'] },
            liteserverPoolStatus: { type: ['string', 'null'] },
          },
          required: ['serviceId', 'ecosystem', 'chainId', 'network'],
        },
        ContractsResponse: {
          type: 'object',
          properties: {
            network: { type: ['string', 'null'] },
            count: { type: 'integer' },
            contracts: { type: 'object', additionalProperties: { type: 'string' } },
            release_id: { type: ['string', 'null'] },
            registry_hash: { type: ['string', 'null'] },
            release_manifest_hash: { type: ['string', 'null'] },
          },
          required: ['count', 'contracts', 'release_id', 'registry_hash', 'release_manifest_hash'],
        },
        ServiceInfoResponse: {
          type: 'object',
          properties: {
            schemaVersion: { type: 'integer', enum: [1] },
            serviceId: { type: 'string', enum: [serviceId] },
            serviceName: { type: 'string' },
            ecosystem: { type: 'string', enum: ['ton'] },
            chainId: { type: 'string' },
            network: { type: 'string' },
            publicBaseUrl: { type: 'string', format: 'uri' },
            readOnly: { type: 'boolean' },
            capabilities: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } },
            release: {
              type: 'object',
              properties: {
                releaseId: { type: ['string', 'null'] },
                registryHash: { type: ['string', 'null'] },
                releaseManifestHash: { type: ['string', 'null'] },
              },
              required: ['releaseId', 'registryHash', 'releaseManifestHash'],
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
        RunGetMethodsRequest: {
          type: 'object',
          properties: {
            calls: { type: 'array', items: { $ref: '#/components/schemas/RunGetMethodRequest' } },
          },
          required: ['calls'],
        },
        RunGetMethodBatchSuccess: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [true] },
            exit_code: { type: 'integer' },
            gas_used: { type: ['integer', 'null'], description: 'Measured TVM gas for verified admission; null when the source does not report gas.' },
            stack: { type: 'array', items: { type: 'array', items: {} } },
          },
          required: ['ok', 'exit_code', 'gas_used', 'stack'],
        },
        RunGetMethodBatchError: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [false] },
            code: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok', 'code', 'error'],
        },
        RunGetMethodBatchResult: {
          oneOf: [
            { $ref: '#/components/schemas/RunGetMethodBatchSuccess' },
            { $ref: '#/components/schemas/RunGetMethodBatchError' },
          ],
        },
        RunGetMethodsResponse: {
          type: 'object',
          properties: {
            results: { type: 'array', items: { $ref: '#/components/schemas/RunGetMethodBatchResult' } },
          },
          required: ['results'],
        },
        DefiSnapshotRequest: {
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
                  governanceGetter: { type: ['string', 'null'] },
                },
                required: ['key', 'address'],
              },
            },
          },
          required: ['contracts'],
        },
        DefiSnapshotResponse: {
          type: 'object',
          properties: {
            owner: { type: ['string', 'null'] },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
            sections: { type: 'object', additionalProperties: true },
          },
          required: ['network', 'updated_at', 'sections'],
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
                  decimals: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Decimal precision. Omitted when it cannot be read or inferred safely.',
                  },
                  symbol: { type: 'string' },
                },
                required: ['master', 'wallet', 'balance'],
              },
            },
            confirmed: {
              type: 'boolean',
              description: 'True only when every configured jetton balance was read and canonically verified.',
            },
            updated_at: {
              type: 'integer',
              description: 'Unix timestamp of the TON account-state observation represented by this response.',
            },
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
            balance: {
              type: 'string',
              description: 'Formatted amount. Omitted for a jetton when its decimal precision is unknown.',
            },
            decimals: {
              type: 'integer',
              minimum: 0,
              description: 'Decimal precision. Omitted for a jetton when it cannot be read or inferred safely.',
            },
          },
          required: ['kind', 'balance_raw'],
          dependentRequired: {
            balance: ['decimals'],
            decimals: ['balance'],
          },
          allOf: [
            {
              if: {
                properties: { kind: { const: 'native' } },
                required: ['kind'],
              },
              then: { required: ['balance', 'decimals'] },
            },
          ],
        },
        BalancesResponse: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            ton_raw: { type: 'string' },
            ton: { type: 'string' },
            assets: { type: 'array', items: { $ref: '#/components/schemas/AssetBalanceResponse' } },
            confirmed: {
              type: 'boolean',
              description: 'True only when every configured jetton balance was read and canonically verified.',
            },
            updated_at: {
              type: 'integer',
              description: 'Unix timestamp of the TON account-state observation represented by this response.',
            },
            network: { type: 'string' },
          },
          required: ['address', 'ton_raw', 'ton', 'assets', 'confirmed', 'updated_at', 'network'],
        },
        JettonTransferPayloadResponse: {
          type: 'object',
          properties: {
            custom_payload: { type: ['string', 'null'] },
            state_init: { type: ['string', 'null'] },
          },
          required: ['custom_payload', 'state_init'],
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
        SwapExecutionEntry: {
          type: 'object',
          properties: {
            txId: { type: 'string' },
            lt: { type: 'string' },
            hash: { type: 'string' },
            utime: { type: 'integer' },
            status: { type: 'string', enum: ['success', 'failed', 'pending'] },
            reason: { type: 'string' },
            payToken: { type: 'string' },
            receiveToken: { type: 'string' },
            requestedPayAmount: { type: 'string', description: 'Original requested input debit, not verified spending.' },
            payAmount: { type: 'string', description: 'Verified consumed input after the unused-input return; absent without qualified settlement.' },
            returnedPayAmount: { type: 'string', description: 'Verified unused input returned to the original payer.' },
            receiveAmount: { type: 'string' },
            receiveAmountSource: { type: 'string', enum: ['actual'] },
            minimumReceiveAmount: { type: 'string', description: 'Requested minimum output; never an actual receipt.' },
            receipt: {
              type: 'object',
              properties: { ledgerEventId: { type: 'string' }, generation: { type: 'string' }, assetId: { type: 'string' } },
              required: ['ledgerEventId', 'generation', 'assetId'],
              description: 'Exact qualified owner-ledger receipt supplying receiveAmount.',
            },
            queryId: { type: 'string' },
            executionType: { type: 'string', enum: ['market', 'limit', 'twap', 'unknown'] },
            twapSlice: { type: 'integer' },
            twapTotal: { type: 'integer' },
            querySequence: { type: 'integer' },
            queryNonce: { type: 'integer' },
            twapRunId: { type: 'string' },
          },
          required: ['txId', 'lt', 'hash', 'utime', 'status', 'executionType'],
        },
        SwapSummaryStatusCounts: {
          type: 'object',
          properties: {
            success: { type: 'integer' },
            failed: { type: 'integer' },
            pending: { type: 'integer' },
          },
          required: ['success', 'failed', 'pending'],
        },
        SwapSummaryExecutionTypeCounts: {
          type: 'object',
          properties: {
            market: { type: 'integer' },
            limit: { type: 'integer' },
            twap: { type: 'integer' },
            unknown: { type: 'integer' },
          },
          required: ['market', 'limit', 'twap', 'unknown'],
        },
        SwapsSummary: {
          type: 'object',
          properties: {
            status_counts: { $ref: '#/components/schemas/SwapSummaryStatusCounts' },
            execution_type_counts: { $ref: '#/components/schemas/SwapSummaryExecutionTypeCounts' },
            twap_run_count: { type: 'integer' },
            pending_limit_count: { type: 'integer' },
          },
          required: ['status_counts', 'execution_type_counts', 'twap_run_count', 'pending_limit_count'],
        },
        PendingLimitOrderEntry: {
          type: 'object',
          properties: {
            txId: { type: 'string' },
            lt: { type: 'string' },
            hash: { type: 'string' },
            utime: { type: 'integer' },
            status: { type: 'string', enum: ['success', 'failed', 'pending'] },
            payToken: { type: 'string' },
            receiveToken: { type: 'string' },
            payAmount: { type: 'string' },
            receiveAmount: { type: 'string' },
            minimumReceiveAmount: { type: 'string' },
            queryId: { type: 'string' },
            querySequence: { type: 'integer' },
            queryNonce: { type: 'integer' },
          },
          required: ['txId', 'lt', 'hash', 'utime', 'status'],
        },
        TwapRunSummaryEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            payToken: { type: 'string' },
            receiveToken: { type: 'string' },
            totalSlices: { type: 'integer' },
            confirmedSlices: { type: 'integer' },
            pendingSlices: { type: 'integer' },
            failedSlices: { type: 'integer' },
            firstUtime: { type: 'integer' },
            lastUtime: { type: 'integer' },
            status: { type: 'string', enum: ['running', 'completed', 'partial', 'failed'] },
          },
          required: ['id', 'confirmedSlices', 'pendingSlices', 'failedSlices', 'firstUtime', 'lastUtime', 'status'],
        },
        SwapsResponse: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            total_swaps: { type: 'integer' },
            returned_swaps: { type: 'integer' },
            history_complete: { type: 'boolean' },
            synced_at: { type: 'integer' },
            network: { type: 'string' },
            swaps: { type: 'array', items: { $ref: '#/components/schemas/SwapExecutionEntry' } },
            summary: { $ref: '#/components/schemas/SwapsSummary' },
            twap_runs: { type: 'array', items: { $ref: '#/components/schemas/TwapRunSummaryEntry' } },
            pending_limits: { type: 'array', items: { $ref: '#/components/schemas/PendingLimitOrderEntry' } },
          },
          required: [
            'address',
            'total_swaps',
            'returned_swaps',
            'history_complete',
            'synced_at',
            'network',
            'swaps',
            'summary',
            'twap_runs',
            'pending_limits',
          ],
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
            last_tx_lt: { type: ['string', 'null'] },
            last_tx_hash: { type: ['string', 'null'] },
            last_seen_utime: { type: ['integer', 'null'] },
            last_confirmed_seqno: { type: ['integer', 'null'] },
            account_state: { type: ['string', 'null'] },
            code_boc: { type: ['string', 'null'] },
            data_boc: { type: ['string', 'null'] },
            network: { type: 'string' },
          },
          required: ['address', 'network'],
        },
        PerpsStatusResponse: {
          type: 'object',
          properties: {
            governance: { type: ['string', 'null'] },
            enabled: { type: 'boolean' },
            feeBps: {
              type: ['string', 'null'],
              description:
                'Base T3 trade fee in basis points from the canonical 33-field engine_config getter; null when that getter cannot be decoded exactly or the value is outside 0..10000.',
            },
          },
          required: ['enabled', 'feeBps'],
        },
        PerpsAutomationResponse: {
          type: 'object',
          properties: {
            fundingCursor: { type: ['string', 'null'] },
            lastFundingTimestamp: { type: ['string', 'null'] },
            lastFundingProcessed: { type: ['string', 'null'] },
            lastFundingRemaining: { type: ['string', 'null'] },
            liquidationCursor: { type: ['string', 'null'] },
            lastLiquidationTimestamp: { type: ['string', 'null'] },
            lastLiquidationProcessed: { type: ['string', 'null'] },
            lastLiquidationRemaining: { type: ['string', 'null'] },
            maxMarketId: { type: ['string', 'null'] },
            liquidationNonce: { type: ['string', 'null'] },
            liquidationBacklog: { type: ['string', 'null'] },
            controlAuthority: { type: ['string', 'null'] },
            controlSequence: { type: ['string', 'null'] },
            controlTimestamp: { type: ['string', 'null'] },
            controlRequestHash: { type: ['string', 'null'] },
          },
        },
        PerpsMarketStateResponse: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            pool: { type: ['string', 'null'] },
            depthUnit: { type: ['string', 'null'] },
            impactAlpha: { type: ['string', 'null'] },
            impactBeta: { type: ['string', 'null'] },
            baseLeverageBps: { type: ['string', 'null'] },
            maxLeverageBps: { type: ['string', 'null'] },
            maintenanceBps: { type: ['string', 'null'] },
            oiCap: { type: ['string', 'null'] },
            fundingCapBps: { type: ['string', 'null'] },
            fundingIndex: { type: ['string', 'null'] },
            lastFundingTs: { type: ['string', 'null'] },
            oiLong: { type: ['string', 'null'] },
            oiShort: { type: ['string', 'null'] },
            longBase: { type: ['string', 'null'] },
            shortBase: { type: ['string', 'null'] },
            halted: { type: 'boolean' },
            oracleMark: { type: ['string', 'null'] },
            oracleMarkTs: { type: ['string', 'null'] },
            liquidationSlice: { type: ['string', 'null'] },
            liquidationCooldown: { type: ['string', 'null'] },
            liquidationPendingBase: { type: ['string', 'null'] },
            liquidationLastTs: { type: ['string', 'null'] },
            adlDeficit: { type: ['string', 'null'] },
            liquidityWeightBps: { type: ['string', 'null'] },
            utilizationWeightBps: { type: ['string', 'null'] },
            lastDynamicWeightBps: { type: ['string', 'null'] },
            rebalanceClampBps: { type: ['string', 'null'] },
            lastClampUpdateTs: { type: ['string', 'null'] },
            auctionActive: { type: 'boolean' },
            auctionOutstandingBase: { type: ['string', 'null'] },
            auctionMinPrice: { type: ['string', 'null'] },
            auctionMaxPrice: { type: ['string', 'null'] },
            auctionExpiryTs: { type: ['string', 'null'] },
            auctionClearingPrice: { type: ['string', 'null'] },
            controlWeightBps: { type: ['string', 'null'] },
            controlFeeDeltaBps: { type: ['string', 'null'] },
            lastFundingPayloadHash: { type: ['string', 'null'] },
            lastFundingPoolHash: { type: ['string', 'null'] },
          },
          required: ['exists', 'halted', 'auctionActive'],
        },
        PerpsSnapshotResponse: {
          type: 'object',
          properties: {
            engine: { type: 'string' },
            status: { oneOf: [{ $ref: '#/components/schemas/PerpsStatusResponse' }, { type: 'null' }] },
            automation: {
              oneOf: [{ $ref: '#/components/schemas/PerpsAutomationResponse' }, { type: 'null' }],
            },
            market_ids: { type: 'array', items: { type: 'integer' } },
            markets: {
              type: 'object',
              additionalProperties: { $ref: '#/components/schemas/PerpsMarketStateResponse' },
            },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['engine', 'market_ids', 'markets', 'source', 'network', 'updated_at'],
        },
        VolIndexConfigResponse: {
          type: 'object',
          properties: {
            seriesManager: { type: ['string', 'null'] },
            oracle: { type: ['string', 'null'] },
            automation: { type: ['string', 'null'] },
            coverManager: { type: ['string', 'null'] },
            minLiquidityBps: { type: ['string', 'null'] },
            staleSeconds: { type: ['string', 'null'] },
            emaAlphaBps: { type: ['string', 'null'] },
          },
        },
        VolIndexStateResponse: {
          type: 'object',
          properties: {
            impliedVolBps: { type: ['string', 'null'] },
            realizedVolBps: { type: ['string', 'null'] },
            varianceSpeedBps: { type: ['string', 'null'] },
            sampleCount: { type: ['string', 'null'] },
            eligibleSeries: { type: ['string', 'null'] },
            lastPremiumTs: { type: ['string', 'null'] },
            lastRealizedTs: { type: ['string', 'null'] },
            lastPublishTs: { type: ['string', 'null'] },
            lastSamplePrice: { type: ['string', 'null'] },
            lastSampleTs: { type: ['string', 'null'] },
          },
        },
        VolIndexRouteResponse: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            sourcePool: { type: ['string', 'null'] },
            coverPolicyId: { type: ['string', 'null'] },
          },
          required: ['exists'],
        },
        VolIndexSnapshotResponse: {
          type: 'object',
          properties: {
            vol_index: { type: 'string' },
            config: { oneOf: [{ $ref: '#/components/schemas/VolIndexConfigResponse' }, { type: 'null' }] },
            state: { oneOf: [{ $ref: '#/components/schemas/VolIndexStateResponse' }, { type: 'null' }] },
            pool: { type: ['string', 'null'] },
            pool_state: { oneOf: [{ $ref: '#/components/schemas/VolIndexStateResponse' }, { type: 'null' }] },
            route_ids: { type: 'array', items: { type: 'integer' } },
            routes: {
              type: 'object',
              additionalProperties: { $ref: '#/components/schemas/VolIndexRouteResponse' },
            },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['vol_index', 'route_ids', 'routes', 'source', 'network', 'updated_at'],
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
        FarmSnapshotRecordResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' }, sponsor: { type: 'string' }, binId: { type: 'integer' },
            rewardSide: { type: 'integer', enum: [0, 1] },
            ...Object.fromEntries(['totalReward', 'startTime', 'endTime', 'totalStaked', 'allocatedReward', 'claimedReward', 'refundedReward', 'cancelledAt'].map(key => [key, { type: 'string' }])),
            user: { type: ['object', 'null'], properties: Object.fromEntries(['shares', 'claimable', 'claimed', 'lastSettlementId'].map(key => [key, { type: 'string' }])) },
          },
          required: ['id', 'sponsor', 'binId', 'rewardSide', 'totalReward', 'startTime', 'endTime', 'totalStaked', 'allocatedReward', 'claimedReward', 'refundedReward', 'cancelledAt', 'user'],
        },
        FarmSnapshotResponse: {
          type: 'object',
          properties: {
            pool: { type: 'string' }, owner: { type: ['string', 'null'] },
            config: { type: 'object', properties: {
              version: { type: 'integer', const: 1 },
              ...Object.fromEntries(['nextCampaignId', 'maxDuration', 'escrowT', 'escrowX'].map(key => [key, { type: 'string' }])),
            }, required: ['version', 'nextCampaignId', 'maxDuration', 'escrowT', 'escrowX'] },
            start_id: { type: 'string' }, next_start_id: { type: ['string', 'null'] },
            campaigns: { type: 'array', items: { $ref: '#/components/schemas/FarmSnapshotRecordResponse' } },
            source: { type: 'string' }, network: { type: 'string' }, updated_at: { type: 'integer' },
          },
          required: ['pool', 'owner', 'config', 'start_id', 'next_start_id', 'campaigns', 'source', 'network', 'updated_at'],
        },
        OptionFactoryStatusResponse: {
          type: 'object',
          properties: {
            governance: { type: ['string', 'null'] },
            enabled: { type: 'boolean' },
          },
          required: ['enabled'],
        },
        OptionSeriesSnapshotRecordResponse: {
          type: 'object',
          properties: {
            seriesId: { type: 'string' },
            templateId: { type: ['string', 'null'] },
            optionKind: { type: ['string', 'null'] },
            optionAddress: { type: ['string', 'null'] },
            expiry: { type: ['string', 'null'] },
            maxNotional: { type: ['string', 'null'] },
            premiumBps: { type: ['string', 'null'] },
            collateralMultiplierBps: { type: ['string', 'null'] },
            openNotional: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            settlementTimestamp: { type: ['string', 'null'] },
            underlyingPool: { type: ['string', 'null'] },
            quotePool: { type: ['string', 'null'] },
            collateralLocked: { type: ['string', 'null'] },
            correlationScaleBps: { type: ['string', 'null'] },
            correlationBps: { type: ['string', 'null'] },
            correlationDispersionBps: { type: ['string', 'null'] },
            correlationTimestamp: { type: ['string', 'null'] },
            isActive: { type: 'boolean' },
            remainingNotional: { type: ['string', 'null'] },
          },
          required: ['seriesId', 'isActive'],
        },
        OptionsSnapshotResponse: {
          type: 'object',
          properties: {
            factory: { type: 'string' },
            status: {
              oneOf: [{ $ref: '#/components/schemas/OptionFactoryStatusResponse' }, { type: 'null' }],
            },
            series_count: { type: 'integer' },
            scanned: { type: 'integer' },
            next_after_id: { type: ['string', 'null'] },
            page_complete: { const: true },
            series: { type: 'array', items: { $ref: '#/components/schemas/OptionSeriesSnapshotRecordResponse' } },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['factory', 'series_count', 'scanned', 'next_after_id', 'page_complete', 'series', 'source', 'network', 'updated_at'],
        },
        CoverStateResponse: {
          type: 'object',
          properties: {
            totalPolicies: { type: ['string', 'null'] },
            activePolicies: { type: ['string', 'null'] },
            breachingPolicies: { type: ['string', 'null'] },
            claimablePolicies: { type: ['string', 'null'] },
            claimedPolicies: { type: ['string', 'null'] },
            nextWakeTimestamp: { type: ['string', 'null'] },
            lastSender: { type: ['string', 'null'] },
            lastJobId: { type: ['string', 'null'] },
            lastWork: { type: ['string', 'null'] },
            lastTimestamp: { type: ['string', 'null'] },
            lastProcessed: { type: ['string', 'null'] },
            lastRemaining: { type: ['string', 'null'] },
            vault: { type: ['string', 'null'] },
            governance: { type: ['string', 'null'] },
            riskVault: { type: ['string', 'null'] },
            riskBucketId: { type: ['string', 'null'] },
          },
        },
        CoverPolicyResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            owner: { type: ['string', 'null'] },
            pool: { type: ['string', 'null'] },
            lowerBound: { type: ['string', 'null'] },
            upperBound: { type: ['string', 'null'] },
            payout: { type: ['string', 'null'] },
            coveredNotional: { type: ['string', 'null'] },
            windowSeconds: { type: ['string', 'null'] },
            requiredObservations: { type: ['string', 'null'] },
            breachStart: { type: ['string', 'null'] },
            breachSeconds: { type: ['string', 'null'] },
            lastObservation: { type: ['string', 'null'] },
            lastHealthyObservation: { type: ['string', 'null'] },
            breachObservations: { type: ['string', 'null'] },
            lastVolatilityTimestamp: { type: ['string', 'null'] },
            lastVolatilityRequestHash: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            riskVault: { type: ['string', 'null'] },
            riskBucketId: { type: ['string', 'null'] },
          },
          required: ['id'],
        },
        CoverSnapshotResponse: {
          type: 'object',
          properties: {
            manager: { type: 'string' },
            owner: { type: ['string', 'null'] },
            enabled: { type: ['boolean', 'null'] },
            state: {
              oneOf: [{ $ref: '#/components/schemas/CoverStateResponse' }, { type: 'null' }],
            },
            policy_count: { type: 'integer' },
            scanned: { type: 'integer' },
            policies: { type: 'array', items: { $ref: '#/components/schemas/CoverPolicyResponse' } },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['manager', 'policy_count', 'scanned', 'policies', 'source', 'network', 'updated_at'],
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
      ...ledgerPaths,
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
      '/api/indexer/v1/runGetMethods': {
        post: {
          summary: 'Run get methods batch',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RunGetMethodsRequest' } },
            },
          },
          responses: {
            200: {
              description: 'Run get methods batch response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/RunGetMethodsResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/defi/snapshot': {
        post: {
          summary: 'DeFi snapshot',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DefiSnapshotRequest' } },
            },
          },
          responses: {
            200: {
              description: 'DeFi snapshot response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DefiSnapshotResponse' } } },
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
      '/api/indexer/v1/accounts/{addr}/balance': {
        get: {
          summary: 'Account balance',
          parameters: [{ $ref: '#/components/parameters/addr' }],
          responses: {
            200: {
              description: 'Balance response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BalanceResponse' } } },
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
      '/api/indexer/v1/accounts/{addr}/balances': {
        get: {
          summary: 'Account balances (formatted)',
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
      '/api/indexer/v1/accounts/{addr}/assets': {
        get: {
          summary: 'Account assets (alias of balances)',
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
      '/api/indexer/v1/jettons/{jetton}/transfer/{owner}/payload': {
        get: {
          summary: 'Jetton transfer payload',
          parameters: [
            { $ref: '#/components/parameters/jetton' },
            { $ref: '#/components/parameters/owner' },
          ],
          responses: {
            200: {
              description: 'Jetton transfer payload response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/JettonTransferPayloadResponse' } },
              },
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
      '/api/indexer/v1/accounts/{addr}/swaps': {
        get: {
          summary: 'Account swap executions',
          parameters: [
            { $ref: '#/components/parameters/addr' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'from_utime', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'to_utime', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'pay_token', in: 'query', schema: { type: 'string' } },
            { name: 'receive_token', in: 'query', schema: { type: 'string' } },
            {
              name: 'execution_type',
              in: 'query',
              schema: { type: 'string', enum: ['market', 'limit', 'twap', 'unknown'] },
            },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['success', 'failed', 'pending'] } },
            { name: 'include_reverse', in: 'query', schema: { type: 'string', enum: ['1', '0', 'true', 'false', 'yes', 'no'] } },
          ],
          responses: {
            200: {
              description: 'Swap executions response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SwapsResponse' } } },
            },
            400: {
              description: 'Bad request',
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
      '/api/indexer/v1/perps/{engine}/snapshot': {
        get: {
          summary: 'Perps engine snapshot, including canonical engine_config base fee',
          parameters: [
            { name: 'engine', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'market_ids', in: 'query', description: 'Comma-separated positive uint32 market IDs; the unique count must fit max_markets.', schema: { type: 'string', pattern: '^[1-9][0-9]*(,[1-9][0-9]*)*$', maxLength: 1407 } },
            { name: 'max_markets', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 128 } },
          ],
          responses: {
            200: {
              description: 'Perps snapshot response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PerpsSnapshotResponse' } } },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/vol-index/{volIndex}/snapshot': {
        get: {
          summary: 'VolIndex snapshot',
          parameters: [
            { name: 'volIndex', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'pool', in: 'query', schema: { type: 'string' } },
            { name: 'route_ids', in: 'query', description: 'Comma-separated positive uint32 route IDs; at most 64 entries.',
              schema: { type: 'string', pattern: '^[1-9][0-9]*(,[1-9][0-9]*)*$', maxLength: 703 } },
          ],
          responses: {
            200: {
              description: 'VolIndex snapshot response',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/VolIndexSnapshotResponse' } } },
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
      '/api/indexer/v1/pools/{pool}/farms': {
        get: {
          summary: 'Native DLMM pool farming campaigns',
          description: 'Current bounded on-chain observations. Amounts and IDs are atomic decimal strings. claimedReward records committed payouts; inspect the original settlement before asserting delivery.',
          parameters: [
            { name: 'pool', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'owner', in: 'query', schema: { type: 'string' } },
            { name: 'start_id', in: 'query', schema: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 64 } },
          ],
          responses: {
            200: { description: 'Complete campaign page', content: { 'application/json': { schema: { $ref: '#/components/schemas/FarmSnapshotResponse' } } } },
            400: { description: 'Invalid request or unavailable/malformed on-chain state', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/indexer/v1/options/{factory}/snapshot': {
        get: {
          summary: 'Options factory snapshot',
          parameters: [
            { name: 'factory', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'after_id', in: 'query', schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 64 } },
          ],
          responses: {
            200: {
              description: 'Options snapshot response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/OptionsSnapshotResponse' } },
              },
            },
            400: {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/indexer/v1/cover/{manager}/snapshot': {
        get: {
          summary: 'Cover manager snapshot',
          parameters: [
            { name: 'manager', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'owner', in: 'query', schema: { type: 'string' } },
            { name: 'max_scan', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 64 } },
            { name: 'max_misses', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 8 } },
          ],
          responses: {
            200: {
              description: 'Cover snapshot response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CoverSnapshotResponse' } },
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
};
