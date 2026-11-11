import { z } from 'zod';
import { normalizeAddress } from './store.js';

const address = z.string().max(100).refine(value => {
  try { return normalizeAddress(value) === value; } catch { return false; }
});
const uint = z.string().max(120).regex(/^(0|[1-9]\d*)$/);
const int = z.string().max(120).regex(/^(0|-?[1-9]\d*)$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amounts = { beforeRaw: uint, afterRaw: uint, deltaRaw: int };
const shares = z.object({ binId: z.number().int().min(-200000).max(200000), ...amounts }).strict();
const common = {
  owner: address, queryId: uint, requestBodyHash: hash,
  dispatch: z.object({ lt: uint, hash }).strict(),
  evidenceHashes: z.array(hash).max(1000), aggregateOwed: z.boolean(),
};
const cash = z.object({
  direction: z.enum(['in', 'out']), amountRaw: uint, ownerTransaction: hash,
  debitTransaction: hash, creditTransaction: hash, wallet: address, otherOwner: address,
}).strict();
const outcome = z.enum(['unresolved', 'accepted', 'delivered', 'refunded']);
export const currentDlmmSchema = z.object({
  ...common, kind: z.enum(['add', 'farm-create', 'farm-action', 'remove', 'owed', 'swap', 'order']), outcome,
  pool: address, side: z.union([z.literal(0), z.literal(1)]), paidInRaw: uint,
  paidOutT3Raw: uint, paidOutXRaw: uint, pendingOutT3Raw: uint, pendingOutXRaw: uint,
  grossFeeT3Raw: uint, protocolFeeT3Raw: uint, lpFeeT3Raw: uint, farmId: uint.nullable(),
  shares: z.array(shares).max(1000),
  cash: z.array(cash.extend({ root: address, originTransaction: hash }).strict()).max(1000),
  order: z.object({ address, nonce: uint, fundedInRaw: uint, consumedInRaw: uint, receivedOutRaw: uint,
    refundedInRaw: uint, executedSlices: z.number().int().nonnegative(), closeReason: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const position = z.object({
  generation: uint, sizeRaw: int, marginRaw: uint, entryNotionalRaw: uint, lastFundingIndexRaw: int,
  reservedRaw: uint, pendingFundingRaw: uint, collectedLossRaw: uint, remainingEntitlementRaw: uint,
}).strict().nullable();
export const currentPerpsSchema = z.object({
  ...common, kind: z.enum(['open', 'increase', 'close', 'addMargin', 'removeMargin', 'funding']),
  outcome: z.enum(['unresolved', 'accepted', 'confirmed', 'refunded', 'rejected']),
  engine: address, riskVault: address, marketId: z.number().int().min(1).max(4), generation: uint.nullable(),
  positionBefore: position, positionAfter: position, depositRaw: uint, feeRaw: uint, fundingAccruedRaw: int,
  fundingCollectedRaw: uint, fundingCancelledRaw: uint, unpaidLossRaw: uint, realizedLossRaw: uint,
  fillPriceRaw: uint, entryNotionalDeltaRaw: int, lpPayoutRaw: uint, localPayoutRaw: uint,
  paidInRaw: uint, paidOutRaw: uint, pendingOutRaw: uint,
  cash: z.array(cash.extend({ aggregateOwed: z.boolean() }).strict()).max(1000), issue: z.string().max(2048).optional(),
}).strict();
export const currentOptionsSchema = z.object({
  ...common, kind: z.enum(['buy', 'fund', 'withdraw', 'payout', 'owed']),
  outcome: z.enum(['unresolved', 'rejected', 'accepted', 'delivered', 'refunded']),
  factory: address, vault: address, seriesId: uint, positionId: uint.nullable(),
  amountRequestedRaw: uint, premiumNetRaw: uint, protocolFeeRaw: uint, writerBackingRaw: uint,
  writerPremiumRaw: uint, rightAcquiredRaw: uint, rightRetiredRaw: uint,
  paidInRaw: uint, paidOutRaw: uint, pendingOutRaw: uint, cash: z.array(cash).max(1000),
}).strict();
const tokenAmounts = z.record(address, uint).refine(values => Object.keys(values).length <= 32);
export const currentLaunchpadSchema = z.object({
  ...common, kind: z.enum(['vest-supply', 'contribute', 'supply', 'claim', 'finalize', 'cancel', 'owed',
    'lp-seed', 'lp-release', 'vest-claim', 'vest-return', 'archive-claim', 'holder-claim']), outcome,
  factory: address, child: address, creator: address.nullable(), nonce: uint.nullable(),
  model: z.number().int().min(0).max(2).nullable(), role: z.number().int().min(0).max(2).nullable(),
  projectRoot: address.nullable(), contributionRaw: uint, allocationAcquiredRaw: uint,
  allocationRetiredRaw: uint, contributionRetiredRaw: uint, inventorySuppliedRaw: uint,
  feeAllocatedRaw: uint, lpFundingAllocatedRaw: uint, creatorProceedsAllocatedRaw: uint,
  recoveredAccountingRaw: uint, owedRetiredRaw: uint, recoveryBeneficiary: address.nullable(),
  lpShares: z.array(shares.extend({ owner: address, pool: address }).strict()).max(1000),
  paidIn: tokenAmounts, paidOut: tokenAmounts, pendingOut: tokenAmounts,
  cash: z.array(z.object({ root: address, from: address, to: address, amountRaw: uint,
    debitTransaction: hash, creditTransaction: hash, sourceWallet: address, targetWallet: address }).strict()).max(1000),
  issues: z.array(z.string().max(2048)).max(100),
}).strict();
export const currentT3ReceiptSchema = z.object({
  slot: z.number().int().min(0).max(3), key: uint, hash, recordBoc: z.string().min(1).max(65536),
  request: z.object({ sourceWallet: address.nullable(), bodyHash: hash.nullable(), owner: address,
    queryId: uint, amountRaw: uint, intentHash: hash.nullable() }).strict(),
  root: hash, phase: z.number().int().min(0).max(3).nullable(), committed: z.literal(true),
}).strict();
export const currentT3RecoverySchema = z.object({
  wallet: address, id: uint, attempt: uint, originLt: uint, recordHash: hash, rootBefore: hash, rootAfter: hash,
  status: z.literal('cancelled'), restoredRaw: uint, requestBodyHash: hash.nullable(), recoveryBodyHash: hash,
}).strict();
