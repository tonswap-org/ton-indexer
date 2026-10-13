import { Cell } from '@ton/core';

type Limits = { maxEntries: number; maxRetainedBytes: number };
type Entry = { encoded: string; retainedBytes: number };

/** Immutable parse facts only. Never retains Cell graphs or chain observations. */
export class SingleRootBocValidationCache {
  private readonly entries = new Map<string, Entry>();
  private retainedBytes = 0;

  constructor(
    private readonly limits: Limits = { maxEntries: 64, maxRetainedBytes: 4 * 1024 * 1024 },
    private readonly decode: (bytes: Buffer) => readonly Cell[] = bytes => Cell.fromBoc(bytes),
  ) {
    if ([limits.maxEntries, limits.maxRetainedBytes].some(value => !Number.isSafeInteger(value) || value < 1))
      throw new Error('BOC validation cache limits must be positive integers.');
    this.limits = Object.freeze({ ...limits });
  }

  hasSingleRoot(encoded: string): boolean {
    const cached = this.entries.get(encoded);
    if (cached) {
      this.entries.delete(cached.encoded);
      this.entries.set(cached.encoded, cached);
      return true;
    }
    const bytes = Buffer.from(encoded, 'base64');
    // Canonical encoding binds every input byte. This fresh string also avoids
    // retaining a larger backing string through a caller's substring/rope.
    const canonical = bytes.toString('base64');
    if (canonical !== encoded || this.decode(bytes).length !== 1) return false;
    // UTF-16 is a conservative bound even when V8 stores ASCII in one byte.
    const retainedBytes = 2 * canonical.length + 64;
    if (retainedBytes > this.limits.maxRetainedBytes) return true;
    while (this.entries.size >= this.limits.maxEntries || this.retainedBytes + retainedBytes > this.limits.maxRetainedBytes) {
      const oldest = this.entries.values().next().value!;
      this.entries.delete(oldest.encoded);
      this.retainedBytes -= oldest.retainedBytes;
    }
    this.entries.set(canonical, { encoded: canonical, retainedBytes });
    this.retainedBytes += retainedBytes;
    return true;
  }
}

const cache = new SingleRootBocValidationCache();
export const hasSingleRootFreshBoc = (encoded: string): boolean => cache.hasSingleRoot(encoded);
