import { z } from 'zod';
import { normalizeAddress } from './store.js';
import { currentDlmmSchema, currentPerpsSchema, currentOptionsSchema, currentLaunchpadSchema, currentT3ReceiptSchema, currentT3RecoverySchema } from './currentLedgerSchemas.js';

const canonicalAddressSchema = z.string().max(100).refine(value => {
  try { return normalizeAddress(value) === value; } catch { return false; }
}, 'Expected a canonical raw address');
const atomicSchema = z.string().max(120).regex(/^(0|[1-9]\d*)$/);
// The ledger publishes transaction hashes as canonical padded base64; code/body hashes are hexadecimal.
const transactionHashSchema = z.string().refine(value => (/^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value), 'Expected a 32-byte TON transaction hash');
const physicalEvidenceSchema = z.object({ account: canonicalAddressSchema, lt: atomicSchema, hash: transactionHashSchema, utime: z.number().int().positive() });
const feeEvidenceSchema = z.array(z.object({ transaction: physicalEvidenceSchema, amountRaw: atomicSchema.nullable(), includedInOwnerFeeMovements: z.boolean() })).max(1000);
export const ledgerEventSchema = z.object({ id: z.string().min(1).max(256), network: z.enum(['mainnet', 'testnet', 'localnet']),
  account: canonicalAddressSchema, lt: z.string().regex(/^\d+$/), hash: transactionHashSchema, txId: z.string().max(256),
  utime: z.number().int().positive(), status: z.enum(['success', 'failed', 'pending']), kind: z.string().max(40),
  movements: z.array(z.object({ direction: z.enum(['in', 'out', 'fee']), amountRaw: atomicSchema, purpose: z.string().optional(),
    asset: z.object({ kind: z.enum(['native', 'jetton', 'lp_position', 'option_position', 'perps_balance', 'unknown']), id: z.string(), pool: z.string().optional(),
      owner: canonicalAddressSchema.optional(), factory: canonicalAddressSchema.optional(), series: canonicalAddressSchema.optional(),
      seriesId: atomicSchema.optional(), positionId: atomicSchema.optional(), decimals: z.number().int().optional() }).passthrough(),
    evidence: z.object({ kind: z.string(), bodyHash: z.string().optional(),
      stateBeforeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), stateAfterHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      beforeSeqno: z.number().int().nonnegative().optional(), afterSeqno: z.number().int().nonnegative().optional(), transactions: z.array(physicalEvidenceSchema).max(1000).optional(),
      getter: z.object({ account: canonicalAddressSchema, method: z.enum(['get_sccp_burn_record', 'redemption_identity']), args: z.array(z.string()).max(10),
        result: z.array(z.string()).max(32), observedAt: z.string().datetime() }).optional() }).passthrough().optional(),
  }).passthrough()).max(1000),
  actions: z.array(z.object({ kind: z.string() }).passthrough()).max(1000), issues: z.array(z.string()).max(100),
  settlement: z.object({ status: z.enum(['confirmed', 'incomplete']), protocol: z.enum(['dlmm', 'jetton', 'options', 'sccp', 't3', 'perps', 'launchpad']),
    operation: z.enum(['swap', 'lp_deposit', 'lp_withdraw', 'transfer', 'bridge_burn', 'bridge_mint', 't3_mint', 't3_redeem', 'perps_operation', 'dlmm_operation', 'option_operation', 'launchpad_operation']), pool: canonicalAddressSchema.optional(),
    currentDlmm: currentDlmmSchema.optional(), currentPerps: currentPerpsSchema.optional(),
    currentOptions: currentOptionsSchema.optional(), currentLaunchpad: currentLaunchpadSchema.optional(),
    t3: z.object({ hub: canonicalAddressSchema, root: canonicalAddressSchema, owner: canonicalAddressSchema, recipient: canonicalAddressSchema,
      queryId: atomicSchema, amountRaw: atomicSchema.nullable(), mintedRaw: atomicSchema.optional(), stage: z.enum(['minted', 'redeemed', 'refunded', 'swapped', 'claimable', 'cancelled', 'unresolved']),
      reserveRoots: z.array(canonicalAddressSchema).max(3),
      receipt: currentT3ReceiptSchema.optional(), walletRecovery: currentT3RecoverySchema.optional(),
      basketRaw: z.array(atomicSchema).length(3), deliveredRaw: z.array(atomicSchema).length(3), feeBreakdown: z.enum(['verified', 'unavailable']),
      feeAmountsRaw: z.array(atomicSchema).length(3).optional(), localNetworkFees: feeEvidenceSchema,
    }).strict().superRefine((value, ctx) => {
      if (value.reserveRoots.length !== 3 && !(value.reserveRoots.length === 0 && value.stage === 'unresolved'))
        ctx.addIssue({ code: 'custom', path: ['reserveRoots'], message: 'Resolved reserve operations require three roots' });
    }).optional(),
    bridge: z.object({ messageId: z.string().max(256).nullable(), nonce: atomicSchema.nullable(), amountRaw: atomicSchema,
      sourceDomain: z.number().int().nonnegative(), destinationDomain: z.number().int().nonnegative(), soraAssetId: z.string().max(256).nullable(),
      recipient32: z.string().max(128), tonMaster: canonicalAddressSchema, tonWallet: canonicalAddressSchema, tonOwner: canonicalAddressSchema,
      verifier: canonicalAddressSchema.optional(), masterCodeHash: z.string().nullable(), verifierCodeHash: z.string().optional(),
      localStage: z.enum(['burned', 'minted', 'unresolved']), counterpartyStatus: z.literal('unverified'),
      localNetworkFees: z.array(z.object({ transaction: physicalEvidenceSchema, amountRaw: atomicSchema.nullable(), includedInOwnerFeeMovements: z.boolean() })).max(1000),
    }).optional(),
    factory: canonicalAddressSchema.optional(), seriesId: atomicSchema.optional(), positionId: atomicSchema.optional(),
    queryId: atomicSchema.optional(),
    evidence: z.array(physicalEvidenceSchema).max(1000),
  }).strict().superRefine((value, ctx) => {
    const required = { dlmm: 'currentDlmm', perps: 'currentPerps', options: 'currentOptions', launchpad: 'currentLaunchpad', t3: 't3' } as const;
    const field = required[value.protocol as keyof typeof required];
    if (field && !(value.protocol === 't3' && value.operation === 'transfer') && !value[field]) ctx.addIssue({ code: 'custom', path: [field], message: 'Current product evidence is required' });
    if (value.t3 && !value.t3.receipt && !value.t3.walletRecovery && value.t3.stage !== 'unresolved')
      ctx.addIssue({ code: 'custom', path: ['t3'], message: 'Current T3 receipt or recovery evidence is required' });
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
