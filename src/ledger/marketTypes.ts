import type { MarketAssetPrecision } from './jettonPrecision';
import type { Network } from '../models';
import type { RawTransaction } from '../data/dataSource';
import type { LedgerStateSnapshot } from './archive';
import type { LedgerEvidenceRef } from './types';

/** Explicit deployment qualification. A registry address alone supplies no code proof. */
export type DlmmMarketBinding = {
  network: Network; pool: string; poolCodeHash: string; walletCodeHash: string;
  tokenT: string; tokenX: string; tokenTCodeHash: string; tokenXCodeHash: string;
};
export type MarketNode = {
  account: string; raw: RawTransaction;
  assetPrecision?: MarketAssetPrecision;
  before?: LedgerStateSnapshot | null; after?: LedgerStateSnapshot | null;
};
export type MarketDependency = {
  account: string; generation: string; historyComplete: boolean;
  headLt: string; headHash: string; checkedThrough: string;
};
export type MarketBoundaryEvidence = {
  transaction: LedgerEvidenceRef; beforeSeqno: number; afterSeqno: number;
  beforeDataHash: string | null; beforeAccountState: 'active' | 'uninitialized'; afterDataHash: string; codeHash: string;
};
export type MarketSettlementEvidence = {
  settlementId: string; kind: 'swap_output' | 'unused_input_refund';
  amountRaw: string; sourceWallet: string; destinationWallet: string; destinationOwner: string;
  requestBodyHash: string; requestBodyBoc: string;
  request: LedgerEvidenceRef; debit: LedgerEvidenceRef; credit: LedgerEvidenceRef;
  acknowledged: LedgerEvidenceRef; walletFinalized: LedgerEvidenceRef; poolFinalized: LedgerEvidenceRef;
  boundaries: MarketBoundaryEvidence[];
};
export type MarketObservation = {
  id: string; network: Network; pool: string; kind: 'settled_dlmm_execution';
  acceptance: LedgerEvidenceRef; executionUtime: number; deliveredUtime: number; finalizedUtime: number;
  payer: string; recipient: string; businessQueryId: string;
  inputAsset: string; outputAsset: string;
  assetPrecision: MarketAssetPrecision;
  paidInputRaw: string; returnedInputRaw: string; consumedInputRaw: string; outputRaw: string;
  /** Exact output atomic units per input atomic unit, including trading fees.
   * This is not a decimal-normalized token price or a fiat valuation. */
  ratio: { numerator: string; denominator: string; unit: 'output_atomic_per_input_atomic'; includesTradingFees: true };
  input: { request: LedgerEvidenceRef; debit: LedgerEvidenceRef; credit: LedgerEvidenceRef; boundaries: MarketBoundaryEvidence[] };
  allocation: MarketBoundaryEvidence;
  settlements: MarketSettlementEvidence[];
  fees: { transaction: LedgerEvidenceRef; nativeAmountRaw: string | null }[];
};
export type MarketCandidate = {
  id: string; acceptance: LedgerEvidenceRef;
  status: 'settled' | 'refunded' | 'unresolved'; issues: string[];
  observationId: string | null;
};
export type MarketProjection = {
  schema: 'dlmm-market-ledger-v1'; binding: DlmmMarketBinding;
  dependencies: MarketDependency[]; observations: MarketObservation[]; candidates: MarketCandidate[];
  issues: string[];
  /** Coverage of supplied, pinned chains only; never worldwide market coverage. */
  historyComplete: boolean;
};
