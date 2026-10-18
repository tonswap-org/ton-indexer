import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { t3Delivery } from '../ledger/currentT3Wire';
import { boundaryTransaction, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { collectCurrentWalletClaimSelection, type CurrentWalletClaimSelection } from './currentWalletClaimSelection';
import { collectProductPhysicalGraph, ProductEvidenceError, PRODUCT_EVIDENCE_LIMITS } from './productEvidence';
import { readPerpsEvidenceContext, readPerpsOperationRequest, verifyPerpsEvidenceHistory, type CurrentPerpsEvidenceRequest } from './perpsOperationEvidence';
export const readPerpsWalletClaimRequest = readPerpsOperationRequest;
export type CurrentPerpsWalletClaimEvidence = {
  schema: 'tonswap-perps-wallet-claim-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string }; request: { kind: CurrentPerpsEvidenceRequest['kind']; owner: string; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  wallets: Array<{ role: 'engine' | 'risk-vault' | 'owner' } & Pick<CurrentWalletClaimSelection, 'wallet' | 'claims'>>;
};
export async function collectPerpsWalletClaimEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readPerpsWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentPerpsWalletClaimEvidence> {
  const p = parsed.request, c = await readPerpsEvidenceContext(manifest, source, store, parsed, signal), causal: PhysicalBoundary[] = [];
  const response: CurrentPerpsWalletClaimEvidence = { schema: 'tonswap-perps-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: c.head.seqno, unixTime: c.head.utime, blockRootHash: c.head.rootHashHex }, request: { kind: p.kind, owner: p.owner, bodyHash: p.bodyHash }, coverage: { complete: false, gaps: [] }, wallets: [] };
  const graph = await collectProductPhysicalGraph(source, store, c.head, { owner: p.owner, target: p.sourceWallet ?? p.engine, body: parsed.body, dispatch: p.dispatch,
    pins: c.pins, completeAccounts: c.completeAccounts, allowFrozenPins: c.allowFrozenPins, reader: c.reader, onCausal: row => causal.push(row) }, signal);
  verifyPerpsEvidenceHistory(manifest, c, graph.transactions);
  response.coverage.gaps.push(...graph.coverage.gaps);
  const binding = { hub: c.t3.root, walletCodeHash: manifest.templates.T3Wallet, proofCodeHash: manifest.templates.T3RecoveryProof };
  if (c.t3.masterCodeHash !== manifest.contracts.T3Hub!.codeHash || c.t3.walletCodeHash !== binding.walletCodeHash) throw new ProductEvidenceError(503, 'upstream_unavailable');
  if (graph.coverage.complete) {
    causal.push(await c.reader.exact(p.owner, p.dispatch.lt, p.dispatch.hash));
    let historyLeft = 10000 - PRODUCT_EVIDENCE_LIMITS.history, records = 0, failures = 0;
    for (const holder of c.wallets) {
      const recipient = holder.role === 'owner' ? p.engine : p.owner;
      if (holder.role === 'owner' && p.sourceWallet !== holder.address) continue;
      // Unrelated fee/treasury transfers never nominate a recovery authority.
      if (!causal.some(row => row.evidence.account === holder.address && boundaryTransaction(row).outMessages.some(message => {
        const attempt = t3Delivery(message); return attempt && !attempt.burn && attempt.owner === holder.owner && attempt.recipient === recipient && attempt.attempt === 0n;
      }))) continue;
      try {
        const selected = await collectCurrentWalletClaimSelection({ binding, head: c.head, reader: c.reader, address: holder.address, owner: holder.owner, recipient,
          causal, historyLimit: historyLeft, signal });
        historyLeft -= selected.historyRows; response.coverage.gaps.push(...selected.gaps);
        records += selected.claims.records.length; failures += selected.claims.failures.length;
        if (records > 32 || failures > 32) { response.coverage.gaps.push({ code: 'wallet_claim_candidate_limit', account: holder.address }); break; }
        response.wallets.push({ role: holder.role, wallet: selected.wallet, claims: selected.claims });
      } catch (error) { if (signal?.aborted) throw error; response.coverage.gaps.push({ code: 'current_wallet_claim_unavailable', account: holder.address }); }
    }
  }
  response.coverage.gaps = [...new Map(response.coverage.gaps.map(g => [JSON.stringify(g), g])).values()];
  response.coverage.complete = response.coverage.gaps.length === 0;
  if (Buffer.byteLength(JSON.stringify(response)) > PRODUCT_EVIDENCE_LIMITS.bytes) {
    response.wallets = []; response.coverage.complete = false; response.coverage.gaps.push({ code: 'response_size_limit', account: p.engine });
  }
  assertFreshHeadTime(c.head.utime); signal?.throwIfAborted(); return response;
}
