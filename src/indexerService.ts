import { Address } from '@ton/core';
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
