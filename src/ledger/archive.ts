import type {
  AccountStateResponse,
  TonDataSource,
  TransactionCursor,
} from '../data/dataSource';
import { canonicalLedgerHash } from './normalize';

export type LedgerStateSnapshot = {
  seqno: number;
  state: AccountStateResponse;
};
/** A boundary is usable only if its account last-transaction hash is exact.
 * Intermediate states require authenticated replay, never interpolation. */
export async function findTransactionState(
  source: TonDataSource,
  account: string,
  cursor: TransactionCursor,
  headSeqno?: number,
): Promise<LedgerStateSnapshot | null> {
  if (!source.getAccountStateAtSeqno || !/^(0|[1-9][0-9]*)$/.test(cursor.lt))
    return null;
  try {
    const head = headSeqno ?? (await source.getMasterchainInfo()).seqno;
    if (!Number.isSafeInteger(head) || head < 0) return null;
    if (cursor.lt === '0') {
      let low = 0, high = head;
      let candidate: LedgerStateSnapshot | null = null;
      // Explicit authenticated absence before the first transaction, shared by
      // owner and market projections. No active state is interpolated to zero.
      if (Buffer.from(canonicalLedgerHash(cursor.hash), 'base64').some(byte => byte !== 0)) return null;
      while (low <= high) {
        const seqno = Math.floor((low + high) / 2), state = await source.getAccountStateAtSeqno(account, seqno);
        if (state.lastTxLt === '0') { candidate = {seqno, state}; low = seqno + 1; }
        else high = seqno - 1;
      }
      return candidate?.state.accountState === 'uninitialized' && !candidate.state.codeBoc && !candidate.state.dataBoc &&
        candidate.state.lastTxHash && canonicalLedgerHash(candidate.state.lastTxHash) === canonicalLedgerHash(cursor.hash) ? candidate : null;
    }
    const target = BigInt(cursor.lt);
    // Bracket from the recent head. A recent transaction must not require an
    // unrelated ancient archive merely because the chain is many years old.
    let high = head, low = 0;
    let candidate: LedgerStateSnapshot | null = { seqno: head, state: await source.getAccountStateAtSeqno(account, head) };
    if (BigInt(candidate.state.lastTxLt ?? '0') < target) return null;
    for (let distance = 1; high > 0; distance *= 2) {
      const seqno = Math.max(0, head - distance);
      const state = await source.getAccountStateAtSeqno(account, seqno);
      if (BigInt(state.lastTxLt ?? '0') < target) { low = seqno + 1; break; }
      candidate = { seqno, state };
      high = seqno;
      if (seqno === 0) break;
    }
    while (low < high) {
      const seqno = Math.floor((low + high) / 2);
      const state = await source.getAccountStateAtSeqno(account, seqno);
      if (BigInt(state.lastTxLt ?? '0') >= target) {
        candidate = { seqno, state };
        high = seqno;
      } else low = seqno + 1;
    }
    if (candidate && BigInt(candidate.state.lastTxLt ?? '0') > BigInt(cursor.lt) &&
        source.getAccountStateAtTransaction) {
      candidate = {
        seqno: candidate.seqno,
        state: await source.getAccountStateAtTransaction(account, cursor, candidate.seqno),
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
