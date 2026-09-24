import { Cell, Dictionary, type Slice } from '@ton/core';
import { end, flag, maybeAddress, raw, readLaunchpadEnvelope, readLaunchpadFills, readLaunchpadReferralTerms } from './launchpadStateCommon';
import { readLaunchpadSharedJournal } from './launchpadSharedJournal';

export type BondingSaleContribution = {
  paymentAmountRaw: string; tokenAmountRaw: string; claimed: boolean; fillCount: number; rewardWallet: string | null; refundWallet: string | null;
} & ReturnType<typeof readLaunchpadFills> & ReturnType<typeof readLaunchpadReferralTerms>;
const contributionValue = {
  serialize: (): never => { throw Error('Read-only bonding contribution decoder'); },
  parse: (s: Slice): BondingSaleContribution => {
    const entry = { paymentAmountRaw: raw(s), tokenAmountRaw: raw(s), claimed: s.loadBoolean(), fillCount: s.loadUint(16), rewardWallet: maybeAddress(s), refundWallet: maybeAddress(s) };
    const fills = readLaunchpadFills(s.loadRef()), referral = readLaunchpadReferralTerms(s.loadRef()); end(s); if (entry.fillCount !== fills.fills.length || entry.fillCount > 64) throw Error('Bonding fill count mismatch'); return { ...entry, ...fills, ...referral };
  },
};
function readConfig(cell: Cell) {
  const s = cell.beginParse(), curve = s.loadRef().beginParse(), limits = s.loadRef().beginParse(), timing = s.loadRef().beginParse(); end(s);
  const curveKind = curve.loadUint(8), basePriceRaw = raw(curve), slopeNumeratorRaw = raw(curve), slopeDenominatorRaw = raw(curve), maxSupplyRaw = raw(curve); end(curve);
  const softCapRaw = raw(limits), minContributionRaw = raw(limits), maxContributionRaw = raw(limits), hardCapRaw = raw(limits), insuranceTargetRaw = raw(limits);
  const refundsEnabled = flag(limits) === 1, insuranceBps = limits.loadUint(16); end(limits);
  const startTime = timing.loadIntBig(64).toString(), endTime = timing.loadIntBig(64).toString(), schedulePresent = flag(timing) === 1;
  const scheduleValues = { cliff: timing.loadIntBig(64).toString(), duration: timing.loadIntBig(64).toString(), period: timing.loadIntBig(64).toString() }; end(timing);
  const schedule = schedulePresent ? scheduleValues : null;
  if (curveKind !== 1) throw Error('Unsupported bonding curve kind');
  return { curveKind: 1 as const, basePriceRaw, slopeNumeratorRaw, slopeDenominatorRaw, maxSupplyRaw, softCapRaw, startTime, endTime,
    minContributionRaw, maxContributionRaw, hardCapRaw, insuranceTargetRaw, insuranceBps, refundsEnabled, schedule };
}
/** Current configured sale_bonding.tolk serialization only. */
export function readBondingSaleState(dataBoc: string) {
  const { configCell, stateCell, headerFeeRecipient, headerFeeBps, ...envelope } = readLaunchpadEnvelope(dataBoc, 'bonding');
  const config = readConfig(configCell), s = stateCell.beginParse();
  if (s.remainingRefs !== 4) throw Error('Bonding state reference layout');
  const r = s.loadRef().beginParse();
  const runtime = { totalRaisedRaw: raw(r), totalSoldRaw: raw(r), totalRefundedRaw: raw(r), currentPriceRaw: raw(r), lastPriceRaw: raw(r), saleSupplyRaw: raw(r) }; end(r);
  const c = s.loadRef().beginParse(), entries = c.loadDict(Dictionary.Keys.Address(), contributionValue); end(c);
  const contributions = new Map([...entries].map(([owner, entry]) => [owner.toRawString(), entry]));
  const f = s.loadRef().beginParse(), feeRecipient = maybeAddress(f), feeBps = f.loadUint(16), totalFeesRaw = raw(f); end(f);
  const journal = readLaunchpadSharedJournal(s.loadRef());
  const finalized = s.loadBoolean(), successful = s.loadBoolean(), escrowBalanceRaw = raw(s), pendingEscrowReturnRaw = raw(s), pendingEscrowQueryId = s.loadUintBig(64).toString();
  const referral = { registry: maybeAddress(s), key: s.loadUint(32) }; end(s);
  if (headerFeeRecipient !== feeRecipient || headerFeeBps !== feeBps) throw Error('Bonding fee configuration mismatch');
  return { layout: 'bonding-v1' as const, ...envelope, config, metrics: { ...runtime, finalized, successful, feeRecipient, feeBps, totalFeesRaw,
    escrowBalanceRaw, pendingEscrowReturnRaw, pendingEscrowQueryId }, contributions, referral, journal };
}
export type BondingSaleState = ReturnType<typeof readBondingSaleState>;
