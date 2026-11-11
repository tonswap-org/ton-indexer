import { Cell } from '@ton/core';
import { decodeCurrentOptionsOperations } from './currentOptions';
import { currentT3OriginalBoundary } from './currentT3Proof';
import { canonicalLedgerHash } from './normalize';
import { chainCoversTransaction, type Node, type ProjectionInput } from './project';
import type { OrderTransactionEvidence } from '../orders/evidence';
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from './types';
export type CurrentOptionLedgerOperation = {
    anchor: Node;
    kind: 'option_operation';
    queryId: string;
    confirmed: boolean;
    evidence: LedgerEvidenceRef[];
    settlement: NonNullable<LedgerEvent['settlement']>;
    issue?: string;
};
const ref = (n: Node): LedgerEvidenceRef => ({ account: n.account, lt: n.raw.lt, hash: canonicalLedgerHash(n.raw.hash), utime: n.raw.utime });
/** Original account evidence is loaded by exact predecessor and transaction.
 * A missing archive boundary remains a gap; no current getter fills it in. */
export async function projectCurrentOptions(input: ProjectionInput, nodes: Node[], attach: (a: Node, b: Node) => void): Promise<CurrentOptionLedgerOperation[]> {
    const binding = input.currentOptionsBinding;
    if (!binding)
        return [];
    const evidence: OrderTransactionEvidence[] = [], byHash = new Map(nodes.map(n => [Buffer.from(canonicalLedgerHash(n.raw.hash), 'base64').toString('hex'), n]));
    for (const node of nodes) {
        if (!node.raw.rawBoc || !node.raw.prevTransactionLt || !node.raw.prevTransactionHash)
            continue;
        try {
            const before = await input.stateAt(node.account, node.raw.prevTransactionLt, node.raw.prevTransactionHash), after = await input.stateAt(node.account, node.raw.lt, node.raw.hash);
            if (!before || !after)
                continue;
            currentT3OriginalBoundary(node, before, after);
            evidence.push({ account: node.account, transactionBoc: node.raw.rawBoc, beforeShardAccountBoc: before.state.shardAccountBoc!, afterShardAccountBoc: after.state.shardAccountBoc! });
        }
        catch { /* Each unsupported original boundary remains absent from business proof. */ }
    }
    const result: CurrentOptionLedgerOperation[] = [];
    for (const operation of decodeCurrentOptionsOperations(input.owner, binding, evidence)) {
        const { request, proof, economics } = operation, anchor = byHash.get(request.dispatch.hash);
        if (!anchor?.event)
            continue;
        const related = economics.evidenceHashes.map(h => byHash.get(h)).filter((n): n is Node => !!n), covered = related.every(n => chainCoversTransaction(input.chains.get(n.account), n.raw));
        const refs = related.map(ref);
        let cashProjected = true;
        for (const n of related)
            attach(anchor, n);
        for (const leg of economics.cash) {
            const node = byHash.get(leg.ownerTransaction);
            if (!node?.event) {
                cashProjected = false;
                continue;
            }
            const purpose: LedgerMovement['purpose'] = leg.direction === 'out' ? (request.kind === 'fund' ? 'option_collateral' : 'option_premium') : (economics.outcome === 'refunded' ? 'option_refund' : 'option_payout');
            const existing = node.event.movements.find(m => m.asset.master === binding.options.t3Root.toRawString() && m.direction === leg.direction && m.amountRaw === leg.amountRaw && m.evidence.kind === 'jetton_internal_transfer');
            // Current T3 projection owns physical token movements. Options adds a
            // purpose and economic components without creating a second cash movement.
            if (existing) {
                existing.purpose = purpose;
                existing.evidence.requestBodyHash = request.bodyHash;
            }
            else
                cashProjected = false;
        }
        for (const [direction, amount] of [['in', economics.rightAcquiredRaw], ['out', economics.rightRetiredRaw]] as const) {
            if (amount === '0' || !economics.positionId)
                continue;
            const id = `${anchor.id}:current-option-right:${direction}:${request.seriesId}:${economics.positionId}`;
            if (!anchor.event.movements.some(m => m.id === id))
                anchor.event.movements.push({ id, direction, ...(direction === 'out' ? { purpose: 'option_right_retired' as const } : {}), amountRaw: amount,
                    asset: { kind: 'option_position', id: `${input.network}:option:${request.factory}:${request.seriesId}:${economics.positionId}`, owner: input.owner, factory: request.factory, seriesId: request.seriesId, positionId: economics.positionId, decimals: 9 },
                    evidence: { kind: 'option_position_delta', requestBodyHash: request.bodyHash, transactions: refs } });
        }
        const complete = covered && cashProjected && economics.outcome !== 'unresolved' && economics.pendingOutRaw === '0';
        result.push({ anchor, kind: 'option_operation', queryId: request.queryId, confirmed: complete, evidence: refs,
            settlement: { status: complete ? 'confirmed' : 'incomplete', protocol: 'options', operation: 'option_operation', factory: request.factory, seriesId: request.seriesId, ...(economics.positionId ? { positionId: economics.positionId } : {}), queryId: request.queryId, evidence: refs, currentOptions: economics },
            ...(!complete ? { issue: economics.pendingOutRaw !== '0' ? 'option_physical_payout_pending' : 'option_current_evidence_incomplete' } : {}) });
    }
    return result;
}
