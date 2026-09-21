import type { Network, TxAction, TxKind } from "../models";

export type LedgerAsset = {
  kind:
    | "native"
    | "jetton"
    | "lp_position"
    | "option_position"
    | "perps_balance"
    | "unknown";
  id: string;
  master?: string;
  wallet?: string;
  owner?: string;
  controller?: string;
  engine?: string;
  balanceType?: "collateral" | "funding" | "payout";
  custody?: "t3_receiver";
  symbol?: string;
  decimals?: number;
  pool?: string;
  binId?: number;
  factory?: string;
  series?: string;
  seriesId?: string;
  positionId?: string;
};

export type LedgerEvidenceRef = {
  account: string;
  lt: string;
  hash: string;
  utime: number;
};
/** Verified original provision to an internal DLMM position. This proves
 * physical funding and shares, not beneficial ownership, a legal tax date,
 * contractual-right value or token precision. */
export type DlmmDepositMetadata = {
  network: Network; pool: string; poolCodeHash: string; walletCodeHash: string;
  owner: string; binId: number; queryId: string;
  sharesBeforeRaw: string; sharesAfterRaw: string; mintedSharesRaw: string; minSharesRaw: string;
  stateBefore: { seqno: number; dataHash: string; transaction: LedgerEvidenceRef };
  stateAfter: { seqno: number; dataHash: string; transaction: LedgerEvidenceRef };
  contributions: {
    tokenSide: 0 | 1; assetId: string; master: string; amountRaw: string;
    movementId: string; sourceWallet: string; destinationWallet: string;
    transferQueryId: string; minSharesRaw: string; forwardTonRaw: string;
    requestBodyHash: string; notificationBodyHash: string;
    origin: LedgerEvidenceRef; debit: LedgerEvidenceRef; credit: LedgerEvidenceRef; acceptance: LedgerEvidenceRef;
    boundaries: import('./marketTypes').MarketBoundaryEvidence[];
  }[];
};
/** Protocol amounts are components of one physical payout, never extra cash
 * movements or an automatic country income classification. */
export type DlmmLiquidityReceipt = {
  pool: string; owner: string; recipient: string; binId: number;
  settlementId: string; principalRaw: string; earnedFeeRaw: string;
  delivery: LedgerEvidenceRef;
};
export type DlmmLiquidityMetadata = {
  pool: string; poolCodeHash: string; walletCodeHash: string;
  owner: string; recipient: string; binId: number;
  request: { opcode: number; sharesRaw: string; bodyHash: string; transaction: LedgerEvidenceRef };
  stateBefore: { seqno: number; dataHash: string; transaction: LedgerEvidenceRef };
  stateAfter: { seqno: number; dataHash: string; transaction: LedgerEvidenceRef };
  sharesBeforeRaw: string; sharesAfterRaw: string;
  economics: { principalTRaw: string; principalXRaw: string; earnedFeeTRaw: string; earnedFeeXRaw: string; totalTRaw: string; totalXRaw: string };
  payouts: {
    tokenSide: 0 | 1; assetId: string; master: string; sourceWallet: string;
    destinationOwner: string; destinationWallet: string; settlementId: string | null;
    totalRaw: string; principalRaw: string; earnedFeeRaw: string;
    movementId: string | null; delivery: LedgerEvidenceRef | null;
    status: "none" | "delivered" | "unresolved";
    finalization: "none" | "confirmed" | "unresolved";
    deliveryEvidence?: import("./dlmmProof").DlmmDeliveryEvidence;
    settlementEvidence?: import("./dlmmProof").DlmmSettlementEvidence;
  }[];
};
export type LedgerRelatedAccount = {
  account: string;
  generation: string | null;
  historyComplete: boolean;
  role:
    | "owner"
    | "owned_jetton_wallet"
    | "controlled_contract"
    | "counterparty"
    | "pool";
};

export type LedgerMovement = {
  id: string;
  direction: "in" | "out" | "fee";
  purpose?:
    | "option_premium"
    | "option_collateral"
    | "protocol_fee"
    | "option_excess"
    | "option_payout"
    | "option_refund"
    | "option_right_retired"
    | "t3_collateral"
    | "t3_mint"
    | "t3_burn"
    | "t3_payout"
    | "perps_collateral"
    | "perps_funding"
    | "perps_payout"
    | "perps_counterparty_profit"
    | "launchpad_refund"
    | "launchpad_participation";
  asset: LedgerAsset;
  amountRaw: string;
  source?: string;
  destination?: string;
  evidence: {
    dlmmDeposit?: DlmmDepositMetadata;
    dlmmReceipt?: DlmmLiquidityReceipt;
    optionPosition?: {
      factory: string;
      factoryCodeHash: string;
      seriesId: string;
      positionId: string;
      owner: string;
      sourceWallet: string;
      notionalRaw: string;
      premiumRaw: string;
      collateralRaw: string;
      seriesWireId: string;
      custodyWireId: string;
      protocolFeeRaw: string;
      excessRaw: string;
      beforeBuyStateRaw: string;
      buyStateRaw: string;
    };
    getter?: {
      account: string;
      method: "redemption_identity";
      args: string[];
      result: string[];
      observedAt: string;
    };
    messageIndex?: number;
    opcode?: number;
    bodyHash?: string;
    requestBodyHash?: string;
    queryId?: string;
    transactions?: LedgerEvidenceRef[];
    stateBeforeHash?: string;
    stateAfterHash?: string;
    beforeSeqno?: number;
    afterSeqno?: number;
  } & ({
    /** Terminal result of exactly this physical transaction, not the event anchor. */
    kind: "native_message" | "transaction_fee" | "message_forward_fee";
    transactionStatus: "success" | "failed";
    transactions: [LedgerEvidenceRef];
  } | {
    transactionStatus?: never;
    kind:
      | "jetton_notification"
      | "jetton_internal_transfer"
      | "jetton_transfer"
      | "lp_position_delta"
      | "option_activation"
      | "option_position_delta"
      | "option_payout"
      | "option_refund"
      | "t3_mint"
      | "t3_burn"
      | "t3_payout"
      | "perps_account_delta"
      | "perps_payout";
  });
};

/** Account-level chain evidence. Actions are decoding hints, never a tax classification or proof of order settlement. */
export type LedgerEvent = {
  id: string;
  network: Network;
  account: string;
  lt: string;
  hash: string;
  txId: string;
  utime: number;
  status: "success" | "failed" | "pending";
  kind:
    | TxKind
    | "lp_fee_collect"
    | "option_buy"
    | "option_exercise"
    | "option_refund"
    | "t3_mint"
    | "t3_redeem"
    | "perps_operation"
    | "launchpad_refund"
    | "launchpad_participation";
  totalFeesRaw: string | null;
  movements: LedgerMovement[];
  actions: TxAction[];
  issues: string[];
  launchpadRequests?: import("./launchpadRequests").LaunchpadRequestIdentity[];
  settlement?: {
    status: "confirmed" | "incomplete";
    protocol: "dlmm" | "jetton" | "options" | "t3" | "perps" | "launchpad";
    operation:
      | "swap"
      | "lp_deposit"
      | "lp_withdraw"
      | "lp_fee_collect"
      | "transfer"
      | "option_buy"
      | "option_exercise"
      | "option_refund"
      | "t3_mint"
      | "t3_redeem"
      | "perps_operation"
      | "launchpad_refund"
      | "launchpad_participation";
    dlmmSwap?: {
      poolCodeHash: string;
      paidInputRaw: string; consumedInputRaw: string; returnedInputRaw: string; outputRaw: string;
      inputMovementId: string; outputMovementId: string | null; refundMovementId: string | null;
      acceptance: LedgerEvidenceRef; finalizations: LedgerEvidenceRef[];
    };
    dlmmLiquidity?: DlmmLiquidityMetadata;
    launchpad?: import("./launchpad").LaunchpadRefundMetadata;
    launchpadParticipation?: import("./launchpadContributions").LaunchpadParticipationMetadata;
    optionLifecycle?: import("./optionLifecycle").OptionLifecycleMetadata;
    perps?: {
      engine: string;
      engineCodeHash: string;
      root: string;
      owner: string;
      ownerWallet: string;
      engineWallet: string;
      marketId: number;
      positionKey: string;
      queryId: string;
      fundingQueryId?: string;
      request: import("./perpsWire").PerpsRequest;
      outcome: "accepted" | "rejected" | "retry" | "unresolved";
      depositRaw: string;
      execution?: { status: "failed"; transaction: LedgerEvidenceRef };
      oracleExecution?: {
        status: "pending" | "accepted" | "rejected";
        wireQueryId: string;
        requestHash: string;
        nativeBudgetRaw: string;
        requestedPool: string;
        reason: number;
        queued: LedgerEvidenceRef;
        pool: LedgerEvidenceRef | null;
        completed: LedgerEvidenceRef | null;
        admission?: { version: 'perps-funded-admission-v1'; vault: string; controller: string;
          reservation: LedgerEvidenceRef; vaultResponse: LedgerEvidenceRef;
          policyRequest: LedgerEvidenceRef | null; policyResponse: LedgerEvidenceRef | null };
        intakeEvidence: LedgerMovement["evidence"];
        intake: {
          account: import("./perpsState").PerpsAccount;
          position: import("./perpsState").PerpsPosition | null;
          pending: import("./perpsState").PerpsPending | null;
        };
      };
      before?: {
        account: import("./perpsState").PerpsAccount;
        position: import("./perpsState").PerpsPosition | null;
        pending: import("./perpsState").PerpsPending | null;
      };
      after?: {
        account: import("./perpsState").PerpsAccount;
        position: import("./perpsState").PerpsPosition | null;
        pending: import("./perpsState").PerpsPending | null;
      };
      economics?: import("./perpsEconomics").PerpsEconomics;
      stateEvidence?: LedgerMovement["evidence"];
      counterpartyPayout: import("./perpsCounterparty").PerpsCounterpartyPayout;
      payout: {
        status: "none" | "pending" | "completed" | "aggregate_unresolved";
        amountRaw: string;
        wireId?: string;
        evidence: LedgerEvidenceRef[];
      };
      localNetworkFees: {
        transaction: LedgerEvidenceRef;
        amountRaw: string | null;
        includedInOwnerFeeMovements: boolean;
      }[];
    };
    t3?: {
      hub: string;
      root: string;
      owner: string;
      recipient: string;
      queryId: string;
      amountRaw: string | null;
      mintedRaw?: string;
      referrer?: string | null;
      stage: "minted" | "redeemed" | "unresolved";
      rootQueryId?: string;
      wireId?: string;
      requestHash?: string;
      payoutId?: string;
      receiver?: string;
      reserveRoots: string[];
      basketRaw: string[];
      deliveredRaw: string[];
      feeBreakdown: "verified" | "unavailable";
      feeAmountsRaw?: string[];
      feeEvidence?: LedgerMovement["evidence"];
      identityEvidence?: LedgerMovement["evidence"]["getter"];
      burnRecovery?: import("./t3Recovery").T3BurnRecovery;
      localNetworkFees: {
        transaction: LedgerEvidenceRef;
        amountRaw: string | null;
        includedInOwnerFeeMovements: boolean;
      }[];
    };
    pool?: string;
    factory?: string;
    series?: string;
    seriesId?: string;
    positionId?: string;
    wireId?: string;
    positionHash?: string;
    notionalRaw?: string;
    referrer?: string | null;
    premiumRaw?: string;
    collateralRaw?: string;
    protocolFeeRaw?: string;
    queryId?: string;
    evidence: LedgerEvidenceRef[];
  };
};

export type LedgerProjectionScope = {
  kind: "owner";
  owner: string;
  /** Exact canonical physical-account set included by this projection, including quiet custody. */
  physicalAccounts: string[];
};

export type LedgerProjection = {
  events: LedgerEvent[];
  projectionScope: LedgerProjectionScope;
};

export type LedgerRangeCoverage = {
  scope: "perps";
  fromUtime: number;
  toUtime: number;
  complete: boolean;
  status: "pending" | "running" | "complete" | "failed";
  retryAfter: string | null;
};
export type LedgerCoverage = {
  range?: LedgerRangeCoverage;
  projectionScope: LedgerProjectionScope | null;
  generation: string | null;
  publishedAt: string | null;
  headObservedAt: string | null;
  checkedAt: string | null;
  snapshotComplete: boolean;
  historyComplete: boolean;
  decodingComplete: boolean;
  syncing: boolean;
  oldestUtime: number | null;
  newestUtime: number | null;
  syncedAt: string | null;
  issues: string[];
  relatedAccounts?: LedgerRelatedAccount[];
  discoveryScope?: "configured_roots_and_observed_wallets";
};

export type LedgerPage = {
  network: Network;
  account: string;
  events: LedgerEvent[];
  nextCursor: string | null;
  coverage: LedgerCoverage;
};

export type LedgerQuery = {
  /** Internal immutable generation selection; never accepted from public query parameters. */
  generation?: string;
  scope?: "perps";
  fromUtime?: number;
  toUtime?: number;
  limit?: number;
  cursor?: string;
};

/** Publication discovery is separate from chain execution and notification eligibility. */
export type LedgerDiscoveryQuery = { since: string; afterRevision?: string; cursor?: string; limit?: number };
export type LedgerDiscoveryPage = {
  network: Network;
  account: string;
  since: string;
  throughRevision: string;
  revisions: Array<{ revision: string; generation: string; discoveredAt: string; evidenceUtime: number; event: LedgerEvent }>;
  nextCursor: string | null;
  coverage: LedgerCoverage;
};
