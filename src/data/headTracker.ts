import type { Network } from '../models';
import { ChainReadError, type ChainHead } from './dataSource';
import { assertFreshNetwork, freshMasterchainBlock } from './freshRead';
import { assertFreshHeadTime, assertFreshLiteHeadTime } from './freshHead';

type Candidate = { last: { workchain: number; shard: string; seqno: number; rootHash: Buffer; fileHash: Buffer };
  init: { workchain?: number; rootHash: Buffer; fileHash: Buffer }; lastUtime: number; now: number };

/** The only accepted process head; absence and lag never lower a published block. */
export class HeadTracker {
  private value: ChainHead | null = null;
  private observedAt = 0;
  constructor(private readonly network: Network, private readonly onHead?: (head: ChainHead) => void) {}
  current(): ChainHead | null { return this.value; }
  fresh(): ChainHead | null {
    if (!this.value || Date.now() - this.observedAt >= 1_000) return null;
    try { assertFreshHeadTime(this.value.utime); }
    catch { return null; }
    return this.value;
  }
  accept(candidate: Candidate): ChainHead {
    try {
      assertFreshNetwork(this.network, candidate.init);
      assertFreshLiteHeadTime(candidate);
      if (!Number.isSafeInteger(candidate.lastUtime) || candidate.lastUtime <= 0) throw new Error('Invalid masterchain block time');
      const next = { ...freshMasterchainBlock(candidate.last), utime: candidate.lastUtime };
      const current = this.value;
      if (current && (next.seqno < current.seqno || (next.seqno === current.seqno
        && (next.rootHashHex !== current.rootHashHex || next.fileHashHex !== current.fileHashHex || next.utime !== current.utime))
        || next.utime < current.utime)) throw new Error('Lagging or conflicting masterchain head');
      this.value = Object.freeze(next);
      this.observedAt = Date.now();
      if (!current || next.seqno !== current.seqno) {
        try { this.onHead?.(this.value); } catch { /* Telemetry cannot fail an accepted head. */ }
      }
      return this.value;
    } catch (cause) { throw new ChainReadError('upstream_unavailable', { cause }); }
  }
}
