import type { Cell } from '@ton/core';
import { LRUCache } from 'lru-cache';
import type { CacheMap, ClientAccountState } from 'ton-lite-client/dist/types';

type Limits = { entries: number; rawBytes: number; cells: number };
type Entry = { promise: Promise<ClientAccountState>; rawBytes: number; cells: number };
const DEFAULT_LIMITS: Limits = { entries: 64, rawBytes: 8 * 1024 * 1024, cells: 65_536 };

/** The SDK keys accounts by block, so its default 1,000-entry cache retains
 * many independent copies of large contract code and proofs. Bound pending
 * entries and both representations of settled accounts. Eviction never cancels
 * a caller's promise, changes its result, or substitutes another block. */
export class LiteAccountCache implements CacheMap {
  private readonly entries = new Map<string, Entry>();
  private rawBytes = 0;
  private cells = 0;

  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw Error('Lite account cache limits must be positive integers');
    }
    this.limits = Object.freeze({ ...limits });
  }

  get size() { return this.entries.size; }
  get retainedRawBytes() { return this.rawBytes; }
  get retainedCells() { return this.cells; }

  get(key: string): Promise<ClientAccountState> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.promise;
  }

  set(key: string, promise: Promise<ClientAccountState>): this {
    this.delete(key);
    const entry: Entry = { promise, rawBytes: 0, cells: 0 };
    this.entries.set(key, entry);
    this.trim();
    void promise.then(value => {
      // An evicted/replaced pending read must not resurrect its old entry.
      if (this.entries.get(key) !== entry) return;
      try {
        const rawBytes = value.raw.byteLength + value.proof.byteLength + value.shardProof.byteLength;
        if (!Number.isSafeInteger(rawBytes) || rawBytes > this.limits.rawBytes) {
          this.delete(key); return;
        }
        const storage = value.state?.storage.state;
        const pending: Cell[] = storage?.type === 'active'
          ? [storage.state.code, storage.state.data].filter((cell): cell is Cell => !!cell) : [];
        const visited = new Set<Cell>();
        while (pending.length) {
          const cell = pending.pop()!;
          if (visited.has(cell)) continue;
          visited.add(cell);
          if (visited.size > this.limits.cells) { this.delete(key); return; }
          pending.push(...cell.refs);
        }
        entry.rawBytes = rawBytes; entry.cells = visited.size;
        this.rawBytes += rawBytes; this.cells += visited.size;
        this.trim();
      } catch {
        // Cache accounting cannot replace the SDK's actual result or failure.
        this.delete(key);
      }
    }, () => {
      if (this.entries.get(key) === entry) this.delete(key);
    });
    return this;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.rawBytes -= entry.rawBytes; this.cells -= entry.cells;
    return this.entries.delete(key);
  }

  clear(): void { this.entries.clear(); this.rawBytes = 0; this.cells = 0; }

  private trim(): void {
    while (this.entries.size > this.limits.entries || this.rawBytes > this.limits.rawBytes || this.cells > this.limits.cells) {
      this.delete(this.entries.keys().next().value!);
    }
  }
}

/** DataLoader clears a failed batch by key before rejecting its original
 * promises. That key may now belong to a replacement after LRU eviction.
 * Only our promise observer has enough identity to retire the failed entry;
 * the SDK's unowned failure-clear must not delete a newer pending/settled read. */
export function liteAccountLoaderCache(cache = new LiteAccountCache()): CacheMap {
  return {
    get: key => cache.get(key),
    set: (key, promise) => cache.set(key, promise),
    delete: () => false,
    clear: () => cache.clear(),
  };
}

/** Other SDK loaders retain only a bounded set of block/header/shard records. */
export function createLiteClientCache(kind: 'block' | 'header' | 'shard' | 'account'): CacheMap {
  return kind === 'account' ? liteAccountLoaderCache() : new LRUCache({ max: 256 });
}
