import { Address, beginCell } from '@ton/core';
import type { ChainHead } from '../data/dataSource';
import { reconstructCurrentT3WalletClaims, type CurrentT3WalletClaim, type CurrentT3WalletClaimsResult } from '../ledger/currentT3Receipts';
import { currentT3WalletAddress, readCurrentT3Wallet } from '../ledger/currentT3State';
import { canonicalLedgerHash } from '../ledger/normalize';
import { t3Attempt, t3Delivery } from '../ledger/currentT3Wire';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState, boundaryTransaction, canonicalPhysicalMessage, type createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalGap } from './physicalEvidence';
import { ProductEvidenceError } from './productEvidence';
export type SelectedCurrentWalletClaims = Omit<Extract<CurrentT3WalletClaimsResult, { status: 'ok' }>, 'status' | 'wallet' | 'owner' | 'records'> & {
  records: Array<CurrentT3WalletClaim & { transferTransaction: OrderTransactionEvidence }>;
};
export type CurrentWalletClaimSelection = { wallet: { address: string; codeBoc: string; dataBoc: string }; claims: SelectedCurrentWalletClaims; gaps: PhysicalGap[]; historyRows: number };
const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');
/** Reconstruct one current sparse tree from complete original history, then
 * select only original causal non-burn debits with immutable recipients/terms.
 * Callers own the aggregate graph/history/candidate/response budgets. */
export async function collectCurrentWalletClaimSelection(input: {
  binding: { hub: string; walletCodeHash: string; proofCodeHash: string }; head: ChainHead;
  reader: ReturnType<typeof createPhysicalEvidenceReader>; address: string; owner: string; recipient?: string;
  causal: readonly PhysicalBoundary[]; historyLimit: number; signal?: AbortSignal;
}): Promise<CurrentWalletClaimSelection> {
  const { binding, reader, head, owner, address, signal } = input; signal?.throwIfAborted();
  const currentState = await reader.current(address), active = activeOrderAccount(orderShard(currentState.shardAccountBoc!, address).shard, binding.walletCodeHash);
  const current = readCurrentT3Wallet(active.data);
  if (current.owner !== owner || current.master !== binding.hub || current.proofCodeHash !== binding.proofCodeHash
    || currentT3WalletAddress(Address.parse(owner), Address.parse(binding.hub), binding.proofCodeHash, active.code) !== address) throw unavailable();
  const hex = (n: bigint) => n.toString(16).padStart(64, '0');
  const result: CurrentWalletClaimSelection = { wallet: { address, codeBoc: active.code.toBoc().toString('base64'), dataBoc: active.data.toBoc().toString('base64') },
    claims: { root: hex(current.root), count: String(current.nextId), records: [], failureRoot: hex(current.failureRoot), failureCount: String(current.failureCount), failures: [] }, gaps: [], historyRows: 0 };
  if (input.historyLimit <= 0) { result.gaps.push({ code: 'wallet_history_limit', account: address }); return result; }
  const history = await reader.history(address, currentState, input.historyLimit); result.historyRows = history.rows.length; result.gaps.push(...history.gaps);
  if (!history.complete) { result.gaps.push({ code: 'wallet_history_incomplete', account: address }); return result; }
  const states = new Map<string, ReturnType<typeof boundaryState>>(), key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const row of history.rows) for (const boc of [row.evidence.beforeShardAccountBoc, row.evidence.afterShardAccountBoc]) {
    const state = boundaryState(address, boc, row.seqno), k = key(address, state.state.lastTxLt!, state.state.lastTxHash!), prior = states.get(k);
    if (prior && prior.state.shardAccountBoc !== state.state.shardAccountBoc) throw unavailable();
    if (!prior || state.seqno < prior.seqno) states.set(k, state);
  }
  const claims = await reconstructCurrentT3WalletClaims({ binding, wallet: address, owner, transactions: history.rows.map(boundaryTransaction),
    currentState: { seqno: head.seqno, state: currentState }, stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null,
    maxTransactions: input.historyLimit, signal });
  if (claims.status !== 'ok') { result.gaps.push({ code: 'wallet_claim_history_unavailable', account: address }); return result; }
  const checked = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
  const tx = (r: PhysicalBoundary) => { let v = checked.get(r); if (!v) { v = verifyOrderTransaction(r.evidence); checked.set(r, v); } return v; };
  const records: SelectedCurrentWalletClaims['records'] = [];
  for (const record of claims.records) {
    signal?.throwIfAborted(); const attempt = t3Attempt(orderCell(record.recordBoc).refs[0]);
    if (record.burn || record.owner !== owner || input.recipient !== undefined && attempt.recipient !== input.recipient || record.cancelled
      || !record.failed && !claims.failures.some(f => f.attemptHash === attempt.cell.hash().toString('hex'))) continue;
    const original = input.causal.find(r => r.evidence.account === address && String(tx(r).tx.lt) === record.originLt); if (!original) continue;
    try {
      const o = tx(original), incoming = o.tx.inMessage;
      const emitters = input.causal.filter(r => r.evidence.account === owner && tx(r).succeeded && tx(r).tx.lt < o.tx.lt && o.incoming
        && [...tx(r).outgoing.values()].some(m => canonicalPhysicalMessage(m).equals(canonicalPhysicalMessage(o.incoming!))));
      if (!o.succeeded || incoming?.info.type !== 'internal' || incoming.info.bounced || incoming.info.src.toRawString() !== owner || emitters.length !== 1) throw unavailable();
      const initial = boundaryTransaction(original).outMessages.map(t3Delivery).find(a => a && a.id === attempt.id && a.originLt === attempt.originLt && a.attempt === 0n);
      if (!initial || initial.burn || initial.owner !== owner || initial.recipient !== attempt.recipient || initial.amount !== attempt.amount
        || !initial.cell.refs[0].refs[0].equals(attempt.cell.refs[0].refs[0])) throw unavailable();
      const b = incoming.body.beginParse();
      if (b.loadUint(32) !== 0x0f8a7ea5 || b.loadUintBig(64) !== initial.queryId || b.loadCoins() !== initial.amount || b.loadAddress().toRawString() !== initial.recipient
        || (b.loadMaybeAddress()?.toRawString() ?? null) !== initial.response) throw unavailable();
      const custom = b.loadMaybeRef();
      if ((custom === null) !== (initial.customPayload === null) || custom && !custom.equals(initial.customPayload!) || b.loadCoins() !== initial.forwardValue
        || !beginCell().storeSlice(b).endCell().equals(initial.forwardPayload)) throw unavailable();
      if (b.loadBit()) { b.loadRef(); b.endParse(); }
      const before = readCurrentT3Wallet(activeOrderAccount(o.before, binding.walletCodeHash).data), after = readCurrentT3Wallet(activeOrderAccount(o.after, binding.walletCodeHash).data);
      for (const s of [before, after]) if (s.owner !== owner || s.master !== binding.hub || s.proofCodeHash !== binding.proofCodeHash) throw unavailable();
      if (before.balance - after.balance !== initial.amount) throw unavailable();
      records.push({ ...record, transferTransaction: original.evidence });
    } catch (error) { if (signal?.aborted) throw error; result.gaps.push({ code: 'original_causal_transfer_unavailable', account: address, lt: record.originLt }); }
  }
  const hashes = new Set(records.map(r => orderCell(r.recordBoc).refs[0].hash().toString('hex')));
  result.claims = { root: claims.root, count: claims.count, records, failureRoot: claims.failureRoot, failureCount: claims.failureCount, failures: claims.failures.filter(f => hashes.has(f.attemptHash)) };
  return result;
}
