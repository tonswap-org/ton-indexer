import { Address, Cell, beginCell, loadCommonMessageInfo, loadStateInit, storeMessage } from '@ton/core';
import { ChainReadError, type AccountStateResponse, type ChainHead, type ChainSource } from '../data/dataSource';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { findTransactionState, type LedgerStateSnapshot } from '../ledger/archive';
import { orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import type { PostgresOrderStore } from './orderStore';

export type PhysicalGap = { code: string; account: string; lt?: string };
export type PhysicalBoundary = { evidence: OrderTransactionEvidence; seqno: number };
export type PhysicalEvidenceStore = Pick<PostgresOrderStore, 'evidenceBoundary' | 'retain'>;
export const boundaryHash = (value: bigint) => value.toString(16).padStart(64, '0');
export function boundaryState(account: string, boc: string, seqno: number): LedgerStateSnapshot {
  const shard = orderShard(boc, account).shard, storage = shard.account?.storage.state;
  const state: AccountStateResponse = { balance: shard.account?.storage.balance.coins.toString() ?? '0',
    accountState: storage?.type === 'active' ? 'active' : storage?.type === 'frozen' ? 'frozen' : 'uninitialized',
    lastTxLt: shard.lastTransactionLt.toString(), lastTxHash: Buffer.from(boundaryHash(shard.lastTransactionHash), 'hex').toString('base64'),
    shardAccountBoc: boc, codeBoc: storage?.type === 'active' ? storage.state.code?.toBoc().toString('base64') ?? null : null,
    dataBoc: storage?.type === 'active' ? storage.state.data?.toBoc().toString('base64') ?? null : null };
  return { seqno, state };
}
export const boundaryTransaction = (value: PhysicalBoundary) => decodeOriginalTransaction(orderCell(value.evidence.transactionBoc), Address.parse(value.evidence.account));
/** Preserve the complete message semantics while normalizing legal TL-B
 * inline/reference placement. Both original transaction cells remain evidence. */
export function canonicalPhysicalMessage(value: Cell): Cell {
  if (value.isExotic) throw new ChainReadError('upstream_unavailable');
  const s = value.beginParse(), info = loadCommonMessageInfo(s); let init = null;
  if (s.loadBit()) {
    if (s.loadBit()) { const cell = s.loadRef(); if (cell.isExotic) throw new ChainReadError('upstream_unavailable');
      const referenced = cell.beginParse(); init = loadStateInit(referenced); referenced.endParse(); }
    else init = loadStateInit(s);
  }
  let body: Cell;
  if (s.loadBit()) { body = s.loadRef(); s.endParse(); } else body = beginCell().storeSlice(s).endCell();
  return beginCell().store(storeMessage({ info, init, body })).endCell();
}

/** Per-request current reads, with only original immutable transaction facts
 * retained between requests. Each history is anchored to the supplied head. */
export function createPhysicalEvidenceReader(source: ChainSource, store: PhysicalEvidenceStore, head: ChainHead,
  options: { signal?: AbortSignal; newTransactions: number }) {
  let remaining = options.newTransactions;
  const current = async (account: string) => {
    options.signal?.throwIfAborted();
    const state = await source.getAccountState(account, { at: head, signal: options.signal });
    if (!state.shardAccountBoc || !state.anchor || state.anchor.genUtime > head.utime) throw new ChainReadError('upstream_unavailable');
    const shard = orderShard(state.shardAccountBoc, account).shard;
    if (state.lastTxLt !== shard.lastTransactionLt.toString() || !state.lastTxHash
      || Buffer.from(state.lastTxHash, /^[0-9a-f]{64}$/i.test(state.lastTxHash) ? 'hex' : 'base64').toString('hex') !== boundaryHash(shard.lastTransactionHash))
      throw new ChainReadError('upstream_unavailable');
    return state;
  };
  const history = async (account: string, state: AccountStateResponse, limit: number,
    stop?: (boundary: PhysicalBoundary) => boolean) => {
    if (!state.shardAccountBoc) throw new ChainReadError('upstream_unavailable');
    const shard = orderShard(state.shardAccountBoc, account).shard, rows: PhysicalBoundary[] = [], gaps: PhysicalGap[] = [];
    let lt = shard.lastTransactionLt, hash = boundaryHash(shard.lastTransactionHash), expected = orderCell(state.shardAccountBoc), stopped = false;
    while (lt > 0n && rows.length < limit) {
      options.signal?.throwIfAborted();
      if (rows.length % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); options.signal?.throwIfAborted(); }
      try {
        let boundary = await store.evidenceBoundary(account, lt.toString(), hash);
        if (!boundary) {
          if (remaining <= 0) { gaps.push({ code: 'archive_work_limit', account, lt: lt.toString() }); break; }
          remaining--;
          const cursor = { lt: lt.toString(), hash: Buffer.from(hash, 'hex').toString('base64') };
          const page = await source.getTransactions(account, 1, cursor.lt, cursor.hash, { signal: options.signal });
          if (page.length !== 1 || !page[0].rawBoc || Cell.fromBase64(page[0].rawBoc).hash().toString('hex') !== hash)
            throw new ChainReadError('upstream_unavailable');
          const located = await findTransactionState(source, account, cursor, head.seqno, { signal: options.signal });
          if (!located) throw new ChainReadError('upstream_unavailable');
          const exact = located.state.replayBoundary ? located.state : await source.getAccountStateAtTransaction(account, cursor, located.seqno, { signal: options.signal });
          const proof = exact.replayBoundary;
          if (!proof || !orderCell(proof.transactionBoc).equals(orderCell(page[0].rawBoc))) throw new ChainReadError('upstream_unavailable');
          const evidence = { account, transactionBoc: proof.transactionBoc, beforeShardAccountBoc: proof.beforeShardAccountBoc, afterShardAccountBoc: proof.afterShardAccountBoc };
          verifyOrderTransaction(evidence);
          if (!orderCell(evidence.afterShardAccountBoc).equals(expected)) throw new ChainReadError('upstream_unavailable');
          await store.retain(evidence, located.seqno); boundary = { evidence, seqno: located.seqno };
        }
        const checked = verifyOrderTransaction(boundary.evidence);
        if (checked.tx.lt !== lt || checked.hash !== hash || checked.tx.now > head.utime || boundary.seqno > head.seqno
          || !orderCell(boundary.evidence.afterShardAccountBoc).equals(expected)) throw new ChainReadError('upstream_unavailable');
        rows.push(boundary); lt = checked.tx.prevTransactionLt; hash = boundaryHash(checked.tx.prevTransactionHash);
        expected = orderCell(boundary.evidence.beforeShardAccountBoc);
        if (stop?.(boundary)) { stopped = true; break; }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        gaps.push({ code: 'archive_evidence_unavailable', account, lt: lt.toString() }); break;
      }
    }
    if (!stopped && lt > 0n && rows.length >= limit) gaps.push({ code: 'archive_history_limit', account, lt: lt.toString() });
    return { rows, gaps, complete: gaps.length === 0 && (stopped || (lt === 0n && hash === '0'.repeat(64))) };
  };
  const exact = async (account: string, lt: string, hash: string): Promise<PhysicalBoundary> => {
    options.signal?.throwIfAborted();
    if (!/^[1-9][0-9]*$/.test(lt) || !/^[0-9a-f]{64}$/.test(hash)) throw new ChainReadError('upstream_unavailable');
    let boundary = await store.evidenceBoundary(account, lt, hash);
    if (!boundary) {
      if (remaining <= 0) throw new ChainReadError('upstream_unavailable');
      remaining--;
      const cursor = { lt, hash: Buffer.from(hash, 'hex').toString('base64') };
      const located = await findTransactionState(source, account, cursor, head.seqno, { signal: options.signal });
      if (!located) throw new ChainReadError('upstream_unavailable');
      const state = located.state.replayBoundary ? located.state : await source.getAccountStateAtTransaction(account, cursor, located.seqno, { signal: options.signal });
      if (!state.replayBoundary) throw new ChainReadError('upstream_unavailable');
      boundary = { evidence: { account, ...state.replayBoundary }, seqno: located.seqno };
      const verified = verifyOrderTransaction(boundary.evidence);
      if (String(verified.tx.lt) !== lt || verified.hash !== hash || verified.tx.now > head.utime || boundary.seqno > head.seqno)
        throw new ChainReadError('upstream_unavailable');
      await store.retain(boundary.evidence, boundary.seqno);
    }
    const verified = verifyOrderTransaction(boundary.evidence);
    if (boundary.evidence.account !== account || String(verified.tx.lt) !== lt || verified.hash !== hash || verified.tx.now > head.utime || boundary.seqno > head.seqno)
      throw new ChainReadError('upstream_unavailable');
    return boundary;
  };
  return { current, history, exact };
}
