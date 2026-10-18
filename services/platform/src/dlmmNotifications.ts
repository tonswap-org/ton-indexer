import { Cell } from '@ton/core';
import type { LedgerEvent } from './ledger.js';
import type { NewNotification } from './store.js';
import { stageTime, type NotificationTransaction } from './notificationEvidence.js';

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
const same = (a: NotificationTransaction | null | undefined, b: NotificationTransaction | null | undefined) => Boolean(a && b &&
  a.account === b.account && a.lt === b.lt && a.hash === b.hash && a.utime === b.utime);
const identity = (ref: NotificationTransaction) => `${ref.account}:${ref.lt}:${ref.hash}`;
const follows = (a: NotificationTransaction, b: NotificationTransaction) => BigInt(a.lt) < BigInt(b.lt) && a.utime <= b.utime;

/** The producer proves the current contract graph; this consumer cross-checks
 * every receipt, its original transfer body and finalizers against that graph.
 * A credited wallet alone never announces completed fee collection. */
export function dlmmLiquidityNotification(event: LedgerEvent, common: Common): NewNotification | null {
  const settlement = event.settlement, liquidity = settlement?.dlmmLiquidity;
  const withdrawal = event.kind === 'lp_withdraw';
  if (event.status !== 'success' || !['lp_fee_collect', 'lp_withdraw'].includes(event.kind) || settlement?.operation !== event.kind ||
    settlement.protocol !== 'dlmm' || settlement.status !== 'confirmed' ||
    (withdrawal ? !settlement.queryId || BigInt(settlement.queryId) <= 0n : settlement.queryId !== undefined) || !liquidity ||
    liquidity.pool !== settlement.pool || liquidity.owner !== event.account || liquidity.recipient !== event.account ||
    event.issues.some(issue => issue !== 'jetton_decimals_unresolved') ||
    !(withdrawal ? [0x44524d56] : [0x44434c4d, 0x44434c54]).includes(liquidity.request.opcode) ||
    BigInt(liquidity.sharesBeforeRaw) - BigInt(liquidity.sharesAfterRaw) !== (withdrawal ? BigInt(liquidity.request.sharesRaw) : 0n) || BigInt(liquidity.request.sharesRaw) <= 0n ||
    BigInt(liquidity.request.sharesRaw) > BigInt(liquidity.sharesBeforeRaw) ||
    liquidity.stateBefore.seqno > liquidity.stateAfter.seqno ||
    liquidity.stateBefore.transaction.account !== liquidity.pool || liquidity.request.transaction.account !== liquidity.pool ||
    !same(liquidity.stateAfter.transaction, liquidity.request.transaction) ||
    !follows(liquidity.stateBefore.transaction, liquidity.request.transaction) ||
    !follows({account: event.account, lt: event.lt, hash: event.hash, utime: event.utime}, liquidity.request.transaction) ||
    !withdrawal && (liquidity.economics.principalTRaw !== '0' || liquidity.economics.principalXRaw !== '0') ||
    liquidity.payouts.length !== 2 || new Set(liquidity.payouts.map(row => row.tokenSide)).size !== 2 ||
    new Set(liquidity.payouts.map(row => row.master)).size !== 2 || new Set(liquidity.payouts.map(row => row.sourceWallet)).size !== 2 ||
    new Set(liquidity.payouts.map(row => row.destinationWallet)).size !== 2) return null;
  const required: NotificationTransaction[] = [liquidity.request.transaction];
  const positions = event.movements.filter(row => row.asset.kind === 'lp_position');
  if (withdrawal) {
    const position = positions[0], proof = position?.evidence;
    if (positions.length !== 1 || !position || position.direction !== 'out' || position.amountRaw !== liquidity.request.sharesRaw ||
      position.asset.pool !== liquidity.pool || position.asset.binId !== liquidity.binId || position.asset.owner !== event.account || position.asset.decimals !== 0 ||
      position.asset.id !== `${event.network}:dlmm-position:${liquidity.pool}:${liquidity.binId}` || position.source !== event.account || position.destination !== liquidity.pool ||
      proof?.kind !== 'lp_position_delta' || proof.stateBeforeHash !== liquidity.stateBefore.dataHash || proof.stateAfterHash !== liquidity.stateAfter.dataHash ||
      proof.beforeSeqno !== liquidity.stateBefore.seqno || proof.afterSeqno !== liquidity.stateAfter.seqno ||
      proof.transactions?.length !== 1 || !same(proof.transactions[0], liquidity.request.transaction)) return null;
  } else if (positions.length) return null;
  const usedMovementIds = new Set<string>(), usedSettlements = new Set<string>();
  for (const payout of liquidity.payouts) {
    const side = payout.tokenSide === 0 ? 'T' : 'X', total = liquidity.economics[`total${side}Raw`], earned = liquidity.economics[`earnedFee${side}Raw`], principal = liquidity.economics[`principal${side}Raw`];
    if (payout.totalRaw !== total || payout.earnedFeeRaw !== earned || BigInt(total) !== BigInt(principal) + BigInt(earned) || payout.principalRaw !== principal ||
      payout.assetId !== `${event.network}:jetton:${payout.master}` || payout.destinationOwner !== event.account) return null;
    if (total === '0') {
      if (payout.status !== 'none' || payout.finalization !== 'none' || payout.settlementId !== null || payout.movementId !== null ||
        payout.delivery !== null || payout.deliveryEvidence || payout.settlementEvidence) return null;
      continue;
    }
    const delivery = payout.deliveryEvidence, full = payout.settlementEvidence;
    if (payout.status !== 'delivered' || payout.finalization !== 'confirmed' || !payout.settlementId || !payout.movementId ||
      !payout.delivery || !delivery || !full || usedMovementIds.has(payout.movementId) || usedSettlements.has(payout.settlementId)) return null;
    usedMovementIds.add(payout.movementId); usedSettlements.add(payout.settlementId);
    for (const proof of [delivery, full]) {
      if (proof.settlementId !== payout.settlementId || proof.kind !== (withdrawal ? 5 : 4) || proof.amountRaw !== total ||
        proof.sourceWallet !== payout.sourceWallet || proof.destinationOwner !== payout.destinationOwner || proof.destinationWallet !== payout.destinationWallet ||
        proof.request.account !== liquidity.pool || proof.debit.account !== payout.sourceWallet || proof.credit.account !== payout.destinationWallet ||
        !same(proof.credit, payout.delivery) || !follows(proof.request, proof.debit) || !follows(proof.debit, proof.credit) ||
        (identity(proof.request) !== identity(liquidity.request.transaction) && !follows(liquidity.request.transaction, proof.request))) return null;
      try {
        const cell = Cell.fromBase64(proof.requestBodyBoc), s = cell.beginParse();
        if (cell.hash().toString('hex') !== proof.requestBodyHash || s.loadUint(32) !== 0x0f8a7ea5 ||
          s.loadUintBig(64).toString() !== payout.settlementId || s.loadCoins().toString() !== total ||
          s.loadAddress().toRawString() !== event.account || s.loadAddress().toRawString() !== liquidity.pool) return null;
        // Current TONSwap build_jetton_transfer stores both payloads as refs.
        const custom = s.loadRef();
        if (custom.bits.length !== 32 || custom.refs.length || custom.beginParse().loadUint(32) !== 0x4a535454 || s.loadCoins() !== 0n) return null;
        const forward = s.loadRef().beginParse();
        if (forward.remainingBits || forward.remainingRefs || s.remainingBits || s.remainingRefs) return null;
      } catch { return null; }
    }
    if (delivery.requestBodyHash !== full.requestBodyHash || delivery.requestBodyBoc !== full.requestBodyBoc ||
      !same(delivery.request, full.request) || !same(delivery.debit, full.debit) || !same(delivery.credit, full.credit) ||
      full.acknowledged.account !== liquidity.pool || full.walletFinalized.account !== payout.sourceWallet || full.poolFinalized.account !== liquidity.pool ||
      !follows(full.credit, full.acknowledged) || !follows(full.acknowledged, full.walletFinalized) || !follows(full.walletFinalized, full.poolFinalized)) return null;
    const boundaries = new Map(full.boundaries.map(row => [identity(row.transaction), row]));
    if (boundaries.size !== full.boundaries.length) return null;
    for (const boundary of full.boundaries) {
      if (boundary.beforeSeqno > boundary.afterSeqno || boundary.codeHash !==
        (boundary.transaction.account === liquidity.pool ? liquidity.poolCodeHash : liquidity.walletCodeHash) ||
        ![liquidity.pool, payout.sourceWallet, payout.destinationWallet].includes(boundary.transaction.account) ||
        (boundary.beforeAccountState === 'active') !== (boundary.beforeDataHash !== null)) return null;
    }
    for (const boundary of delivery.boundaries) {
      const matched = boundaries.get(identity(boundary.transaction));
      if (!matched || !same(matched.transaction, boundary.transaction) || matched.beforeDataHash !== boundary.beforeDataHash ||
        matched.afterDataHash !== boundary.afterDataHash || matched.beforeSeqno !== boundary.beforeSeqno || matched.afterSeqno !== boundary.afterSeqno ||
        matched.beforeAccountState !== boundary.beforeAccountState || matched.codeHash !== boundary.codeHash) return null;
    }
    for (const ref of [full.request, full.debit, full.credit, full.acknowledged, full.walletFinalized, full.poolFinalized]) {
      if (!same(boundaries.get(identity(ref))?.transaction, ref)) return null;
      required.push(ref);
    }
    if (![full.request, full.debit, full.credit].every(ref => delivery.boundaries.some(row => same(row.transaction, ref)))) return null;
    required.push(...full.boundaries.map(row => row.transaction));
    const movements = event.movements.filter(row => row.id === payout.movementId), movement = movements[0], receipt = movement?.evidence?.dlmmReceipt;
    if (movements.length !== 1 || !movement || movement.direction !== 'in' || movement.asset.kind !== 'jetton' || movement.asset.id !== payout.assetId ||
      movement.asset.master !== payout.master || movement.asset.owner !== event.account || movement.asset.wallet !== payout.destinationWallet ||
      movement.amountRaw !== total || movement.source !== liquidity.pool || movement.destination !== event.account ||
      movement.evidence?.kind !== 'jetton_transfer' || movement.evidence.requestBodyHash !== delivery.requestBodyHash ||
      movement.evidence.queryId !== payout.settlementId || movement.evidence.transactions?.length !== 2 ||
      !same(movement.evidence.transactions[0], delivery.debit) || !same(movement.evidence.transactions[1], delivery.credit) ||
      !receipt || receipt.pool !== liquidity.pool || receipt.owner !== event.account || receipt.recipient !== event.account || receipt.binId !== liquidity.binId ||
      receipt.settlementId !== payout.settlementId || receipt.principalRaw !== principal || receipt.earnedFeeRaw !== earned || !same(receipt.delivery, payout.delivery)) return null;
  }
  if (!usedMovementIds.size || event.movements.filter(row => row.evidence?.dlmmReceipt).some(row => !usedMovementIds.has(String(row.id)))) return null;
  // Keep chronology errors visible to the worker transaction so a cursor is not
  // committed before genuinely available evidence can qualify the same event.
  const timed = stageTime(common, required, settlement.evidence);
  return {...timed, category: 'activity', sourceEventId: `dlmm-${withdrawal ? 'withdrawal' : 'fees'}:${liquidity.pool}:${identity(liquidity.request.transaction)}`,
    title: withdrawal ? 'Liquidity withdrawal confirmed' : 'Liquidity fees received',
    body: withdrawal ? 'Your LP share withdrawal and received assets were confirmed and finalized on-chain.' : 'Your collected liquidity fees were received and finalized on-chain. Your LP shares are unchanged.',
    evidence: {...timed.evidence, settlement, movements: event.movements}};
}
