import { Cell, Dictionary, type Slice } from '@ton/core';
import { address, end, maybeAddress, raw, readLaunchpadEnvelope, readLaunchpadFills, readLaunchpadReferralTerms } from './launchpadStateCommon';
import { readLaunchpadSharedJournal } from './launchpadSharedJournal';

export type AuctionSaleBid = {
  commitmentRaw: string; maxPriceRaw: string; quantityRaw: string; claimed: boolean; rewardWallet: string | null; refundWallet: string | null;
} & ReturnType<typeof readLaunchpadFills> & ReturnType<typeof readLaunchpadReferralTerms>;
const bidValue = {
  serialize: (): never => { throw Error('Read-only auction bid decoder'); },
  parse: (s: Slice): AuctionSaleBid => {
    const entry = { commitmentRaw: raw(s), maxPriceRaw: raw(s), quantityRaw: raw(s), claimed: s.loadBoolean(), rewardWallet: maybeAddress(s), refundWallet: maybeAddress(s) };
    const fills = readLaunchpadFills(s.loadRef()), referral = readLaunchpadReferralTerms(s.loadRef()); end(s); return { ...entry, ...fills, ...referral };
  },
};
function readConfig(cell: Cell) {
  const s = cell.beginParse(), auctionKind = s.loadUint(8), amounts = s.loadRef().beginParse(), timing = s.loadRef().beginParse();
  const startPriceRaw = raw(amounts), reservePriceRaw = raw(amounts), tickSizeRaw = raw(amounts), maxAllocationRaw = raw(amounts);
  const minContributionRaw = raw(amounts), maxContributionRaw = raw(amounts), hardCapRaw = raw(amounts), softCapRaw = raw(amounts), insuranceTargetRaw = raw(amounts); end(amounts);
  const priceDecayInterval = timing.loadIntBig(64).toString(), startTime = timing.loadIntBig(64).toString(), endTime = timing.loadIntBig(64).toString(), settlementTime = timing.loadIntBig(64).toString();
  const schedule = timing.loadBoolean() ? { cliff: timing.loadIntBig(64).toString(), duration: timing.loadIntBig(64).toString(), period: timing.loadIntBig(64).toString() } : null; end(timing);
  const insuranceBps = s.loadUint(16), minBidIncrementBps = s.loadUint(16); end(s);
  if (auctionKind !== 1) throw Error('Unsupported auction kind');
  return { auctionKind: 1 as const, startPriceRaw, reservePriceRaw, tickSizeRaw, maxAllocationRaw, minContributionRaw, maxContributionRaw,
    hardCapRaw, softCapRaw, insuranceTargetRaw, priceDecayInterval, startTime, endTime, settlementTime, schedule, insuranceBps, minBidIncrementBps };
}
/** Current sale_auction.tolk uses only runtime, bids and the shared journal. */
export function readAuctionSaleState(dataBoc: string) {
  const { configCell, stateCell, headerFeeRecipient, headerFeeBps, ...envelope } = readLaunchpadEnvelope(dataBoc);
  const config = readConfig(configCell), s = stateCell.beginParse();
  if (s.remainingRefs !== 3) throw Error('Auction state reference layout');
  const r = s.loadRef().beginParse();
  const runtime = { totalCommittedRaw: raw(r), totalQuantityRaw: raw(r), saleSupplyRaw: raw(r), clearingPriceRaw: raw(r), clearingQuantityRaw: raw(r),
    distributedQuantityRaw: raw(r), totalRefundedRaw: raw(r), finalized: r.loadBoolean() }; end(r);
  const b = s.loadRef().beginParse(), entries = b.loadDict(Dictionary.Keys.Address(), bidValue); end(b);
  const bids = new Map([...entries].map(([owner, entry]) => [owner.toRawString(), entry]));
  const journal = readLaunchpadSharedJournal(s.loadRef());
  const feeRecipient = s.loadBoolean() ? address(s) : null, feeBps = s.loadUint(16), totalFeesRaw = raw(s);
  const escrowBalanceRaw = raw(s), pendingEscrowReturnRaw = raw(s), pendingEscrowQueryId = s.loadUintBig(64).toString();
  const referral = { registry: maybeAddress(s), key: s.loadUint(32) }; end(s);
  if (headerFeeRecipient !== feeRecipient || headerFeeBps !== feeBps) throw Error('Auction fee configuration mismatch');
  return { layout: 'auction-v1' as const, ...envelope, config, metrics: { ...runtime, feeRecipient, feeBps, totalFeesRaw, escrowBalanceRaw, pendingEscrowReturnRaw, pendingEscrowQueryId },
    bids, referral, journal };
}
export type AuctionSaleState = ReturnType<typeof readAuctionSaleState>;
