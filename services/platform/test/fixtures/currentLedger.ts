import { createHash } from 'node:crypto';
import type { LedgerEvent } from '../../src/ledger.js';
const address = (n: number) => `0:${String(n).padStart(64, '0')}`;
/** Synthetic transport-only records exercise persistence; native proof coverage
 * lives in currentLedgerNative.test.ts and never uses these manufactured refs. */
export function currentSwap(owner: string, requested: number, settled: number | null, id = 'owner-transaction'): LedgerEvent {
  const pool = address(2), t3 = address(3), x = address(4), wallets = [address(5), address(6), address(7), address(8)];
  const digest = (index: number) => createHash('sha256').update(`${owner}:${requested}:${index}`).digest();
  const refs = [owner, ...wallets, pool, address(9)].map((account, index) => ({ account, lt: String(requested * 10 + index), hash: digest(index).toString('base64'), utime: index < 3 ? requested : settled ?? requested }));
  const body = digest(9).toString('hex'), cash = [
    { direction: 'out' as const, root: t3, amountRaw: '100000000000000001', wallet: wallets[0]!, otherOwner: pool, ownerTransaction: digest(1).toString('hex'), debitTransaction: digest(1).toString('hex'), creditTransaction: digest(2).toString('hex'), originTransaction: digest(1).toString('hex') },
    { direction: 'in' as const, root: x, amountRaw: '95000000000000007', wallet: wallets[3]!, otherOwner: pool, ownerTransaction: digest(4).toString('hex'), debitTransaction: digest(3).toString('hex'), creditTransaction: digest(4).toString('hex'), originTransaction: digest(3).toString('hex') },
  ];
  return { id, network: 'testnet', account: owner, lt: refs[0]!.lt, hash: refs[0]!.hash, txId: `${refs[0]!.lt}:${refs[0]!.hash}`, utime: requested, status: 'success', kind: 'swap', actions: [], issues: [],
    movements: cash.map((leg, index) => ({ direction: leg.direction, amountRaw: leg.amountRaw,
      asset: { kind: 'jetton', id: `testnet:jetton:${leg.root}`, master: leg.root, owner, wallet: leg.wallet },
      source: index === 0 ? owner : pool, destination: index === 0 ? pool : owner,
      evidence: { kind: 'jetton_internal_transfer', requestBodyHash: body, transactions: refs.slice(index === 0 ? 1 : 3, index === 0 ? 3 : 5) } })),
    settlement: { status: settled === null ? 'incomplete' : 'confirmed', protocol: 'dlmm', operation: 'swap', pool, queryId: '1', evidence: refs,
      currentDlmm: { owner, queryId: '1', requestBodyHash: body, dispatch: { lt: refs[0]!.lt, hash: digest(0).toString('hex') },
        evidenceHashes: refs.map(r => Buffer.from(r.hash, 'base64').toString('hex')), aggregateOwed: false, kind: 'swap', outcome: settled === null ? 'unresolved' : 'delivered', pool, side: 0,
        paidInRaw: cash[0]!.amountRaw, paidOutT3Raw: '0', paidOutXRaw: cash[1]!.amountRaw, pendingOutT3Raw: '0', pendingOutXRaw: '0',
        grossFeeT3Raw: '0', protocolFeeT3Raw: '0', lpFeeT3Raw: '0', farmId: null, shares: [], cash } } };
}
export function currentOption(owner: string, time: number): LedgerEvent {
  const e = currentSwap(owner, time, time), d = e.settlement!.currentDlmm!, cash = d.cash.slice(0, 1).map(({ root, originTransaction, ...c }) => c);
  e.kind = 'option_operation'; e.movements = e.movements.slice(0, 1);
  e.movements.push({ direction: 'in', amountRaw: '10000', asset: { kind: 'option_position', id: `testnet:option:${d.pool}:7:3`, factory: d.pool, seriesId: '7', positionId: '3', owner, decimals: 9 }, evidence: { kind: 'option_position_delta', requestBodyHash: d.requestBodyHash, transactions: e.settlement!.evidence } });
  e.settlement = { status: 'confirmed', protocol: 'options', operation: 'option_operation', factory: d.pool, seriesId: '7', positionId: '3', queryId: d.queryId, evidence: e.settlement!.evidence,
    currentOptions: { owner, queryId: d.queryId, requestBodyHash: d.requestBodyHash, dispatch: d.dispatch, evidenceHashes: d.evidenceHashes, aggregateOwed: false, kind: 'buy', outcome: 'accepted',
      factory: d.pool, vault: address(9), seriesId: '7', positionId: '3', amountRequestedRaw: d.paidInRaw, premiumNetRaw: d.paidInRaw, protocolFeeRaw: '0', writerBackingRaw: '0', writerPremiumRaw: '0', rightAcquiredRaw: '10000', rightRetiredRaw: '0', paidInRaw: d.paidInRaw, paidOutRaw: '0', pendingOutRaw: '0', cash } };
  return e;
}
