import { Cell } from '@ton/core';
import type { LedgerEvent } from './ledger.js';
import type { NewNotification } from './store.js';
import { stageTime } from './notificationEvidence.js';

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
type Settlement = NonNullable<LedgerEvent['settlement']>;
type Movement = LedgerEvent['movements'][number];
type Cash = { direction: 'in' | 'out'; amountRaw: string; wallet: string; otherOwner: string;
  ownerTransaction: string; debitTransaction: string; creditTransaction: string; root?: string };
const hex = (hash: string) => Buffer.from(hash, 'base64').toString('hex');
const positive = (value: string | null | undefined) => value != null && BigInt(value) > 0n;
const total = (legs: readonly Cash[], direction: Cash['direction']) =>
  legs.filter(leg => leg.direction === direction).reduce((n, leg) => n + BigInt(leg.amountRaw), 0n);
function refsBound(movement: Movement, settlement: Settlement) {
  return !!movement.evidence?.transactions?.length && movement.evidence.transactions.every(ref =>
    settlement.evidence.some(s => s.account === ref.account && s.lt === ref.lt && s.hash === ref.hash && s.utime === ref.utime));
}
function cashBound(event: LedgerEvent, bodyHash: string, legs: Cash[]): boolean {
  const refs = event.settlement!.evidence, used = new Set<Movement>(), ids = new Set<string>();
  return legs.every(leg => {
    const ownerHash = leg.direction === 'in' ? leg.creditTransaction : leg.debitTransaction;
    const id = `${leg.debitTransaction}:${leg.creditTransaction}`;
    if (!positive(leg.amountRaw) || leg.ownerTransaction !== ownerHash || ids.has(id)) return false;
    ids.add(id);
    const debit = refs.find(ref => hex(ref.hash) === leg.debitTransaction);
    const credit = refs.find(ref => hex(ref.hash) === leg.creditTransaction);
    if (!debit || !credit || debit.account === credit.account ||
      (leg.direction === 'in' ? credit : debit).account !== leg.wallet) return false;
    const matches = event.movements.filter(m => m.direction === leg.direction && m.amountRaw === leg.amountRaw &&
      m.asset.kind === 'jetton' && m.asset.owner === event.account && m.asset.wallet === leg.wallet &&
      typeof m.asset.master === 'string' && (!leg.root || m.asset.master === leg.root) &&
      m.asset.id === `${event.network}:jetton:${m.asset.master}` &&
      m.source === (leg.direction === 'out' ? event.account : leg.otherOwner) &&
      m.destination === (leg.direction === 'in' ? event.account : leg.otherOwner) &&
      (m.evidence?.kind === 'jetton_internal_transfer' ||
        m.evidence?.kind === 'jetton_transfer' && [debit, credit].every(legRef =>
          m.evidence!.transactions?.some(ref => ref.account === legRef.account && ref.lt === legRef.lt && ref.hash === legRef.hash))) &&
      m.evidence.requestBodyHash === bodyHash &&
      m.evidence.transactions?.some(ref => hex(ref.hash) === ownerHash && ref.account === leg.wallet) &&
      refsBound(m, event.settlement!));
    if (matches.length !== 1 || used.has(matches[0]!)) return false;
    used.add(matches[0]!); return true;
  });
}
function currentT3Notification(event: LedgerEvent, common: Common): NewNotification | null {
  const s = event.settlement!, t = s.t3!;
  if (s.status !== 'confirmed' || t.hub !== t.root || t.owner !== event.account || t.recipient !== event.account ||
    s.operation !== event.kind || (s.queryId !== undefined && s.queryId !== t.queryId) || !positive(t.amountRaw)) return null;
  const token = (m: Movement, root: string) => m.asset.kind === 'jetton' && m.asset.master === root &&
    m.asset.id === `${event.network}:jetton:${root}` && m.asset.owner === event.account && refsBound(m, s);
  let title: string, body: string, identity: string;
  if (t.walletRecovery) {
    const recovery = t.walletRecovery;
    if (!recovery.requestBodyHash || t.stage !== 'cancelled' || recovery.restoredRaw !== t.amountRaw || s.operation !== 't3_redeem' ||
      !s.evidence.some(ref => ref.account === recovery.wallet && ref.lt === recovery.originLt) ||
      event.movements.filter(m => token(m, t.root) && m.direction === 'in' && m.purpose === 't3_refund' &&
        m.amountRaw === recovery.restoredRaw && m.asset.wallet === recovery.wallet &&
        m.evidence?.kind === 't3_refund' && m.evidence.bodyHash === recovery.recoveryBodyHash).length !== 1) return null;
    title = 'T3 redemption cancelled'; body = 'The failed burn was cancelled and your T3 balance was restored.';
    identity = `${recovery.wallet}:${recovery.id}:${recovery.recoveryBodyHash}`;
  } else {
    const r = t.receipt;
    if (!r || !r.request.bodyHash || !r.request.sourceWallet || r.request.owner !== t.owner || r.request.queryId !== t.queryId ||
      r.request.amountRaw !== t.amountRaw || !s.evidence.some(ref => ref.account === t.hub) ||
      new Set(t.reserveRoots).size !== 3) return null;
    try { if (Cell.fromBase64(r.recordBoc).hash().toString('hex') !== r.hash) return null; } catch { return null; }
    const sums = (purpose: string, direction: 'in' | 'out', roots: string[]) => roots.map(root =>
      event.movements.filter(m => m.purpose === purpose && m.direction === direction && token(m, root))
        .reduce((n, m) => n + BigInt(m.amountRaw), 0n));
    const paid = sums(t.stage === 'refunded' ? 't3_refund' : 't3_payout', 'in', t.reserveRoots);
    const originalDebit = event.movements.some(m => m.direction === 'out' && m.amountRaw === r.request.amountRaw &&
      m.asset.wallet === r.request.sourceWallet && (t.stage === 'redeemed' ?
        m.purpose === 't3_burn' && token(m, t.root) :
        m.purpose === 't3_collateral' && t.reserveRoots.some(root => token(m, root))));
    if (!originalDebit) return null;
    if (t.stage === 'minted') {
      if (s.operation !== 't3_mint' || !positive(t.mintedRaw) || r.phase !== 2 ||
        event.movements.filter(m => token(m, t.root) && m.direction === 'in' && m.purpose === 't3_mint' &&
          m.amountRaw === t.mintedRaw && m.evidence?.kind === 't3_mint').length !== 1 ||
        !sums('t3_collateral', 'out', t.reserveRoots).every((n, i) => n === BigInt(t.basketRaw[i]!))) return null;
      title = 'T3 mint confirmed'; body = 'Your minted T3 was credited to your wallet.';
    } else if (['redeemed', 'refunded', 'swapped'].includes(t.stage)) {
      if (!paid.some(n => n > 0n) || !paid.every((n, i) => n === BigInt(t.deliveredRaw[i]!) && t.deliveredRaw[i] === t.basketRaw[i])) return null;
      if (t.stage === 'redeemed' && (s.operation !== 't3_redeem' ||
        event.movements.filter(m => token(m, t.root) && m.direction === 'out' && m.purpose === 't3_burn' &&
          m.amountRaw === t.amountRaw && m.evidence?.kind === 't3_burn').length !== 1)) return null;
      if (t.stage === 'refunded' && (r.phase !== 3 || !event.movements.some(m => m.direction === 'out' &&
        m.purpose === 't3_collateral' && t.reserveRoots.some(root => token(m, root)) && positive(m.amountRaw)))) return null;
      if (t.stage === 'swapped' && (s.operation !== 'swap' || r.phase !== 2)) return null;
      title = t.stage === 'redeemed' ? 'T3 redemption confirmed' : t.stage === 'refunded' ? 'T3 refund confirmed' : 'Reserve swap confirmed';
      body = t.stage === 'refunded' ? 'Your reserve refund was credited to your wallet.' : 'Your reserve tokens were credited to your wallet.';
    } else return null;
    // Receipt identity survives retries and projection generations.
    identity = `${t.hub}:${r.slot}:${r.key}`;
  }
  const timed = stageTime(common, s.evidence);
  return { ...timed, category: 'activity', sourceEventId: `current-t3:${identity}:${t.stage}`, title, body,
    evidence: { ...timed.evidence, settlement: s, movements: event.movements } };
}

/** undefined means this is not a current product record. A refused current
 * record returns null so it cannot fall through to a generic success notice. */
export function currentLedgerNotification(event: LedgerEvent, common: Common): NewNotification | null | undefined {
  const s = event.settlement;
  if (!s) return undefined;
  if (s.protocol === 't3') return s.t3 ? currentT3Notification(event, common) : s.operation === 'transfer' ? undefined : null;
  const records = [s.currentDlmm, s.currentPerps, s.currentOptions, s.currentLaunchpad].filter(v => v !== undefined);
  if (!records.length) return ['dlmm', 'perps', 'options', 'launchpad'].includes(s.protocol) ? null : undefined;
  if (records.length !== 1 || s.status !== 'confirmed' || event.kind !== s.operation) return null;
  const e = records[0]!;
  const refs = s.evidence, hashes = new Set(refs.map(ref => hex(ref.hash)));
  if (e.owner !== event.account || s.queryId !== e.queryId || e.outcome === 'unresolved' ||
    !refs.some(ref => ref.account === e.owner && ref.lt === e.dispatch.lt && hex(ref.hash) === e.dispatch.hash) ||
    hashes.size !== refs.length || new Set(e.evidenceHashes).size !== hashes.size || e.evidenceHashes.some(hash => !hashes.has(hash))) return null;
  let title: string, body = 'The operation was verified in the contract state.';
  if (s.currentDlmm) {
    const d = s.currentDlmm;
    if (s.protocol !== 'dlmm' || s.pool !== d.pool || !refs.some(ref => ref.account === d.pool) || d.pendingOutT3Raw !== '0' || d.pendingOutXRaw !== '0' ||
      !cashBound(event, d.requestBodyHash, d.cash) || total(d.cash, 'out') !== BigInt(d.paidInRaw) ||
      total(d.cash, 'in') !== BigInt(d.paidOutT3Raw) + BigInt(d.paidOutXRaw) ||
      BigInt(d.grossFeeT3Raw) !== BigInt(d.protocolFeeT3Raw) + BigInt(d.lpFeeT3Raw)) return null;
    for (const share of d.shares) {
      const delta = BigInt(share.deltaRaw);
      if (BigInt(share.afterRaw) - BigInt(share.beforeRaw) !== delta) return null;
      if (delta && !event.movements.some(m => m.asset.kind === 'lp_position' && m.asset.owner === event.account &&
        m.asset.pool === d.pool && m.asset.binId === share.binId && m.direction === (delta > 0n ? 'in' : 'out') &&
        BigInt(m.amountRaw) === (delta > 0n ? delta : -delta) && m.evidence?.kind === 'lp_position_delta' &&
        m.evidence.requestBodyHash === d.requestBodyHash && refsBound(m, s))) return null;
    }
    title = d.outcome === 'refunded' ? 'Pool refund confirmed' : d.aggregateOwed ? 'Pool recovery confirmed' :
      ({ add: 'Liquidity deposit confirmed', remove: 'Liquidity withdrawal confirmed', swap: 'Swap confirmed',
        order: 'Order settlement confirmed', 'farm-create': 'Farm funding confirmed', 'farm-action': 'Farm operation confirmed', owed: 'Pool recovery confirmed' })[d.kind];
    body = d.cash.some(leg => leg.direction === 'in') ? 'The recorded token outputs were credited to your wallet.' :
      'The pool accounting change was verified. LP shares and fee allocations are not additional cash.';
  } else if (s.currentPerps || s.currentOptions) {
    const p = s.currentPerps ?? s.currentOptions!;
    if (p.pendingOutRaw !== '0' || !cashBound(event, p.requestBodyHash, p.cash) ||
      total(p.cash, 'out') !== BigInt(p.paidInRaw) || total(p.cash, 'in') !== BigInt(p.paidOutRaw)) return null;
    if (s.currentPerps) {
      if (s.protocol !== 'perps' || s.operation !== 'perps_operation' || !refs.some(ref => ref.account === s.currentPerps!.engine)) return null;
      title = p.outcome === 'refunded' ? 'Perps refund confirmed' : p.outcome === 'rejected' ? 'Perps request declined' :
        ({ open: 'Position opening confirmed', increase: 'Position increase confirmed', close: 'Position close confirmed',
          addMargin: 'Margin deposit confirmed', removeMargin: 'Margin removal confirmed', funding: 'Funding update confirmed' })[s.currentPerps.kind];
      body = 'The engine accounting change was verified. Margin and counterparty backing are not additional wallet cash.';
    } else {
      const o = s.currentOptions!;
      if (s.protocol !== 'options' || s.operation !== 'option_operation' || s.factory !== o.factory || s.seriesId !== o.seriesId || !refs.some(ref => ref.account === o.vault)) return null;
      for (const [direction, amount] of [['in', o.rightAcquiredRaw], ['out', o.rightRetiredRaw]] as const)
        if (positive(amount) && !event.movements.some(m => m.asset.kind === 'option_position' &&
          m.asset.owner === event.account && m.asset.factory === o.factory && m.asset.seriesId === o.seriesId &&
          m.asset.positionId === o.positionId && m.direction === direction && m.amountRaw === amount &&
          m.evidence?.kind === 'option_position_delta' && m.evidence.requestBodyHash === o.requestBodyHash && refsBound(m, s))) return null;
      title = o.outcome === 'refunded' ? 'Option refund confirmed' : o.outcome === 'rejected' ? 'Option request declined' :
        ({ buy: 'Option purchase confirmed', fund: 'Option backing confirmed', withdraw: 'Option withdrawal confirmed',
          payout: 'Option settlement confirmed', owed: 'Option recovery confirmed' })[o.kind];
      body = 'The option accounting change was verified. Position rights and allocated premiums are not additional wallet cash.';
    }
    if (positive(p.paidOutRaw)) body += p.aggregateOwed ?
      ' Recovered tokens were credited to your wallet; their original income classification remains unresolved.' :
      ' The recorded T3 payout was credited to your wallet.';
  } else {
    const l = s.currentLaunchpad!;
    if (s.protocol !== 'launchpad' || s.operation !== 'launchpad_operation' || s.factory !== l.factory ||
      !refs.some(ref => ref.account === l.child) || !refs.some(ref => ref.account === l.factory) ||
      Object.values(l.pendingOut).some(n => n !== '0')) return null;
    const legs: Cash[] = l.cash.filter(c => c.from === event.account || c.to === event.account).map(c => ({
      direction: c.to === event.account ? 'in' : 'out', root: c.root, amountRaw: c.amountRaw,
      wallet: c.to === event.account ? c.targetWallet : c.sourceWallet, otherOwner: c.to === event.account ? c.from : c.to,
      ownerTransaction: c.to === event.account ? c.creditTransaction : c.debitTransaction,
      debitTransaction: c.debitTransaction, creditTransaction: c.creditTransaction,
    }));
    if (!cashBound(event, l.requestBodyHash, legs)) return null;
    for (const [direction, amounts] of [['out', l.paidIn], ['in', l.paidOut]] as const) {
      const roots = new Set([...Object.keys(amounts), ...legs.filter(c => c.direction === direction).map(c => c.root!)]);
      for (const root of roots) if (total(legs.filter(c => c.root === root), direction) !== BigInt(amounts[root] ?? '0')) return null;
    }
    title = l.outcome === 'refunded' ? 'Launchpad refund confirmed' : l.aggregateOwed ? 'Launchpad recovery confirmed' :
      l.kind === 'contribute' ? 'Launchpad contribution confirmed' : 'Launchpad operation confirmed';
    body = 'The sale accounting change was verified. Allocations and retired claims are not token delivery.';
    if (legs.some(c => c.direction === 'in')) body += ' The recorded token payout was credited to your wallet.';
  }
  const timed = stageTime(common, refs);
  return { ...timed, category: 'activity', title, body,
    sourceEventId: `current:${s.protocol}:${e.owner}:${e.dispatch.lt}:${e.dispatch.hash}:${e.requestBodyHash}`,
    evidence: { ...timed.evidence, settlement: s, movements: event.movements } };
}
