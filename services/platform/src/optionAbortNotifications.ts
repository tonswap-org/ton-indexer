import { stageTime } from './notificationEvidence.js';
import { Address, beginCell, Cell } from '@ton/core';
import { isDeepStrictEqual } from 'node:util';
import type { LedgerEvent } from './ledger.js';
import type { NewNotification } from './store.js';

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
type Settlement = NonNullable<LedgerEvent['settlement']>;
type Lifecycle = NonNullable<Settlement['optionLifecycle']>;
type Unwind = NonNullable<NonNullable<Lifecycle['refund']>['unwind']>;
type Historical = Unwind['funding']['stateEvidence'];
type Cash = Unwind['factoryReturn'];
type Ref = Settlement['evidence'][number];
const key = (r: Ref) => `${r.account}:${r.lt}:${r.hash}`;
const uint = (v: string | null | undefined, bits: number, positive = false): v is string =>
  typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && BigInt(v) >= (positive ? 1n : 0n) && BigInt(v) < 1n << BigInt(bits);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function refs(items: Ref[], all: Ref[], minimum = 1) {
  return items.length >= minimum && new Set(items.map(key)).size === items.length &&
    items.every(r => uint(r.lt, 64, true) && all.some(a => key(a) === key(r)));
}
function historical(e: Historical | undefined, account: string, all: Ref[]): e is Historical {
  return !!e && e.kind === 'option_position_delta' && e.afterSeqno >= e.beforeSeqno && refs(e.transactions, all) &&
    e.transactions.some(r => r.account === account);
}
function sameHistory(a: Historical | undefined, b: Historical | undefined) {
  return !!a && !!b && a.stateBeforeHash === b.stateBeforeHash && a.stateAfterHash === b.stateAfterHash &&
    a.beforeSeqno === b.beforeSeqno && a.afterSeqno === b.afterSeqno;
}
const baseId = (l: Lifecycle, u: Unwind) => `option-abort:${l.factory}:${l.seriesId}:${l.positionId}:${u.funding.requestBodyHash}`;

function initialBuyBounced(event: LedgerEvent, l: Lifecycle, u: Unwind) {
  const trigger = u.trigger, b = l.beforePosition, pb = l.productBefore, pa = l.productAfter, all = event.settlement!.evidence;
  if (trigger.kind !== 'initial_series_buy_bounced' || !b || !pb || !pa || !l.series || !l.seriesId || !l.positionId ||
    b.buyStateRaw !== '0' || u.reservationStatus !== 'failed' || pb.position !== null || pa.position !== null ||
    !uint(trigger.wireId, 64, true) || trigger.wireId !== b.seriesWireId || trigger.opcode !== (l.optionKind === 1 ? 0x424f5952 : 0x42425559) ||
    trigger.failedTransaction.account !== l.series || trigger.recoveryTransaction.account !== l.factory ||
    !refs([trigger.failedTransaction, trigger.recoveryTransaction], all, 2) ||
    BigInt(trigger.failedTransaction.lt) <= BigInt(u.funding.evidence[2]!.lt) ||
    BigInt(trigger.recoveryTransaction.lt) <= BigInt(trigger.failedTransaction.lt) ||
    u.reservationEvidence.length !== 1 || key(u.reservationEvidence[0]!) !== key(trigger.failedTransaction) ||
    u.reservationStateEvidence.transactions.length !== 1 || key(u.reservationStateEvidence.transactions[0]!) !== key(trigger.failedTransaction) ||
    u.reservationStateEvidence.stateBeforeHash !== u.reservationStateEvidence.stateAfterHash ||
    u.reservationStateEvidence.bodyHash !== trigger.originalMessageBodyHash ||
    !historical(l.productEvidence, l.series, all) || !sameHistory(l.productEvidence, u.reservationStateEvidence) ||
    l.productEvidence.bodyHash !== trigger.originalMessageBodyHash ||
    l.productEvidence.stateBeforeHash !== pb.dataHash || l.productEvidence.stateAfterHash !== pa.dataHash ||
    l.productEvidence.transactions.length !== 1 || key(l.productEvidence.transactions[0]!) !== key(trigger.failedTransaction) ||
    !historical(l.requestEvidence, l.factory, all) || l.requestEvidence.bodyHash !== trigger.bodyHash ||
    l.requestEvidence.transactions.length !== 1 || key(l.requestEvidence.transactions[0]!) !== key(trigger.recoveryTransaction) ||
    u.cancellation.status !== 'completed' || !historical(u.cancellation.stateEvidence, l.factory, all) ||
    !sameHistory(u.cancellation.stateEvidence, l.requestEvidence) || u.cancellation.stateEvidence.bodyHash !== trigger.bodyHash ||
    u.cancellation.stateEvidence.transactions.length !== 1 || key(u.cancellation.stateEvidence.transactions[0]!) !== key(trigger.recoveryTransaction) ||
    u.cancellation.evidence.length !== 2 || key(u.cancellation.evidence[0]!) !== key(trigger.failedTransaction) ||
    key(u.cancellation.evidence[1]!) !== key(trigger.recoveryTransaction)) return false;
  const { seriesBuyIndexBefore, seriesBuyIndexAfter, beforeSeries, afterSeries } = trigger.factoryUnwind;
  if (!uint(seriesBuyIndexBefore, 128, true) || BigInt(seriesBuyIndexBefore) !== (BigInt(l.seriesId) << 64n | BigInt(l.positionId)) ||
    seriesBuyIndexAfter !== null || [beforeSeries, afterSeries].some(series => series.kind !== l.optionKind || series.optionAddress !== l.series ||
      !uint(series.openNotionalRaw, 120) || !uint(series.collateralLockedRaw, 120)) ||
    BigInt(beforeSeries.openNotionalRaw) - BigInt(afterSeries.openNotionalRaw) !== BigInt(b.notionalRaw) ||
    BigInt(beforeSeries.collateralLockedRaw) - BigInt(afterSeries.collateralLockedRaw) !== BigInt(b.collateralRaw)) return false;
  try {
    const body = Cell.fromBase64(trigger.bodyBoc), cursor = body.beginParse();
    const original = beginCell().storeUint(trigger.opcode, 32).storeUint(BigInt(trigger.wireId), 64).storeAddress(Address.parse(l.owner))
      .storeUint(BigInt(l.positionId), 64).storeCoins(BigInt(b.notionalRaw)).storeCoins(BigInt(b.premiumRaw)).storeCoins(BigInt(b.collateralRaw)).endCell();
    const expected = beginCell().storeUint(0xffffffff, 32).storeBits(original.beginParse().loadBits(256)).endCell();
    return original.hash().toString('hex') === trigger.originalMessageBodyHash && body.hash().toString('hex') === trigger.bodyHash &&
      cursor.remainingRefs === 0 && cursor.remainingBits === 288 && body.equals(expected) &&
      cursor.loadUint(32) === 0xffffffff && cursor.loadUint(32) === trigger.opcode && cursor.loadUintBig(64).toString() === trigger.wireId;
  } catch { return false; }
}

/** Explicit qualified unwind triggers establish scope. Only independently
 * finalized physical cash legs earn receipt notifications. */
function originalAborted(event: LedgerEvent, l: Lifecycle, u: Unwind) {
  const s = event.settlement!, b = l.beforePosition, a = l.afterPosition, f = u.funding, all = s.evidence;
  if (event.status !== 'success' || event.kind !== 'option_refund' || s.protocol !== 'options' || s.operation !== event.kind ||
    l.refund?.kind !== 'aborted_buy' || l.refund.scope !== 'position_unwind' || l.owner !== event.account || l.recipient !== l.owner ||
    !l.series || !l.vault || !l.vaultCodeHash || !l.productCodeHash || ![1, 2].includes(l.optionKind ?? 0) ||
    !uint(l.seriesId, 64, true) || !uint(l.positionId, 64, true) || !uint(f.queryId, 64, true) || s.queryId !== f.queryId ||
    l.refund.queryId !== f.queryId || !uint(f.amountRaw, 120, true) || l.originalRequestBodyHash !== f.requestBodyHash ||
    l.refund.payloadHash !== f.payloadHash || !refs(all, all) ||
    event.issues.some(i => !['option_abort_return_pending', 'option_abort_risk_accounting_unverified', 'transaction_fee_unavailable'].includes(i)) ||
    !b || !a || !historical(l.requestEvidence, l.factory, all) || l.requestEvidence.stateBeforeHash !== b.dataHash ||
    !historical(f.stateEvidence, l.factory, all) || f.stateEvidence.afterSeqno > l.requestEvidence.beforeSeqno ||
    !refs(f.evidence, all, 3) || f.evidence.length !== 3 || f.evidence[0]!.account !== f.ownerWallet ||
    f.evidence[1]!.account !== f.factoryWallet || f.evidence[2]!.account !== l.factory ||
    f.stateEvidence.transactions.length !== 1 || key(f.stateEvidence.transactions[0]!) !== key(f.evidence[2]!)) return false;
  if (b.owner !== l.owner || b.refundOwner !== l.owner || b.sourceWallet !== f.factoryWallet || b.settled || b.settlementReady !== false || b.settlementPayoutRaw !== '0' ||
    !uint(b.notionalRaw, 120, true) || !uint(b.collateralRaw, 120, true) || !uint(b.premiumRaw, 120) ||
    !uint(b.protocolFeeRaw, 120) || !uint(b.excessRaw, 120) || !uint(b.seriesWireId, 64, true) || !uint(b.custodyWireId, 64, true) ||
    !uint(b.buyStateRaw, 16) || u.beforeAbortBuyStateRaw !== b.buyStateRaw || (BigInt(b.buyStateRaw) & ~(1n | 4n | 8n)) !== 0n ||
    BigInt(f.amountRaw) !== BigInt(b.collateralRaw) + BigInt(b.premiumRaw) + BigInt(b.protocolFeeRaw) + BigInt(b.excessRaw) ||
    ['owner', 'refundOwner', 'sourceWallet', 'notionalRaw', 'collateralRaw', 'premiumRaw', 'protocolFeeRaw', 'excessRaw', 'seriesWireId', 'custodyWireId']
      .some(field => a[field] !== b[field]) || !a.settled || a.settlementReady !== false || a.settlementPayoutRaw !== '0' ||
    !uint(a.buyStateRaw, 16) || (BigInt(a.buyStateRaw) & (16n | 32n)) !== (16n | 32n) || (BigInt(a.buyStateRaw) & (512n | 2n | 256n)) !== 0n ||
    !historical(l.positionEvidence, l.factory, all) || l.positionEvidence.stateAfterHash !== a.dataHash) return false;
  const funding = event.movements.filter(m => m.direction === 'out' && m.asset.kind === 'jetton' && m.asset.master === l.root);
  if (funding.length !== 1 || funding[0]!.amountRaw !== f.amountRaw || funding[0]!.asset.id !== `${event.network}:jetton:${l.root}` ||
    funding[0]!.asset.owner !== l.owner || funding[0]!.asset.wallet !== f.ownerWallet || funding[0]!.source !== l.owner || funding[0]!.destination !== l.factory ||
    funding[0]!.evidence?.kind !== 'jetton_transfer' || funding[0]!.evidence.requestBodyHash !== f.requestBodyHash || funding[0]!.evidence.queryId !== f.queryId ||
    funding[0]!.evidence.transactions?.length !== 2 || !funding[0]!.evidence.transactions.every((r, i) => key(r) === key(f.evidence[i]!)) ||
    event.movements.some(m => m.asset.kind === 'option_position')) return false;
  const pb = l.productBefore, pa = l.productAfter, cancellation = u.cancellation;
  if (!pb || !pa || !historical(u.reservationStateEvidence, l.series, all) || !refs(u.reservationEvidence, all) ||
    !u.reservationEvidence.every(r => r.account === l.series && u.reservationStateEvidence.transactions.some(a => key(a) === key(r))) ||
    u.reservationStateEvidence.stateAfterHash !== pb.dataHash ||
    [pb, pa].some(p => p.manager !== l.factory || p.vault !== l.vault || p.seriesId !== l.seriesId) || pa.position !== null) return false;
  if (u.reservationStatus === 'failed' ? pb.position !== null || u.reservationStateEvidence.stateBeforeHash !== u.reservationStateEvidence.stateAfterHash :
    !pb.position || pb.position.active || pb.position.exercised || pb.position.owner !== l.owner || pb.position.tokenId !== l.positionId ||
    pb.position.notionalRaw !== b.notionalRaw || pb.position.premiumRaw !== b.premiumRaw || pb.position.collateralRaw !== b.collateralRaw || pb.position.buyWireId !== b.seriesWireId) return false;
  if (u.trigger.kind === 'owner_abort') {
    const abortHash = beginCell().storeUint(0x4f424152, 32).storeUint(BigInt(l.seriesId), 64).storeUint(BigInt(l.positionId), 64).endCell().hash().toString('hex');
    if (u.trigger.bodyHash !== abortHash || l.requestEvidence.bodyHash !== abortHash || cancellation.status !== 'completed' ||
      !historical(cancellation.stateEvidence, l.series, all) || !historical(l.productEvidence, l.series, all) ||
      !sameHistory(cancellation.stateEvidence, l.productEvidence) || l.productEvidence.stateBeforeHash !== pb.dataHash ||
      l.productEvidence.stateAfterHash !== pa.dataHash || !refs(cancellation.evidence, all, 3) || cancellation.evidence.length !== 3 ||
      cancellation.evidence[0]!.account !== l.factory || cancellation.evidence[1]!.account !== l.series || cancellation.evidence[2]!.account !== l.factory) return false;
  } else if (!initialBuyBounced(event, l, u)) return false;
  const transferred = (BigInt(b.buyStateRaw) & 4n) !== 0n;
  const vaultAmount = transferred ? BigInt(b.premiumRaw) + BigInt(b.collateralRaw) : 0n;
  if (u.custody.amountRaw !== String(vaultAmount) || u.vaultReturn.amountRaw !== String(vaultAmount) ||
    u.factoryReturn.amountRaw !== String(BigInt(f.amountRaw) - vaultAmount) || l.payout.amountRaw !== f.amountRaw) return false;
  if (!transferred) return u.custody.status === 'not_transferred' && !u.commit && !u.vaultAbort &&
    u.vaultReturn.status === 'none' && u.vaultReturn.evidence.length === 0 && (BigInt(b.buyStateRaw) & ~1n) === 0n;
  const custody = u.custody, commit = u.commit, abort = u.vaultAbort;
  if (custody.status !== 'proven' || custody.wireId !== b.custodyWireId || !historical(custody.stateEvidence, l.factory, all) ||
    !refs(custody.evidence, all, 7) || custody.evidence[0]!.account !== l.factory || custody.evidence[1]!.account !== f.factoryWallet ||
    custody.evidence.at(-1)!.account !== l.factory || custody.stateEvidence.transactions.length !== 1 ||
    key(custody.stateEvidence.transactions[0]!) !== key(custody.evidence.at(-1)!) ||
    !commit || !refs(commit.evidence, all) || key(commit.evidence[0]!) !== key(custody.evidence.at(-1)!) ||
    !abort || !historical(abort.stateEvidence, l.vault, all) || !refs(abort.evidence, all) || abort.evidence.length !== 1 ||
    abort.evidence[0]!.account !== l.vault || abort.stateEvidence.transactions.length !== 1 ||
    key(abort.stateEvidence.transactions[0]!) !== key(abort.evidence[0]!) ||
    BigInt(abort.evidence[0]!.lt) <= BigInt(custody.evidence.at(-1)!.lt) ||
    !uint(abort.trackedBalanceBeforeRaw, 120) || !uint(abort.trackedBalanceAfterRaw, 120) ||
    (BigInt(a.buyStateRaw) & 1024n) === 0n) return false;
  const vaultWallet = custody.evidence[2]!.account;
  const receipt = beginCell().storeUint(BigInt(l.seriesId), 64).storeUint(BigInt(l.positionId), 64).storeUint(BigInt(b.custodyWireId), 64)
    .storeCoins(BigInt(b.collateralRaw)).storeCoins(BigInt(b.premiumRaw)).storeAddress(Address.parse(vaultWallet)).endCell().hash().toString('hex');
  const abortReceipt = beginCell().storeUint(0x4f424142, 32).storeUint(BigInt(`0x${receipt}`), 256).endCell().hash().toString('hex');
  const refund = beginCell().storeUint(0x4f424142, 32).storeUint(BigInt(l.seriesId), 64).storeUint(BigInt(l.positionId), 64).storeUint(BigInt(b.custodyWireId), 64)
    .storeCoins(vaultAmount).storeAddress(Address.parse(l.recipient)).storeUint(BigInt(`0x${receipt}`), 256).endCell().hash().toString('hex');
  const journal = beginCell().storeUint(3, 8).storeUint(BigInt(l.seriesId), 64).storeUint(BigInt(b.custodyWireId), 64).endCell().hash().toString('hex');
  if (abort.receiptHash !== receipt || abort.abortHash !== abortReceipt || abort.requestHash !== refund || abort.journalKey !== journal ||
    abort.receiptAfterHash !== abortReceipt || abort.stateEvidence.stateBeforeHash === abort.stateEvidence.stateAfterHash) return false;
  // These are separate transactions on a shared vault. Unrelated activity can
  // change its whole state between them; bind each proof to its own transaction.
  if (commit.status === 'committed') return commit.evidence.length === 2 && commit.evidence[1]!.account === l.vault &&
    historical(commit.stateEvidence, l.vault, all) && commit.stateEvidence.transactions.length === 1 &&
    key(commit.stateEvidence.transactions[0]!) === key(commit.evidence[1]!) &&
    commit.stateEvidence.stateBeforeHash !== commit.stateEvidence.stateAfterHash &&
    BigInt(commit.evidence[1]!.lt) > BigInt(custody.evidence.at(-1)!.lt) &&
    BigInt(abort.evidence[0]!.lt) > BigInt(commit.evidence[1]!.lt) && abort.receiptBeforeHash === receipt &&
    abort.trackedBalanceBeforeRaw === abort.trackedBalanceAfterRaw &&
    !!abort.beforeBucket && !!abort.afterBucket &&
    BigInt(abort.beforeBucket.lockedRaw) - BigInt(abort.afterBucket.lockedRaw) === BigInt(b.collateralRaw) &&
    BigInt(abort.beforeBucket.premiumRaw) - BigInt(abort.afterBucket.premiumRaw) === BigInt(b.premiumRaw);
  // Orphan custody is established by the exact abort boundary: no original
  // receipt, a new tombstone, and newly tracked principal. Commit flags or the
  // aggregate payout cannot substitute for these facts or finalized cash below.
  if (abort.receiptBeforeHash !== null || !isDeepStrictEqual(abort.beforeBucket, abort.afterBucket) ||
    BigInt(abort.trackedBalanceAfterRaw) - BigInt(abort.trackedBalanceBeforeRaw) !== vaultAmount) return false;
  if (commit.status === 'unobserved') return commit.evidence.length === 1 && commit.stateEvidence === undefined;
  return commit.status === 'failed' && commit.evidence.length === 2 && commit.evidence[1]!.account === l.vault &&
    historical(commit.stateEvidence, l.vault, all) && commit.stateEvidence.transactions.length === 1 &&
    key(commit.stateEvidence.transactions[0]!) === key(commit.evidence[1]!) &&
    commit.stateEvidence.stateBeforeHash === commit.stateEvidence.stateAfterHash &&
    BigInt(commit.evidence[1]!.lt) > BigInt(custody.evidence.at(-1)!.lt) &&
    BigInt(abort.evidence[0]!.lt) > BigInt(commit.evidence[1]!.lt);
}
function credited(event: LedgerEvent, l: Lifecycle, u: Unwind, lane: 'factory' | 'vault') {
  const p: Cash = lane === 'factory' ? u.factoryReturn : u.vaultReturn, authority = lane === 'factory' ? l.factory : l.vault!;
  const all = event.settlement!.evidence;
  if (p.status !== 'completed' || !uint(p.amountRaw, 120, true) || !uint(p.wireId, 64, true) ||
    p.sourceWallet !== (lane === 'factory' ? u.funding.factoryWallet : u.custody.evidence[2]?.account) || p.destinationWallet !== u.funding.ownerWallet ||
    !refs(p.evidence, all, 7) || p.evidence[0]!.account !== authority || p.evidence[1]!.account !== p.sourceWallet || p.evidence[2]!.account !== p.destinationWallet ||
    p.evidence.at(-1)!.account !== authority || !historical(p.stateEvidence, authority, all)) return null;
  const credits = event.movements.filter(m => m.purpose === 'option_refund' && m.source === authority);
  if (credits.length !== 1) return null;
  const m = credits[0]!, e = m.evidence;
  if (m.direction !== 'in' || m.amountRaw !== p.amountRaw || m.asset.kind !== 'jetton' || m.asset.id !== `${event.network}:jetton:${l.root}` ||
    m.asset.master !== l.root || m.asset.owner !== l.owner || m.asset.wallet !== p.destinationWallet || m.destination !== l.recipient ||
    e?.kind !== 'option_refund' || e.queryId !== p.wireId || !hex(e.requestBodyHash) || !hex(e.bodyHash) ||
    !sameHistory(e as Historical, p.stateEvidence) || e.transactions?.length !== p.evidence.length ||
    !e.transactions.every((r, i) => key(r) === key(p.evidence[i]!))) return null;
  if (lane === 'factory') {
    const a = l.afterPosition!;
    if (a.refundWireId !== p.wireId || a.walletFundingRaw !== '0' || (BigInt(a.buyStateRaw) & 128n) === 0n ||
      (BigInt(a.buyStateRaw) & (64n | 8192n | 16384n)) !== 0n || p.stateEvidence.stateAfterHash !== a.dataHash ||
      !sameHistory(l.positionEvidence, p.stateEvidence)) return null;
  } else {
    const b = p.beforeJournal, a = p.afterJournal, abort = u.vaultAbort!;
    if (!b || !a || b.status !== 3 || a.status !== 4 || b.accountingApplied !== 0 || a.accountingApplied !== 1 ||
      p.requestHash !== abort.requestHash || p.journalKey !== abort.journalKey ||
      [b, a].some(j => j.kind !== 3 || j.requestId !== u.custody.wireId || j.seriesId !== l.seriesId || j.wireId !== p.wireId ||
        j.requestHash !== abort.requestHash || j.recipient !== l.recipient || j.destinationWallet !== p.destinationWallet ||
        j.amountRaw !== p.amountRaw || j.lockedDeltaRaw !== '0' || j.premiumDeltaRaw !== '0' || j.finalizeReservedRaw !== '0')) return null;
  }
  return { movement: m, id: `${baseId(l, u)}:${lane}:${p.wireId}:${e.requestBodyHash}` };
}
export function optionAbortNotifications(event: LedgerEvent, common: Common): NewNotification[] {
  const l = event.settlement?.optionLifecycle, u = l?.refund?.unwind;
  if (!l || !u || !originalAborted(event, l, u)) return [];
  const notices: NewNotification[] = [];
  const notice = (sourceEventId: string, title: string, body: string, refs: NonNullable<LedgerEvent['settlement']>['evidence']): NewNotification => ({ ...stageTime(common, refs, event.settlement!.evidence), category: 'activity', sourceEventId, title, body,
    evidence: { ...stageTime(common, refs, event.settlement!.evidence).evidence, settlement: event.settlement, movements: event.movements } });
  const factory = credited(event, l, u, 'factory'), vault = credited(event, l, u, 'vault');
  const purchase = u.trigger.kind === 'initial_series_buy_bounced' ? 'failed option purchase' : 'cancelled option purchase';
  if (factory) notices.push(notice(factory.id, 'Option factory refund received', `The factory return for your ${purchase} was credited to your wallet. This confirms the factory return only.`, u.factoryReturn.evidence));
  if (vault) notices.push(notice(vault.id, 'Option vault refund received', `The vault return for your ${purchase} was credited to your wallet. This confirms the vault return only.`, u.vaultReturn.evidence));
  const done = (p: Cash, cash: unknown) => p.status === 'none' ? p.amountRaw === '0' && p.evidence.length === 0 : !!cash;
  if (event.settlement!.status === 'confirmed' && l.outcome === 'refunded' && l.payout.status === 'completed' &&
    done(u.factoryReturn, factory) && done(u.vaultReturn, vault) &&
    refs(l.payout.evidence, event.settlement!.evidence) && l.payout.evidence.length === u.factoryReturn.evidence.length + u.vaultReturn.evidence.length &&
    [...u.factoryReturn.evidence, ...u.vaultReturn.evidence].every(r => l.payout.evidence.some(a => key(a) === key(r))))
    notices.push(notice(`${baseId(l, u)}:complete`, 'Option purchase refund complete', `All required token returns for your ${purchase} were credited to your wallet.` +
      (l.protocolAccounting.status === 'unverified' ? ' Separate protocol accounting remains unverified.' : ''), l.payout.evidence));
  return notices;
}
