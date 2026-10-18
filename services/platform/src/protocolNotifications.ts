import { stageTime } from './notificationEvidence.js';
import { Address, beginCell } from '@ton/core';
import type { LedgerEvent } from './ledger.js';
import type { NewNotification } from './store.js';
export { optionLifecycleNotifications } from './optionNotifications.js';

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
const positive = (value: string | undefined | null) => value !== undefined && value !== null && BigInt(value) > 0n;
/** Notices describe independently verified principal or engine bookkeeping. A queued payout is never described as received. */
export function protocolLedgerNotification(event: LedgerEvent, common: Common): NewNotification | null {
  const s = event.settlement;
  if (event.status !== 'success' || s?.status !== 'confirmed' || event.kind !== s.operation) return null;
  const t = s.t3;
  if (s.protocol === 't3' && t && t.owner === event.account && t.recipient === event.account && s.queryId === t.queryId && positive(t.queryId) && t.requestHash &&
    new Set(t.reserveRoots).size === 3 && s.evidence.some(ref => ref.account === t.hub) && s.evidence.some(ref => ref.account === t.root)) {
    const token = (m: LedgerEvent['movements'][number], root: string) => m.asset.kind === 'jetton' && m.asset.master === root && m.asset.id === `${event.network}:jetton:${root}`;
    const minting = s.operation === 't3_mint' && t.stage === 'minted';
    const redeeming = s.operation === 't3_redeem' && t.stage === 'redeemed';
    let principal = false;
    if (minting && positive(t.mintedRaw) && positive(t.rootQueryId) && positive(t.wireId)) {
      const credits = event.movements.filter(m => m.purpose === 't3_mint');
      const debits = event.movements.filter(m => m.purpose === 't3_collateral' || m.purpose === 'protocol_fee');
      principal = credits.length === 1 && credits[0]!.direction === 'in' && credits[0]!.amountRaw === t.mintedRaw &&
        token(credits[0]!, t.root) && credits[0]!.asset.owner === event.account && credits[0]!.evidence?.kind === 't3_mint' &&
        debits.length > 0 && debits.every(m => m.asset.owner === event.account && t.reserveRoots.some(root => token(m, root)) &&
          m.direction === (m.purpose === 'protocol_fee' ? 'fee' : 'out')) &&
        t.reserveRoots.every((root, i) => debits.filter(m => token(m, root)).reduce((sum, m) => sum + BigInt(m.amountRaw), 0n) === BigInt(t.basketRaw[i]!));
    }
    if (redeeming && positive(t.amountRaw) && positive(t.payoutId) && positive(t.rootQueryId) && t.receiver) {
      const burns = event.movements.filter(m => m.purpose === 't3_burn');
      const payouts = event.movements.filter(m => m.purpose === 't3_payout');
      principal = burns.length === 1 && burns[0]!.direction === 'out' && burns[0]!.amountRaw === t.amountRaw &&
        token(burns[0]!, t.root) && burns[0]!.asset.owner === event.account && burns[0]!.evidence?.kind === 't3_burn' &&
        payouts.length > 0 && payouts.every(m => m.direction === 'in' && m.asset.owner === t.receiver && m.asset.controller === event.account &&
          m.asset.custody === 't3_receiver' && t.reserveRoots.some(root => token(m, root)) && m.evidence?.kind === 't3_payout') &&
        t.reserveRoots.every((root, i) => payouts.filter(m => token(m, root)).reduce((sum, m) => sum + BigInt(m.amountRaw), 0n) === BigInt(t.deliveredRaw[i]!) && t.deliveredRaw[i] === t.basketRaw[i]);
    }
    if (principal) return { ...stageTime(common, s.evidence), category: 'activity',
      sourceEventId: `t3:${t.hub}:${event.account}:${t.queryId}:${minting ? t.rootQueryId + ':' + t.wireId : t.payoutId}:${t.stage}`,
      title: minting ? 'T3 mint confirmed' : 'T3 redemption confirmed',
      body: (minting ? 'Your minted T3 was credited to your wallet.' : 'Your redemption reserves were credited to your controlled receiver.') +
        (t.feeBreakdown === 'unavailable' ? ' The protocol fee breakdown remains unavailable.' : ''),
      evidence: { ...stageTime(common, s.evidence).evidence, settlement: s, movements: event.movements } };
  }
  const p = s.perps;
  if (s.protocol === 'perps' && s.operation === 'perps_operation' && p && p.owner === event.account && p.outcome === 'accepted' &&
    p.queryId === p.request.queryId && p.marketId === p.request.marketId && p.marketId <= 0xffffffff &&
    (!p.request.owner || p.request.owner === event.account) && p.before && p.after && p.stateEvidence &&
    p.stateEvidence.afterSeqno >= p.stateEvidence.beforeSeqno && p.stateEvidence.transactions.length === 1 &&
    p.stateEvidence.transactions[0]!.account === p.engine &&
    [p.before, p.after].every(boundary => !boundary.position || (boundary.position.owner === event.account && boundary.position.marketId === p.marketId))) {
    const positionKey = beginCell().storeAddress(Address.parse(event.account)).storeUint(p.marketId, 32).endCell().hash().toString('hex');
    if (positionKey !== p.positionKey) return null;
    const engineTx = p.stateEvidence.transactions[0]!;
    if (!s.evidence.some(ref => ref.account === p.engine && ref.lt === engineTx.lt && ref.hash === engineTx.hash)) return null;
    const paid = p.payout.status === 'completed';
    if (paid) {
      const payouts = event.movements.filter(m => m.purpose === 'perps_payout');
      if (!positive(p.payout.wireId) || !positive(p.payout.amountRaw) || p.payout.evidence.length === 0 || !payouts.length ||
        payouts.some(m => m.direction !== 'in' || m.asset.kind !== 'jetton' || m.asset.master !== p.root || m.asset.owner !== event.account ||
          m.asset.id !== `${event.network}:jetton:${p.root}` || m.evidence?.kind !== 'perps_payout') ||
        payouts.reduce((sum, m) => sum + BigInt(m.amountRaw), 0n) !== BigInt(p.payout.amountRaw)) return null;
    }
    const descriptions = { open: 'Position opening', modify: 'Position update', close: 'Position close', add_margin: 'Margin deposit', remove_margin: 'Margin removal', claim: 'Funding claim', liquidation: 'Liquidation', adl: 'Automatic deleveraging' };
    return { ...stageTime(common, paid ? p.payout.evidence : p.stateEvidence.transactions, s.evidence), category: 'activity',
      sourceEventId: `perps:${p.engine}:${engineTx.lt}:${engineTx.hash}:${p.queryId}:${paid ? 'payout:' + p.payout.wireId : 'booked'}`,
      title: paid ? 'Perps payout confirmed' : `${descriptions[p.request.operation]} confirmed`,
      body: `${descriptions[p.request.operation]} was verified in the engine account.` +
        (paid ? ' The associated T3 payout was credited to your wallet.' : ['pending', 'aggregate_unresolved'].includes(p.payout.status) ? ' The associated wallet payout remains unverified.' : ''),
      evidence: { ...stageTime(common, paid ? p.payout.evidence : p.stateEvidence.transactions, s.evidence).evidence, settlement: s, movements: event.movements } };
  }
  return null;
}
