import type {
  AccountStateResponse,
  ChainSource,
  TransactionCursor,
} from '../data/dataSource';
import { canonicalLedgerHash } from './normalize';

export type LedgerStateSnapshot = {
  seqno: number;
  state: AccountStateResponse;
};
type ArchiveSource = Pick<ChainSource, 'head' | 'getAccountStateAtSeqno' | 'getAccountStateAtTransaction' | 'getMasterchainSeqnoAtTime'>;
const unavailable = new WeakMap<ArchiveSource, Map<string, { seqno: number; expiresAt: number }>>();
/** A boundary is usable only if its account last-transaction hash is exact.
 * Intermediate states require authenticated replay, never interpolation. */
export async function findTransactionState(
  source: ArchiveSource,
  account: string,
  cursor: TransactionCursor,
  headSeqno?: number,
  options: { signal?: AbortSignal; transactionTime?: number } = {},
): Promise<LedgerStateSnapshot | null> {
  if (!/^(0|[1-9][0-9]*)$/.test(cursor.lt))
    return null;
  try {
    options.signal?.throwIfAborted();
    const head = headSeqno ?? (await source.head(options)).seqno;
    let misses = unavailable.get(source);
    if (!misses) unavailable.set(source, misses = new Map());
    const read = async (seqno: number, cursor?: TransactionCursor) => {
      options.signal?.throwIfAborted();
      const miss = misses!.get(account);
      // This cache is a temporary inability to read, never authenticated absence.
      if (miss && miss.expiresAt > Date.now() && seqno <= miss.seqno) throw Error('archive_temporarily_unavailable');
      try {
        return cursor ? await source.getAccountStateAtTransaction(account, cursor, seqno, options)
          : await source.getAccountStateAtSeqno(account, seqno, options);
      } catch (error) {
        // A caller-selected exact replay failure cannot establish an account-wide
        // outage. Only a seqno account-state read may start this shared cooldown.
        if (!cursor && !options.signal?.aborted) {
          if (misses!.size >= 4096) misses!.delete(misses!.keys().next().value!);
          misses!.set(account, { seqno: miss && miss.expiresAt > Date.now() ? Math.max(miss.seqno, seqno) : seqno,
            expiresAt: Date.now() + 60_000 });
        }
        throw error;
      }
    };
    if (!Number.isSafeInteger(head) || head < 0) return null;
    if (cursor.lt === '0') {
      let low = 0, high = head;
      let candidate: LedgerStateSnapshot | null = null;
      // Explicit authenticated absence before the first transaction, shared by
      // owner and market projections. No active state is interpolated to zero.
      if (Buffer.from(canonicalLedgerHash(cursor.hash), 'base64').some(byte => byte !== 0)) return null;
      while (low <= high) {
        const seqno = Math.floor((low + high) / 2), state = await read(seqno);
        if (state.lastTxLt === '0') { candidate = {seqno, state}; low = seqno + 1; }
        else high = seqno - 1;
      }
      return candidate?.state.accountState === 'uninitialized' && !candidate.state.codeBoc && !candidate.state.dataBoc &&
        candidate.state.lastTxHash && canonicalLedgerHash(candidate.state.lastTxHash) === canonicalLedgerHash(cursor.hash) ? candidate : null;
    }
    const target = BigInt(cursor.lt);
    // Without a timestamp hint, recent transactions only need the recent archive.
    let start = head;
    if (options.transactionTime !== undefined && source.getMasterchainSeqnoAtTime) {
      const hint = await source.getMasterchainSeqnoAtTime(options.transactionTime, options).catch(() => undefined);
      if (hint !== undefined && Number.isSafeInteger(hint) && hint > 0 && hint <= head) start = hint;
    }
    let high = start, low = 0;
    let candidate: LedgerStateSnapshot | null = { seqno: start, state: await read(start) };
    // A shard transaction can appear in a later masterchain block. Expand in
    // either direction from the time hint, always inside the captured head.
    if (BigInt(candidate.state.lastTxLt ?? '0') < target) {
      for (let distance = 1; high < head; distance *= 2) {
        low = high + 1; high = Math.min(head, start + distance);
        candidate = { seqno: high, state: await read(high) };
        if (BigInt(candidate.state.lastTxLt ?? '0') >= target) break;
      }
      if (BigInt(candidate.state.lastTxLt ?? '0') < target) return null;
    } else {
      for (let distance = 1; high > 0; distance *= 2) {
        const seqno = Math.max(0, start - distance);
        const state = await read(seqno);
        if (BigInt(state.lastTxLt ?? '0') < target) { low = seqno + 1; break; }
        candidate = { seqno, state };
        high = seqno;
        if (seqno === 0) break;
      }
    }
    while (low < high) {
      const seqno = Math.floor((low + high) / 2);
      const state = await read(seqno);
      if (BigInt(state.lastTxLt ?? '0') >= target) {
        candidate = { seqno, state };
        high = seqno;
      } else low = seqno + 1;
    }
    if (candidate && BigInt(candidate.state.lastTxLt ?? '0') > BigInt(cursor.lt)) {
      candidate = {
        seqno: candidate.seqno,
        state: await read(candidate.seqno, cursor),
      };
    }
    if (
      candidate?.state.lastTxLt !== cursor.lt ||
      !candidate.state.lastTxHash ||
      canonicalLedgerHash(candidate.state.lastTxHash) !==
        canonicalLedgerHash(cursor.hash)
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}
