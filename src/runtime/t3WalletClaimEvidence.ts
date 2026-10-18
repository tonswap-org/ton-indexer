import { Address, loadMessage } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { reconstructCurrentT3WalletClaims, type CurrentT3WalletClaimsResult } from '../ledger/currentT3Receipts';
import { currentT3WalletAddress, readCurrentT3Wallet } from '../ledger/currentT3State';
import { t3Attempt } from '../ledger/currentT3Wire';
import { canonicalLedgerHash } from '../ledger/normalize';
import { orderCell, verifyOrderTransaction } from '../orders/evidence';
import { boundaryState, boundaryTransaction, createPhysicalEvidenceReader, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { readT3OperationRequest, T3EvidenceError, type CurrentT3Request } from './t3OperationRequest';

export const T3_WALLET_CLAIM_LIMITS = Object.freeze({ history: 10_000, candidates: 32, failures: 32,
  responseBytes: 8 * 1024 * 1024, newTransactions: 64 });
export function readT3WalletClaimRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  const parsed = readT3OperationRequest(value, manifest);
  if (parsed.request.kind !== 'redeem') throw new T3EvidenceError(400, 'bad_request');
  return { ...parsed, request: parsed.request as Extract<CurrentT3Request, { kind: 'redeem' }> };
}
type Claims = Omit<Extract<CurrentT3WalletClaimsResult, { status: 'ok' }>, 'status' | 'wallet' | 'owner'>;
export type CurrentT3WalletClaimEvidence = {
  schema: 'tonswap-t3-wallet-claim-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'redeem'; owner: string; wallet: string; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  wallet: { address: string; codeBoc: string; dataBoc: string }; claims: Claims;
};

/** Reconstruct both current sparse trees from original wallet history. Returned
 * witnesses select one exact saved burn; they never certify a payout or make a
 * stale retry safe without the wallet's current getter/state checks. */
export async function collectT3WalletClaimEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readT3WalletClaimRequest>, signal?: AbortSignal): Promise<CurrentT3WalletClaimEvidence> {
  const { request, body, intent } = parsed, limits = T3_WALLET_CLAIM_LIMITS;
  if (`ton:${source.network}` !== manifest.network) throw new T3EvidenceError(503, 'upstream_unavailable');
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const hub = manifest.contracts.T3Hub!, token = manifest.tokens.find(token => token.root === hub.address);
  if (!token || token.masterCodeHash !== hub.codeHash || token.walletCodeHash !== manifest.templates.T3Wallet)
    throw new T3EvidenceError(503, 'upstream_unavailable');
  const binding = { hub: hub.address, walletCodeHash: manifest.templates.T3Wallet, proofCodeHash: manifest.templates.T3RecoveryProof };
  const selected = await createJettonWalletReader({ source, tokens: manifest.tokens.map(token => ({ master: token.root,
    masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash })) }).wallet(binding.hub, request.owner, { at: head, signal });
  if (selected.status === 'unavailable') throw new T3EvidenceError(503, 'upstream_unavailable');
  if (selected.wallet !== request.wallet) throw new T3EvidenceError(400, 'bad_request');
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  const state = await reader.current(request.wallet);
  if (!state.codeBoc || !state.dataBoc || orderCell(state.codeBoc).hash().toString('hex') !== binding.walletCodeHash)
    throw new T3EvidenceError(503, 'upstream_unavailable');
  const current = readCurrentT3Wallet(state.dataBoc);
  if (current.owner !== request.owner || current.master !== binding.hub || current.proofCodeHash !== binding.proofCodeHash
    || currentT3WalletAddress(Address.parse(request.owner), Address.parse(binding.hub), binding.proofCodeHash, orderCell(state.codeBoc)) !== request.wallet)
    throw new T3EvidenceError(503, 'upstream_unavailable');
  const hex = (value: bigint) => value.toString(16).padStart(64, '0');
  const response: CurrentT3WalletClaimEvidence = { schema: 'tonswap-t3-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    request: { kind: 'redeem', owner: request.owner, wallet: request.wallet, bodyHash: request.bodyHash },
    coverage: { complete: false, gaps: [] }, wallet: { address: request.wallet, codeBoc: state.codeBoc, dataBoc: state.dataBoc },
    claims: { root: hex(current.root), count: String(current.nextId), records: [], failureRoot: hex(current.failureRoot), failureCount: String(current.failureCount), failures: [] } };
  const gaps = response.coverage.gaps;
  const finish = () => {
    assertFreshHeadTime(head.utime); signal?.throwIfAborted();
    response.coverage.gaps = [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()];
    response.coverage.complete = response.coverage.gaps.length === 0;
    if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) {
      response.coverage.complete = false; response.coverage.gaps.push({ code: 'response_size_limit', account: request.wallet });
      response.claims.records = []; response.claims.failures = [];
      if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) throw new T3EvidenceError(503, 'upstream_unavailable');
    }
    return response;
  };
  const history = await reader.history(request.wallet, state, limits.history); gaps.push(...history.gaps);
  if (!history.complete) { gaps.push({ code: 'wallet_history_incomplete', account: request.wallet }); return finish(); }
  const states = new Map<string, ReturnType<typeof boundaryState>>();
  const key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const boundary of history.rows) for (const boc of [boundary.evidence.beforeShardAccountBoc, boundary.evidence.afterShardAccountBoc]) {
    const snapshot = boundaryState(request.wallet, boc, boundary.seqno), id = key(request.wallet, snapshot.state.lastTxLt!, snapshot.state.lastTxHash!);
    const previous = states.get(id);
    if (previous && previous.state.shardAccountBoc !== snapshot.state.shardAccountBoc) throw new T3EvidenceError(503, 'upstream_unavailable');
    if (!previous || snapshot.seqno < previous.seqno) states.set(id, snapshot);
  }
  const reconstructed = await reconstructCurrentT3WalletClaims({ binding, wallet: request.wallet, owner: request.owner,
    transactions: history.rows.map(boundaryTransaction), currentState: { seqno: head.seqno, state },
    stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null, maxTransactions: limits.history, signal });
  if (reconstructed.status !== 'ok') { gaps.push({ code: 'wallet_claim_history_unavailable', account: request.wallet }); return finish(); }
  const origins = new Set(history.rows.flatMap(boundary => {
    const row = verifyOrderTransaction(boundary.evidence); if (!row.incoming) return [];
    const message = loadMessage(row.incoming.beginParse());
    return message.info.type === 'internal' && message.info.src.toRawString() === request.owner && !message.info.bounced && message.body.equals(body)
      ? [row.tx.lt.toString()] : [];
  }));
  if (!origins.size) { gaps.push({ code: 'original_request_unobserved', account: request.wallet }); return finish(); }
  const records = reconstructed.records.filter(record => {
    const attempt = t3Attempt(orderCell(record.recordBoc).refs[0]);
    return record.burn && record.owner === request.owner && record.queryId === request.queryId && record.amountRaw === request.amountRaw
      // Burn WalletTerms.recipient is the wallet owner; the actual redemption
      // beneficiary is inside the exact custom intent, not this outer field.
      && record.recipient === request.owner && origins.has(record.originLt) && !!attempt.customPayload?.equals(intent);
  });
  if (records.length > limits.candidates) { gaps.push({ code: 'wallet_claim_candidate_limit', account: request.wallet }); return finish(); }
  const hashes = new Set(records.map(record => orderCell(record.recordBoc).refs[0].hash().toString('hex')));
  const failures = reconstructed.failures.filter(failure => hashes.has(failure.attemptHash));
  if (failures.length > limits.failures) { gaps.push({ code: 'wallet_failure_candidate_limit', account: request.wallet }); return finish(); }
  response.claims = { root: reconstructed.root, count: reconstructed.count, records, failureRoot: reconstructed.failureRoot,
    failureCount: reconstructed.failureCount, failures };
  return finish();
}
