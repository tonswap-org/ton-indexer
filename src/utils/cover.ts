import { Dictionary, TupleReader, beginCell, type TupleItem } from '@ton/core';

type Result = { exitCode: number; stack: TupleItem[] } | null;
export type CoverGetter = (method: string, args: TupleItem[]) => Promise<Result>;
export type CoverPolicySnapshot = {
  id: string; owner: string; pool: string; lowerBound: string; upperBound: string;
  payout: string; coveredNotional: string; windowSeconds: string; requiredObservations: string;
  breachStart: string; breachSeconds: string; lastObservation: string; lastHealthyObservation: string;
  breachObservations: string; lastVolatilityTimestamp: string; lastVolatilityRequestHash: string;
  status: string; riskVault: string; riskBucketId: string; startsAt: string; expiresAt: string;
  graceEndsAt: string; riskPositionKey: string; closeReason: string; closeQueryId: string;
  closeRequester: string | null; premiumFinal: boolean; exitNativeEscrow: string;
};
function stack(result: Result, count: number): TupleReader {
  if (!result || result.exitCode !== 0 || result.stack.length !== count) throw new Error('Cover getter is unavailable or malformed.');
  return new TupleReader(result.stack);
}
function uint(s: TupleReader, bits: number): bigint {
  const value = s.readBigNumber();
  if (value < 0n || value >= 1n << BigInt(bits)) throw new Error('Cover getter contains an invalid unsigned field.');
  return value;
}
function signed(s: TupleReader): string {
  const value = s.readBigNumber();
  if (value < -(1n << 63n) || value >= 1n << 63n) throw new Error('Cover getter contains an invalid range.');
  return value.toString();
}
function boolean(s: TupleReader): boolean {
  const value = s.readBigNumber();
  if (value !== 0n && value !== -1n) throw new Error('Cover getter contains an invalid TVM boolean.');
  return value === -1n;
}
function address(s: TupleReader): string | null {
  const body = s.readCell().beginParse();
  const result = body.loadMaybeAddress()?.toRawString() ?? null;
  body.endParse();
  return result;
}
export function decodeCoverPolicy(result: Result, id: bigint): CoverPolicySnapshot {
  const s = stack(result, 28);
  if (!boolean(s)) throw new Error('Declared live Cover policy is missing; refresh the page.');
  const owner = address(s), pool = address(s);
  const lowerBound = signed(s), upperBound = signed(s);
  const payout = uint(s, 120).toString(), coveredNotional = uint(s, 120).toString();
  const windowSeconds = uint(s, 63).toString(), requiredObservations = uint(s, 16).toString();
  const breachStart = uint(s, 63).toString(), breachSeconds = uint(s, 63).toString();
  const lastObservation = uint(s, 63).toString(), lastHealthyObservation = uint(s, 63).toString();
  const breachObservations = uint(s, 16).toString(), lastVolatilityTimestamp = uint(s, 63).toString();
  const lastVolatilityRequestHash = uint(s, 256).toString(), status = uint(s, 8);
  const riskVault = address(s), riskBucketId = uint(s, 16).toString();
  const startsAt = uint(s, 63).toString(), expiresAt = uint(s, 63).toString(), graceEndsAt = uint(s, 63).toString();
  const riskPositionKey = uint(s, 256).toString(), closeReason = uint(s, 8), closeQueryId = uint(s, 64).toString();
  const closeRequester = address(s), premiumFinal = boolean(s), exitNativeEscrow = uint(s, 120).toString();
  if (!owner || !pool || !riskVault || status > 9n || closeReason > 3n) throw new Error('Invalid live Cover policy identity or status.');
  return { id: id.toString(), owner, pool, lowerBound, upperBound, payout, coveredNotional, windowSeconds,
    requiredObservations, breachStart, breachSeconds, lastObservation, lastHealthyObservation, breachObservations,
    lastVolatilityTimestamp, lastVolatilityRequestHash, status: status.toString(), riskVault, riskBucketId,
    startsAt, expiresAt, graceEndsAt, riskPositionKey, closeReason: closeReason.toString(), closeQueryId,
    closeRequester, premiumFinal, exitNativeEscrow };
}
export function decodeCoverLivePage(result: Result, afterSlot: number, limit: number) {
  const s = stack(result, 4), revision = uint(s, 64), nextCursor = Number(uint(s, 16)), done = boolean(s);
  const cell = s.readCell(), body = cell.beginParse();
  const dict = Dictionary.load(Dictionary.Keys.Uint(16), Dictionary.Values.BigUint(64), body);
  body.endParse();
  const ids = [...dict].sort(([a], [b]) => a - b);
  if (!beginCell().storeDict(dict).endCell().equals(cell) || ids.length > limit ||
      ids.some(([slot, id]) => slot <= afterSlot || slot > 1024 || id === 0n) ||
      new Set(ids.map(([, id]) => id)).size !== ids.length ||
      nextCursor !== (ids.at(-1)?.[0] ?? afterSlot) || (!done && (ids.length !== limit || nextCursor === 1024))) {
    throw new Error('Cover live policy page has an invalid dictionary or continuation.');
  }
  return { revision, nextCursor, done, ids };
}

export type CoverPageOptions = { owner?: string | null; afterSlot?: number; limit?: number; revision?: string };
export async function readCoverPolicyPage(options: CoverPageOptions, get: CoverGetter) {
  const cursor = options.afterSlot ?? 0, limit = options.limit ?? 40;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 40) {
    throw new Error('Cover requires a slot cursor in 0..1024 and page size in 1..40.');
  }
  if ((cursor !== 0 && options.revision === undefined) || (options.revision !== undefined &&
      (!/^(0|[1-9][0-9]{0,19})$/.test(options.revision) || BigInt(options.revision) >= 1n << 64n))) {
    throw new Error('Cover continuation requires its original uint64 revision.');
  }
  const page = decodeCoverLivePage(await get('live_policy_ids', [{ type: 'int', value: BigInt(cursor) }, { type: 'int', value: BigInt(limit) }]), cursor, limit);
  if (options.revision !== undefined && page.revision !== BigInt(options.revision)) throw new Error('Cover membership changed; restart from the first page.');
  const policies: CoverPolicySnapshot[] = [];
  for (let start = 0; start < page.ids.length; start += 5) {
    policies.push(...await Promise.all(page.ids.slice(start, start + 5).map(async ([slot, id]) => {
      const policy = decodeCoverPolicy(await get('get_policy', [{ type: 'int', value: id }]), id);
      if (policy.riskPositionKey !== String(slot)) throw new Error('Cover slot changed; restart from the first page.');
      return policy;
    })));
  }
  const check = decodeCoverLivePage(await get('live_policy_ids', [{ type: 'int', value: 0n }, { type: 'int', value: 1n }]), 0, 1);
  if (check.revision !== page.revision) throw new Error('Cover membership changed; restart from the first page.');
  return { policies: policies.filter(policy => !options.owner || policy.owner === options.owner), scanned: page.ids.length,
    live_revision: page.revision.toString(), next_after_slot: page.done ? null : page.nextCursor, page_complete: true as const };
}
