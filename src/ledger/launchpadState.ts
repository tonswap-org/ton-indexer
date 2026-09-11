import { Cell, Dictionary, type Slice } from '@ton/core';

import { end, address, maybeAddress, raw, hash, hex, flag, readLaunchpadEnvelope } from './launchpadStateCommon';
const states = ['none', 'ready', 'in-flight', 'delivered', 'bounced', 'final', 'negative-finalized'] as const;
export type FixedSaleSettlementStatus = 1 | 2 | 3 | 4 | 5 | 6;
export type FixedSaleSettlement = {
  settlementId: string; requestHash: string; amountRaw: string; forwardTonAmountRaw: string;
  route: 1 | 2; kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  status: FixedSaleSettlementStatus; state: typeof states[FixedSaleSettlementStatus]; deployRequired: 0 | 1;
  deliveryReservedRaw: string; finalizeReservedRaw: string; predecessorId: string; recordedAt: string;
  sourceWallet: string; destinationWallet: string; recipientOwner: string;
  forwardPayloadBoc: string; forwardPayloadHash: string; recordHash: string;
};
export type FixedSaleContribution = {
  paymentAmountRaw: string; tokenAmountRaw: string; claimed: boolean; rewardWallet: string | null; refundWallet: string | null;
};

/** Current sale_fixed.tolk record. FINAL is a raw state, never a payment claim:
 * a negative predecessor is also marked FINAL when a fresh wire replaces it. */
export function readFixedSaleSettlementRecord(cell: Cell): FixedSaleSettlement {
  const s = cell.beginParse();
  const settlementId = s.loadUintBig(64).toString(), requestHash = hex(s.loadUintBig(256));
  const amountRaw = raw(s), forwardTonAmountRaw = raw(s), route = s.loadUint(8), kind = s.loadUint(8), status = s.loadUint(8);
  if (!BigInt(settlementId) || !BigInt(amountRaw) || ![1, 2].includes(route) || kind < 1 || kind > 8 || status < 1 || status > 6)
    throw Error('Invalid fixed-sale settlement identity, route, kind or state');
  const deployRequired = flag(s), deliveryReservedRaw = raw(s), finalizeReservedRaw = raw(s);
  const predecessorId = s.loadUintBig(64).toString(), recordedAt = s.loadIntBig(64).toString();
  if (BigInt(predecessorId) >= BigInt(settlementId)) throw Error('Invalid fixed-sale predecessor');
  if (s.remainingRefs !== 3) throw Error('Fixed-sale settlement reference layout');
  const routeCell = s.loadRef().beginParse(), sourceWallet = address(routeCell), destinationWallet = address(routeCell); end(routeCell);
  const recipientCell = s.loadRef().beginParse(), recipientOwner = address(recipientCell); end(recipientCell);
  const payload = s.loadRef(); end(s);
  return { settlementId, requestHash, amountRaw, forwardTonAmountRaw, route: route as 1 | 2,
    kind: kind as FixedSaleSettlement['kind'], status: status as FixedSaleSettlementStatus,
    state: states[status as FixedSaleSettlementStatus], deployRequired, deliveryReservedRaw, finalizeReservedRaw,
    predecessorId, recordedAt, sourceWallet, destinationWallet, recipientOwner,
    forwardPayloadBoc: payload.toBoc().toString('base64'), forwardPayloadHash: hash(payload), recordHash: hash(cell) };
}

function readJournal(cell: Cell) {
  const s = cell.beginParse(), entries = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  const nextSettlementId = s.loadUintBig(64).toString(), currentPaymentId = s.loadUintBig(64).toString(), currentSaleId = s.loadUintBig(64).toString();
  const tailPaymentId = s.loadUintBig(64).toString(), tailSaleId = s.loadUintBig(64).toString();
  const reservedPaymentRaw = raw(s), reservedSaleRaw = raw(s); end(s);
  if (!BigInt(nextSettlementId)) throw Error('Invalid fixed-sale next settlement ID');
  const records = new Map<string, FixedSaleSettlement>();
  for (const [id, cell] of entries) {
    const record = readFixedSaleSettlementRecord(cell);
    if (record.settlementId !== id.toString() || id >= BigInt(nextSettlementId)) throw Error('Fixed-sale journal key mismatch');
    records.set(id.toString(), record);
  }
  for (const [id, route] of [[currentPaymentId, 1], [tailPaymentId, 1], [currentSaleId, 2], [tailSaleId, 2]] as const)
    if (id !== '0' && records.get(id)?.route !== route) throw Error('Fixed-sale lane record mismatch');
  return { nextSettlementId, currentPaymentId, currentSaleId, tailPaymentId, tailSaleId, reservedPaymentRaw, reservedSaleRaw, entries: records };
}
function readConfig(cell: Cell) {
  const s = cell.beginParse(), priceRaw = raw(s), hardCapRaw = raw(s), softCapRaw = raw(s);
  const startTime = s.loadIntBig(64).toString(), endTime = s.loadIntBig(64).toString();
  const minContributionRaw = raw(s), maxContributionRaw = raw(s), insuranceTargetRaw = raw(s), insuranceBps = s.loadUint(16); end(s);
  return { priceRaw, hardCapRaw, softCapRaw, startTime, endTime, minContributionRaw, maxContributionRaw, insuranceTargetRaw, insuranceBps };
}
const contributionValue = {
  serialize: (_value: FixedSaleContribution, _builder: unknown): never => { throw Error('Read-only fixed-sale contribution decoder'); },
  parse: (s: Slice): FixedSaleContribution => {
    const value = { paymentAmountRaw: raw(s), tokenAmountRaw: raw(s), claimed: s.loadBoolean(), rewardWallet: maybeAddress(s), refundWallet: maybeAddress(s) };
    end(s); return value;
  },
};

/** Strict current configured fixed-sale layout. Shared bonding/auction and
 * vesting layouts are intentionally different, and are not guessed here. */
export function readFixedSaleState(dataBoc: string) {
  const { configCell, stateCell, headerFeeRecipient, headerFeeBps, ...envelope } = readLaunchpadEnvelope(dataBoc);
  const config = readConfig(configCell), state = stateCell.beginParse();
  const totalRaisedRaw = raw(state);
  if (state.remainingRefs !== 4) throw Error('Fixed-sale state reference layout');
  const m = state.loadRef().beginParse();
  const metrics = { totalRaisedRaw, totalSoldRaw: raw(m), totalRefundedRaw: raw(m), outstandingRaisedRaw: raw(m), saleSupplyRaw: raw(m),
    finalized: m.loadBoolean(), successful: m.loadBoolean(), feeRecipient: maybeAddress(m), feeBps: m.loadUint(16), totalFeesRaw: raw(m),
    escrowBalanceRaw: raw(m), pendingEscrowReturnRaw: raw(m), pendingEscrowQueryId: m.loadUintBig(64).toString() }; end(m);
  if (headerFeeRecipient !== metrics.feeRecipient || headerFeeBps !== metrics.feeBps) throw Error('Fixed-sale fee configuration mismatch');
  const c = state.loadRef().beginParse(), entries = c.loadDict(Dictionary.Keys.Address(), contributionValue); end(c);
  const contributions = new Map([...entries].map(([owner, entry]) => [owner.toRawString(), entry]));
  const referral = state.loadRef().beginParse(); maybeAddress(referral); referral.loadUint(32); end(referral);
  const journal = readJournal(state.loadRef()); end(state);
  return { layout: 'fixed-v1' as const, ...envelope, config, metrics, contributions, journal };
}
export type FixedSaleState = ReturnType<typeof readFixedSaleState>;
