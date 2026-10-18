import { Address, beginCell } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { reconstructCurrentT3WalletClaims, type CurrentT3WalletClaim, type CurrentT3WalletClaimsResult } from '../ledger/currentT3Receipts';
import { currentT3WalletAddress, readCurrentT3Wallet } from '../ledger/currentT3State';
import { canonicalLedgerHash } from '../ledger/normalize';
import { t3Attempt, t3Delivery } from '../ledger/currentT3Wire';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState, boundaryTransaction, canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { readOptionsOperationRequest, readOptionsEvidenceContext, type CurrentOptionsEvidenceRequest } from './optionsOperationEvidence';
import { collectProductPhysicalGraph, ProductEvidenceError, PRODUCT_EVIDENCE_LIMITS } from './productEvidence';
export const OPTIONS_WALLET_CLAIM_LIMITS = Object.freeze({ history: 10000, candidates: 32, failures: 32, bytes: 8 * 1024 * 1024, newTransactions: 64 });
export const readOptionsWalletClaimRequest = readOptionsOperationRequest;
type Claims = Omit<Extract<CurrentT3WalletClaimsResult, { status: 'ok' }>, 'status' | 'wallet' | 'owner' | 'records'> & {
  records: Array<CurrentT3WalletClaim & { transferTransaction: OrderTransactionEvidence }>;
};
export type CurrentOptionsWalletClaimEvidence = {
  schema: 'tonswap-options-wallet-claim-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: CurrentOptionsEvidenceRequest['kind']; owner: string; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  wallet: { address: string; codeBoc: string; dataBoc: string }; claims: Claims;
};
const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');
/** Select only current failed vault attempts whose original debit is causally
 * linked by complete original messages to the exact saved owner operation.
 * The complete wallet history authenticates both sparse roots at the same head.
 * Witnesses authorize recovery, never a claim of physical payment. */
export async function collectOptionsWalletClaimEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readOptionsWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentOptionsWalletClaimEvidence> {
  const { request } = parsed, limits = OPTIONS_WALLET_CLAIM_LIMITS;
  const context = await readOptionsEvidenceContext(manifest, source, parsed, signal), { head, pins, completeAccounts, vaultWallet } = context;
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  const hub = manifest.contracts.T3Hub!, token = manifest.tokens.find(t => t.root === hub.address);
  if (!token || token.masterCodeHash !== hub.codeHash || token.walletCodeHash !== manifest.templates.T3Wallet) throw unavailable();
  const binding = { hub: hub.address, walletCodeHash: manifest.templates.T3Wallet, proofCodeHash: manifest.templates.T3RecoveryProof };
  const currentState = await reader.current(vaultWallet.wallet);
  if (!currentState.shardAccountBoc) throw unavailable();
  const active = activeOrderAccount(orderShard(currentState.shardAccountBoc, vaultWallet.wallet).shard, binding.walletCodeHash);
  const current = readCurrentT3Wallet(active.data), wallet = { address: vaultWallet.wallet, codeBoc: active.code.toBoc().toString('base64'), dataBoc: active.data.toBoc().toString('base64') };
  if (current.owner !== request.vault || current.master !== hub.address || current.proofCodeHash !== binding.proofCodeHash
    || currentT3WalletAddress(Address.parse(request.vault), Address.parse(hub.address), binding.proofCodeHash, active.code) !== wallet.address) throw unavailable();
  const hex = (n: bigint) => n.toString(16).padStart(64, '0');
  const response: CurrentOptionsWalletClaimEvidence = { schema: 'tonswap-options-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex }, request: { kind: request.kind, owner: request.owner, bodyHash: request.bodyHash },
    coverage: { complete: false, gaps: [] }, wallet, claims: { root: hex(current.root), count: String(current.nextId), records: [], failureRoot: hex(current.failureRoot), failureCount: String(current.failureCount), failures: [] } };
  const gaps = response.coverage.gaps;
  const finish = () => {
    signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
    response.coverage.gaps = [...new Map(gaps.map(g => [JSON.stringify(g), g])).values()]; response.coverage.complete = response.coverage.gaps.length === 0;
    if (Buffer.byteLength(JSON.stringify(response)) > limits.bytes) {
      gaps.push({ code: 'response_size_limit', account: wallet.address }); response.coverage.complete = false; response.coverage.gaps = gaps;
      response.claims.records = []; response.claims.failures = [];
      if (Buffer.byteLength(JSON.stringify(response)) > limits.bytes) throw unavailable();
    } return response;
  };
  const causal: PhysicalBoundary[] = [];
  const graph = await collectProductPhysicalGraph(source, store, head, { owner: request.owner, target: parsed.target, body: parsed.body,
    dispatch: request.dispatch, pins, completeAccounts, reader, onCausal: row => causal.push(row) }, signal);
  gaps.push(...graph.coverage.gaps); if (!graph.coverage.complete) return finish();
  // The graph can inspect unselected recipient rows; reserve its entire bounded
  // history allowance rather than counting only returned envelopes.
  const history = await reader.history(wallet.address, currentState, limits.history - PRODUCT_EVIDENCE_LIMITS.history);
  gaps.push(...history.gaps); if (!history.complete) { gaps.push({ code: 'wallet_history_incomplete', account: wallet.address }); return finish(); }
  const states = new Map<string, ReturnType<typeof boundaryState>>(), key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const row of history.rows) for (const boc of [row.evidence.beforeShardAccountBoc, row.evidence.afterShardAccountBoc]) {
    const state = boundaryState(wallet.address, boc, row.seqno), k = key(wallet.address, state.state.lastTxLt!, state.state.lastTxHash!), prior = states.get(k);
    if (prior && prior.state.shardAccountBoc !== state.state.shardAccountBoc) throw unavailable();
    if (!prior || state.seqno < prior.seqno) states.set(k, state);
  }
  const claims = await reconstructCurrentT3WalletClaims({ binding, wallet: wallet.address, owner: request.vault, transactions: history.rows.map(boundaryTransaction),
    currentState: { seqno: head.seqno, state: currentState }, stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null, maxTransactions: limits.history, signal });
  if (claims.status !== 'ok') { gaps.push({ code: 'wallet_claim_history_unavailable', account: wallet.address }); return finish(); }
  const checked = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
  const tx = (r: PhysicalBoundary) => { let v = checked.get(r); if (!v) { v = verifyOrderTransaction(r.evidence); checked.set(r, v); } return v; };
  const records: Claims['records'] = [];
  for (const record of claims.records) {
    signal?.throwIfAborted(); const attempt = t3Attempt(orderCell(record.recordBoc).refs[0]);
    if (record.burn || record.owner !== request.vault || record.cancelled || !record.failed && !claims.failures.some(f => f.attemptHash === attempt.cell.hash().toString('hex'))) continue;
    // Other current vault operations are intentionally outside this request.
    const original = causal.find(r => r.evidence.account === wallet.address && String(tx(r).tx.lt) === record.originLt); if (!original) continue;
    try {
      const o = tx(original), incoming = o.tx.inMessage;
      const emitters = causal.filter(r => r.evidence.account === request.vault && tx(r).succeeded && tx(r).tx.lt < o.tx.lt && o.incoming
        && [...tx(r).outgoing.values()].some(m => canonicalPhysicalMessage(m).equals(canonicalPhysicalMessage(o.incoming!))));
      if (!o.succeeded || incoming?.info.type !== 'internal' || incoming.info.bounced || incoming.info.src.toRawString() !== request.vault || emitters.length !== 1) throw unavailable();
      const initial = boundaryTransaction(original).outMessages.map(t3Delivery).find(a => a && a.id === attempt.id && a.originLt === attempt.originLt && a.attempt === 0n);
      // Options retries retain the original recipient as well as WalletDetails.
      if (!initial || initial.burn || initial.owner !== request.vault || initial.recipient !== attempt.recipient || initial.amount !== attempt.amount
        || !initial.cell.refs[0].refs[0].equals(attempt.cell.refs[0].refs[0])) throw unavailable();
      const b = incoming.body.beginParse();
      if (b.loadUint(32) !== 0x0f8a7ea5 || b.loadUintBig(64) !== initial.queryId || b.loadCoins() !== initial.amount || b.loadAddress().toRawString() !== initial.recipient
        || (b.loadMaybeAddress()?.toRawString() ?? null) !== initial.response) throw unavailable();
      const custom = b.loadMaybeRef();
      if ((custom === null) !== (initial.customPayload === null) || custom && !custom.equals(initial.customPayload!) || b.loadCoins() !== initial.forwardValue
        || !beginCell().storeSlice(b).endCell().equals(initial.forwardPayload)) throw unavailable();
      if (b.loadBit()) { b.loadRef(); b.endParse(); }
      const before = readCurrentT3Wallet(activeOrderAccount(o.before, binding.walletCodeHash).data), after = readCurrentT3Wallet(activeOrderAccount(o.after, binding.walletCodeHash).data);
      for (const s of [before, after]) if (s.owner !== request.vault || s.master !== hub.address || s.proofCodeHash !== binding.proofCodeHash) throw unavailable();
      if (before.balance - after.balance !== initial.amount) throw unavailable();
      records.push({ ...record, transferTransaction: original.evidence });
    } catch { gaps.push({ code: 'original_vault_transfer_unavailable', account: wallet.address, lt: record.originLt }); }
  }
  if (records.length > limits.candidates) { gaps.push({ code: 'wallet_claim_candidate_limit', account: wallet.address }); return finish(); }
  const hashes = new Set(records.map(r => orderCell(r.recordBoc).refs[0].hash().toString('hex'))), failures = claims.failures.filter(f => hashes.has(f.attemptHash));
  if (failures.length > limits.failures) { gaps.push({ code: 'wallet_failure_candidate_limit', account: wallet.address }); return finish(); }
  if (gaps.length) return finish();
  response.claims = { root: claims.root, count: claims.count, records, failureRoot: claims.failureRoot, failureCount: claims.failureCount, failures };
  return finish();
}
