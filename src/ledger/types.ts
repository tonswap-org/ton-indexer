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
    | "launchpad_refund"
    | "launchpad_participation";
  asset: LedgerAsset;
  amountRaw: string;
  source?: string;
  destination?: string;
  evidence: {
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
      method: "get_sccp_burn_record" | "redemption_identity";
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
    kind:
      | "native_message"
      | "transaction_fee"
      | "message_forward_fee"
      | "jetton_notification"
      | "jetton_internal_transfer"
      | "jetton_transfer"
      | "lp_position_delta"
      | "option_activation"
      | "option_position_delta"
      | "option_payout"
      | "option_refund"
      | "sccp_burn_record"
      | "sccp_mint"
      | "t3_mint"
      | "t3_burn"
      | "t3_payout"
      | "perps_account_delta"
      | "perps_payout";
  };
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
    | "option_buy"
    | "option_exercise"
    | "option_refund"
    | "bridge_burn"
    | "bridge_mint"
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
    protocol: "dlmm" | "jetton" | "options" | "sccp" | "t3" | "perps" | "launchpad";
    operation:
      | "swap"
      | "lp_deposit"
      | "lp_withdraw"
      | "transfer"
      | "option_buy"
      | "option_exercise"
      | "option_refund"
      | "bridge_burn"
      | "bridge_mint"
      | "t3_mint"
      | "t3_redeem"
      | "perps_operation"
      | "launchpad_refund"
      | "launchpad_participation";
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
    bridge?: {
      messageId: string | null;
      sourceDomain: number;
      destinationDomain: number;
      soraAssetId: string | null;
      recipient32: string;
      nonce: string | null;
      amountRaw: string;
      tonMaster: string;
      tonWallet: string;
      tonOwner: string;
      verifier?: string;
      masterCodeHash: string | null;
      verifierCodeHash?: string;
      localStage: "burned" | "minted" | "unresolved";
      counterpartyStatus: "unverified";
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

export type LedgerCoverage = {
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
  fromUtime?: number;
  toUtime?: number;
  limit?: number;
  cursor?: string;
};
