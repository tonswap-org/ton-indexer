import type { TonBlockIdExt } from './dataSource';
import { FreshReadUnavailableError, freshMasterchainBlock } from './freshRead';

const unavailable = (message: string): never => { throw new FreshReadUnavailableError(new Error(message)); };

function ownedHead(head: TonBlockIdExt): Readonly<TonBlockIdExt> {
  return Object.freeze(freshMasterchainBlock({ ...head, rootHash: head.rootHashHex, fileHash: head.fileHashHex }));
}

function assertIdentity(head: TonBlockIdExt, known?: TonBlockIdExt): void {
  if (known && head.seqno === known.seqno &&
    (head.rootHashHex !== known.rootHashHex || head.fileHashHex !== known.fileHashHex))
    unavailable('Fresh masterchain head conflicts at the same height.');
}

export type FreshReadHeadFloor = Readonly<{ head?: Readonly<TonBlockIdExt> }>;

/** Stores only a full block identity, never account state or getter results. */
export class FreshHeadFence {
  private highest?: Readonly<TonBlockIdExt>;

  /** Capture before awaiting: unrelated faster requests must not starve this read. */
  capture(inherited?: FreshReadHeadFloor): FreshReadHeadFloor {
    // An inherited empty floor is intentional: fallback belongs to the original
    // operation, not a new operation started after another batch completed.
    const head = inherited ? (inherited.head && ownedHead(inherited.head)) : this.highest;
    if (head) assertIdentity(head, this.highest);
    return Object.freeze({ head });
  }

  assert(head: TonBlockIdExt, floor: FreshReadHeadFloor): void {
    if (floor.head && head.seqno < floor.head.seqno) unavailable('Fresh masterchain head is behind the request floor.');
    assertIdentity(head, floor.head);
    assertIdentity(head, this.highest);
  }

  /** Commit only a fully validated, uncancelled batch. Older concurrent reads cannot lower the floor. */
  accept(head: TonBlockIdExt, floor: FreshReadHeadFloor): void {
    const owned = ownedHead(head);
    this.assert(owned, floor);
    if (!this.highest || owned.seqno > this.highest.seqno) this.highest = owned;
  }
}

/** lastUtime is block creation time; the peer's `now` alone is not freshness. */
export function assertFreshLiteHeadTime(master: { lastUtime: number; now: number }, wallTimeMs = Date.now()): void {
  const wallTime = Math.floor(wallTimeMs / 1_000);
  if (!Number.isSafeInteger(master.lastUtime) || !Number.isSafeInteger(master.now)
    || master.lastUtime < 0 || master.now < master.lastUtime
    || Math.abs(master.now - wallTime) > 30
    || master.lastUtime < wallTime - 30 || master.lastUtime > wallTime + 5)
    unavailable('Fresh liteserver head has stale or invalid block time.');
}
