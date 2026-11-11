import { LRUCache } from 'lru-cache';
import { Buffer } from 'node:buffer';
import { Address } from '@ton/core';
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

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeAddress = (value: string) => {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return value.trim().toLowerCase();
  }
};

const isCanonicalLt = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  if (value.length > 20) return false;
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
};

const compareTxDesc = (a: IndexedTx, b: IndexedTx) => {
  const ltA = BigInt(a.lt);
  const ltB = BigInt(b.lt);
  if (ltA === ltB) {
    if (a.hash === b.hash) return 0;
    return a.hash > b.hash ? -1 : 1;
  }
  return ltA > ltB ? -1 : 1;
};

const parseHash32 = (value: unknown): Buffer | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (normalized.length % 4 === 1) return null;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length !== 32) return null;
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) return null;
  return decoded;
};

const sameHash32 = (left: unknown, right: unknown) => {
  const parsedLeft = parseHash32(left);
  const parsedRight = parseHash32(right);
  return Boolean(parsedLeft && parsedRight && parsedLeft.equals(parsedRight));
};

const canonicalHash32 = (value: unknown) => parseHash32(value)?.toString('base64') ?? null;

const ZERO_HASH = Buffer.alloc(32);

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
  private cacheAccounting: { active: boolean };
  private config: Config;
  private totalTxs = 0;
  private addressLocks = new Map<string, Promise<void>>();
  private workflowGeneration = 0;

  constructor(config: Config) {
    this.config = config;
    this.cacheAccounting = { active: true };
    this.cache = this.createCache(this.cacheAccounting);
  }

  private createCache(accounting: { active: boolean }) {
    return new LRUCache<string, AddressEntry>({
      // Address and idle limits are enforced explicitly so entries participating
      // in an async address workflow cannot be evicted between awaits.
      maxSize: Number.MAX_SAFE_INTEGER,
      sizeCalculation: () => 1,
      noDisposeOnSet: true,
      dispose: (entry) => {
        if (!accounting.active) return;
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

  getWorkflowGeneration() {
    return this.workflowGeneration;
  }

  isWorkflowGenerationCurrent(generation: number) {
    return generation === this.workflowGeneration;
  }

  get(address: string) {
    return this.cache.get(address);
  }

  getOrCreate(address: string): AddressEntry {
    const existing = this.cache.get(address);
    if (existing) return existing;
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
    this.enforceAddressLimit();
    return entry;
  }

  async withAddressLock<T>(
    address: string,
    operation: () => Promise<T> | T,
    expectedWorkflowGeneration?: number
  ): Promise<T | undefined> {
    const lockAddress = normalizeAddress(address);
    const previous = this.addressLocks.get(lockAddress) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.addressLocks.set(lockAddress, tail);

    await previous;
    try {
      if (
        expectedWorkflowGeneration !== undefined &&
        !this.isWorkflowGenerationCurrent(expectedWorkflowGeneration)
      ) {
        return undefined;
      }
      return await operation();
    } finally {
      release();
      if (this.addressLocks.get(lockAddress) === tail) {
        this.addressLocks.delete(lockAddress);
      }
      this.enforceAddressLimit();
      this.enforceGlobalLimit();
    }
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

  markHistoryIncomplete(address: string) {
    const entry = this.getOrCreate(address);
    entry.stats.historyComplete = false;
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
      entry.stats.historyComplete = false;
    }

    entry.pageIndex = rebuildPageIndex(entry.txs, this.config.pageSize);
    entry.stats.txCount = entry.txs.length;
    entry.stats.totalPagesMin = Math.ceil(entry.txs.length / this.config.pageSize);

    const newCount = entry.txs.length;
    this.totalTxs += newCount - existingCount;
    this.enforceGlobalLimit();
  }

  replaceTransactions(address: string, txs: IndexedTx[]) {
    const uniqueTransactions = new Map<string, IndexedTx>();
    for (const tx of txs) {
      const key = txKey(tx);
      if (!uniqueTransactions.has(key)) uniqueTransactions.set(key, tx);
    }
    const replacement = [...uniqueTransactions.values()].sort(compareTxDesc);
    const maxTxs = this.config.pageSize * this.config.maxPagesPerAddress;
    if (replacement.length > maxTxs) replacement.splice(maxTxs);

    const entry = this.getOrCreate(address);
    const previousCount = entry.txs.length;
    entry.txs = replacement;
    entry.txIndex = new Set(replacement.map(txKey));
    entry.pageIndex = rebuildPageIndex(replacement, this.config.pageSize);
    entry.stats.txCount = replacement.length;
    entry.stats.totalPagesMin = Math.ceil(replacement.length / this.config.pageSize);
    // Replacement changes the canonical retained segment. Only a caller that
    // has validated the entire account chain may certify it complete again.
    entry.stats.historyComplete = false;

    this.totalTxs += replacement.length - previousCount;
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
    const idleTtlMs = Math.max(0, this.config.idleTtlMs);
    const now = Date.now();
    for (const [address, entry] of this.cache.rentries() as Iterable<
      [string, AddressEntry]
    >) {
      if (this.addressLocks.has(normalizeAddress(address))) continue;
      if (now - entry.stats.lastRequestAt >= idleTtlMs) {
        this.cache.delete(address);
      }
    }
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
    const normalized = this.normalizeSnapshot(snapshot);
    if (this.addressLocks.size > 0) {
      throw new Error('Cannot import a snapshot while address updates are in flight.');
    }
    const retained = normalized.slice(0, this.config.maxAddresses);
    const globalMaxTxs = this.config.globalMaxPages * this.config.pageSize;
    let nextTotalTxs = retained.reduce((total, entry) => total + entry.txs.length, 0);
    while (nextTotalTxs > globalMaxTxs && retained.length > 0) {
      const evicted = retained.pop();
      nextTotalTxs -= evicted?.txs.length ?? 0;
    }

    const nextAccounting = { active: false };
    const nextCache = this.createCache(nextAccounting);
    // Snapshot iteration is most-recent to least-recent. Insert in reverse so
    // the replacement cache preserves that recency order.
    for (let index = retained.length - 1; index >= 0; index -= 1) {
      const entry = retained[index];
      nextCache.set(entry.address, entry);
    }
    nextTotalTxs = [...nextCache.values()].reduce(
      (total, entry) => total + entry.txs.length,
      0
    );

    this.cacheAccounting.active = false;
    nextAccounting.active = true;
    this.cache = nextCache;
    this.cacheAccounting = nextAccounting;
    this.totalTxs = nextTotalTxs;
    this.workflowGeneration += 1;
  }

  private normalizeSnapshot(snapshot: StoreSnapshot): AddressEntry[] {
    if (
      !isRecord(snapshot) ||
      snapshot.version !== 1 ||
      typeof snapshot.createdAt !== 'number' ||
      !Number.isFinite(snapshot.createdAt) ||
      !Array.isArray(snapshot.entries)
    ) {
      throw new Error('Invalid store snapshot header.');
    }

    const addresses = new Set<string>();
    const maxTxs = this.config.pageSize * this.config.maxPagesPerAddress;
    return snapshot.entries.map((rawItem, entryIndex) => {
      if (!isRecord(rawItem)) {
        throw new Error(`Invalid store snapshot entry at index ${entryIndex}.`);
      }
      const snapshotAddress = rawItem.address;
      if (typeof snapshotAddress !== 'string' || snapshotAddress.length === 0) {
        throw new Error(`Invalid store snapshot address at index ${entryIndex}.`);
      }
      const address = normalizeAddress(snapshotAddress);
      if (addresses.has(address)) {
        throw new Error(`Duplicate store snapshot address: ${address}`);
      }
      addresses.add(address);

      if (!Array.isArray(rawItem.txs) || !isRecord(rawItem.stats)) {
        throw new Error(`Invalid store snapshot payload for ${address}.`);
      }
      const rawStats = rawItem.stats;
      if (
        typeof rawStats.historyComplete !== 'boolean' ||
        typeof rawStats.lastRequestAt !== 'number' ||
        !Number.isFinite(rawStats.lastRequestAt)
      ) {
        throw new Error(`Invalid store snapshot stats for ${address}.`);
      }
      if (
        rawStats.lastBackfillLt !== undefined &&
        !isCanonicalLt(rawStats.lastBackfillLt)
      ) {
        throw new Error(`Invalid last backfill LT for ${address}.`);
      }
      if (
        rawStats.lastUpdateSeqno !== undefined &&
        (typeof rawStats.lastUpdateSeqno !== 'number' ||
          !Number.isInteger(rawStats.lastUpdateSeqno) ||
          rawStats.lastUpdateSeqno < 0)
      ) {
        throw new Error(`Invalid last update seqno for ${address}.`);
      }

      const uniqueTransactions = new Map<string, IndexedTx>();
      let normalizedHistory = false;
      for (let txIndex = 0; txIndex < rawItem.txs.length; txIndex += 1) {
        const rawTx = rawItem.txs[txIndex];
        if (
          !isRecord(rawTx) ||
          typeof rawTx.address !== 'string' ||
          normalizeAddress(rawTx.address) !== address ||
          !isCanonicalLt(rawTx.lt) ||
          typeof rawTx.utime !== 'number' ||
          !Number.isFinite(rawTx.utime) ||
          typeof rawTx.success !== 'boolean' ||
          !Array.isArray(rawTx.outMessages) ||
          typeof rawTx.kind !== 'string' ||
          !Array.isArray(rawTx.actions) ||
          !isRecord(rawTx.ui)
        ) {
          throw new Error(`Invalid transaction ${txIndex} in snapshot entry ${address}.`);
        }
        const canonicalHash = canonicalHash32(rawTx.hash);
        const hasPredecessorLt = rawTx.prevTransactionLt !== undefined;
        const hasPredecessorHash = rawTx.prevTransactionHash !== undefined;
        const canonicalPredecessorHash = hasPredecessorHash
          ? canonicalHash32(rawTx.prevTransactionHash)
          : null;
        if (
          !canonicalHash ||
          hasPredecessorLt !== hasPredecessorHash ||
          (hasPredecessorLt && !isCanonicalLt(rawTx.prevTransactionLt)) ||
          (hasPredecessorHash && !canonicalPredecessorHash)
        ) {
          throw new Error(`Invalid transaction hash chain at index ${txIndex} for ${address}.`);
        }
        const transaction = structuredClone(rawTx) as IndexedTx;
        transaction.address = address;
        transaction.hash = canonicalHash;
        transaction.ui.txId = `${transaction.lt}:${canonicalHash}`;
        if (hasPredecessorLt && canonicalPredecessorHash) {
          transaction.prevTransactionLt = rawTx.prevTransactionLt as string;
          transaction.prevTransactionHash = canonicalPredecessorHash;
        }
        const key = txKey(transaction);
        if (uniqueTransactions.has(key)) {
          normalizedHistory = true;
          continue;
        }
        uniqueTransactions.set(key, transaction);
      }

      const txs = [...uniqueTransactions.values()].sort(compareTxDesc);
      if (txs.length > maxTxs) {
        txs.splice(maxTxs);
        normalizedHistory = true;
      }
      const txIndex = new Set(txs.map(txKey));
      const stats: AccountStats = {
        txCount: txs.length,
        historyComplete: false,
        totalPagesMin: Math.ceil(txs.length / this.config.pageSize),
        lastRequestAt: rawStats.lastRequestAt,
      };
      if (rawStats.lastBackfillLt !== undefined) {
        stats.lastBackfillLt = rawStats.lastBackfillLt;
      }
      if (rawStats.lastUpdateSeqno !== undefined) {
        stats.lastUpdateSeqno = rawStats.lastUpdateSeqno;
      }

      let balance: AccountState | undefined;
      if (rawItem.balance !== undefined) {
        const rawBalance = rawItem.balance;
        const hasLastTxLt = isRecord(rawBalance) && rawBalance.lastTxLt !== undefined;
        const hasLastTxHash = isRecord(rawBalance) && rawBalance.lastTxHash !== undefined;
        const canonicalLastTxHash = hasLastTxHash
          ? canonicalHash32(rawBalance.lastTxHash)
          : null;
        if (
          !isRecord(rawBalance) ||
          typeof rawBalance.address !== 'string' ||
          normalizeAddress(rawBalance.address) !== address ||
          typeof rawBalance.balance !== 'string' ||
          typeof rawBalance.updatedAt !== 'number' ||
          !Number.isFinite(rawBalance.updatedAt) ||
          hasLastTxLt !== hasLastTxHash ||
          (hasLastTxLt && !isCanonicalLt(rawBalance.lastTxLt)) ||
          (hasLastTxHash && !canonicalLastTxHash)
        ) {
          throw new Error(`Invalid account balance in snapshot entry ${address}.`);
        }
        balance = structuredClone(rawBalance) as AccountState;
        balance.address = address;
        if (hasLastTxLt && canonicalLastTxHash) {
          balance.lastTxLt = rawBalance.lastTxLt as string;
          balance.lastTxHash = canonicalLastTxHash;
        }
      }

      stats.historyComplete =
        rawStats.historyComplete &&
        !normalizedHistory &&
        this.certifiesCompleteHistory(txs, balance);

      return {
        address,
        txs,
        txIndex,
        pageIndex: rebuildPageIndex(txs, this.config.pageSize),
        stats,
        balance,
      };
    });
  }

  private certifiesCompleteHistory(txs: IndexedTx[], balance: AccountState | undefined) {
    if (!balance) return false;
    const hasBalanceHeadLt = balance.lastTxLt !== undefined;
    const hasBalanceHeadHash = balance.lastTxHash !== undefined;
    if (hasBalanceHeadLt !== hasBalanceHeadHash) return false;

    if (txs.length === 0) {
      return !hasBalanceHeadLt && !hasBalanceHeadHash;
    }

    const newest = txs[0];
    if (
      !hasBalanceHeadLt ||
      !hasBalanceHeadHash ||
      balance.lastTxLt !== newest.lt ||
      !sameHash32(balance.lastTxHash, newest.hash)
    ) {
      return false;
    }

    for (let index = 0; index < txs.length; index += 1) {
      const transaction = txs[index];
      if (!isCanonicalLt(transaction.prevTransactionLt)) return false;
      const predecessorHash = parseHash32(transaction.prevTransactionHash);
      if (!predecessorHash) return false;

      const predecessor = txs[index + 1];
      if (predecessor) {
        const predecessorTransactionHash = parseHash32(predecessor.hash);
        if (
          transaction.prevTransactionLt !== predecessor.lt ||
          !predecessorTransactionHash ||
          !predecessorHash.equals(predecessorTransactionHash)
        ) {
          return false;
        }
      } else if (
        transaction.prevTransactionLt !== '0' ||
        !predecessorHash.equals(ZERO_HASH)
      ) {
        return false;
      }
    }

    return true;
  }

  private enforceGlobalLimit() {
    const maxTxs = this.config.globalMaxPages * this.config.pageSize;
    if (this.totalTxs <= maxTxs) return;

    for (const [address, entry] of this.cache.rentries() as Iterable<[string, AddressEntry]>) {
      if (this.totalTxs <= maxTxs) break;
      if (this.addressLocks.has(normalizeAddress(address))) continue;
      this.cache.delete(address);
    }
  }

  private enforceAddressLimit() {
    if (this.cache.size <= this.config.maxAddresses) return;
    for (const [address] of this.cache.rentries() as Iterable<[string, AddressEntry]>) {
      if (this.cache.size <= this.config.maxAddresses) break;
      if (this.addressLocks.has(normalizeAddress(address))) continue;
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
