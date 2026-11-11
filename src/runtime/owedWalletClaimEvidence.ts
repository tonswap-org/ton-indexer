import { Address } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { currentT3WalletAddress, readCurrentT3Wallet } from '../ledger/currentT3State';
import { activeOrderAccount, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { collectCurrentWalletClaimSelection, type SelectedCurrentWalletClaims } from './currentWalletClaimSelection';
import { emptyOwedArchive } from './currentOwedState';
import { readOwedEvidenceContext, readOwedOperationRequest } from './owedEvidence';
import { createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { collectProductPhysicalGraph, PRODUCT_EVIDENCE_LIMITS, ProductEvidenceError } from './productEvidence';

export const OWED_WALLET_CLAIM_LIMITS = Object.freeze({ history: 10_000, candidates: 32, failures: 32, bytes: 8 * 1024 * 1024, newTransactions: 64 });
export const readOwedWalletClaimRequest = readOwedOperationRequest;
export type CurrentOwedWalletClaimEvidence = {
  schema: 'tonswap-owed-wallet-claim-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'direct' | 'archive'; owner: string; holder: string; slot: number; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  wallet: { address: string; codeBoc: string; dataBoc: string }; claims: SelectedCurrentWalletClaims;
};
const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');

/** Select exact failed T3 payouts caused by the saved owner CLMJ/CLMA. Full
 * original wallet history authenticates current witnesses; neither a witness
 * nor a successful retry is evidence that the owner received tokens. */
export async function collectOwedWalletClaimEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readOwedWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentOwedWalletClaimEvidence> {
  const p = parsed.request, c = await readOwedEvidenceContext(manifest, source, p, signal), limits = OWED_WALLET_CLAIM_LIMITS;
  const hub = manifest.contracts.T3Hub;
  if (!hub || c.token.root !== hub.address || c.token.masterCodeHash !== hub.codeHash || c.token.walletCodeHash !== manifest.templates.T3Wallet) throw unavailable();
  const binding = { hub: hub.address, walletCodeHash: manifest.templates.T3Wallet, proofCodeHash: manifest.templates.T3RecoveryProof };
  const reader = createPhysicalEvidenceReader(source, store, c.head, { signal, newTransactions: limits.newTransactions });
  const account = await reader.current(c.holderWallet.wallet);
  if (account.accountState !== 'active') throw unavailable();
  const active = activeOrderAccount(orderShard(account.shardAccountBoc!, c.holderWallet.wallet).shard, binding.walletCodeHash);
  const state = readCurrentT3Wallet(active.data);
  if (state.owner !== p.holder || state.master !== binding.hub || state.proofCodeHash !== binding.proofCodeHash
    || currentT3WalletAddress(Address.parse(p.holder), Address.parse(binding.hub), binding.proofCodeHash, active.code) !== c.holderWallet.wallet) throw unavailable();
  const response: CurrentOwedWalletClaimEvidence = {
    schema: 'tonswap-owed-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: c.head.seqno, unixTime: c.head.utime, blockRootHash: c.head.rootHashHex },
    request: { kind: p.kind, owner: p.owner, holder: p.holder, slot: p.slot, bodyHash: p.bodyHash }, coverage: { complete: false, gaps: [] },
    wallet: { address: c.holderWallet.wallet, codeBoc: active.code.toBoc().toString('base64'), dataBoc: active.data.toBoc().toString('base64') },
    claims: { root: state.root.toString(16).padStart(64, '0'), count: String(state.nextId), records: [],
      failureRoot: state.failureRoot.toString(16).padStart(64, '0'), failureCount: String(state.failureCount), failures: [] },
  };
  const finish = () => {
    signal?.throwIfAborted(); assertFreshHeadTime(c.head.utime);
    response.coverage.gaps = [...new Map(response.coverage.gaps.map(g => [JSON.stringify(g), g])).values()];
    response.coverage.complete = response.coverage.gaps.length === 0;
    if (Buffer.byteLength(JSON.stringify(response)) > limits.bytes) {
      response.coverage.complete = false; response.coverage.gaps.push({ code: 'response_size_limit', account: p.holder });
      response.claims.records = []; response.claims.failures = [];
      if (Buffer.byteLength(JSON.stringify(response)) > limits.bytes) throw unavailable();
    }
    return response;
  };
  const pins = new Map([[p.holder, c.pin.codeHash], [c.holderWallet.wallet, binding.walletCodeHash], [c.ownerWallet.wallet, binding.walletCodeHash]]);
  const recipientState = await reader.current(c.ownerWallet.wallet);
  const frozenRecipient = orderShard(recipientState.shardAccountBoc!, c.ownerWallet.wallet).shard.account?.storage.state.type === 'frozen';
  const causal: PhysicalBoundary[] = [];
  const graph = await collectProductPhysicalGraph(source, store, c.head, { owner: p.owner, target: p.holder, body: parsed.body, dispatch: p.dispatch,
    pins, reader, completeAccounts: [], historyOnlyAccounts: frozenRecipient ? [c.ownerWallet.wallet] : [], allowFrozenPins: new Set([c.ownerWallet.wallet]),
    onCausal: row => causal.push(row) }, signal);
  response.coverage.gaps.push(...graph.coverage.gaps);
  if (!graph.coverage.complete) return finish();
  try {
    for (const row of graph.transactions) if (row.account === p.holder) {
      const tx = verifyOrderTransaction(row);
      for (const shard of [tx.before, tx.after]) if (shard.account?.storage.state.type === 'active') c.readState(shard, emptyOwedArchive(), false);
    }
  } catch { response.coverage.gaps.push({ code: 'owed_holder_release_mismatch', account: p.holder }); return finish(); }
  const selected = await collectCurrentWalletClaimSelection({ binding, head: c.head, reader, address: c.holderWallet.wallet,
    owner: p.holder, recipient: p.owner, causal, historyLimit: limits.history - PRODUCT_EVIDENCE_LIMITS.history, signal });
  response.coverage.gaps.push(...selected.gaps);
  if (selected.claims.records.length > limits.candidates || selected.claims.failures.length > limits.failures)
    response.coverage.gaps.push({ code: 'wallet_claim_candidate_limit', account: c.holderWallet.wallet });
  // CLMJ consumes the owner's whole direct balance at execution; legitimate
  // credits after review can increase it. CLMA commits its amount in the body.
  // In both cases expose the original physical debit, never the reviewed amount.
  if (selected.claims.records.some(r => r.queryId !== p.queryId || (p.kind === 'archive'
    ? r.amountRaw !== p.amountRaw : BigInt(r.amountRaw) < BigInt(p.amountRaw))))
    response.coverage.gaps.push({ code: 'original_owed_transfer_mismatch', account: c.holderWallet.wallet });
  if (!response.coverage.gaps.length) response.claims = selected.claims;
  return finish();
}
