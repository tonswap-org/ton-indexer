import type { LedgerEvent } from '../../src/ledger.js';
import { currentSwap } from './currentLedger.js';
const addr = (n: number) => `0:${n.toString(16).padStart(64, '0')}`;
export function perpsEvent(owner = addr(1), utime = 1700000000): LedgerEvent {
  const e = currentSwap(owner, utime, utime), d = e.settlement!.currentDlmm!;
  e.kind = 'perps_operation'; e.movements = e.movements.slice(0, 1);
  e.settlement = { protocol: 'perps', operation: 'perps_operation', status: 'confirmed', queryId: d.queryId, evidence: e.settlement!.evidence,
    currentPerps: { owner, engine: d.pool, riskVault: addr(9), marketId: 1, queryId: d.queryId, generation: '1', requestBodyHash: d.requestBodyHash, dispatch: d.dispatch,
      evidenceHashes: d.evidenceHashes, aggregateOwed: false, kind: 'open', outcome: 'confirmed', positionBefore: null,
      positionAfter: { generation: '1', sizeRaw: '100', marginRaw: '20', entryNotionalRaw: '100', lastFundingIndexRaw: '0', reservedRaw: '200', pendingFundingRaw: '0', collectedLossRaw: '0', remainingEntitlementRaw: '100' },
      depositRaw: d.paidInRaw, feeRaw: '0', fundingAccruedRaw: '0', fundingCollectedRaw: '0', fundingCancelledRaw: '0', unpaidLossRaw: '0', realizedLossRaw: '0', fillPriceRaw: '1', entryNotionalDeltaRaw: '100', lpPayoutRaw: '0', localPayoutRaw: '0', paidInRaw: d.paidInRaw, paidOutRaw: '0', pendingOutRaw: '0',
      cash: d.cash.slice(0, 1).map(({ root, originTransaction, ...c }) => ({ ...c, aggregateOwed: false })) } };
  return e;
}
