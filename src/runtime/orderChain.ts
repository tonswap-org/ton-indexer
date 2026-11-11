import { Cell, loadMessage } from '@ton/core';
import { ChainReadError, type ChainHead, type ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { findTransactionState } from '../ledger/archive';
import { orderHash, type OrderGap, type OrderRelease } from '../orders/discovery';
import { orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { buildOpenOrderSnapshot, type CurrentOrderAccount, type OpenOrderSnapshot, type OrderHead } from '../orders/openOrders';
import type { OrderStore } from './orderStore';

export const ORDER_COLLECTION_LIMITS = Object.freeze({ newTransactions: 64, historyTransactions: 10_000, accounts: 256 });
const asOf = (head: ChainHead): OrderHead => ({ masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex });
const hex = (value: bigint) => value.toString(16).padStart(64, '0');

/** Current account envelopes and original transaction boundaries come only from
 * ChainSource's authenticated lite/archive path. Persisted transaction evidence
 * is immutable; every current account and masterchain boundary is read afresh. */
export async function collectCurrentOrders(source: ChainSource, release: OrderRelease, store: OrderStore,
  options: { signal?: AbortSignal; now?: () => number; limits?: { newTransactions: number; historyTransactions: number; accounts: number } } = {}): Promise<OpenOrderSnapshot> {
  const now = options.now ?? Date.now, limits = options.limits ?? ORDER_COLLECTION_LIMITS;
  if (`ton:${source.network}` !== release.network) throw new ChainReadError('upstream_unavailable');
  const head = await source.head({ signal: options.signal }); assertFreshHeadTime(head.utime, now());
  const boundary = asOf(head), gaps: OrderGap[] = []; let remaining = limits.newTransactions;
  const current = async (address: string): Promise<CurrentOrderAccount> => {
    options.signal?.throwIfAborted();
    const state = await source.getAccountState(address, { at: head, signal: options.signal });
    const boc = state.shardAccountBoc;
    if (!boc || !state.anchor || state.anchor.genUtime > head.utime) throw new ChainReadError('upstream_unavailable');
    const shard = orderShard(boc, address).shard;
    if (state.lastTxLt !== shard.lastTransactionLt.toString() || !state.lastTxHash
      || Buffer.from(state.lastTxHash, /^[0-9a-f]{64}$/i.test(state.lastTxHash) ? 'hex' : 'base64').toString('hex') !== hex(shard.lastTransactionHash))
      throw new ChainReadError('upstream_unavailable');
    return { address, asOf: { ...boundary }, shardAccountBoc: boc };
  };
  const history = async (account: CurrentOrderAccount): Promise<OrderTransactionEvidence[]> => {
    const rows: OrderTransactionEvidence[] = [], shard = orderShard(account.shardAccountBoc, account.address).shard;
    let lt = shard.lastTransactionLt, hash = hex(shard.lastTransactionHash), expected = orderCell(account.shardAccountBoc);
    while (lt > 0n && rows.length < limits.historyTransactions) {
      options.signal?.throwIfAborted();
      try {
        let evidence = await store.evidence(account.address, lt.toString(), hash);
        if (!evidence) {
          if (remaining <= 0) { gaps.push({ code: 'archive_work_limit', account: account.address, lt: lt.toString() }); break; }
          remaining--;
          const cursor = { lt: lt.toString(), hash: Buffer.from(hash, 'hex').toString('base64') };
          const page = await source.getTransactions(account.address, 1, cursor.lt, cursor.hash, { signal: options.signal });
          if (page.length !== 1 || !page[0].rawBoc || Cell.fromBase64(page[0].rawBoc).hash().toString('hex') !== hash)
            throw new ChainReadError('upstream_unavailable');
          const located = await findTransactionState(source, account.address, cursor, head.seqno, { signal: options.signal });
          if (!located) throw new ChainReadError('upstream_unavailable');
          const exact = located.state.replayBoundary ? located.state
            : await source.getAccountStateAtTransaction(account.address, cursor, located.seqno, { signal: options.signal });
          const proof = exact.replayBoundary;
          if (!proof || !orderCell(proof.transactionBoc).equals(orderCell(page[0].rawBoc))) throw new ChainReadError('upstream_unavailable');
          evidence = { account: account.address, transactionBoc: proof.transactionBoc,
            beforeShardAccountBoc: proof.beforeShardAccountBoc, afterShardAccountBoc: proof.afterShardAccountBoc };
          verifyOrderTransaction(evidence);
          if (!orderCell(evidence.afterShardAccountBoc).equals(expected)) throw new ChainReadError('upstream_unavailable');
          await store.retain(evidence, located.seqno);
        }
        const verified = verifyOrderTransaction(evidence);
        if (verified.tx.lt !== lt || verified.hash !== hash || verified.tx.now > head.utime
          || !orderCell(evidence.afterShardAccountBoc).equals(expected)) throw new ChainReadError('upstream_unavailable');
        rows.push(evidence); lt = verified.tx.prevTransactionLt; hash = hex(verified.tx.prevTransactionHash);
        expected = orderCell(evidence.beforeShardAccountBoc);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        gaps.push({ code: 'archive_evidence_unavailable', account: account.address, lt: lt.toString() }); break;
      }
    }
    if (lt > 0n && rows.length >= limits.historyTransactions) gaps.push({ code: 'archive_history_limit', account: account.address, lt: lt.toString() });
    return rows;
  };
  const factoryCurrent = await current(release.factory), factoryHistory = await history(factoryCurrent);
  const candidates = new Set<string>();
  for (const row of factoryHistory) {
    const tx = verifyOrderTransaction(row);
    for (const raw of tx.outgoing.values()) {
      const message = loadMessage(raw.beginParse());
      if (message.info.type !== 'internal' || message.info.src.toRawString() !== release.factory || message.info.dest.workChain !== 0
        || message.body.bits.length < 32 || message.body.beginParse().preloadUint(32) !== 0x4f494e49) continue;
      if (candidates.size >= limits.accounts && !candidates.has(message.info.dest.toRawString())) {
        gaps.push({ code: 'order_account_limit', account: release.factory }); continue;
      }
      candidates.add(message.info.dest.toRawString());
    }
  }
  const accounts: CurrentOrderAccount[] = [], childHistory: OrderTransactionEvidence[] = [];
  for (const address of candidates) {
    try { const account = await current(address); accounts.push(account); childHistory.push(...await history(account)); }
    catch (error) { if (options.signal?.aborted) throw error; gaps.push({ code: 'current_order_unavailable', account: address }); }
  }
  assertFreshHeadTime(head.utime, now());
  const snapshot = buildOpenOrderSnapshot(release, boundary, { factoryCurrent, factoryHistory, accounts, childHistory }, now());
  if (!gaps.length) return snapshot;
  const { snapshotId: omitted, ...content } = snapshot;
  const unique = new Map([...content.coverage.gaps, ...gaps].map(gap => [JSON.stringify(gap), gap]));
  content.coverage = { ...content.coverage, complete: false, gaps: [...unique.values()] };
  return { ...content, snapshotId: orderHash(content) };
}
