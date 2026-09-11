import { Cell, Dictionary, type Slice } from '@ton/core';
import { end, flag, maybeAddress, raw, readLaunchpadEnvelope, readLaunchpadFills } from './launchpadStateCommon';
import { readLaunchpadSharedJournal } from './launchpadSharedJournal';

export type BondingSaleContribution = {
  paymentAmountRaw: string; tokenAmountRaw: string; claimed: boolean; rewardWallet: string | null; refundWallet: string | null;
} & ReturnType<typeof readLaunchpadFills>;
const contributionValue = {
  serialize: (): never => { throw Error('Read-only bonding contribution decoder'); },
  parse: (s: Slice): BondingSaleContribution => {
    const entry = { paymentAmountRaw: raw(s), tokenAmountRaw: raw(s), claimed: s.loadBoolean(), rewardWallet: maybeAddress(s), refundWallet: maybeAddress(s) };
    const fills = readLaunchpadFills(s.loadRef()); end(s); return { ...entry, ...fills };
  },
};
function readConfig(cell: Cell) {
  const s = cell.beginParse(), curveKind = s.loadUint(8), basePriceRaw = raw(s), slopeNumeratorRaw = raw(s), slopeDenominatorRaw = raw(s);
  const maxSupplyRaw = raw(s), softCapRaw = raw(s), startTime = s.loadIntBig(64).toString(), endTime = s.loadIntBig(64).toString();
  const minContributionRaw = raw(s), maxContributionRaw = raw(s), hardCapRaw = raw(s), insuranceTargetRaw = raw(s), insuranceBps = s.loadUint(16);
  const refundsEnabled = flag(s) === 1, schedulePresent = s.loadBoolean();
  const schedule = schedulePresent ? { cliff: s.loadIntBig(64).toString(), duration: s.loadIntBig(64).toString(), period: s.loadIntBig(64).toString() } : null; end(s);
  if (curveKind !== 1) throw Error('Unsupported bonding curve kind');
  return { curveKind: 1 as const, basePriceRaw, slopeNumeratorRaw, slopeDenominatorRaw, maxSupplyRaw, softCapRaw, startTime, endTime,
    minContributionRaw, maxContributionRaw, hardCapRaw, insuranceTargetRaw, insuranceBps, refundsEnabled, schedule };
}
/** Current configured sale_bonding.tolk serialization only. */
export function readBondingSaleState(dataBoc: string) {
  const { configCell, stateCell, headerFeeRecipient, headerFeeBps, ...envelope } = readLaunchpadEnvelope(dataBoc);
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
