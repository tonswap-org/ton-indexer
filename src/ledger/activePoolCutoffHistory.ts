import { createHash } from 'node:crypto';
import { Address, Cell } from '@ton/core';
import type { RawTransaction, TransactionCursor } from '../data/dataSource';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';

export type PoolCutoffHistoryRequest = {
  pool: string;
  /** Original chain observation time. The caller must authenticate this time
   * and the current head at the same masterchain block before pricing. */
  observedAt: string;
  cutoffAt: string;
  head: TransactionCursor;
};
export type PoolCutoffHistoryEvidence = Readonly<{
  schema: 'active-pool-cutoff-history-v1';
  id: string;
  proof: 'linked-original-account-transactions';
  pool: string;
  observedAt: string;
  applicableAt: string;
  observedHead: Readonly<TransactionCursor>;
  applicable: Readonly<RawTransaction>;
  successor: Readonly<RawTransaction> | null;
  /** Descending original account chain from the observed head up to, but not
   * including, the selected cutoff transaction. Failed transactions count. */
  intervening: readonly Readonly<RawTransaction>[];
}>;
export type PoolCutoffHistoryResult =
  | { status: 'available'; evidence: PoolCutoffHistoryEvidence }
  | { status: 'unavailable'; issue: string };

const MAX_LT = (1n << 64n) - 1n;
function lt(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_LT)
    throw Error('pool_cutoff_request_invalid');
  return value;
}
function chainTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || time % 1000 || new Date(time).toISOString() !== value)
    throw Error('pool_cutoff_request_invalid');
  return time / 1000;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One cutoff-chain dependency, not a standalone network/archive or price
 * attestation. Prices still require authenticated same-head current state,
 * the exact selected historical state, qualified code/root/precision and
 * retained block provenance. Neither a wall-clock poll nor an executed-trade
 * ratio can supply those separate prerequisites.
 *
 * Decode the retained original cells and prove every predecessor from the
 * pinned current pointer to the inclusive cutoff. An unchanged account needs
 * only its original head: the authenticated current pointer then proves no
 * account transaction intervened. History before the selected cutoff state is
 * irrelevant to this interval and is never described as complete history. */
export function selectActivePoolCutoffHistory(
  request: PoolCutoffHistoryRequest,
  history: readonly RawTransaction[],
): PoolCutoffHistoryResult {
  const unavailable = (issue: string): PoolCutoffHistoryResult => ({ status: 'unavailable', issue });
  let pool: string, observedUtime: number, cutoffUtime: number, head: TransactionCursor;
  try {
    pool = canonicalLedgerAddress(request.pool);
    if (pool !== request.pool || pool.endsWith(`:${'0'.repeat(64)}`)) throw Error();
    observedUtime = chainTime(request.observedAt); cutoffUtime = chainTime(request.cutoffAt);
    if (observedUtime - cutoffUtime !== 86400) throw Error();
    head = { lt: lt(request.head.lt), hash: canonicalLedgerHash(request.head.hash) };
  } catch { return unavailable('pool_cutoff_request_invalid'); }
  if (!Array.isArray(history) || !history.length) return unavailable('pool_cutoff_state_uncovered');
  const originals = new Map<string, RawTransaction>();
  let oldestLt: bigint | null = null;
  try {
    const account = Address.parse(pool);
    for (const row of history) {
      if (!row.rawBoc || Buffer.from(row.rawBoc, 'base64').toString('base64') !== row.rawBoc) throw Error();
      const roots = Cell.fromBoc(Buffer.from(row.rawBoc, 'base64'));
      if (roots.length !== 1) throw Error();
      const original = decodeOriginalTransaction(roots[0], account);
      if (original.lt !== row.lt || original.hash !== canonicalLedgerHash(row.hash) ||
        original.prevTransactionLt !== row.prevTransactionLt ||
        original.prevTransactionHash !== canonicalLedgerHash(row.prevTransactionHash!)) throw Error();
      if (originals.has(original.lt)) return unavailable('pool_cutoff_duplicate_transaction');
      originals.set(original.lt, original);
      if (oldestLt === null || BigInt(original.lt) < oldestLt) oldestLt = BigInt(original.lt);
    }
  } catch { return unavailable('pool_cutoff_original_unavailable'); }
  const first = originals.get(head.lt);
  if (!first || first.hash !== head.hash) return unavailable('pool_cutoff_head_mismatch');
  const intervening: RawTransaction[] = [];
  let current: RawTransaction | undefined = first;
  while (current) {
    if (current.utime > observedUtime) return unavailable('pool_cutoff_future_transaction');
    const next = intervening.at(-1);
    if (next && current.utime > next.utime) return unavailable('pool_cutoff_time_order_invalid');
    if (current.utime <= cutoffUtime) {
      const contents = {
        schema: 'active-pool-cutoff-history-v1' as const,
        proof: 'linked-original-account-transactions' as const,
        pool, observedAt: request.observedAt, applicableAt: request.cutoffAt,
        observedHead: head, applicable: current, successor: next ?? null, intervening,
      };
      const id = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
      return { status: 'available', evidence: freeze({ ...contents, id }) };
    }
    intervening.push(current);
    if (current.prevTransactionLt === '0') return unavailable('pool_cutoff_state_uncovered');
    const prior: RawTransaction | undefined = originals.get(current.prevTransactionLt!);
    if (!prior) return unavailable(oldestLt !== null && oldestLt < BigInt(current.prevTransactionLt!)
      ? 'pool_cutoff_history_gap' : 'pool_cutoff_state_uncovered');
    if (prior.hash !== current.prevTransactionHash || BigInt(prior.lt) >= BigInt(current.lt))
      return unavailable('pool_cutoff_history_gap');
    current = prior;
  }
  return unavailable('pool_cutoff_state_uncovered');
}
