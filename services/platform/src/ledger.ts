import { z } from 'zod';
import { normalizeAddress } from './store.js';

const canonicalAddressSchema = z.string().max(100).refine(value => {
  try { return normalizeAddress(value) === value; } catch { return false; }
}, 'Expected a canonical raw address');
const atomicSchema = z.string().max(120).regex(/^(0|[1-9]\d*)$/);
const signedSchema = z.string().max(120).regex(/^(0|-?[1-9]\d*)$/);
// The ledger publishes transaction hashes as canonical padded base64; code/body hashes are hexadecimal.
const transactionHashSchema = z.string().refine(value => (/^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value), 'Expected a 32-byte TON transaction hash');
const physicalEvidenceSchema = z.object({ account: canonicalAddressSchema, lt: atomicSchema, hash: transactionHashSchema, utime: z.number().int().positive() });
const feeEvidenceSchema = z.array(z.object({ transaction: physicalEvidenceSchema, amountRaw: atomicSchema.nullable(), includedInOwnerFeeMovements: z.boolean() })).max(1000);
const hexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const dlmmBoundarySchema = z.object({ transaction: physicalEvidenceSchema, beforeSeqno: z.number().int().nonnegative(), afterSeqno: z.number().int().nonnegative(),
  beforeDataHash: hexSchema.nullable(), beforeAccountState: z.enum(['active', 'uninitialized']), afterDataHash: hexSchema, codeHash: hexSchema }).strict();
const dlmmDeliverySchema = z.object({ settlementId: atomicSchema, kind: z.number().int().min(1).max(8), amountRaw: atomicSchema,
  sourceWallet: canonicalAddressSchema, destinationWallet: canonicalAddressSchema, destinationOwner: canonicalAddressSchema,
  requestBodyHash: hexSchema, requestBodyBoc: z.string().min(1).max(65536), request: physicalEvidenceSchema, debit: physicalEvidenceSchema,
  credit: physicalEvidenceSchema, boundaries: z.array(dlmmBoundarySchema).max(1000) }).strict();
const dlmmSettlementSchema = dlmmDeliverySchema.extend({ acknowledged: physicalEvidenceSchema, walletFinalized: physicalEvidenceSchema, poolFinalized: physicalEvidenceSchema }).strict();
const dlmmReceiptSchema = z.object({ pool: canonicalAddressSchema, owner: canonicalAddressSchema, recipient: canonicalAddressSchema,
  binId: z.number().int().min(-200000).max(200000), settlementId: atomicSchema, principalRaw: atomicSchema, earnedFeeRaw: atomicSchema, delivery: physicalEvidenceSchema }).strict();
const dlmmLiquiditySchema = z.object({ pool: canonicalAddressSchema, poolCodeHash: hexSchema, walletCodeHash: hexSchema,
  owner: canonicalAddressSchema, recipient: canonicalAddressSchema, binId: z.number().int().min(-200000).max(200000),
  request: z.object({ opcode: z.number().int().nonnegative().max(0xffffffff), sharesRaw: atomicSchema, bodyHash: hexSchema, transaction: physicalEvidenceSchema }).strict(),
  stateBefore: z.object({ seqno: z.number().int().nonnegative(), dataHash: hexSchema, transaction: physicalEvidenceSchema }).strict(),
  stateAfter: z.object({ seqno: z.number().int().nonnegative(), dataHash: hexSchema, transaction: physicalEvidenceSchema }).strict(),
  sharesBeforeRaw: atomicSchema, sharesAfterRaw: atomicSchema,
  economics: z.object({ principalTRaw: atomicSchema, principalXRaw: atomicSchema, earnedFeeTRaw: atomicSchema, earnedFeeXRaw: atomicSchema, totalTRaw: atomicSchema, totalXRaw: atomicSchema }).strict(),
  payouts: z.array(z.object({ tokenSide: z.union([z.literal(0), z.literal(1)]), assetId: z.string().max(256), master: canonicalAddressSchema,
    sourceWallet: canonicalAddressSchema, destinationOwner: canonicalAddressSchema, destinationWallet: canonicalAddressSchema, settlementId: atomicSchema.nullable(),
    totalRaw: atomicSchema, principalRaw: atomicSchema, earnedFeeRaw: atomicSchema, movementId: z.string().min(1).max(256).nullable(), delivery: physicalEvidenceSchema.nullable(),
    status: z.enum(['none', 'delivered', 'unresolved']), finalization: z.enum(['none', 'confirmed', 'unresolved']),
    deliveryEvidence: dlmmDeliverySchema.optional(), settlementEvidence: dlmmSettlementSchema.optional() }).strict()).length(2),
}).strict();
const historicalEvidenceSchema = z.object({ kind: z.string(), bodyHash: hexSchema.optional(), stateBeforeHash: hexSchema,
  stateAfterHash: hexSchema, beforeSeqno: z.number().int().nonnegative(), afterSeqno: z.number().int().nonnegative(),
  transactions: z.array(physicalEvidenceSchema).max(1000) }).passthrough();
const optionPositionStateSchema = z.object({ owner: canonicalAddressSchema, sourceWallet: canonicalAddressSchema,
  notionalRaw: atomicSchema, premiumRaw: atomicSchema, collateralRaw: atomicSchema, settled: z.boolean(),
  buyStateRaw: atomicSchema, seriesWireId: atomicSchema, custodyWireId: atomicSchema, dataHash: hexSchema,
  settlementReady: z.boolean().optional(), settlementPayoutRaw: atomicSchema.optional(), refundOwner: canonicalAddressSchema.optional(),
  refundWireId: atomicSchema.optional(), protocolFeeRaw: atomicSchema.optional(), excessRaw: atomicSchema.optional(), walletFundingRaw: atomicSchema.optional() }).passthrough();
const optionProductStateSchema = z.object({ dataHash: hexSchema, manager: canonicalAddressSchema.nullable(), vault: canonicalAddressSchema.nullable(), seriesId: atomicSchema,
  position: z.object({ owner: canonicalAddressSchema, tokenId: atomicSchema, notionalRaw: atomicSchema, premiumRaw: atomicSchema,
    collateralRaw: atomicSchema, active: z.boolean(), exercised: z.boolean(), settled: z.boolean(), buyWireId: atomicSchema }).passthrough().nullable() }).passthrough();
const optionJournalSchema = z.object({ kind: z.number().int(), requestId: atomicSchema, seriesId: atomicSchema, status: z.number().int(),
  amountRaw: atomicSchema, wireId: atomicSchema, finalizeReservedRaw: atomicSchema, lockedDeltaRaw: atomicSchema, premiumDeltaRaw: atomicSchema,
  accountingApplied: z.number().int(), recipient: canonicalAddressSchema.nullable(), destinationWallet: canonicalAddressSchema.nullable(), requestHash: hexSchema }).passthrough();
const optionVaultBucketSchema = z.object({ lockedRaw: atomicSchema, premiumRaw: atomicSchema,
  reservedLockedRaw: atomicSchema, reservedPremiumRaw: atomicSchema, liabilityActionId: atomicSchema,
  liabilityStatus: z.number().int().min(0).max(255), liabilityLastDispatchTs: signedSchema, liabilityRequestHash: hexSchema,
  liabilityTargetNotionalRaw: atomicSchema, liabilityTargetImRaw: atomicSchema, liabilityTargetCmRaw: atomicSchema }).passthrough();
const optionPayoutSchema = z.object({ status: z.enum(['none', 'pending', 'completed']), amountRaw: atomicSchema.nullable(), issue: z.string().optional(), wireId: atomicSchema.optional(),
  sourceWallet: canonicalAddressSchema.optional(), destinationWallet: canonicalAddressSchema.optional(), requestHash: hexSchema.optional(), journalKey: hexSchema.optional(),
  beforeJournal: optionJournalSchema.optional(), afterJournal: optionJournalSchema.optional(), evidence: z.array(physicalEvidenceSchema).max(1000),
  stateEvidence: historicalEvidenceSchema.optional() }).passthrough();
const optionFactorySeriesSchema = z.object({ kind: z.union([z.literal(1), z.literal(2)]), optionAddress: canonicalAddressSchema,
  openNotionalRaw: atomicSchema, collateralLockedRaw: atomicSchema }).strict();
const optionAbortTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner_abort'), bodyHash: hexSchema }).strict(),
  z.object({ kind: z.literal('initial_series_buy_bounced'), bodyHash: hexSchema, bodyBoc: z.string().min(1).max(4096),
    opcode: z.number().int().nonnegative().max(0xffffffff), wireId: atomicSchema, originalMessageBodyHash: hexSchema,
    failedTransaction: physicalEvidenceSchema, recoveryTransaction: physicalEvidenceSchema,
    factoryUnwind: z.object({ seriesBuyIndexBefore: atomicSchema, seriesBuyIndexAfter: z.null(),
      beforeSeries: optionFactorySeriesSchema, afterSeries: optionFactorySeriesSchema }).strict() }).strict(),
]);
const optionUnwindSchema = z.object({
  funding: z.object({ queryId: atomicSchema, amountRaw: atomicSchema, ownerWallet: canonicalAddressSchema, factoryWallet: canonicalAddressSchema,
    requestBodyHash: hexSchema, payloadHash: hexSchema, evidence: z.array(physicalEvidenceSchema).max(1000), stateEvidence: historicalEvidenceSchema }).passthrough(),
  trigger: optionAbortTriggerSchema, beforeAbortBuyStateRaw: atomicSchema, reservationStatus: z.enum(['reserved', 'failed']),
  reservationEvidence: z.array(physicalEvidenceSchema).max(1000), reservationStateEvidence: historicalEvidenceSchema,
  custody: z.object({ status: z.enum(['not_transferred', 'proven', 'unverified']), amountRaw: atomicSchema, wireId: atomicSchema.optional(),
    evidence: z.array(physicalEvidenceSchema).max(1000), stateEvidence: historicalEvidenceSchema.optional() }).passthrough(),
  commit: z.object({ status: z.enum(['committed', 'failed', 'unobserved', 'unverified']), evidence: z.array(physicalEvidenceSchema).max(1000),
    stateEvidence: historicalEvidenceSchema.optional() }).passthrough().optional(),
  cancellation: z.object({ status: z.enum(['pending', 'completed']), evidence: z.array(physicalEvidenceSchema).max(1000),
    stateEvidence: historicalEvidenceSchema.optional() }).passthrough(),
  vaultAbort: z.object({ receiptHash: hexSchema, abortHash: hexSchema, requestHash: hexSchema, journalKey: hexSchema,
    receiptBeforeHash: hexSchema.nullable(), receiptAfterHash: hexSchema,
    trackedBalanceBeforeRaw: atomicSchema, trackedBalanceAfterRaw: atomicSchema,
    evidence: z.array(physicalEvidenceSchema).length(1), stateEvidence: historicalEvidenceSchema,
    beforeBucket: optionVaultBucketSchema.nullable(), afterBucket: optionVaultBucketSchema.nullable() }).passthrough().optional(),
  factoryReturn: optionPayoutSchema, vaultReturn: optionPayoutSchema,
}).passthrough();
const optionLifecycleSchema = z.object({ factory: canonicalAddressSchema, factoryCodeHash: hexSchema, vault: canonicalAddressSchema.optional(), vaultCodeHash: hexSchema.optional(),
  root: canonicalAddressSchema, series: canonicalAddressSchema.optional(), productCodeHash: hexSchema.optional(), optionKind: z.union([z.literal(1), z.literal(2)]).optional(),
  seriesId: atomicSchema.optional(), positionId: atomicSchema.optional(), owner: canonicalAddressSchema, recipient: canonicalAddressSchema,
  originalRequestBodyHash: hexSchema.optional(), requestedPayoutRaw: atomicSchema.optional(), requestedPremiumBurnRaw: atomicSchema.optional(),
  outcome: z.enum(['exercised', 'refunded', 'pending']), beforePosition: optionPositionStateSchema.nullable().optional(), afterPosition: optionPositionStateSchema.nullable().optional(),
  productBefore: optionProductStateSchema.optional(), productAfter: optionProductStateSchema.optional(), positionEvidence: historicalEvidenceSchema.optional(),
  requestEvidence: historicalEvidenceSchema.optional(), productEvidence: historicalEvidenceSchema.optional(),
  payout: optionPayoutSchema,
  protocolAccounting: z.object({ status: z.enum(['not_required', 'unverified', 'confirmed']), riskClaimId: atomicSchema.optional(),
    riskRequestHash: hexSchema.optional(), riskDeliveredRaw: atomicSchema.optional() }).passthrough(),
  collateralLiabilityReleasedRaw: atomicSchema.optional(), premiumAccountingReleasedRaw: atomicSchema.optional(),
  refund: z.object({ kind: z.string().max(40), scope: z.string().max(40), claimId: atomicSchema.optional(), identityHash: hexSchema.optional(),
    queryId: atomicSchema.optional(), payloadHash: hexSchema.optional(), unwind: optionUnwindSchema.optional(), beforeClaim: z.object({ claimId: atomicSchema, identityHash: hexSchema,
      kind: z.number().int(), amountRaw: atomicSchema, wireId: atomicSchema, finalizeWireId: atomicSchema, status: z.number().int(),
      fundedValueRaw: atomicSchema, owner: canonicalAddressSchema, recipient: canonicalAddressSchema }).passthrough().optional() }).passthrough().optional(),
  localNetworkFees: feeEvidenceSchema,
}).passthrough();
const launchpadContributionSchema = z.object({ paymentAmountRaw: atomicSchema, tokenAmountRaw: atomicSchema,
  claimed: z.boolean(), rewardWallet: canonicalAddressSchema.nullable(), refundWallet: canonicalAddressSchema.nullable(), feePaidRaw: atomicSchema, referrer: canonicalAddressSchema.nullable() }).strict();
const launchpadOriginalRequestSchema = z.object({ transaction: physicalEvidenceSchema, messageIndex: z.number().int().nonnegative(),
  messageBodyHash: hexSchema, incomingBodyHash: hexSchema.nullable() }).strict();
const launchpadFillShape = { fillsBoc: z.string().min(1), fillsHash: hexSchema, fills: z.array(z.object({ tokenAmountRaw: atomicSchema,
  paymentAmountRaw: atomicSchema, hash: hexSchema, previousHash: hexSchema.nullable() }).strict()).max(10000) };
const launchpadBondingEntrySchema = launchpadContributionSchema.extend(launchpadFillShape).strict();
const launchpadBidEntrySchema = z.object({ commitmentRaw: atomicSchema, maxPriceRaw: atomicSchema, quantityRaw: atomicSchema,
  claimed: z.boolean(), rewardWallet: canonicalAddressSchema.nullable(), refundWallet: canonicalAddressSchema.nullable(), feePaidRaw: atomicSchema, referrer: canonicalAddressSchema.nullable(), ...launchpadFillShape }).strict();
const launchpadParticipationSchema = z.object({ network: z.enum(['mainnet', 'testnet', 'localnet']), model: z.enum(['fixed', 'bonding', 'auction']),
  requestKind: z.enum(['contribution', 'bid']), sale: canonicalAddressSchema, factory: canonicalAddressSchema.nullable(), saleId: atomicSchema.nullable(),
  participant: canonicalAddressSchema, referrer: canonicalAddressSchema.nullable(), outerQueryId: atomicSchema, innerQueryId: atomicSchema, originalRequest: launchpadOriginalRequestSchema,
  payment: z.object({ root: canonicalAddressSchema, sourceWallet: canonicalAddressSchema, destinationWallet: canonicalAddressSchema,
    amountRaw: atomicSchema, requestBodyHash: hexSchema, forwardPayloadHash: hexSchema }).strict(),
  entitlement: z.discriminatedUnion('model', [
    z.object({ model: z.literal('fixed'), before: launchpadContributionSchema.nullable(), after: launchpadContributionSchema,
      paymentDeltaRaw: atomicSchema, tokenDeltaRaw: atomicSchema, priceRaw: atomicSchema }).strict(),
    z.object({ model: z.literal('bonding'), before: launchpadBondingEntrySchema.nullable(), after: launchpadBondingEntrySchema,
      paymentDeltaRaw: atomicSchema, tokenDeltaRaw: atomicSchema, priceRaw: atomicSchema }).strict(),
    z.object({ model: z.literal('auction'), before: launchpadBidEntrySchema.nullable(), after: launchpadBidEntrySchema,
      commitmentDeltaRaw: atomicSchema, quantityDeltaRaw: atomicSchema, maxPriceRaw: atomicSchema }).strict(),
  ]).nullable(),
  stateEvidence: z.array(z.object({ purpose: z.enum(['acceptance', 'payment-debit', 'payment-credit']), transaction: physicalEvidenceSchema,
    beforeHash: hexSchema, afterHash: hexSchema, beforeSeqno: z.number().int().nonnegative(), afterSeqno: z.number().int().nonnegative(),
    balanceBeforeRaw: atomicSchema.nullable(), balanceAfterRaw: atomicSchema.nullable() }).strict()).max(1000),
  tokenDelivery: z.literal('separate-settlement'),
}).strict();
const launchpadRefundSchema = z.object({
  model: z.literal('fixed'), reason: z.literal('failed-soft-cap').nullable(), sale: canonicalAddressSchema, factory: canonicalAddressSchema.nullable(),
  saleId: atomicSchema.nullable(), participant: canonicalAddressSchema, claimQueryId: atomicSchema, claimBodyHash: hexSchema,
  claimRequest: launchpadOriginalRequestSchema,
  paymentRoot: canonicalAddressSchema, sourceWallet: canonicalAddressSchema, recipientOwner: canonicalAddressSchema.nullable(),
  destinationWallet: canonicalAddressSchema.nullable(), amountRaw: atomicSchema.nullable(), settlementId: atomicSchema.nullable(), settlementRequestHash: hexSchema.nullable(),
  originalPayment: z.object({ queryId: atomicSchema, amountRaw: atomicSchema, sourceWallet: canonicalAddressSchema, destinationWallet: canonicalAddressSchema,
    requestBodyHash: hexSchema, evidence: z.array(physicalEvidenceSchema).max(1000) }).strict().nullable(),
  contribution: z.object({ before: launchpadContributionSchema, after: launchpadContributionSchema }).strict().nullable(),
  stateEvidence: z.array(z.object({ purpose: z.enum(['contribution', 'refund-enqueue', 'delivery', 'finalization']), transaction: physicalEvidenceSchema,
    beforeHash: hexSchema, afterHash: hexSchema, beforeSeqno: z.number().int().nonnegative(), afterSeqno: z.number().int().nonnegative() }).strict()).max(1000),
  localNetworkFees: feeEvidenceSchema,
}).strict();
const perpsBoundarySchema = z.object({
  account: z.object({ collateralRaw: atomicSchema, pendingFundingRaw: signedSchema, crossMargin: z.number().int(), referralLinked: z.number().int(), openPositionCount: z.number().int().nonnegative() }),
  position: z.object({ owner: canonicalAddressSchema, marketId: z.number().int().nonnegative(), sizeRaw: signedSchema, marginRaw: atomicSchema,
    entryNotionalRaw: atomicSchema, lastFundingIndexRaw: signedSchema, flags: z.number().int().nonnegative() }).nullable(),
}).passthrough();
export const ledgerEventSchema = z.object({ id: z.string().min(1).max(256), network: z.enum(['mainnet', 'testnet', 'localnet']),
  account: canonicalAddressSchema, lt: z.string().regex(/^\d+$/), hash: transactionHashSchema, txId: z.string().max(256),
  utime: z.number().int().positive(), status: z.enum(['success', 'failed', 'pending']), kind: z.string().max(40),
  launchpadRequests: z.array(z.object({ kind: z.enum(['contribute', 'bid', 'claim']), sale: canonicalAddressSchema, outerQueryId: atomicSchema,
    innerQueryId: atomicSchema.nullable(), referrer: canonicalAddressSchema.nullable(), sourceWallet: canonicalAddressSchema.nullable(), forwardPayloadHash: hexSchema.nullable(),
    originalRequest: launchpadOriginalRequestSchema }).strict()).max(32768).optional(),
  movements: z.array(z.object({ direction: z.enum(['in', 'out', 'fee']), amountRaw: atomicSchema, purpose: z.string().optional(),
    asset: z.object({ kind: z.enum(['native', 'jetton', 'lp_position', 'option_position', 'perps_balance', 'unknown']), id: z.string(), pool: z.string().optional(),
      owner: canonicalAddressSchema.optional(), factory: canonicalAddressSchema.optional(), series: canonicalAddressSchema.optional(),
      seriesId: atomicSchema.optional(), positionId: atomicSchema.optional(), decimals: z.number().int().optional() }).passthrough(),
    evidence: z.object({ kind: z.string(), bodyHash: z.string().optional(),
      dlmmReceipt: dlmmReceiptSchema.optional(),
      optionPosition: z.object({ factory: canonicalAddressSchema, factoryCodeHash: z.string().regex(/^[a-f0-9]{64}$/),
        seriesId: atomicSchema, positionId: atomicSchema, owner: canonicalAddressSchema, sourceWallet: canonicalAddressSchema,
        notionalRaw: atomicSchema, premiumRaw: atomicSchema, collateralRaw: atomicSchema, seriesWireId: atomicSchema, custodyWireId: atomicSchema,
        protocolFeeRaw: atomicSchema, excessRaw: atomicSchema, beforeBuyStateRaw: atomicSchema, buyStateRaw: atomicSchema }).optional(),
      stateBeforeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), stateAfterHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      beforeSeqno: z.number().int().nonnegative().optional(), afterSeqno: z.number().int().nonnegative().optional(), transactions: z.array(physicalEvidenceSchema).max(1000).optional(),
      getter: z.object({ account: canonicalAddressSchema, method: z.enum(['get_sccp_burn_record', 'redemption_identity']), args: z.array(z.string()).max(10),
        result: z.array(z.string()).max(32), observedAt: z.string().datetime() }).optional() }).passthrough().optional(),
  }).passthrough()).max(1000),
  actions: z.array(z.object({ kind: z.string() }).passthrough()).max(1000), issues: z.array(z.string()).max(100),
  settlement: z.object({ status: z.enum(['confirmed', 'incomplete']), protocol: z.enum(['dlmm', 'jetton', 'options', 'sccp', 't3', 'perps', 'launchpad']),
    operation: z.enum(['swap', 'lp_deposit', 'lp_withdraw', 'lp_fee_collect', 'transfer', 'option_buy', 'option_exercise', 'option_refund', 'bridge_burn', 'bridge_mint', 't3_mint', 't3_redeem', 'perps_operation', 'launchpad_refund', 'launchpad_participation']), pool: canonicalAddressSchema.optional(),
    dlmmLiquidity: dlmmLiquiditySchema.optional(),
    optionLifecycle: optionLifecycleSchema.optional(),
    launchpad: launchpadRefundSchema.optional(),
    launchpadParticipation: launchpadParticipationSchema.optional(),
    t3: z.object({ hub: canonicalAddressSchema, root: canonicalAddressSchema, owner: canonicalAddressSchema, recipient: canonicalAddressSchema,
      queryId: atomicSchema, amountRaw: atomicSchema.nullable(), mintedRaw: atomicSchema.optional(), stage: z.enum(['minted', 'redeemed', 'unresolved']),
      rootQueryId: atomicSchema.optional(), wireId: atomicSchema.optional(), requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      payoutId: atomicSchema.optional(), receiver: canonicalAddressSchema.optional(), reserveRoots: z.array(canonicalAddressSchema).length(3),
      basketRaw: z.array(atomicSchema).length(3), deliveredRaw: z.array(atomicSchema).length(3), feeBreakdown: z.enum(['verified', 'unavailable']),
      feeAmountsRaw: z.array(atomicSchema).length(3).optional(), localNetworkFees: feeEvidenceSchema,
    }).passthrough().optional(),
    perps: z.object({ engine: canonicalAddressSchema, engineCodeHash: z.string().regex(/^[a-f0-9]{64}$/), root: canonicalAddressSchema,
      owner: canonicalAddressSchema, ownerWallet: canonicalAddressSchema, engineWallet: canonicalAddressSchema, marketId: z.number().int().nonnegative(),
      positionKey: z.string().regex(/^[a-f0-9]{64}$/), queryId: atomicSchema, fundingQueryId: atomicSchema.optional(),
      request: z.object({ opcode: z.number().int().nonnegative(), operation: z.enum(['open','modify','close','add_margin','remove_margin','claim','liquidation','adl']),
        queryId: atomicSchema, marketId: z.number().int().nonnegative(), owner: canonicalAddressSchema.optional() }).passthrough(),
      outcome: z.enum(['accepted','rejected','retry','unresolved']), depositRaw: atomicSchema,
      before: perpsBoundarySchema.optional(), after: perpsBoundarySchema.optional(),
      stateEvidence: z.object({ kind: z.literal('perps_account_delta'), stateBeforeHash: z.string().regex(/^[a-f0-9]{64}$/),
        stateAfterHash: z.string().regex(/^[a-f0-9]{64}$/), beforeSeqno: z.number().int().nonnegative(), afterSeqno: z.number().int().nonnegative(),
        transactions: z.array(physicalEvidenceSchema).max(1000) }).optional(),
      payout: z.object({ status: z.enum(['none','pending','completed','aggregate_unresolved']), amountRaw: atomicSchema,
        wireId: atomicSchema.optional(), evidence: z.array(physicalEvidenceSchema).max(1000) }), localNetworkFees: feeEvidenceSchema,
    }).passthrough().optional(),
    bridge: z.object({ messageId: z.string().max(256).nullable(), nonce: atomicSchema.nullable(), amountRaw: atomicSchema,
      sourceDomain: z.number().int().nonnegative(), destinationDomain: z.number().int().nonnegative(), soraAssetId: z.string().max(256).nullable(),
      recipient32: z.string().max(128), tonMaster: canonicalAddressSchema, tonWallet: canonicalAddressSchema, tonOwner: canonicalAddressSchema,
      verifier: canonicalAddressSchema.optional(), masterCodeHash: z.string().nullable(), verifierCodeHash: z.string().optional(),
      localStage: z.enum(['burned', 'minted', 'unresolved']), counterpartyStatus: z.literal('unverified'),
      localNetworkFees: z.array(z.object({ transaction: physicalEvidenceSchema, amountRaw: atomicSchema.nullable(), includedInOwnerFeeMovements: z.boolean() })).max(1000),
    }).optional(),
    factory: canonicalAddressSchema.optional(), series: canonicalAddressSchema.optional(), seriesId: atomicSchema.optional(),
    positionId: atomicSchema.optional(), wireId: atomicSchema.optional(), positionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    notionalRaw: atomicSchema.optional(), premiumRaw: atomicSchema.optional(), collateralRaw: atomicSchema.optional(), protocolFeeRaw: atomicSchema.optional(),
    queryId: atomicSchema.optional(),
    evidence: z.array(physicalEvidenceSchema).max(1000),
  }).superRefine((value, ctx) => {
    if (value.operation === 'lp_fee_collect' && value.queryId !== undefined)
      ctx.addIssue({code: 'custom', path: ['queryId'], message: 'Fee collection has no business query ID'});
  }).optional(),
}).passthrough();
const ledgerCoverageSchema = z.object({ syncing: z.boolean(), historyComplete: z.boolean(),
  decodingComplete: z.boolean(), issues: z.array(z.string()), generation: z.string().uuid().nullable(),
  snapshotComplete: z.boolean(), publishedAt: z.string().datetime().nullable(), headObservedAt: z.string().datetime().nullable(), checkedAt: z.string().datetime().nullable(),
}).passthrough();
const revisionSchema = z.string().regex(/^(0|[1-9]\d{0,29})$/);
export const ledgerDiscoverySchema = z.object({
  network: z.enum(['mainnet', 'testnet', 'localnet']), account: canonicalAddressSchema,
  since: z.string().datetime(), throughRevision: revisionSchema,
  revisions: z.array(z.object({ revision: revisionSchema, generation: z.string().uuid(), discoveredAt: z.string().datetime(),
    evidenceUtime: z.number().int().nonnegative(), event: ledgerEventSchema }).strict()).max(100),
  nextCursor: z.string().max(2048).nullable(), coverage: ledgerCoverageSchema,
}).strict();
export type LedgerEvent = z.infer<typeof ledgerEventSchema>;
