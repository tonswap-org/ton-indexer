import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { t3Delivery } from '../ledger/currentT3Wire';
import { boundaryTransaction, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { collectCurrentWalletClaimSelection, type CurrentWalletClaimSelection } from './currentWalletClaimSelection';
import { collectProductPhysicalGraph, ProductEvidenceError, PRODUCT_EVIDENCE_LIMITS } from './productEvidence';
import { readLaunchpadEvidenceContext, readLaunchpadOperationRequest, type CurrentLaunchpadEvidenceRequest } from './launchpadOperationEvidence';

export const readLaunchpadWalletClaimRequest = readLaunchpadOperationRequest;
export type CurrentLaunchpadWalletClaimEvidence = {
  schema: 'tonswap-launchpad-wallet-claim-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: CurrentLaunchpadEvidenceRequest['kind']; owner: string; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  wallets: Array<{ role: 'source' | 'holder' } & Pick<CurrentWalletClaimSelection, 'wallet' | 'claims'>>;
};

/** Only the original request's canonical T3 source and target holder can
 * nominate recovery. A native immutable recipient may differ from the sender. */
export async function collectLaunchpadWalletClaimEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readLaunchpadWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentLaunchpadWalletClaimEvidence> {
  const c = await readLaunchpadEvidenceContext(manifest, source, parsed, signal), p = c.request;
  const reader = createPhysicalEvidenceReader(source, store, c.head, { signal, newTransactions: PRODUCT_EVIDENCE_LIMITS.newTransactions });
  const causal: PhysicalBoundary[] = [], response: CurrentLaunchpadWalletClaimEvidence = {
    schema: 'tonswap-launchpad-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: c.head.seqno, unixTime: c.head.utime, blockRootHash: c.head.rootHashHex },
    request: { kind: p.kind, owner: p.owner, bodyHash: p.bodyHash }, coverage: { complete: false, gaps: [] }, wallets: [],
  };
  const graph = await collectProductPhysicalGraph(source, store, c.head, { owner: p.owner, target: parsed.dispatchTarget, body: parsed.body,
    dispatch: p.dispatch, pins: c.pins, completeAccounts: c.completeAccounts, reader, onCausal: row => causal.push(row) }, signal);
  response.coverage.gaps.push(...graph.coverage.gaps);
  const binding = { hub: c.t3.root, walletCodeHash: manifest.templates.T3Wallet, proofCodeHash: manifest.templates.T3RecoveryProof };
  if (c.t3.masterCodeHash !== manifest.contracts.T3Hub!.codeHash || c.t3.walletCodeHash !== binding.walletCodeHash) throw new ProductEvidenceError(503, 'upstream_unavailable');
  if (graph.coverage.complete) {
    const holders: { role: 'source' | 'holder'; address: string; owner: string }[] = [];
    if (p.kind === 'contribute') {
      const original = await c.wallets.identity(c.t3.root, p.owner, { at: c.head, signal });
      if (p.sourceWallet !== original.wallet) throw new ProductEvidenceError(400, 'bad_request');
      holders.push({ role: 'source', address: original.wallet, owner: p.owner });
    }
    if (c.targetRole === 0 || c.targetRole === 1) {
      const slot = c.loaded.get(c.targetRole)?.slots.get(0);
      if (slot?.wallet) {
        const canonical = await c.wallets.identity(c.t3.root, p.target, { at: c.head, signal });
        if (slot.master !== c.t3.root || canonical.wallet !== slot.wallet) throw new ProductEvidenceError(503, 'upstream_unavailable');
        holders.push({ role: 'holder', address: canonical.wallet, owner: p.target });
      }
    }
    if (new Set(holders.map(h => h.address)).size !== holders.length) throw new ProductEvidenceError(503, 'upstream_unavailable');
    // The initial owner TON dispatch is the emitter of a source-wallet debit.
    causal.push(await reader.exact(p.owner, p.dispatch.lt, p.dispatch.hash));
    let remainingHistory = 10000 - PRODUCT_EVIDENCE_LIMITS.history, records = 0, failures = 0;
    for (const holder of holders) {
      if (!causal.some(row => row.evidence.account === holder.address && boundaryTransaction(row).outMessages.some(message => {
        const attempt = t3Delivery(message); return attempt && !attempt.burn && attempt.owner === holder.owner && attempt.attempt === 0n;
      }))) continue;
      try {
        const selected = await collectCurrentWalletClaimSelection({ binding, head: c.head, reader, address: holder.address, owner: holder.owner,
          causal, historyLimit: remainingHistory, signal });
        remainingHistory -= selected.historyRows; records += selected.claims.records.length; failures += selected.claims.failures.length;
        response.coverage.gaps.push(...selected.gaps);
        if (records > 32 || failures > 32) { response.coverage.gaps.push({ code: 'wallet_claim_candidate_limit', account: holder.address }); break; }
        response.wallets.push({ role: holder.role, wallet: selected.wallet, claims: selected.claims });
      } catch (error) { if (signal?.aborted) throw error; response.coverage.gaps.push({ code: 'current_wallet_claim_unavailable', account: holder.address }); }
    }
  }
  response.coverage.gaps = [...new Map(response.coverage.gaps.map(g => [JSON.stringify(g), g])).values()];
  response.coverage.complete = response.coverage.gaps.length === 0;
  if (Buffer.byteLength(JSON.stringify(response)) > PRODUCT_EVIDENCE_LIMITS.bytes) {
    response.wallets = []; response.coverage.complete = false; response.coverage.gaps.push({ code: 'response_size_limit', account: p.target });
  }
  assertFreshHeadTime(c.head.utime); signal?.throwIfAborted(); return response;
}
