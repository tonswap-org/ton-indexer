import { stageTime } from './notificationEvidence.js';
import { beginCell } from '@ton/core';
import type { LedgerEvent } from './ledger.js';
import type { NewNotification } from './store.js';
import { optionAbortNotifications } from './optionAbortNotifications.js';

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
type Lifecycle = NonNullable<NonNullable<LedgerEvent['settlement']>['optionLifecycle']>;
type Evidence = NonNullable<LedgerEvent['movements'][number]['evidence']>;
const positive = (v: string | null | undefined) => v !== null && v !== undefined && BigInt(v) > 0n;
const refKey = (r: { account: string; lt: string; hash: string }) => `${r.account}:${r.lt}:${r.hash}`;
function historical(e: Evidence | undefined, account: string, all: NonNullable<LedgerEvent['settlement']>['evidence']) {
  return !!e?.stateBeforeHash && !!e.stateAfterHash && e.beforeSeqno !== undefined && e.afterSeqno !== undefined && e.afterSeqno >= e.beforeSeqno &&
    !!e.transactions?.length && new Set(e.transactions.map(refKey)).size === e.transactions.length &&
    e.transactions.some(r => r.account === account) && e.transactions.every(r => all.some(a => refKey(a) === refKey(r)));
}
function exercisedPosition(event: LedgerEvent, l: Lifecycle) {
  const all = event.settlement!.evidence, b = l.beforePosition, a = l.afterPosition, pb = l.productBefore, pa = l.productAfter;
  if (!l.series || l.seriesId === undefined || l.positionId === undefined || !l.productCodeHash || !l.originalRequestBodyHash || !l.vault || !l.vaultCodeHash ||
    ![1, 2].includes(l.optionKind ?? 0) || l.outcome !== 'exercised' || !b || !a || !pb || !pa || l.payout.amountRaw === null ||
    (l.payout.status === 'none' && l.payout.amountRaw !== '0') ||
    !historical(l.positionEvidence, l.factory, all) || !historical(l.requestEvidence, l.factory, all) || !historical(l.productEvidence, l.series, all)) return false;
  if (b.owner !== l.owner || a.owner !== b.owner || b.settled || !a.settled || !positive(b.notionalRaw) || !positive(b.collateralRaw) || a.collateralRaw !== '0' ||
    a.notionalRaw !== b.notionalRaw || a.sourceWallet !== b.sourceWallet || a.seriesWireId !== b.seriesWireId || a.custodyWireId !== b.custodyWireId ||
    !positive(b.seriesWireId) || !positive(b.custodyWireId) || (BigInt(b.buyStateRaw) & 525n) !== 525n || (BigInt(a.buyStateRaw) & 525n) !== 525n ||
    ((BigInt(b.buyStateRaw) | BigInt(a.buyStateRaw)) & (16n | 32n | 128n)) !== 0n || BigInt(l.payout.amountRaw) > BigInt(b.collateralRaw) ||
    l.premiumAccountingReleasedRaw === undefined || BigInt(a.premiumRaw) + BigInt(l.premiumAccountingReleasedRaw) !== BigInt(b.premiumRaw) ||
    l.collateralLiabilityReleasedRaw === undefined || BigInt(l.collateralLiabilityReleasedRaw) + BigInt(l.payout.amountRaw) !== BigInt(b.collateralRaw) ||
    a.settlementReady !== false || a.settlementPayoutRaw !== '0' ||
    l.requestEvidence!.stateBeforeHash !== b.dataHash || l.positionEvidence!.stateAfterHash !== a.dataHash ||
    l.requestEvidence!.bodyHash !== l.originalRequestBodyHash || l.positionEvidence!.bodyHash !== l.originalRequestBodyHash ||
    l.productEvidence!.stateBeforeHash !== pb.dataHash || l.productEvidence!.stateAfterHash !== pa.dataHash) return false;
  if ([pb, pa].some(p => p.manager !== l.factory || p.vault !== l.vault || p.seriesId !== l.seriesId) || !pb.position ||
    pb.position.owner !== l.owner || pb.position.tokenId !== l.positionId || !pb.position.active || pb.position.exercised ||
    pb.position.buyWireId !== b.seriesWireId || pb.position.notionalRaw !== b.notionalRaw || pb.position.premiumRaw !== b.premiumRaw || pb.position.collateralRaw !== b.collateralRaw) return false;
  if (l.optionKind === 1 ? pb.position.settled || pa.position !== null : !pb.position.settled || !pa.position?.exercised || !pa.position.settled ||
    pa.position.owner !== l.owner || pa.position.tokenId !== l.positionId || pa.position.notionalRaw !== pb.position.notionalRaw ||
    pa.position.premiumRaw !== pb.position.premiumRaw || pa.position.collateralRaw !== pb.position.collateralRaw ||
    pa.position.buyWireId !== pb.position.buyWireId || pa.position.active !== pb.position.active ||
    pa.position.payoutRaw !== pb.position.payoutRaw || pb.position.payoutRaw !== l.payout.amountRaw) return false;
  return true;
}
function rightRetired(event: LedgerEvent, l: Lifecycle) {
  if (event.account !== l.owner || !exercisedPosition(event, l)) return false;
  const all = event.settlement!.evidence, rights = event.movements.filter(m => m.purpose === 'option_right_retired');
  return rights.length === 1 && rights[0]!.direction === 'out' && rights[0]!.amountRaw === '1' && rights[0]!.asset.kind === 'option_position' &&
    rights[0]!.asset.id === `${event.network}:option-position:${l.factory}:${l.seriesId}:${l.positionId}` && rights[0]!.asset.factory === l.factory &&
    rights[0]!.asset.series === l.series && rights[0]!.asset.seriesId === l.seriesId && rights[0]!.asset.positionId === l.positionId &&
    rights[0]!.asset.owner === l.owner && rights[0]!.asset.decimals === 0 && rights[0]!.source === l.owner && rights[0]!.destination === l.factory &&
    rights[0]!.evidence?.kind === 'option_position_delta' && rights[0]!.evidence.bodyHash === l.originalRequestBodyHash &&
    rights[0]!.evidence.stateAfterHash === l.afterPosition!.dataHash && historical(rights[0]!.evidence, l.factory, all);
}
function cashCredited(event: LedgerEvent, l: Lifecycle, purpose: 'option_payout' | 'option_refund', authority: string) {
  const p = l.payout, all = event.settlement!.evidence;
  if (event.account !== l.recipient || event.issues.includes('option_identity_or_cash_settlement_unverified') ||
    p.status !== 'completed' || !positive(p.amountRaw) || !positive(p.wireId) || !p.sourceWallet || !p.destinationWallet || p.evidence.length < 6 ||
    new Set(p.evidence.map(refKey)).size !== p.evidence.length || !p.evidence.every(r => all.some(a => refKey(a) === refKey(r))) ||
    ![p.sourceWallet, p.destinationWallet, authority].every(account => p.evidence.some(r => r.account === account))) return false;
  const credits = event.movements.filter(m => m.purpose === purpose);
  return credits.length === 1 && credits[0]!.direction === 'in' && credits[0]!.amountRaw === p.amountRaw && credits[0]!.asset.kind === 'jetton' &&
    credits[0]!.asset.id === `${event.network}:jetton:${l.root}` && credits[0]!.asset.master === l.root && credits[0]!.asset.owner === l.recipient &&
    credits[0]!.asset.wallet === p.destinationWallet && credits[0]!.destination === l.recipient && credits[0]!.source === authority &&
    credits[0]!.evidence?.kind === purpose && credits[0]!.evidence.queryId === p.wireId &&
    typeof credits[0]!.evidence.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(credits[0]!.evidence.bodyHash) &&
    historical(credits[0]!.evidence, authority, all) &&
    p.evidence.every(r => credits[0]!.evidence!.transactions!.some(a => refKey(a) === refKey(r)));
}
function exerciseCash(event: LedgerEvent, l: Lifecycle) {
  const p = l.payout, b = p.beforeJournal, a = p.afterJournal;
  if (l.seriesId === undefined || l.positionId === undefined || BigInt(l.seriesId) >= 1n << 64n || BigInt(l.positionId) >= 1n << 64n) return false;
  const key = beginCell().storeUint(1, 8).storeUint(BigInt(l.seriesId), 64).storeUint(BigInt(l.positionId), 64).endCell().hash().toString('hex');
  return !!l.vault && cashCredited(event, l, 'option_payout', l.vault) && !!p.journalKey && !!p.requestHash && !!b && !!a &&
    p.journalKey === key && b.status === 3 && a.status === 4 && [b, a].every(j => j.kind === 1 && j.requestId === l.positionId && j.seriesId === l.seriesId &&
      j.wireId === p.wireId && j.requestHash === p.requestHash && j.recipient === l.recipient && j.destinationWallet === p.destinationWallet &&
      j.amountRaw === p.amountRaw && j.lockedDeltaRaw === p.amountRaw && j.premiumDeltaRaw === l.premiumAccountingReleasedRaw && j.finalizeReservedRaw === '0');
}
/** Independent stages have independent durable keys. Exercise has no user query ID. */
export function optionLifecycleNotifications(event: LedgerEvent, common: Common): NewNotification[] {
  const s = event.settlement, l = s?.optionLifecycle;
  if (l?.refund?.kind === 'aborted_buy') return optionAbortNotifications(event, common);
  if (event.status !== 'success' || s?.status !== 'confirmed' || s.protocol !== 'options' || event.kind !== s.operation || !l ||
    ![l.owner, l.recipient].includes(event.account) || new Set(s.evidence.map(refKey)).size !== s.evidence.length ||
    event.issues.some(issue => issue.startsWith('option_') && !['option_payout_settlement_pending', 'option_risk_reimbursement_unverified',
      'option_identity_or_cash_settlement_unverified'].includes(issue))) return [];
  const notice = (sourceEventId: string, title: string, body: string, refs: NonNullable<LedgerEvent['settlement']>['evidence']): NewNotification => ({ ...stageTime(common, refs, s.evidence), category: 'activity', sourceEventId, title, body,
    evidence: { ...stageTime(common, refs, s.evidence).evidence, settlement: s, movements: event.movements } });
  if (s.operation === 'option_exercise') {
    if (!exercisedPosition(event, l)) return [];
    const notices: NewNotification[] = [];
    if (rightRetired(event, l)) notices.push(notice(`option:${l.factory}:${l.seriesId}:${l.positionId}:${l.originalRequestBodyHash}:exercised`, 'Option exercise confirmed',
      'Your option right was retired on-chain.' + (l.payout.status === 'none' ? ' This exercise has no cash payout.' : ' Cash delivery is tracked separately.'), [...l.requestEvidence!.transactions, ...l.positionEvidence!.transactions, ...l.productEvidence!.transactions]));
    if (exerciseCash(event, l)) notices.push(notice(`option:${l.factory}:${l.seriesId}:${l.positionId}:${l.payout.journalKey}:${l.payout.wireId}:${l.payout.requestHash}:paid`,
      'Option payout confirmed', 'The exact option payout was credited to the designated recipient.' +
      (l.protocolAccounting.status === 'unverified' ? ' Separate protocol accounting remains unverified.' : ''), l.payout.evidence));
    return notices;
  }
  const r = l.refund, c = r?.beforeClaim;
  if (s.operation !== 'option_refund' || l.outcome !== 'refunded' || !r || r.scope !== 'individual_claim' || !['ingress', 'excess'].includes(r.kind) ||
    !c || !positive(r.claimId) || !r.identityHash || c.claimId !== r.claimId || c.identityHash !== r.identityHash || c.kind !== (r.kind === 'ingress' ? 1 : 3) ||
    c.status !== 3 || c.owner !== l.owner || c.recipient !== l.recipient || c.amountRaw !== l.payout.amountRaw || c.wireId !== l.payout.wireId || c.finalizeWireId !== c.wireId ||
    !historical(l.positionEvidence, l.factory, s.evidence) || !cashCredited(event, l, 'option_refund', l.factory)) return [];
  return [notice(`option-refund:${l.factory}:${r.kind}:${r.claimId}:${r.identityHash}:${l.payout.wireId}`, 'Option refund received',
    `Your ${r.kind === 'ingress' ? 'incoming purchase funding' : 'excess purchase funding'} refund claim was credited to its recipient. This confirms this individual claim only.`, l.payout.evidence)];
}
