import { Cell } from '@ton/core';
import { decodeNativeFundingBody } from './nativeFunding';

/** Content facts only: no Cell, Buffer, message context or settlement decision. */
export type WireBodySummary = Readonly<{
  hash: string;
  bits: number;
  exotic: boolean;
  opcode: number | null;
  businessOpcode: number | null;
}>;

/** Exact encoded content is immutable; account/head/causal checks remain with callers.
 * Bound both entry count and retained UTF-16 source bytes. Oversized bodies are
 * decoded normally but never retained. Parsed graphs must not escape this cache:
 * even a frozen @ton/core Cell exposes mutable hash and bit buffers. */
export class WireBodySummaryCache {
  private readonly entries = new Map<string, { key: string; summary: WireBodySummary }>();
  private retainedBytes = 0;

  constructor(private readonly maxEntries = 1024, private readonly maxBodyBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
        !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
      throw new Error('Wire summary cache limits must be positive safe integers.');
  }

  get(body: string): WireBodySummary | null {
    const cached = this.entries.get(body);
    if (cached) {
      this.entries.delete(body);
      this.entries.set(cached.key, cached);
      return cached.summary;
    }
    let summary: WireBodySummary;
    try {
      const roots = Cell.fromBoc(Buffer.from(body, 'base64'));
      if (roots.length !== 1) return null;
      const cell = roots[0];
      let businessOpcode: number | null = null;
      try {
        const business = decodeNativeFundingBody(cell).businessBody;
        if (business.bits.length >= 32) businessOpcode = business.beginParse().preloadUint(32);
      } catch { /* Invalid funding remains unavailable for business decoding. */ }
      summary = Object.freeze({
        hash: cell.hash().toString('hex'), bits: cell.bits.length, exotic: cell.isExotic,
        opcode: !cell.isExotic && cell.bits.length >= 32 ? cell.beginParse().preloadUint(32) : null,
        businessOpcode,
      });
    } catch { return null; }
    const bytes = body.length * 2;
    if (bytes <= this.maxBodyBytes) {
      while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBodyBytes) {
        const oldest = this.entries.keys().next().value!;
        this.entries.delete(oldest);
        this.retainedBytes -= oldest.length * 2;
      }
      // Detach sliced strings from potentially much larger provider responses.
      // UTF-16 preserves the exact JS string, including unpaired surrogates;
      // cache retention must not impose a new base64 canonicalization policy.
      const key = Buffer.from(body, 'utf16le').toString('utf16le');
      this.entries.set(key, { key, summary });
      this.retainedBytes += bytes;
    }
    return summary;
  }
}
