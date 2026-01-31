import { LRUCache } from 'lru-cache';
import { AccountState, AccountStats, IndexedTx, PageCursor } from '../models';
import { Config } from '../config';

export type AddressEntry = {
  address: string;
  txs: IndexedTx[];
  txIndex: Set<string>;
  pageIndex: PageCursor[];
  stats: AccountStats;
  balance?: AccountState;
};

export type StoreSnapshot = {
  version: 1;
  createdAt: number;
  entries: Array<{
    address: string;
    txs: IndexedTx[];
    stats: AccountStats;
    balance?: AccountState;
  }>;
};

export type PageResult = {
  page: number;
  pageSize: number;
  totalTxs: number;
  totalPages: number | null;
  totalPagesMin: number;
  historyComplete: boolean;
  txs: IndexedTx[];
};

const txKey = (tx: { lt: string; hash: string }) => `${tx.lt}:${tx.hash}`;

const compareTxDesc = (a: IndexedTx, b: IndexedTx) => {
  const ltA = BigInt(a.lt);
  const ltB = BigInt(b.lt);
  if (ltA === ltB) {
    if (a.hash === b.hash) return 0;
    return a.hash > b.hash ? -1 : 1;
  }
  return ltA > ltB ? -1 : 1;
};

const rebuildPageIndex = (txs: IndexedTx[], pageSize: number): PageCursor[] => {
  const result: PageCursor[] = [];
  for (let i = 0; i < txs.length; i += pageSize) {
    const tx = txs[i];
    if (tx) {
      result.push({ lt: tx.lt, hash: tx.hash });
    }
  }
  return result;
};

export class MemoryStore {
  private cache: LRUCache<string, AddressEntry>;
  private config: Config;
  private totalTxs = 0;
  private suppressDispose = false;

  constructor(config: Config) {
    this.config = config;
    this.cache = new LRUCache({
      max: config.maxAddresses,
      ttl: config.idleTtlMs,
      allowStale: false,
      noDisposeOnSet: true,
      dispose: (entry) => {
        if (this.suppressDispose) return;
        const count = entry?.txs?.length ?? 0;
        if (!count) return;
        this.totalTxs = Math.max(0, this.totalTxs - count);
      },
    });
  }

  getTotalTxs() {
    return this.totalTxs;
  }

  getAddressCount() {
    return this.cache.size;
  }

  get(address: string) {
    return this.cache.get(address);
  }

  getOrCreate(address: string): AddressEntry {
    const existing = this.cache.get(address);
    if (existing) {
      existing.stats.lastRequestAt = Date.now();
      this.cache.set(address, existing);
      return existing;
    }
    const entry: AddressEntry = {
      address,
      txs: [],
      txIndex: new Set(),
      pageIndex: [],
      stats: {
        txCount: 0,
        historyComplete: false,
        totalPagesMin: 0,
        lastRequestAt: Date.now(),
      },
    };
    this.cache.set(address, entry);
    return entry;
  }

  touch(address: string) {
    const entry = this.getOrCreate(address);
    entry.stats.lastRequestAt = Date.now();
    this.cache.set(address, entry);
  }

  setBalance(address: string, balance: AccountState) {
    const entry = this.getOrCreate(address);
    entry.balance = balance;
  }

  setLastUpdateSeqno(address: string, seqno: number) {
    const entry = this.getOrCreate(address);
    entry.stats.lastUpdateSeqno = seqno;
  }

  markHistoryComplete(address: string) {
    const entry = this.getOrCreate(address);
    entry.stats.historyComplete = true;
  }

  setLastBackfillLt(address: string, lt?: string) {
    const entry = this.getOrCreate(address);
    entry.stats.lastBackfillLt = lt;
  }

  addTransactions(address: string, txs: IndexedTx[]) {
    if (txs.length === 0) return;
    const entry = this.getOrCreate(address);
    const existingCount = entry.txs.length;
    let added = 0;
    for (const tx of txs) {
      const key = txKey(tx);
      if (entry.txIndex.has(key)) continue;
      entry.txIndex.add(key);
      entry.txs.push(tx);
      added += 1;
    }
    if (added === 0) return;

    entry.txs.sort(compareTxDesc);

    const maxTxs = this.config.pageSize * this.config.maxPagesPerAddress;
    if (entry.txs.length > maxTxs) {
      const overflow = entry.txs.splice(maxTxs);
      for (const tx of overflow) {
        entry.txIndex.delete(txKey(tx));
      }
    }

    entry.pageIndex = rebuildPageIndex(entry.txs, this.config.pageSize);
    entry.stats.txCount = entry.txs.length;
    entry.stats.totalPagesMin = Math.ceil(entry.txs.length / this.config.pageSize);

    const newCount = entry.txs.length;
    this.totalTxs += newCount - existingCount;
    this.enforceGlobalLimit();
  }

  getPage(address: string, page: number): PageResult | undefined {
    const entry = this.cache.get(address);
    if (!entry) return undefined;

    const pageSize = this.config.pageSize;
    let start = (page - 1) * pageSize;
    const cursor = entry.pageIndex[page - 1];
    if (cursor) {
      const idx = this.findIndexByCursor(entry.txs, cursor);
      if (idx !== null) start = idx;
    }
    const end = start + pageSize;
    const txs = entry.txs.slice(start, end);

    return {
      page,
      pageSize,
      totalTxs: entry.stats.txCount,
      totalPages: entry.stats.historyComplete
        ? Math.ceil(entry.stats.txCount / pageSize)
        : null,
      totalPagesMin: entry.stats.totalPagesMin,
      historyComplete: entry.stats.historyComplete,
      txs,
    };
  }

  getPageByCursor(address: string, cursor: PageCursor): PageResult | undefined {
    const entry = this.cache.get(address);
    if (!entry) return undefined;
    const pageSize = this.config.pageSize;
    const start = this.findIndexByCursor(entry.txs, cursor);
    if (start === null) return undefined;
    const txs = entry.txs.slice(start, start + pageSize);
    return {
      page: 1,
      pageSize,
      totalTxs: entry.stats.txCount,
      totalPages: entry.stats.historyComplete ? Math.ceil(entry.stats.txCount / pageSize) : null,
      totalPagesMin: entry.stats.totalPagesMin,
      historyComplete: entry.stats.historyComplete,
      txs,
    };
  }

  listWatchlist(): AddressEntry[] {
    return [...this.cache.values()];
  }

  purgeStale() {
    this.cache.purgeStale();
  }

  exportSnapshot(): StoreSnapshot {
    const entries = [...this.cache.values()].map((entry) => ({
      address: entry.address,
      txs: entry.txs,
      stats: entry.stats,
      balance: entry.balance,
    }));
    return {
      version: 1,
      createdAt: Date.now(),
      entries,
    };
  }

  importSnapshot(snapshot: StoreSnapshot) {
    this.suppressDispose = true;
    this.cache.clear();
    this.suppressDispose = false;
    this.totalTxs = 0;

    for (const item of snapshot.entries) {
      const entry: AddressEntry = {
        address: item.address,
        txs: item.txs ?? [],
        txIndex: new Set(),
        pageIndex: [],
        stats: item.stats,
        balance: item.balance,
      };
      for (const tx of entry.txs) {
        entry.txIndex.add(txKey(tx));
      }
      entry.txs.sort(compareTxDesc);
      entry.pageIndex = rebuildPageIndex(entry.txs, this.config.pageSize);
      entry.stats.txCount = entry.txs.length;
      entry.stats.totalPagesMin = Math.ceil(entry.txs.length / this.config.pageSize);
      this.totalTxs += entry.txs.length;
      this.cache.set(entry.address, entry);
    }

    this.enforceGlobalLimit();
  }

  private enforceGlobalLimit() {
    const maxTxs = this.config.globalMaxPages * this.config.pageSize;
    if (this.totalTxs <= maxTxs) return;

    for (const [address, entry] of this.cache.rentries() as Iterable<[string, AddressEntry]>) {
      if (this.totalTxs <= maxTxs) break;
      this.cache.delete(address);
    }
  }

  private findIndexByCursor(txs: IndexedTx[], cursor: PageCursor): number | null {
    if (txs.length === 0) return null;
    const cursorLt = BigInt(cursor.lt);
    const cursorHash = cursor.hash;
    let lo = 0;
    let hi = txs.length - 1;
    let result: number | null = null;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const tx = txs[mid];
      const txLt = BigInt(tx.lt);
      let cmp: number;
      if (txLt === cursorLt) {
        if (tx.hash === cursorHash) {
          cmp = 0;
        } else {
          cmp = tx.hash > cursorHash ? -1 : 1;
        }
      } else {
        cmp = txLt > cursorLt ? -1 : 1;
      }

      if (cmp >= 0) {
        result = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return result;
  }
}
