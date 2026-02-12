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
        PerpsStatusResponse: {
          type: 'object',
          properties: {
            governance: { type: ['string', 'null'] },
            enabled: { type: 'boolean' },
          },
          required: ['enabled'],
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
            marketKind: { type: ['string', 'null'] },
            timerVolatilityBps: { type: ['string', 'null'] },
            timerEmaVolatilityBps: { type: ['string', 'null'] },
            timerLastUpdateTs: { type: ['string', 'null'] },
            timerWeightBps: { type: ['string', 'null'] },
            correlationBps: { type: ['string', 'null'] },
            correlationDispersionBps: { type: ['string', 'null'] },
            correlationLastUpdateTs: { type: ['string', 'null'] },
            correlationWeightBps: { type: ['string', 'null'] },
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
            proposals: {
              type: 'array',
              items: { $ref: '#/components/schemas/GovernanceProposalResponse' },
            },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['voting', 'proposal_count', 'scanned', 'proposals', 'source', 'network', 'updated_at'],
        },
        FarmFactoryStatusResponse: {
          type: 'object',
          properties: {
            governance: { type: ['string', 'null'] },
            enabled: { type: 'boolean' },
          },
          required: ['enabled'],
        },
        FarmSnapshotRecordResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            farm: { type: ['string', 'null'] },
            staker: { type: ['string', 'null'] },
            sponsor: { type: ['string', 'null'] },
            rewardRoot: { type: ['string', 'null'] },
            rewardWallet: { type: ['string', 'null'] },
            rewardAmount: { type: ['string', 'null'] },
            duration: { type: ['string', 'null'] },
            sponsorFeeBps: { type: ['string', 'null'] },
            startTime: { type: ['string', 'null'] },
            endTime: { type: ['string', 'null'] },
            gasBudget: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            createdAt: { type: ['string', 'null'] },
            backlogLimit: { type: ['string', 'null'] },
            resumeBacklog: { type: ['string', 'null'] },
          },
          required: ['id'],
        },
        FarmSnapshotResponse: {
          type: 'object',
          properties: {
            factory: { type: 'string' },
            status: {
              oneOf: [{ $ref: '#/components/schemas/FarmFactoryStatusResponse' }, { type: 'null' }],
            },
            next_id: { type: ['string', 'null'] },
            farm_count: { type: 'integer' },
            scanned: { type: 'integer' },
            farms: { type: 'array', items: { $ref: '#/components/schemas/FarmSnapshotRecordResponse' } },
            source: { type: 'string' },
            network: { type: 'string' },
            updated_at: { type: 'integer' },
          },
          required: ['factory', 'farm_count', 'scanned', 'farms', 'source', 'network', 'updated_at'],
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
            admin: { type: ['string', 'null'] },
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
            windowSeconds: { type: ['string', 'null'] },
            requiredObservations: { type: ['string', 'null'] },
            breachStart: { type: ['string', 'null'] },
            breachSeconds: { type: ['string', 'null'] },
            lastObservation: { type: ['string', 'null'] },
            lastHealthyObservation: { type: ['string', 'null'] },
            breachObservations: { type: ['string', 'null'] },
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
      '/api/indexer/v1/perps/{engine}/snapshot': {
        get: {
          summary: 'Perps engine snapshot',
          parameters: [
            { name: 'engine', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'market_ids', in: 'query', schema: { type: 'string' } },
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
      '/api/indexer/v1/governance/{voting}/snapshot': {
        get: {
          summary: 'Governance snapshot',
          parameters: [
            { name: 'voting', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'owner', in: 'query', schema: { type: 'string' } },
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
      '/api/indexer/v1/farms/{factory}/snapshot': {
        get: {
          summary: 'Farm factory snapshot',
          parameters: [
            { name: 'factory', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'max_scan', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 64 } },
            { name: 'max_misses', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 8 } },
          ],
          responses: {
            200: {
              description: 'Farm snapshot response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/FarmSnapshotResponse' } },
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
