import { decodeCurrentLaunchpadOperations } from './currentLaunchpad';
import { currentT3OriginalBoundary } from './currentT3Proof';
import { canonicalLedgerHash } from './normalize';
import { chainCoversTransaction, type Node, type ProjectionInput } from './project';
import type { OrderTransactionEvidence } from '../orders/evidence';
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from './types';

export type CurrentLaunchpadLedgerOperation = {
  anchor: Node; kind: 'launchpad_operation'; queryId: string; confirmed: boolean;
  evidence: LedgerEvidenceRef[]; settlement: NonNullable<LedgerEvent['settlement']>; issue?: string;
};
const ref = (node: Node): LedgerEvidenceRef => ({ account: node.account, lt: node.raw.lt,
  hash: canonicalLedgerHash(node.raw.hash), utime: node.raw.utime });

/** Allocation rights, LP funding and creator/fee splits are accounting facts.
 * Only independently verified wallet debits/credits create token movements. */
export async function projectCurrentLaunchpad(input: ProjectionInput, nodes: Node[], attach: (a: Node, b: Node) => void): Promise<CurrentLaunchpadLedgerOperation[]> {
  const binding = input.currentLaunchpadBinding; if (!binding) return [];
  const evidence: OrderTransactionEvidence[] = [];
  const byHash = new Map(nodes.map(node => [Buffer.from(canonicalLedgerHash(node.raw.hash), 'base64').toString('hex'), node]));
  for (const node of nodes) {
    if (!node.raw.rawBoc || !node.raw.prevTransactionLt || !node.raw.prevTransactionHash) continue;
    try {
      const before = await input.stateAt(node.account, node.raw.prevTransactionLt, node.raw.prevTransactionHash);
      const after = await input.stateAt(node.account, node.raw.lt, node.raw.hash);
      if (!before || !after) continue;
      currentT3OriginalBoundary(node, before, after);
      evidence.push({ account: node.account, transactionBoc: node.raw.rawBoc,
        beforeShardAccountBoc: before.state.shardAccountBoc!, afterShardAccountBoc: after.state.shardAccountBoc! });
    } catch { /* An unavailable original boundary remains an explicit proof gap. */ }
  }
  const result: CurrentLaunchpadLedgerOperation[] = [];
  for (const { economics } of decodeCurrentLaunchpadOperations(input.owner, binding, evidence)) {
    const anchor = byHash.get(economics.dispatch.hash); if (!anchor?.event) continue;
    const related = [...new Set(economics.evidenceHashes)].map(hash => byHash.get(hash)).filter((n): n is Node => !!n);
    const covered = related.length === new Set(economics.evidenceHashes).size
      && related.every(node => chainCoversTransaction(input.chains.get(node.account), node.raw));
    const refs = related.map(ref); let cashProjected = true;
    for (const node of related) attach(anchor, node);
    for (const leg of economics.cash) for (const direction of ['in', 'out'] as const) {
      if ((direction === 'in' ? leg.to : leg.from) !== input.owner) continue;
      const node = byHash.get(direction === 'in' ? leg.creditTransaction : leg.debitTransaction);
      if (!node?.event) { cashProjected = false; continue; }
      const purpose: LedgerMovement['purpose'] = direction === 'out' && economics.kind === 'contribute' ? 'launchpad_participation'
        : direction === 'in' && (economics.outcome === 'refunded' || economics.contributionRetiredRaw !== '0' && leg.root === binding.manifest.contracts.T3Hub!.address) ? 'launchpad_refund' : undefined;
      const ownerHash = direction === 'in' ? leg.creditTransaction : leg.debitTransaction;
      const hasHash = (m: LedgerMovement, hash: string) => m.evidence.transactions?.some(t => Buffer.from(canonicalLedgerHash(t.hash), 'base64').toString('hex') === hash) ?? false;
      const existing = node.event.movements.filter(m => m.asset.master === leg.root && m.direction === direction
        && m.amountRaw === leg.amountRaw && m.source === leg.from && m.destination === leg.to
        && (m.evidence.kind === 'jetton_internal_transfer' || m.evidence.kind === 'jetton_transfer')
        && hasHash(m, ownerHash)
        && (m.evidence.kind === 'jetton_internal_transfer' || hasHash(m, leg.debitTransaction) && hasHash(m, leg.creditTransaction)));
      if (existing.length) {
        if (existing.length !== 1) { cashProjected = false; continue; }
        existing[0].purpose = purpose; existing[0].evidence.requestBodyHash = economics.requestBodyHash; continue;
      }
      // Current T3 owns protected token cash. Do not bypass its projection when
      // its hub/original-history qualification is unavailable.
      if (leg.root === binding.manifest.contracts.T3Hub!.address) { cashProjected = false; continue; }
      const wallet = direction === 'in' ? leg.targetWallet : leg.sourceWallet;
      const asset = input.wallets.get(wallet);
      // The Launchpad proof independently authenticated this approved paired
      // project-token family and canonical wallet. Precision remains optional.
      node.event.movements.push({ id: `${node.id}:current-launchpad-cash:${direction}:${leg.root}`, direction,
        ...(purpose ? { purpose } : {}), amountRaw: leg.amountRaw,
        asset: { ...(asset ?? {}), kind: 'jetton', id: `${input.network}:jetton:${leg.root}`, master: leg.root, wallet, owner: input.owner },
        source: leg.from, destination: leg.to,
        evidence: { kind: 'jetton_internal_transfer', requestBodyHash: economics.requestBodyHash, transactions: [byHash.get(leg.debitTransaction), byHash.get(leg.creditTransaction)].filter((n): n is Node => !!n).map(ref) } });
    }
    const pending = Object.values(economics.pendingOut).some(amount => amount !== '0');
    const complete = covered && cashProjected && ['delivered', 'refunded'].includes(economics.outcome) && !pending;
    result.push({ anchor, kind: 'launchpad_operation', queryId: economics.queryId, confirmed: complete, evidence: refs,
      settlement: { status: complete ? 'confirmed' : 'incomplete', protocol: 'launchpad', operation: 'launchpad_operation',
        factory: economics.factory, queryId: economics.queryId, evidence: refs, currentLaunchpad: economics },
      ...(!complete ? { issue: pending ? 'launchpad_physical_payout_pending' : 'launchpad_current_evidence_incomplete' } : {}) });
  }
  return result;
}
