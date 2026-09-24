import { Cell, Dictionary, type Slice } from '@ton/core';

import { end, maybeAddress, raw, readLaunchpadEnvelope, readLaunchpadReferralTerms } from './launchpadStateCommon';
import { readLaunchpadSharedJournal, readLaunchpadSharedSettlement, type LaunchpadSharedSettlement, type LaunchpadSettlementStatus } from './launchpadSharedJournal';
export type FixedSaleSettlementStatus = LaunchpadSettlementStatus;
export type FixedSaleSettlement = LaunchpadSharedSettlement;
export const readFixedSaleSettlementRecord = readLaunchpadSharedSettlement;
export type FixedSaleContribution = {
  paymentAmountRaw: string; tokenAmountRaw: string; claimed: boolean; rewardWallet: string | null; refundWallet: string | null;
  feePaidRaw: string; referrer: string | null;
};

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
    const referral = readLaunchpadReferralTerms(s.loadRef()); end(s); return { ...value, ...referral };
  },
};

/** Strict current configured fixed-sale layout. Settlement records share the same mandatory first-release schema across all models. */
export function readFixedSaleState(dataBoc: string) {
  const { configCell, stateCell, headerFeeRecipient, headerFeeBps, ...envelope } = readLaunchpadEnvelope(dataBoc, 'fixed');
  const config = readConfig(configCell), state = stateCell.beginParse();
  const totalRaisedRaw = raw(state);
  if (state.remainingRefs !== 4) throw Error('Fixed-sale state reference layout');
  const m = state.loadRef().beginParse(), amounts = m.loadRef().beginParse();
  const metrics = { totalRaisedRaw, totalSoldRaw: raw(amounts), totalRefundedRaw: raw(amounts), outstandingRaisedRaw: raw(amounts), saleSupplyRaw: raw(amounts),
    totalFeesRaw: raw(amounts), escrowBalanceRaw: raw(amounts), pendingEscrowReturnRaw: raw(amounts),
    finalized: m.loadBoolean(), successful: m.loadBoolean(), feeRecipient: maybeAddress(m), feeBps: m.loadUint(16),
    pendingEscrowQueryId: m.loadUintBig(64).toString() }; end(amounts); end(m);
  if (headerFeeRecipient !== metrics.feeRecipient || headerFeeBps !== metrics.feeBps) throw Error('Fixed-sale fee configuration mismatch');
  const c = state.loadRef().beginParse(), entries = c.loadDict(Dictionary.Keys.Address(), contributionValue); end(c);
  const contributions = new Map([...entries].map(([owner, entry]) => [owner.toRawString(), entry]));
  const r = state.loadRef().beginParse(), referral = { registry: maybeAddress(r), key: r.loadUint(32) }; end(r);
  const journal = readLaunchpadSharedJournal(state.loadRef()); end(state);
  return { layout: 'fixed-v1' as const, ...envelope, config, metrics, contributions, referral, journal };
}
export type FixedSaleState = ReturnType<typeof readFixedSaleState>;
