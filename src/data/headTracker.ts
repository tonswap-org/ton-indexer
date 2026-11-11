import type { Network } from '../models';
import { ChainReadError, type ChainHead } from './dataSource';
import { assertFreshNetwork, freshMasterchainBlock, FreshReadUnavailableError } from './freshRead';
import { assertFreshHeadTime, assertFreshLiteHeadTime } from './freshHead';

type Candidate = { last: { workchain: number; shard: string; seqno: number; rootHash: Buffer; fileHash: Buffer };
  init: { workchain?: number; rootHash: Buffer; fileHash: Buffer }; lastUtime: number; now: number };

/** The only accepted process head; absence and lag never lower a published block.
 * Wall-clock age is not head validity: a testnet stall or host clock skew keeps
 * serving explicit-block reads. Only unpinned current reads require assertCurrent. */
export class HeadTracker {
  private value: ChainHead | null = null;
  private observedAt = 0;
  /** Peer clock and local time of the observation that produced each accepted head object. */
  private readonly observations = new WeakMap<ChainHead, { now: number; observedAt: number }>();
  constructor(private readonly network: Network, private readonly onHead?: (head: ChainHead) => void) {}
  current(): ChainHead | null { return this.value; }
  /** The one-second reuse window; it measures observation age, not block age. */
  fresh(): ChainHead | null { return this.value && Date.now() - this.observedAt < 1_000 ? this.value : null; }
  accept(candidate: Candidate): ChainHead {
    try {
      assertFreshNetwork(this.network, candidate.init);
      if (!Number.isSafeInteger(candidate.lastUtime) || candidate.lastUtime <= 0) throw new Error('Invalid masterchain block time');
      const next = { ...freshMasterchainBlock(candidate.last), utime: candidate.lastUtime };
      const current = this.value;
      if (current && (next.seqno < current.seqno || (next.seqno === current.seqno
        && (next.rootHashHex !== current.rootHashHex || next.fileHashHex !== current.fileHashHex || next.utime !== current.utime))
        || next.utime < current.utime)) throw new Error('Lagging or conflicting masterchain head');
      const accepted = Object.freeze(next);
      this.value = accepted;
      this.observedAt = Date.now();
      this.observations.set(accepted, { now: candidate.now, observedAt: this.observedAt });
      if (!current || next.seqno !== current.seqno) {
        try { this.onHead?.(accepted); } catch { /* Telemetry cannot fail an accepted head. */ }
      }
      return accepted;
    } catch (cause) { throw new ChainReadError('upstream_unavailable', { cause }); }
  }
  /** Current-read freshness: the block was at most 30 s old and the peer clock
   * consistent when observed, and the block is still at most 30 s old now. */
  assertCurrent(head: ChainHead, wallTimeMs = Date.now()): void {
    const observation = this.observations.get(head);
    if (!observation) throw new FreshReadUnavailableError(new Error('Current reads require a head observed by this source.'));
    assertFreshLiteHeadTime({ lastUtime: head.utime, now: observation.now }, observation.observedAt);
    assertFreshHeadTime(head.utime, wallTimeMs);
  }
  isCurrent(head: ChainHead): boolean {
    try { this.assertCurrent(head); return true; } catch { return false; }
  }
}
