import { loadMessage } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { deriveT3RedemptionBinding } from '../ledger/runtimeT3Binding';
import { reconstructCurrentT3Receipts, type CurrentT3ReceiptCandidate } from '../ledger/currentT3Receipts';
import { t3Receipt, t3ReceiptLog } from '../ledger/currentT3Wire';
import { readCurrentT3Hub } from '../ledger/currentT3State';
import { canonicalLedgerHash } from '../ledger/normalize';
import { orderCell, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState, boundaryTransaction, canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { T3EvidenceError, type readT3OperationRequest } from './t3OperationRequest';

export const T3_EVIDENCE_LIMITS = Object.freeze({ receiptCandidates: 32, relatedTransactions: 256, responseBytes: 8 * 1024 * 1024,
  hubHistory: 10_000, newTransactions: 64, relatedAccounts: 16 });
export type CurrentT3OperationEvidence = { schema: 'tonswap-t3-operation-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'mint' | 'redeem'; owner: string; bodyHash: string }; coverage: { complete: boolean; gaps: PhysicalGap[] };
  hub: { address: string; codeBoc: string; dataBoc: string }; receipts: CurrentT3ReceiptCandidate[]; transactions: OrderTransactionEvidence[] };
const identity = (boundary: PhysicalBoundary) => {
  const row = verifyOrderTransaction(boundary.evidence); return `${boundary.evidence.account}:${row.tx.lt}:${row.hash}`;
};
/** Membership candidates and original physical boundaries only. This service
 * never converts receipt status, counters or logs into a cash conclusion. */
export async function collectT3OperationEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readT3OperationRequest>, signal?: AbortSignal): Promise<CurrentT3OperationEvidence> {
  const { request, body, intent } = parsed, limits = T3_EVIDENCE_LIMITS;
  if (`ton:${source.network}` !== manifest.network) throw new T3EvidenceError(503, 'upstream_unavailable');
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const binding = await deriveT3RedemptionBinding(manifest, source, { at: head, signal });
  if (!binding) throw new T3EvidenceError(503, 'upstream_unavailable');
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  const hubState = await reader.current(binding.hub);
  if (!hubState.codeBoc || !hubState.dataBoc || orderCell(hubState.codeBoc).hash().toString('hex') !== binding.hubCodeHash
    || readCurrentT3Hub(hubState.dataBoc).configHash !== binding.configHash) throw new T3EvidenceError(503, 'upstream_unavailable');
  const response: CurrentT3OperationEvidence = { schema: 'tonswap-t3-operation-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    request: { kind: request.kind, owner: request.owner, bodyHash: request.bodyHash }, coverage: { complete: false, gaps: [] },
    hub: { address: binding.hub, codeBoc: hubState.codeBoc, dataBoc: hubState.dataBoc }, receipts: [], transactions: [] };
  const gaps = response.coverage.gaps;
  const finish = () => {
    assertFreshHeadTime(head.utime); signal?.throwIfAborted();
    const unique = new Map(gaps.map(gap => [JSON.stringify(gap), gap])); response.coverage.gaps = [...unique.values()];
    response.coverage.complete = response.coverage.gaps.length === 0;
    if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) {
      response.coverage.complete = false; response.coverage.gaps.push({ code: 'response_size_limit', account: binding.hub });
      // Never return a truncated complete publication. Preserve the current hub
      // and explicit gap, then remove bounded candidate/physical rows if needed.
      while (response.transactions.length && Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) response.transactions.pop();
      while (response.receipts.length && Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) response.receipts.pop();
      if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) throw new T3EvidenceError(503, 'upstream_unavailable');
    }
    return response;
  };
  const tokens = manifest.tokens.map(token => ({ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash }));
  const sourceRoot = request.kind === 'mint' ? request.collateralRoot : binding.hub;
  const sourceAddress = request.kind === 'mint' ? request.sourceWallet : request.wallet;
  const selectedWallet = await createJettonWalletReader({ source, tokens }).wallet(sourceRoot, request.owner, { at: head, signal });
  if (selectedWallet.status === 'unavailable') throw new T3EvidenceError(503, 'upstream_unavailable');
  if (selectedWallet.wallet !== sourceAddress) throw new T3EvidenceError(400, 'bad_request');
  const hubHistory = await reader.history(binding.hub, hubState, limits.hubHistory); gaps.push(...hubHistory.gaps);
  if (!hubHistory.complete) { gaps.push({ code: 'hub_history_incomplete', account: binding.hub }); return finish(); }
  const states = new Map<string, ReturnType<typeof boundaryState>>();
  const key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const boundary of hubHistory.rows) for (const boc of [boundary.evidence.beforeShardAccountBoc, boundary.evidence.afterShardAccountBoc]) {
    const state = boundaryState(binding.hub, boc, boundary.seqno), id = key(binding.hub, state.state.lastTxLt!, state.state.lastTxHash!);
    const previous = states.get(id);
    if (previous && previous.state.shardAccountBoc !== state.state.shardAccountBoc) throw new T3EvidenceError(503, 'upstream_unavailable');
    // A shared boundary may occur before and after neighboring transactions;
    // retain the earliest authenticated containing block observation.
    if (!previous || state.seqno < previous.seqno) states.set(id, state);
  }
  const reconstructed = await reconstructCurrentT3Receipts({ binding, transactions: hubHistory.rows.map(boundaryTransaction),
    currentState: { seqno: head.seqno, state: hubState }, stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null,
    maxTransactions: limits.hubHistory, signal });
  if (reconstructed.status !== 'ok') { gaps.push({ code: 'receipt_history_unavailable', account: binding.hub }); return finish(); }
  const wantedSlot = request.kind === 'mint' ? request.input : 3;
  const candidates = reconstructed.trees.flatMap(tree => tree.records).filter(candidate => {
    if (candidate.owner !== request.owner || candidate.slot !== wantedSlot) return false;
    const receipt = t3Receipt(candidate.slot, orderCell(candidate.recordBoc));
    return receipt.kind === 'credit' ? request.kind === 'mint' && receipt.credit.queryId.toString() === request.queryId
      && receipt.credit.amount.toString() === request.amountRaw && receipt.credit.intent.equals(intent)
      : request.kind === 'redeem' && receipt.attempt.queryId.toString() === request.queryId
      && receipt.attempt.amount.toString() === request.amountRaw && !!receipt.attempt.customPayload?.equals(intent);
  });
  if (candidates.length > limits.receiptCandidates) gaps.push({ code: 'receipt_candidate_limit', account: binding.hub });
  response.receipts = candidates.slice(0, limits.receiptCandidates);
  const sourceState = await reader.current(sourceAddress);
  const isOrigin = (boundary: PhysicalBoundary) => {
    const row = verifyOrderTransaction(boundary.evidence); if (!row.incoming) return false;
    const message = loadMessage(row.incoming.beginParse());
    return message.info.type === 'internal' && message.info.src.toRawString() === request.owner && !message.info.bounced
      && message.body.equals(body) && (request.kind !== 'mint' || message.info.value.coins.toString() === request.valueNano);
  };
  const sourceHistory = await reader.history(sourceAddress, sourceState, limits.relatedTransactions, isOrigin); gaps.push(...sourceHistory.gaps);
  const origin = sourceHistory.rows.find(isOrigin);
  if (!origin) { gaps.push({ code: 'original_request_unobserved', account: sourceAddress }); return finish(); }
  const originLt = verifyOrderTransaction(origin.evidence).tx.lt;
  let remainingRelatedReads = limits.relatedTransactions - sourceHistory.rows.length;
  const accountHistory = new Map<string, PhysicalBoundary[]>([[binding.hub, hubHistory.rows], [sourceAddress, sourceHistory.rows]]);
  const pending: PhysicalBoundary[] = [origin], selected = new Map<string, PhysicalBoundary>();
  for (const candidate of response.receipts) {
    // Credit keys name the reserve-wallet receiving LT, not the hub LT. Use
    // original authenticated receipt logs and retain subsequent updates too.
    const accepted = hubHistory.rows.filter(row => boundaryTransaction(row).outMessages.some(message => {
      const receipt = t3ReceiptLog(message); return receipt?.slot === candidate.slot && receipt.key.toString() === candidate.key;
    }));
    if (accepted.length) pending.push(...accepted); else gaps.push({ code: 'receipt_transaction_unavailable', account: binding.hub });
  }
  while (pending.length) {
    signal?.throwIfAborted(); const boundary = pending.shift()!, id = identity(boundary); if (selected.has(id)) continue;
    if (selected.size >= limits.relatedTransactions) { gaps.push({ code: 'related_transaction_limit', account: boundary.evidence.account }); break; }
    selected.set(id, boundary);
    for (const raw of verifyOrderTransaction(boundary.evidence).outgoing.values()) {
      const message = loadMessage(raw.beginParse()); if (message.info.type !== 'internal') continue;
      const account = message.info.dest.toRawString();
      if (message.info.dest.workChain !== 0) { gaps.push({ code: 'related_workchain_unavailable', account }); continue; }
      let history = accountHistory.get(account);
      if (!history) {
        if (accountHistory.size >= limits.relatedAccounts) { gaps.push({ code: 'related_account_limit', account }); continue; }
        if (remainingRelatedReads <= 0) { gaps.push({ code: 'related_transaction_limit', account }); continue; }
        accountHistory.set(account, []);
        try {
          const current = await reader.current(account), collected = await reader.history(account, current, remainingRelatedReads,
            row => verifyOrderTransaction(row.evidence).tx.lt < originLt);
          remainingRelatedReads -= collected.rows.length;
          history = collected.rows; accountHistory.set(account, history); gaps.push(...collected.gaps);
          if (!collected.complete) gaps.push({ code: 'related_history_incomplete', account });
        } catch (error) {
          if (signal?.aborted) throw error; gaps.push({ code: 'related_account_unavailable', account }); continue;
        }
      }
      const matches = history.filter(row => { const tx = verifyOrderTransaction(row.evidence);
        return tx.tx.lt > verifyOrderTransaction(boundary.evidence).tx.lt && tx.incoming
          && canonicalPhysicalMessage(tx.incoming).equals(canonicalPhysicalMessage(raw)); });
      if (matches.length === 1) pending.push(matches[0]); else gaps.push({ code: matches.length ? 'ambiguous_related_transaction' : 'related_transaction_unobserved', account, lt: message.info.createdLt.toString() });
    }
  }
  response.transactions = [...selected.values()].sort((a, b) => a.evidence.account.localeCompare(b.evidence.account)
    || (verifyOrderTransaction(a.evidence).tx.lt < verifyOrderTransaction(b.evidence).tx.lt ? -1 : 1)).map(row => row.evidence);
  return finish();
}
