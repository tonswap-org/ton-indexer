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
import { T3EvidenceError, t3DepositRequests, type readT3OperationRequest } from './t3OperationRequest';

export const T3_EVIDENCE_LIMITS = Object.freeze({ receiptCandidates: 32, relatedTransactions: 256, responseBytes: 8 * 1024 * 1024,
  hubHistory: 10_000, newTransactions: 64, relatedAccounts: 16 });
export type CurrentT3OperationEvidence = { schema: 'tonswap-t3-operation-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'mint' | 'pair' | 'swap' | 'redeem'; owner: string; bodyHash: string }; coverage: { complete: boolean; gaps: PhysicalGap[] };
  hub: { address: string; codeBoc: string; dataBoc: string }; receipts: CurrentT3ReceiptCandidate[]; transactions: OrderTransactionEvidence[] };
const identity = (boundary: PhysicalBoundary) => {
  const row = verifyOrderTransaction(boundary.evidence); return `${boundary.evidence.account}:${row.tx.lt}:${row.hash}`;
};
/** Membership candidates and original physical boundaries only. This service
 * never converts receipt status, counters or logs into a cash conclusion. */
export async function collectT3OperationEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readT3OperationRequest>, signal?: AbortSignal): Promise<CurrentT3OperationEvidence> {
  const { request } = parsed, deposits = t3DepositRequests(parsed), limits = T3_EVIDENCE_LIMITS;
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
  for (const { request: deposit } of deposits) {
    const sourceRoot = deposit.kind !== 'redeem' ? deposit.collateralRoot : binding.hub;
    const sourceAddress = deposit.kind !== 'redeem' ? deposit.sourceWallet : deposit.wallet;
    const selectedWallet = await createJettonWalletReader({ source, tokens }).wallet(sourceRoot, deposit.owner, { at: head, signal });
    if (selectedWallet.status === 'unavailable') throw new T3EvidenceError(503, 'upstream_unavailable');
    if (selectedWallet.wallet !== sourceAddress) throw new T3EvidenceError(400, 'bad_request');
  }
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
  const candidates = reconstructed.trees.flatMap(tree => tree.records).filter(candidate => deposits.some(({ request: deposit, intent }) => {
    const wantedSlot = deposit.kind !== 'redeem' ? deposit.input : 3;
    if (candidate.owner !== deposit.owner || candidate.slot !== wantedSlot) return false;
    const receipt = t3Receipt(candidate.slot, orderCell(candidate.recordBoc));
    return receipt.kind === 'credit' ? deposit.kind !== 'redeem' && receipt.credit.queryId.toString() === deposit.queryId
      && receipt.credit.amount.toString() === deposit.amountRaw && receipt.credit.intent.equals(intent)
      : deposit.kind === 'redeem' && receipt.attempt.queryId.toString() === deposit.queryId
      && receipt.attempt.amount.toString() === deposit.amountRaw && !!receipt.attempt.customPayload?.equals(intent);
  }));
  if (candidates.length > limits.receiptCandidates) gaps.push({ code: 'receipt_candidate_limit', account: binding.hub });
  response.receipts = candidates.slice(0, limits.receiptCandidates);
  let remainingRelatedReads: number = limits.relatedTransactions;
  const accountHistory = new Map<string, PhysicalBoundary[]>([[binding.hub, hubHistory.rows]]);
  const pending: PhysicalBoundary[] = [], selected = new Map<string, PhysicalBoundary>(), origins: PhysicalBoundary[] = [];
  for (const { request: deposit, body } of deposits) {
    if((deposit.kind==='pair'||deposit.kind==='swap')&&!deposit.dispatch)continue;
    const sourceAddress = deposit.kind !== 'redeem' ? deposit.sourceWallet : deposit.wallet;
    const isOrigin = (boundary: PhysicalBoundary) => {
      const row = verifyOrderTransaction(boundary.evidence); if (!row.incoming) return false;
      if((deposit.kind==='pair'||deposit.kind==='swap')&&(row.tx.lt.toString()!==deposit.dispatch?.lt||row.hash!==deposit.dispatch?.hash))return false;
      const message = loadMessage(row.incoming.beginParse());
      return message.info.type === 'internal' && message.info.src.toRawString() === deposit.owner && !message.info.bounced
        && message.body.equals(body) && (deposit.kind === 'redeem' || message.info.value.coins.toString() === deposit.valueNano);
    };
    if (remainingRelatedReads <= 0) { gaps.push({ code: 'related_transaction_limit', account: sourceAddress }); continue; }
    const sourceState = await reader.current(sourceAddress);
    const history = await reader.history(sourceAddress, sourceState, remainingRelatedReads, isOrigin);
    remainingRelatedReads -= history.rows.length; accountHistory.set(sourceAddress, history.rows); gaps.push(...history.gaps);
    const origin = history.rows.find(isOrigin);
    if (origin) { origins.push(origin); pending.push(origin); }
    else gaps.push({ code: 'original_request_unobserved', account: sourceAddress });
  }
  if (!origins.length) return finish();
  const originLt = origins.reduce((lt, row) => { const next = verifyOrderTransaction(row.evidence).tx.lt; return next < lt ? next : lt; }, verifyOrderTransaction(origins[0].evidence).tx.lt);
  if (request.kind === 'pair' || request.kind === 'swap') {
    // New basket operations bind each original source hop to the full original
    // owner message. Query IDs or notification receipts are never that authority.
    const matches = (owner: PhysicalBoundary, origin: PhysicalBoundary) => {
      const a = verifyOrderTransaction(owner.evidence), b = verifyOrderTransaction(origin.evidence);
      return b.tx.lt > a.tx.lt && b.incoming && a.outgoing.values().some(raw => canonicalPhysicalMessage(raw).equals(canonicalPhysicalMessage(b.incoming!)));
    };
    if (remainingRelatedReads <= 0) gaps.push({ code: 'related_transaction_limit', account: request.owner });
    else {
      const seen: PhysicalBoundary[] = [];
      const history = await reader.history(request.owner, await reader.current(request.owner), remainingRelatedReads, row => {
        seen.push(row); return origins.every(origin => seen.some(owner => matches(owner, origin)));
      });
      remainingRelatedReads -= history.rows.length; accountHistory.set(request.owner, history.rows); gaps.push(...history.gaps);
      for (const origin of origins) {
        const owners = history.rows.filter(owner => matches(owner, origin));
        if (owners.length === 1) selected.set(identity(owners[0]), owners[0]);
        else gaps.push({ code: 'original_owner_dispatch_unavailable', account: request.owner });
      }
    }
  }
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
