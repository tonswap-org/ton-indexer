import type { MarketRoutingEvidence } from './marketTypes';
import type { LedgerEvidenceRef } from './types';
export function routingEvidenceRefs(routing: MarketRoutingEvidence | null): LedgerEvidenceRef[] {
    if (!routing)
        return [];
    return [routing.routerAcceptance, routing.completion, routing.completionAcknowledged, ...routing.boundaries.map(b => b.transaction),
        ...[routing.inputSettlement, routing.terminalSettlement].flatMap(s => [s.request, s.debit, s.credit, s.acknowledged, s.walletFinalized, s.routerFinalized, ...s.boundaries.map(b => b.transaction)]),
        ...(routing.protocolFeeSettlement ? [routing.protocolFeeSettlement].flatMap(s => [s.request, s.debit, s.credit, s.acknowledged, s.walletFinalized, s.poolFinalized, ...s.boundaries.map(b => b.transaction)]) : [])];
}
/** Owner ledger evidence uses canonical base64 transaction hashes; Cell hashes
 * and market-ledger transaction hashes retain their separate representations. */
export function mapRoutingEvidence(routing: MarketRoutingEvidence, map: (ref: LedgerEvidenceRef) => LedgerEvidenceRef): MarketRoutingEvidence {
    const copy = structuredClone(routing);
    const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object')
            return;
        const item = value as Record<string, unknown>;
        if (typeof item.account === 'string' && typeof item.lt === 'string' && typeof item.hash === 'string' && typeof item.utime === 'number')
            Object.assign(item, map(item as LedgerEvidenceRef));
        else
            Object.values(item).forEach(visit);
    };
    visit(copy);
    return copy;
}
