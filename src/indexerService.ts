import { Address, TupleItem, beginCell } from '@ton/core';
import { EventEmitter } from 'node:events';
import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import { TonDataSource } from './data/dataSource';
import { OpcodeSets } from './utils/opcodes';
import { AccountBalance, AccountBalances, AccountState, HealthStatus, IndexedTx, Network, UiTx } from './models';
import { classifyTransaction } from './utils/txClassifier';
import { JettonMetadata } from './models';
import { MetricsCollector } from './metricsCollector';
import { PoolTracker } from './poolTracker';
import { LRUCache } from 'lru-cache';

export type BalanceChangeEvent = {
  type: 'balances_changed';
  address: string;
  seq: number;
  ts: number;
  hints: {
    ton: boolean;
    jettons: string[] | null;
  };
};

const normalizeAddress = (value: string) => {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return value.trim().toLowerCase();
  }
};

const balanceStateSignature = (state?: AccountState) => {
  if (!state) return '';
  return [state.balance ?? '', state.lastTxLt ?? '', state.lastTxHash ?? ''].join(':');
};

const tupleItemBigInt = (item?: TupleItem): bigint | null => {
  if (!item) return null;
  if (item.type === 'int') return item.value;
  return null;
};

const tupleItemBigIntString = (item?: TupleItem): string | null => {
  const value = tupleItemBigInt(item);
  return value !== null ? value.toString(10) : null;
};

const tupleItemBool = (item?: TupleItem): boolean => {
  const value = tupleItemBigInt(item);
  return value !== null && value !== 0n;
};

const tupleItemAddress = (item?: TupleItem): string | null => {
  if (!item || item.type === 'null') return null;
  if (item.type !== 'cell' && item.type !== 'slice' && item.type !== 'builder') return null;
  try {
    const exact = item.cell.beginParse().loadAddress();
    return exact ? exact.toRawString() : null;
  } catch {
    // fall through to maybe-address decoding
  }
  try {
    const maybe = item.cell.beginParse().loadMaybeAddress();
    return maybe ? maybe.toRawString() : null;
  } catch {
    return null;
  }
};

const GOVERNANCE_SNAPSHOT_CACHE_TTL_MS = 5_000;
const GOVERNANCE_MAX_SCAN_DEFAULT = 20;
const GOVERNANCE_MAX_SCAN_LIMIT = 64;
const GOVERNANCE_MAX_CONSECUTIVE_MISSES_DEFAULT = 2;
const GOVERNANCE_MAX_CONSECUTIVE_MISSES_LIMIT = 8;
const GOVERNANCE_SCAN_BATCH_SIZE = 5;

type GovernanceLockSnapshot = {
  amount: string | null;
  unlockTime: string | null;
  tier: string | null;
  activatedAt: string | null;
  weight: string | null;
};

type GovernanceProposalSnapshot = {
  id: string;
  status: string | null;
  passed: string | null;
  yesWeight: string | null;
  noWeight: string | null;
  abstainWeight: string | null;
  quorumWeight: string | null;
  totalWeightSnapshot: string | null;
  startTime: string | null;
  minCloseTime: string | null;
  maxCloseTime: string | null;
  cooldownEnd: string | null;
  target: string | null;
  value: string | null;
  descriptionHash: string | null;
};

type GovernanceSnapshotResponse = {
  voting: string;
  owner: string | null;
  lock: GovernanceLockSnapshot | null;
  proposal_count: number;
  scanned: number;
  proposals: GovernanceProposalSnapshot[];
  source: 'lite' | 'http4';
  network: Network;
  updated_at: number;
};

export class IndexerService {
  private config: Config;
  private store: MemoryStore;
  private source: TonDataSource;
  private opcodes: OpcodeSets;
  private network: Network;
  private lastMasterSeqno?: number;
  private lastMasterTimestamp?: number;
  private enqueueBackfill?: (address: string) => void;
  private jettonRoots: Array<{ master: string; symbol?: string }>;
  private jettonMetaCache = new Map<string, { meta: JettonMetadata | null; updatedAt: number }>();
  private metrics?: MetricsCollector;
  private poolTracker?: PoolTracker;
  private balanceCache: LRUCache<string, { value: AccountBalance; signature: string }>;
  private txCache: LRUCache<string, { value: any; signature: string }>;
  private stateCache: LRUCache<string, { value: any; signature: string }>;
  private governanceSnapshotCache: LRUCache<string, GovernanceSnapshotResponse>;
  private governanceSnapshotInFlight = new Map<string, Promise<GovernanceSnapshotResponse>>();
  private healthCache?: { value: HealthStatus; expiresAt: number };
  private balanceEventEmitter = new EventEmitter();
  private balanceEventSeq = 0;

  constructor(
    config: Config,
    store: MemoryStore,
    source: TonDataSource,
    opcodes: OpcodeSets,
    jettonRoots: Array<{ master: string; symbol?: string }>,
    metrics?: MetricsCollector,
    poolTracker?: PoolTracker
  ) {
    this.config = config;
    this.store = store;
    this.source = source;
    this.opcodes = opcodes;
    this.network = config.network;
    this.jettonRoots = jettonRoots;
    this.metrics = metrics;
    this.poolTracker = poolTracker;

    const balanceCacheMax = Math.max(1, config.maxAddresses);
    const stateCacheMax = Math.max(1, config.maxAddresses);
    const txCacheMax = Math.max(
      1000,
      Math.min(config.globalMaxPages, config.maxAddresses * config.maxPagesPerAddress)
    );

    this.balanceCache = new LRUCache({
      max: balanceCacheMax,
      ttl: config.balanceCacheTtlMs,
      allowStale: false,
    });
    this.stateCache = new LRUCache({
      max: stateCacheMax,
      ttl: config.stateCacheTtlMs,
      allowStale: false,
    });
    this.txCache = new LRUCache({
      max: txCacheMax,
      ttl: config.txCacheTtlMs,
      allowStale: false,
    });
    this.governanceSnapshotCache = new LRUCache({
      max: 512,
      ttl: GOVERNANCE_SNAPSHOT_CACHE_TTL_MS,
      allowStale: false
    });
  }

  setBackfillEnqueue(fn: (address: string) => void) {
    this.enqueueBackfill = fn;
  }

  setMasterchainInfo(seqno: number, timestamp?: number) {
    this.lastMasterSeqno = seqno;
    this.lastMasterTimestamp = timestamp;
  }

  getHealth(): HealthStatus {
    if (this.config.responseCacheEnabled && this.config.healthCacheTtlMs > 0) {
      if (this.healthCache && this.healthCache.expiresAt > Date.now()) {
        return this.healthCache.value;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const lag = this.lastMasterTimestamp ? Math.max(0, now - this.lastMasterTimestamp) : undefined;
    const response = {
      lastMasterSeqno: this.lastMasterSeqno,
      indexerLagSec: lag,
      liteserverPoolStatus:
        this.config.dataSource === 'lite'
          ? this.config.liteserverPool
            ? 'liteserver:custom'
            : 'liteserver:ton.org'
          : this.config.httpEndpoint
            ? 'http4:custom'
            : 'http4:auto',
    };
    if (this.config.responseCacheEnabled && this.config.healthCacheTtlMs > 0) {
      this.healthCache = { value: response, expiresAt: Date.now() + this.config.healthCacheTtlMs };
    }
    return response;
  }

  async getBalance(address: string): Promise<AccountBalance> {
    this.store.touch(address);
    const entry = this.store.get(address);
    const cached = Boolean(entry?.balance);
    this.metrics?.recordBalanceCache(cached);

    if (this.config.responseCacheEnabled && entry?.balance) {
      const signature = this.getAccountSignature(entry);
      if (signature) {
        const cachedValue = this.getCached(this.balanceCache, address, signature);
        if (cachedValue) return cachedValue;
      }
    }

    const refreshStatePromise = cached ? Promise.resolve() : this.refreshAccountState(address);
    const jettonPromise = Promise.all(
      this.jettonRoots.map(async (root) => {
        const balance = await this.source.getJettonBalance(address, root.master);
        if (!balance) return null;
        try {
          if (BigInt(balance.balance) === 0n) return null;
        } catch {
          // Keep malformed balances visible so issues can be diagnosed upstream.
        }
        const meta = await this.getJettonMetadata(root.master);
        return {
          master: root.master,
          wallet: balance.wallet,
          balance: balance.balance,
          symbol: meta?.symbol ?? root.symbol,
          decimals: meta?.decimals ?? this.fallbackJettonDecimals(meta?.symbol ?? root.symbol),
        };
      })
    );
    const [jettons] = await Promise.all([jettonPromise, refreshStatePromise]);
    const updated = this.store.get(address)?.balance;
    const now = Math.floor(Date.now() / 1000);

    const response = {
      ton: {
        balance: updated?.balance ?? '0',
        last_tx_lt: updated?.lastTxLt,
        last_tx_hash: updated?.lastTxHash,
      },
      jettons: jettons.filter(Boolean) as AccountBalance['jettons'],
      confirmed: true,
      updated_at: now,
      network: this.network,
    };
    const signature = this.getAccountSignature(this.store.get(address));
    this.setCached(this.balanceCache, address, response, signature, this.config.balanceCacheTtlMs);
    return response;
  }

  async getBalances(address: string): Promise<AccountBalances> {
    const snapshot = await this.getBalance(address);
    const tonRaw = snapshot.ton.balance ?? '0';
    const ton = this.formatRawAmount(tonRaw, 9);
    const assets = [
      {
        kind: 'native' as const,
        symbol: 'TON',
        address,
        wallet: address,
        balance_raw: tonRaw,
        balance: ton,
        decimals: 9,
      },
      ...snapshot.jettons.map((jetton) => {
        const decimals = typeof jetton.decimals === 'number' && Number.isFinite(jetton.decimals)
          ? Math.max(0, Math.trunc(jetton.decimals))
          : this.fallbackJettonDecimals(jetton.symbol) ?? 9;
        return {
          kind: 'jetton' as const,
          symbol: jetton.symbol,
          address: jetton.master,
          wallet: jetton.wallet,
          balance_raw: jetton.balance,
          balance: this.formatRawAmount(jetton.balance, decimals),
          decimals,
        };
      }),
    ];

    return {
      address,
      ton_raw: tonRaw,
      ton,
      assets,
      confirmed: snapshot.confirmed,
      updated_at: snapshot.updated_at,
      network: snapshot.network,
    };
  }

  getBalancesSignature(snapshot: AccountBalances) {
    const assetsSignature = [...snapshot.assets]
      .map((asset) => {
        const kind = asset.kind ?? 'unknown';
        const key = asset.address ?? asset.wallet ?? asset.symbol ?? '';
        return `${kind}:${key}:${asset.balance_raw ?? ''}`;
      })
      .sort()
      .join('|');
    return `${snapshot.ton_raw ?? ''}:${assetsSignature}`;
  }

  subscribeBalanceChanges(addresses: string[], listener: (event: BalanceChangeEvent) => void) {
    const normalized = new Set(addresses.map((value) => normalizeAddress(value)));
    const handler = (event: BalanceChangeEvent) => {
      const target = normalizeAddress(event.address);
      if (normalized.size > 0 && !normalized.has(target)) return;
      listener(event);
    };
    this.balanceEventEmitter.on('balances_changed', handler);
    return () => {
      this.balanceEventEmitter.off('balances_changed', handler);
    };
  }

  private emitBalanceChanged(address: string) {
    const event: BalanceChangeEvent = {
      type: 'balances_changed',
      address,
      seq: ++this.balanceEventSeq,
      ts: Date.now(),
      hints: { ton: true, jettons: null },
    };
    this.balanceEventEmitter.emit('balances_changed', event);
  }

  private async getJettonMetadata(master: string): Promise<JettonMetadata | null> {
    const cached = this.jettonMetaCache.get(master);
    const now = Date.now();
    if (cached && now - cached.updatedAt < this.config.jettonMetadataTtlMs) {
      return cached.meta;
    }

    const meta = await this.source.getJettonMetadata(master);
    this.jettonMetaCache.set(master, { meta, updatedAt: now });
    return meta;
  }

  private fallbackJettonDecimals(symbol?: string | null): number | null {
    const normalized = (symbol ?? '').trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'USDT' || normalized === 'USDC' || normalized === 'KUSD') return 6;
    if (normalized === 'T3' || normalized === 'TS' || normalized === 'DLMMX') return 9;
    return null;
  }

  private getAccountSignature(entry?: {
    balance?: AccountState;
    stats: { txCount: number; historyComplete: boolean; totalPagesMin: number };
  }) {
    if (!entry?.balance) return null;
    return [
      entry.balance.lastTxLt ?? '',
      entry.balance.lastTxHash ?? '',
      entry.balance.balance ?? '',
      entry.stats.txCount,
      entry.stats.historyComplete ? '1' : '0',
      entry.stats.totalPagesMin,
    ].join(':');
  }

  private formatRawAmount(rawValue: string, decimals: number) {
    let raw: bigint;
    try {
      raw = BigInt(rawValue);
    } catch (_err) {
      return '0';
    }
    const safeDecimals = Math.max(0, Math.trunc(decimals));
    if (safeDecimals === 0) return raw.toString(10);

    const divisor = 10n ** BigInt(safeDecimals);
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const whole = abs / divisor;
    const fraction = abs % divisor;
    if (fraction === 0n) {
      return `${negative ? '-' : ''}${whole.toString(10)}`;
    }
    const fractionStr = fraction
      .toString(10)
      .padStart(safeDecimals, '0')
      .replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString(10)}.${fractionStr}`;
  }

  private getTxPageSignature(
    entry: { stats: { txCount: number; historyComplete: boolean; totalPagesMin: number }; pageIndex: { lt: string; hash: string }[] } | undefined,
    page: number
  ) {
    if (!entry) return null;
    const cursor = entry.pageIndex[page - 1];
    return [
      entry.stats.txCount,
      entry.stats.historyComplete ? '1' : '0',
      entry.stats.totalPagesMin,
      cursor?.lt ?? '',
      cursor?.hash ?? '',
      page,
    ].join(':');
  }

  private getTxCursorSignature(
    entry: { stats: { txCount: number; historyComplete: boolean } } | undefined,
    lt: string,
    hash: string
  ) {
    if (!entry) return null;
    return [entry.stats.txCount, entry.stats.historyComplete ? '1' : '0', lt, hash].join(':');
  }

  private getCached<T>(
    cache: LRUCache<string, { value: T; signature: string }>,
    key: string,
    signature: string
  ) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.signature !== signature) return null;
    return cached.value;
  }

  private setCached<T>(
    cache: LRUCache<string, { value: T; signature: string }>,
    key: string,
    value: T,
    signature: string | null,
    ttl: number
  ) {
    if (!this.config.responseCacheEnabled || !signature || ttl <= 0) return;
    cache.set(key, { value, signature }, { ttl });
  }

  async getState(address: string) {
    this.store.touch(address);
    let entry = this.store.get(address);
    if (!entry?.balance) {
      await this.refreshAccountState(address);
      entry = this.store.get(address);
    }
    const latest = entry?.txs?.[0];
    const signature = this.getAccountSignature(entry);
    if (this.config.responseCacheEnabled && signature) {
      const cachedValue = this.getCached(this.stateCache, address, signature);
      if (cachedValue) return cachedValue;
    }

    const response = {
      address,
      last_tx_lt: entry?.balance?.lastTxLt,
      last_tx_hash: entry?.balance?.lastTxHash,
      last_seen_utime: latest?.utime ?? null,
      last_confirmed_seqno: this.lastMasterSeqno ?? null,
      network: this.network,
    };
    this.setCached(this.stateCache, address, response, signature, this.config.stateCacheTtlMs);
    return response;
  }

  async getPerpsSnapshot(
    engineAddress: string,
    options: { marketIds?: number[]; maxMarkets?: number } = {}
  ) {
    const normalizedEngine = normalizeAddress(engineAddress);
    const maxMarkets = Math.max(1, Math.min(128, Math.trunc(options.maxMarkets ?? 64)));
    const requestedMarketIds = Array.from(
      new Set(
        (options.marketIds ?? [])
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.trunc(value))
      )
    ).slice(0, maxMarkets);

    const [governanceRes, enabledRes, automationRes] = await Promise.all([
      this.source.runGetMethod(normalizedEngine, 'engine_governance', []),
      this.source.runGetMethod(normalizedEngine, 'engine_enabled', []),
      this.source.runGetMethod(normalizedEngine, 'automation_state', [])
    ]);

    if (!governanceRes && !enabledRes && !automationRes) {
      throw new Error('Perps snapshot is unavailable from the configured data source.');
    }

    const status =
      governanceRes?.exitCode === 0 && enabledRes?.exitCode === 0
        ? {
            governance: tupleItemAddress(governanceRes.stack[0]),
            enabled: tupleItemBool(enabledRes.stack[0])
          }
        : null;

    const automation =
      automationRes?.exitCode === 0
        ? {
            fundingCursor: tupleItemBigIntString(automationRes.stack[0]),
            lastFundingTimestamp: tupleItemBigIntString(automationRes.stack[1]),
            lastFundingProcessed: tupleItemBigIntString(automationRes.stack[2]),
            lastFundingRemaining: tupleItemBigIntString(automationRes.stack[3]),
            liquidationCursor: tupleItemBigIntString(automationRes.stack[4]),
            lastLiquidationTimestamp: tupleItemBigIntString(automationRes.stack[5]),
            lastLiquidationProcessed: tupleItemBigIntString(automationRes.stack[6]),
            lastLiquidationRemaining: tupleItemBigIntString(automationRes.stack[7]),
            maxMarketId: tupleItemBigIntString(automationRes.stack[8]),
            liquidationNonce: tupleItemBigIntString(automationRes.stack[9]),
            liquidationBacklog: tupleItemBigIntString(automationRes.stack[10]),
            controlAuthority: tupleItemAddress(automationRes.stack[11]),
            controlSequence: tupleItemBigIntString(automationRes.stack[12]),
            controlTimestamp: tupleItemBigIntString(automationRes.stack[13])
          }
        : null;

    const derivedMarketIds =
      requestedMarketIds.length > 0
        ? requestedMarketIds
        : (() => {
            const maxMarketId = automation?.maxMarketId ? Number(automation.maxMarketId) : 0;
            if (Number.isFinite(maxMarketId) && maxMarketId > 0) {
              return Array.from({ length: Math.min(maxMarkets, Math.trunc(maxMarketId)) }, (_, index) => index + 1);
            }
            return [1, 2, 3];
          })();

    const markets: Record<string, any> = {};
    const marketIds: number[] = [];

    for (const marketId of derivedMarketIds.slice(0, maxMarkets)) {
      const marketRes = await this.source.runGetMethod(normalizedEngine, 'market_state', [
        { type: 'int', value: BigInt(marketId) }
      ]);
      if (!marketRes || marketRes.exitCode !== 0) continue;
      const stack = marketRes.stack;
      markets[String(marketId)] = {
        exists: tupleItemBool(stack[0]),
        pool: tupleItemAddress(stack[1]),
        depthUnit: tupleItemBigIntString(stack[2]),
        impactAlpha: tupleItemBigIntString(stack[3]),
        impactBeta: tupleItemBigIntString(stack[4]),
        baseLeverageBps: tupleItemBigIntString(stack[5]),
        maxLeverageBps: tupleItemBigIntString(stack[6]),
        maintenanceBps: tupleItemBigIntString(stack[7]),
        oiCap: tupleItemBigIntString(stack[8]),
        fundingCapBps: tupleItemBigIntString(stack[9]),
        fundingIndex: tupleItemBigIntString(stack[10]),
        lastFundingTs: tupleItemBigIntString(stack[11]),
        oiLong: tupleItemBigIntString(stack[12]),
        oiShort: tupleItemBigIntString(stack[13]),
        longBase: tupleItemBigIntString(stack[14]),
        shortBase: tupleItemBigIntString(stack[15]),
        halted: tupleItemBool(stack[16]),
        oracleMark: tupleItemBigIntString(stack[17]),
        oracleMarkTs: tupleItemBigIntString(stack[18]),
        liquidationSlice: tupleItemBigIntString(stack[19]),
        liquidationCooldown: tupleItemBigIntString(stack[20]),
        liquidationPendingBase: tupleItemBigIntString(stack[21]),
        liquidationLastTs: tupleItemBigIntString(stack[22]),
        adlDeficit: tupleItemBigIntString(stack[23]),
        liquidityWeightBps: tupleItemBigIntString(stack[24]),
        utilizationWeightBps: tupleItemBigIntString(stack[25]),
        lastDynamicWeightBps: tupleItemBigIntString(stack[26]),
        rebalanceClampBps: tupleItemBigIntString(stack[27]),
        lastClampUpdateTs: tupleItemBigIntString(stack[28]),
        auctionActive: tupleItemBool(stack[29]),
        auctionOutstandingBase: tupleItemBigIntString(stack[30]),
        auctionMinPrice: tupleItemBigIntString(stack[31]),
        auctionMaxPrice: tupleItemBigIntString(stack[32]),
        auctionExpiryTs: tupleItemBigIntString(stack[33]),
        auctionClearingPrice: tupleItemBigIntString(stack[34]),
        controlWeightBps: tupleItemBigIntString(stack[35]),
        controlFeeDeltaBps: tupleItemBigIntString(stack[36]),
        marketKind: tupleItemBigIntString(stack[37]),
        timerVolatilityBps: tupleItemBigIntString(stack[38]),
        timerEmaVolatilityBps: tupleItemBigIntString(stack[39]),
        timerLastUpdateTs: tupleItemBigIntString(stack[40]),
        timerWeightBps: tupleItemBigIntString(stack[41]),
        correlationBps: tupleItemBigIntString(stack[42]),
        correlationDispersionBps: tupleItemBigIntString(stack[43]),
        correlationLastUpdateTs: tupleItemBigIntString(stack[44]),
        correlationWeightBps: tupleItemBigIntString(stack[45]),
        lastFundingPayloadHash: tupleItemBigIntString(stack[46]),
        lastFundingPoolHash: tupleItemBigIntString(stack[47])
      };
      marketIds.push(marketId);
    }

    return {
      engine: normalizedEngine,
      status,
      automation,
      market_ids: marketIds,
      markets,
      source: this.config.dataSource === 'lite' ? 'lite' : 'http4',
      network: this.network,
      updated_at: Math.floor(Date.now() / 1000)
    };
  }

  async getGovernanceSnapshot(
    votingAddress: string,
    options: { owner?: string | null; maxScan?: number; maxConsecutiveMisses?: number } = {}
  ): Promise<GovernanceSnapshotResponse> {
    const normalizedVoting = normalizeAddress(votingAddress);
    const normalizedOwner = options.owner ? normalizeAddress(options.owner) : null;
    const maxScan = Math.max(
      1,
      Math.min(GOVERNANCE_MAX_SCAN_LIMIT, Math.trunc(options.maxScan ?? GOVERNANCE_MAX_SCAN_DEFAULT))
    );
    const maxConsecutiveMisses = Math.max(
      1,
      Math.min(
        GOVERNANCE_MAX_CONSECUTIVE_MISSES_LIMIT,
        Math.trunc(options.maxConsecutiveMisses ?? GOVERNANCE_MAX_CONSECUTIVE_MISSES_DEFAULT)
      )
    );
    const cacheKey = [normalizedVoting, normalizedOwner ?? '', maxScan, maxConsecutiveMisses].join('|');

    if (this.config.responseCacheEnabled) {
      const cached = this.governanceSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.governanceSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = (async () => {
      let lockResponded = false;
      const lockPromise = (async (): Promise<GovernanceLockSnapshot | null> => {
        if (!normalizedOwner) return null;
        const owner = Address.parse(normalizedOwner);
        const ownerCell = beginCell().storeAddress(owner).endCell();
        const lockRes = await this.source.runGetMethod(normalizedVoting, 'governance_lock', [
          { type: 'slice', cell: ownerCell }
        ]);
        lockResponded = lockRes !== null;
        if (!lockRes || lockRes.exitCode !== 0) return null;
        const stack = lockRes.stack;
        return {
          amount: tupleItemBigIntString(stack[0]),
          unlockTime: tupleItemBigIntString(stack[1]),
          tier: tupleItemBigIntString(stack[2]),
          activatedAt: tupleItemBigIntString(stack[3]),
          weight: tupleItemBigIntString(stack[4])
        };
      })().catch(() => null);

      const proposals: GovernanceProposalSnapshot[] = [];
      let scanned = 0;
      let misses = 0;
      let proposalResponded = false;

      outer: for (let startId = 1; startId <= maxScan; startId += GOVERNANCE_SCAN_BATCH_SIZE) {
        const endId = Math.min(maxScan, startId + GOVERNANCE_SCAN_BATCH_SIZE - 1);
        const batchIds = Array.from({ length: endId - startId + 1 }, (_, index) => startId + index);
        const batch = await Promise.all(
          batchIds.map((proposalId) =>
            this.source
              .runGetMethod(normalizedVoting, 'governance_proposal', [{ type: 'int', value: BigInt(proposalId) }])
              .catch(() => null)
          )
        );

        for (let index = 0; index < batch.length; index += 1) {
          scanned += 1;
          const res = batch[index];
          if (res) {
            proposalResponded = true;
          }
          if (!res || res.exitCode !== 0) {
            misses += 1;
            if (misses >= maxConsecutiveMisses && proposals.length > 0) {
              break outer;
            }
            continue;
          }
          const stack = res.stack;
          const id = tupleItemBigIntString(stack[0]);
          if (!id) {
            misses += 1;
            if (misses >= maxConsecutiveMisses && proposals.length > 0) {
              break outer;
            }
            continue;
          }
          misses = 0;
          proposals.push({
            id,
            status: tupleItemBigIntString(stack[1]),
            passed: tupleItemBigIntString(stack[2]),
            yesWeight: tupleItemBigIntString(stack[3]),
            noWeight: tupleItemBigIntString(stack[4]),
            abstainWeight: tupleItemBigIntString(stack[5]),
            quorumWeight: tupleItemBigIntString(stack[6]),
            totalWeightSnapshot: tupleItemBigIntString(stack[7]),
            startTime: tupleItemBigIntString(stack[8]),
            minCloseTime: tupleItemBigIntString(stack[9]),
            maxCloseTime: tupleItemBigIntString(stack[10]),
            cooldownEnd: tupleItemBigIntString(stack[11]),
            target: tupleItemAddress(stack[12]),
            value: tupleItemBigIntString(stack[13]),
            descriptionHash: tupleItemBigIntString(stack[14])
          });
        }
      }

      const lock = await lockPromise;
      if (!proposalResponded && !lockResponded) {
        throw new Error('Governance snapshot is unavailable from the configured data source.');
      }

      proposals.sort((left, right) => {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        if (leftId === rightId) return 0;
        return leftId > rightId ? -1 : 1;
      });
      const source: 'lite' | 'http4' = this.config.dataSource === 'lite' ? 'lite' : 'http4';

      return {
        voting: normalizedVoting,
        owner: normalizedOwner,
        lock,
        proposal_count: proposals.length,
        scanned,
        proposals,
        source,
        network: this.network,
        updated_at: Math.floor(Date.now() / 1000)
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.governanceSnapshotInFlight.set(cacheKey, request);
    }

    try {
      const result = await request;
      if (this.config.responseCacheEnabled) {
        this.governanceSnapshotCache.set(cacheKey, result);
      }
      return result;
    } finally {
      this.governanceSnapshotInFlight.delete(cacheKey);
    }
  }

  async getTransactions(address: string, page: number) {
    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (_error) {
      const fallback = this.store.getPage(address, page);
      if (!fallback) {
        return {
          page,
          page_size: this.config.pageSize,
          total_txs: 0,
          total_pages: null,
          total_pages_min: 0,
          history_complete: false,
          txs: [],
          network: this.network,
        };
      }
    }

    const entry = this.store.get(address);
    const signature = this.getTxPageSignature(entry, page);
    const cacheKey = `${address}:page:${page}`;
    if (this.config.responseCacheEnabled && signature) {
      const cachedValue = this.getCached(this.txCache, cacheKey, signature);
      if (cachedValue) return cachedValue;
    }

    const result = this.store.getPage(address, page);
    this.metrics?.recordTxCache(Boolean(result));
    if (!result) {
      return {
        page,
        page_size: this.config.pageSize,
        total_txs: 0,
        total_pages: null,
        total_pages_min: 0,
        history_complete: false,
        txs: [],
        network: this.network,
      };
    }

    if (!result.historyComplete && this.enqueueBackfill) {
      const backfillCapped = result.totalPagesMin >= this.config.backfillMaxPagesPerAddress;
      if (!backfillCapped && page >= result.totalPagesMin) {
        this.enqueueBackfill(address);
      }
    }

    const txs = result.txs.map(this.toApiTx);

    const response = {
      page: result.page,
      page_size: result.pageSize,
      total_txs: result.totalTxs,
      total_pages: result.totalPages,
      total_pages_min: result.totalPagesMin,
      history_complete: result.historyComplete,
      txs,
      network: this.network,
    };
    this.setCached(this.txCache, cacheKey, response, signature, this.config.txCacheTtlMs);
    return response;
  }

  async getTransactionsByCursor(address: string, lt: string, hash: string) {
    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (_error) {
      const fallback = this.store.getPageByCursor(address, { lt, hash });
      if (!fallback) {
        return {
          page: 1,
          page_size: this.config.pageSize,
          total_txs: 0,
          total_pages: null,
          total_pages_min: 0,
          history_complete: false,
          txs: [],
          network: this.network,
        };
      }
    }

    const entry = this.store.get(address);
    const signature = this.getTxCursorSignature(entry, lt, hash);
    const cacheKey = `${address}:cursor:${lt}:${hash}`;
    if (this.config.responseCacheEnabled && signature) {
      const cachedValue = this.getCached(this.txCache, cacheKey, signature);
      if (cachedValue) return cachedValue;
    }

    const result = this.store.getPageByCursor(address, { lt, hash });
    this.metrics?.recordTxCache(Boolean(result));
    if (!result) {
      return {
        page: 1,
        page_size: this.config.pageSize,
        total_txs: 0,
        total_pages: null,
        total_pages_min: 0,
        history_complete: false,
        txs: [],
        network: this.network,
      };
    }

    const txs = result.txs.map(this.toApiTx);
    const response = {
      page: result.page,
      page_size: result.pageSize,
      total_txs: result.totalTxs,
      total_pages: result.totalPages,
      total_pages_min: result.totalPagesMin,
      history_complete: result.historyComplete,
      txs,
      network: this.network,
    };
    this.setCached(this.txCache, cacheKey, response, signature, this.config.txCacheTtlMs);
    return response;
  }

  async refreshAccountState(address: string) {
    const previous = this.store.get(address)?.balance;
    const previousSignature = balanceStateSignature(previous);
    const state = await this.source.getAccountState(address);
    const accountState: AccountState = {
      address,
      balance: state.balance,
      lastTxLt: state.lastTxLt,
      lastTxHash: state.lastTxHash,
      updatedAt: Date.now(),
    };
    this.store.setBalance(address, accountState);
    const nextSignature = balanceStateSignature(accountState);
    if (nextSignature !== previousSignature) {
      this.emitBalanceChanged(address);
    }
  }

  async ensureInitialTransactions(address: string) {
    const entry = this.store.get(address);
    if (entry && entry.txs.length > 0) return;

    const limit = this.config.pageSize * this.config.backfillPageBatch;
    const raw = await this.source.getTransactions(address, limit);
    this.poolTracker?.observeTransactions(raw);
    const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
    this.store.addTransactions(address, indexed);

    const updated = this.store.get(address);
    if (!updated) return;
    const oldest = updated.txs[updated.txs.length - 1];
    this.store.setLastBackfillLt(address, oldest?.lt);

    if (raw.length < limit) {
      this.store.markHistoryComplete(address);
    } else if (this.enqueueBackfill) {
      this.enqueueBackfill(address);
    }
  }

  async updateWithNewTransactions(address: string, rawTxs: IndexedTx[]) {
    if (rawTxs.length === 0) return;
    this.store.addTransactions(address, rawTxs);
  }

  classify(address: string, raw: any[]): IndexedTx[] {
    return raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
  }

  private toApiTx(tx: IndexedTx): UiTx & { kind: string; actions: any[]; lt: string; hash: string } {
    return {
      ...tx.ui,
      kind: tx.kind,
      actions: tx.actions,
      lt: tx.lt,
      hash: tx.hash,
    };
  }
}
