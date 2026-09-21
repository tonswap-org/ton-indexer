import { decodeControlMeshSnapshot } from './utils/controlMesh';
import { decodeRiskControllerSnapshot, type RiskControllerSnapshot } from './utils/riskController';
import { readOriginalTransactionEvidence, originalTransactionToToncenter } from './data/transactionEvidence';
import { AdmissionExecutor } from './data/admission/nativePool';
import { AdmissionError, AdmissionExecution, isAdmissionMethod } from './data/admission/protocol';
import { readDlmmFarmSnapshot, type DlmmFarmSnapshot, type DlmmFarmSnapshotOptions } from './utils/dlmmFarming';
import { Address, Cell, TupleItem, beginCell, contractAddress, parseTuple, serializeTuple, storeStateInit } from '@ton/core';
import { EventEmitter } from 'node:events';
import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import {
  RawTransaction,
  TonDataSource,
  transactionPageIsLinkedInclusiveSegment,
  transactionPageReachesHistoryStart
} from './data/dataSource';
import { OpcodeSets } from './utils/opcodes';
import { governanceProposalRange } from './utils/governanceStorage';
import {
  AccountBalance,
  AccountBalances,
  AccountState,
  HealthStatus,
  IndexedTx,
  Network,
  SwapExecutionType,
  TxAction,
  UiTx,
} from './models';
import { classifyTransaction } from './utils/txClassifier';
import { JettonMetadata } from './models';
import { MetricsCollector } from './metricsCollector';
import { PoolTracker } from './poolTracker';
import { LRUCache } from 'lru-cache';
import {
  buildTonswapJettonWalletInitialData,
  isSuccessfulGetterResult,
  parseCanonicalJettonRootData,
  parseCanonicalJettonWalletAddress
} from './data/jettonAbi';
import { resolveDlmmPoolSettlementEvidence } from './utils/dlmmSettlementEvidence';
import { enrichSwapReceipts, type SwapLedgerReader } from './ledger/swapReceipts';

type ToncenterStackEntry = [string, unknown];
type ToncenterRunResult = {
  stack: ToncenterStackEntry[];
  exit_code: number;
  gas_used: number | null;
  admission?: AdmissionExecution;
};

export type BalanceChangeEvent = {
  type: 'balances_changed';
  address: string;
  seq: number;
  ts: number;
  hints: {
    ton: boolean;
    jettons: string[] | null;
  };
};

export class InitialHistoryReadTimeoutError extends Error {
  readonly code = 'INITIAL_HISTORY_READ_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`Initial transaction history source timed out after ${timeoutMs}ms`);
    this.name = 'InitialHistoryReadTimeoutError';
  }
}

const normalizeAddress = (value: string) => {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return value.trim().toLowerCase();
  }
};

const transactionIdentity = (transaction: { lt: string; hash: string }) =>
  `${transaction.lt}:${transaction.hash}`;

const retainedExactInitialTransactionPage = (
  raw: readonly RawTransaction[],
  retained: readonly IndexedTx[]
) => {
  const rawIdentities = new Set(raw.map(transactionIdentity));
  if (rawIdentities.size !== raw.length || retained.length !== raw.length) return false;
  const retainedIdentities = new Set(retained.map(transactionIdentity));
  return retainedIdentities.size === retained.length &&
    [...rawIdentities].every((identity) => retainedIdentities.has(identity));
};

const balanceStateSignature = (state?: AccountState) => {
  if (!state) return '';
  return [state.balance ?? '', state.lastTxLt ?? '', state.lastTxHash ?? ''].join(':');
};

const normalizeTokenSymbol = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
};

type SwapExecutionStatus = UiTx['status'];

export type AccountSwapExecution = {
  txId: string;
  lt: string;
  hash: string;
  utime: number;
  status: SwapExecutionStatus;
  reason?: string;
  payToken?: string;
  receiveToken?: string;
  /** Original requested wallet debit, distinct from verified consumption. */
  requestedPayAmount?: string;
  /** Verified input consumption after any unused-input return. */
  payAmount?: string;
  returnedPayAmount?: string;
  receiveAmount?: string;
  receiveAmountSource?: 'actual';
  minimumReceiveAmount?: string;
  receipt?: { ledgerEventId: string; generation: string; assetId: string };
  queryId?: string;
  executionType: SwapExecutionType;
  twapSlice?: number;
  twapTotal?: number;
  querySequence?: number;
  queryNonce?: number;
  twapRunId?: string;
};

export type AccountSwapStatusCounts = {
  success: number;
  failed: number;
  pending: number;
};

export type AccountSwapExecutionTypeCounts = {
  market: number;
  limit: number;
  twap: number;
  unknown: number;
};

export type AccountSwapsSummary = {
  status_counts: AccountSwapStatusCounts;
  execution_type_counts: AccountSwapExecutionTypeCounts;
  twap_run_count: number;
  pending_limit_count: number;
};

export type AccountPendingLimitOrder = {
  txId: string;
  lt: string;
  hash: string;
  utime: number;
  status: SwapExecutionStatus;
  payToken?: string;
  receiveToken?: string;
  payAmount?: string;
  receiveAmount?: string;
  minimumReceiveAmount?: string;
  queryId?: string;
  querySequence?: number;
  queryNonce?: number;
};

export type AccountTwapRunSummary = {
  id: string;
  payToken?: string;
  receiveToken?: string;
  totalSlices?: number;
  confirmedSlices: number;
  pendingSlices: number;
  failedSlices: number;
  firstUtime: number;
  lastUtime: number;
  status: 'running' | 'completed' | 'partial' | 'failed';
};

export type AccountSwapsResponse = {
  address: string;
  total_swaps: number;
  returned_swaps: number;
  history_complete: boolean;
  synced_at: number;
  network: Network;
  swaps: AccountSwapExecution[];
  summary: AccountSwapsSummary;
  twap_runs: AccountTwapRunSummary[];
  pending_limits: AccountPendingLimitOrder[];
};

export type MarketCandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export type MarketCandle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeBase: number;
  volumeQuote: number;
  tradeCount: number;
  sourceTxIds: string[];
};

export type MarketCandlesResponse = {
  market_key: string;
  market_address: string;
  interval: MarketCandleInterval;
  from_utime: number | null;
  to_utime: number | null;
  candle_count: number;
  history_complete: boolean;
  synced_at: number;
  network: Network;
  candles: MarketCandle[];
};

const MARKET_CANDLE_INTERVAL_SECONDS: Record<MarketCandleInterval, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

const rawAmountToNumber = (value: string | undefined, decimals: number): number | null => {
  if (!value || !/^\d+$/.test(value)) return null;
  let raw: bigint;
  try {
    raw = BigInt(value);
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  const result = Number(raw) / 10 ** decimals;
  return Number.isFinite(result) && result > 0 ? result : null;
};

export type JettonTransferPayloadResponse = {
  custom_payload: string | null;
  state_init: string | null;
};

const tupleItemBigInt = (item?: TupleItem): bigint | null => {
  if (!item) return null;
  if (item.type === 'int') return item.value;
  return null;
};

const tupleItemBigIntString = (item?: TupleItem): string | null => {
  const value = tupleItemBigInt(item);
  return value !== null ? value.toString(10) : null;
};

const tupleItemBool = (item?: TupleItem): boolean => {
  const value = tupleItemBigInt(item);
  return value !== null && value !== 0n;
};

const tupleItemCell = (item?: TupleItem): Cell | null => {
  if (!item || item.type === 'null') return null;
  if (item.type === 'cell' || item.type === 'slice' || item.type === 'builder') {
    return item.cell as Cell;
  }
  return null;
};

const tupleItemAddress = (item?: TupleItem): string | null => {
  if (!item || item.type === 'null') return null;
  if (item.type !== 'cell' && item.type !== 'slice' && item.type !== 'builder') return null;
  try {
    const exact = item.cell.beginParse().loadAddress();
    return exact ? exact.toRawString() : null;
  } catch {
    // fall through to maybe-address decoding
  }
  try {
    const maybe = item.cell.beginParse().loadMaybeAddress();
    return maybe ? maybe.toRawString() : null;
  } catch {
    return null;
  }
};

// `engine_config` is a canonical, fixed-width getter for the first Perps
// release. Keep its arity and fee slot explicit so a truncated or unrelated
// tuple can never be mistaken for a trade-fee quote.
const PERPS_ENGINE_CONFIG_STACK_ARITY = 33;
const PERPS_ENGINE_CONFIG_FEE_BPS_INDEX = 9;

const canonicalPerpsFeeBps = (
  response: { exitCode: number; stack: TupleItem[] } | null
): string | null => {
  if (
    !response
    || response.exitCode !== 0
    || response.stack.length !== PERPS_ENGINE_CONFIG_STACK_ARITY
  ) {
    return null;
  }
  const feeBps = tupleItemBigInt(response.stack[PERPS_ENGINE_CONFIG_FEE_BPS_INDEX]);
  if (feeBps === null || feeBps < 0n || feeBps > 10_000n) return null;
  return feeBps.toString(10);
};

const toBocBase64 = (cell: any): string | null => {
  if (!cell) return null;
  try {
    return Buffer.from(cell.toBoc()).toString('base64');
  } catch {
    return null;
  }
};

const tupleItemToTvmStackEntry = (item: TupleItem): Record<string, unknown> => {
  if (item.type === 'null') return { '@type': 'tvm.stackEntryNull' };
  if (item.type === 'nan') return { '@type': 'tvm.stackEntryNaN' };
  if (item.type === 'int') {
    return {
      '@type': 'tvm.stackEntryNumber',
      number: {
        '@type': 'tvm.numberDecimal',
        number: item.value.toString(10),
      },
    };
  }
  if (item.type === 'cell') {
    return {
      '@type': 'tvm.stackEntryCell',
      cell: {
        '@type': 'tvm.cell',
        bytes: toBocBase64(item.cell) ?? '',
      },
    };
  }
  if (item.type === 'slice') {
    return {
      '@type': 'tvm.stackEntrySlice',
      slice: {
        '@type': 'tvm.slice',
        bytes: toBocBase64(item.cell) ?? '',
      },
    };
  }
  if (item.type === 'builder') {
    return {
      '@type': 'tvm.stackEntryBuilder',
      builder: {
        '@type': 'tvm.builder',
        bytes: toBocBase64(item.cell) ?? '',
      },
    };
  }
  if (item.type === 'tuple') {
    return {
      '@type': 'tvm.stackEntryTuple',
      tuple: {
        '@type': 'tvm.tuple',
        elements: item.items.map(tupleItemToTvmStackEntry),
      },
    };
  }
  throw new Error('Unsupported nested TVM stack item.');
};

const tupleItemToToncenterStackEntry = (item: TupleItem): ToncenterStackEntry => {
  if (item.type === 'null') return ['null', null];
  if (item.type === 'int') return ['num', item.value.toString(10)];
  if (item.type === 'nan') return ['nan', null];
  if (item.type === 'cell') {
    const b64 = toBocBase64(item.cell);
    return ['cell', { bytes: b64 ?? '' }];
  }
  if (item.type === 'slice') {
    const b64 = toBocBase64(item.cell);
    return ['slice', { bytes: b64 ?? '' }];
  }
  if (item.type === 'builder') {
    const b64 = toBocBase64(item.cell);
    return ['builder', { bytes: b64 ?? '' }];
  }
  if (item.type === 'tuple') {
    return ['tuple', { elements: item.items.map(tupleItemToTvmStackEntry) }];
  }
  return ['unknown', null];
};

const unwrapTupleStack = (stack: TupleItem[]): TupleItem[] => {
  if (stack.length === 1 && stack[0].type === 'tuple') {
    return stack[0].items;
  }
  return stack;
};

const buildSliceCell = (addressRaw: string) => beginCell().storeAddress(Address.parse(addressRaw)).endCell();

const parseAnchorStateCell = (cell: Cell): AnchorStateSnapshot | null => {
  try {
    const slice = cell.beginParse();
    const quorumBps = slice.loadUintBig(16);
    const maxAgeSeconds = slice.loadIntBig(32);
    const epsilonExtBps = slice.loadIntBig(32);
    const epsilonClipBps = slice.loadIntBig(32);
    const trimCount = slice.loadUintBig(8);
    const totalWeight = slice.loadUintBig(64);
    const ready = slice.loadBit();
    const quorumMet = slice.loadBit();
    const price = slice.loadIntBig(128);
    const minPrice = slice.loadIntBig(128);
    const maxPrice = slice.loadIntBig(128);
    const varianceBps = slice.loadIntBig(32);
    const weight = slice.loadUintBig(64);
    const quorumWeight = slice.loadUintBig(64);
    const sampleCount = slice.loadUintBig(32);
    const latestTimestamp = slice.loadIntBig(64);
    return {
      quorumBps: quorumBps.toString(10),
      maxAgeSeconds: maxAgeSeconds.toString(10),
      epsilonExtBps: epsilonExtBps.toString(10),
      epsilonClipBps: epsilonClipBps.toString(10),
      trimCount: trimCount.toString(10),
      totalWeight: totalWeight.toString(10),
      ready,
      quorumMet,
      price: price.toString(10),
      minPrice: minPrice.toString(10),
      maxPrice: maxPrice.toString(10),
      varianceBps: varianceBps.toString(10),
      weight: weight.toString(10),
      quorumWeight: quorumWeight.toString(10),
      sampleCount: sampleCount.toString(10),
      latestTimestamp: latestTimestamp.toString(10)
    };
  } catch {
    return null;
  }
};

const GOVERNANCE_SNAPSHOT_CACHE_TTL_MS = 30_000;
const GOVERNANCE_MAX_SCAN_DEFAULT = 20;
const GOVERNANCE_MAX_SCAN_LIMIT = 64;
const GOVERNANCE_MAX_CONSECUTIVE_MISSES_DEFAULT = 2;
const GOVERNANCE_MAX_CONSECUTIVE_MISSES_LIMIT = 8;
const GOVERNANCE_SCAN_BATCH_SIZE = 5;
const COVER_SNAPSHOT_CACHE_TTL_MS = 30_000;
const COVER_MAX_SCAN_DEFAULT = 20;
const COVER_MAX_SCAN_LIMIT = 64;
const COVER_MAX_CONSECUTIVE_MISSES_DEFAULT = 2;
const COVER_MAX_CONSECUTIVE_MISSES_LIMIT = 8;
const COVER_SCAN_BATCH_SIZE = 5;

const DEFI_SNAPSHOT_CACHE_TTL_MS = 5_000;
const DLMM_POOLS_SNAPSHOT_CACHE_TTL_MS = 5_000;

type GovernanceLockSnapshot = {
  amount: string | null;
  unlockTime: string | null;
  tier: string | null;
  activatedAt: string | null;
  weight: string | null;
};

type GovernanceProposalSnapshot = {
  id: string;
  status: string | null;
  passed: string | null;
  yesWeight: string | null;
  noWeight: string | null;
  abstainWeight: string | null;
  quorumWeight: string | null;
  totalWeightSnapshot: string | null;
  startTime: string | null;
  minCloseTime: string | null;
  maxCloseTime: string | null;
  cooldownEnd: string | null;
  target: string | null;
  value: string | null;
  descriptionHash: string | null;
};

type GovernanceSnapshotResponse = {
  voting: string;
  owner: string | null;
  lock: GovernanceLockSnapshot | null;
  proposal_count: number;
  scanned: number;
  start_id: string;
  next_start_id: string | null;
  coverage: { rangeKnown: boolean; pageComplete: boolean; scanComplete: boolean; nextProposalId: string | null; dataHash: string | null; issues: string[] };
  proposals: GovernanceProposalSnapshot[];
  source: 'lite' | 'http4';
  network: Network;
  updated_at: number;
};

type FarmSnapshotResponse = DlmmFarmSnapshot & { source: 'lite' | 'http4'; network: Network; updated_at: number };

type OptionFactoryStatusSnapshot = {
  governance: string | null;
  enabled: boolean;
};

type OptionSeriesSnapshotRecord = {
  seriesId: string;
  templateId: string | null;
  optionKind: string | null;
  optionAddress: string | null;
  expiry: string | null;
  maxNotional: string | null;
  premiumBps: string | null;
  collateralMultiplierBps: string | null;
  openNotional: string | null;
  status: string | null;
  settlementTimestamp: string | null;
  underlyingPool: string | null;
  quotePool: string | null;
  collateralLocked: string | null;
  correlationScaleBps: string | null;
  correlationBps: string | null;
  correlationDispersionBps: string | null;
  correlationTimestamp: string | null;
  isActive: boolean;
  remainingNotional: string | null;
};

type OptionsSnapshotResponse = {
  factory: string;
  status: OptionFactoryStatusSnapshot | null;
  series_count: number;
  scanned: number;
  next_after_id: string | null;
  page_complete: true;
  series: OptionSeriesSnapshotRecord[];
  source: 'lite' | 'http4';
  network: Network;
  updated_at: number;
};

type CoverStateSnapshot = {
  totalPolicies: string | null;
  activePolicies: string | null;
  breachingPolicies: string | null;
  claimablePolicies: string | null;
  claimedPolicies: string | null;
  nextWakeTimestamp: string | null;
  lastSender: string | null;
  lastJobId: string | null;
  lastWork: string | null;
  lastTimestamp: string | null;
  lastProcessed: string | null;
  lastRemaining: string | null;
  vault: string | null;
  governance: string | null;
  riskVault: string | null;
  riskBucketId: string | null;
};

type CoverPolicySnapshot = {
  id: string;
  owner: string | null;
  pool: string | null;
  lowerBound: string | null;
  upperBound: string | null;
  payout: string | null;
  coveredNotional: string | null;
  windowSeconds: string | null;
  requiredObservations: string | null;
  breachStart: string | null;
  breachSeconds: string | null;
  lastObservation: string | null;
  lastHealthyObservation: string | null;
  breachObservations: string | null;
  lastVolatilityTimestamp: string | null;
  lastVolatilityRequestHash: string | null;
  status: string | null;
  riskVault: string | null;
  riskBucketId: string | null;
};

type CoverSnapshotResponse = {
  manager: string;
  owner: string | null;
  enabled: boolean | null;
  state: CoverStateSnapshot | null;
  policy_count: number;
  scanned: number;
  policies: CoverPolicySnapshot[];
  source: 'lite' | 'http4';
  network: Network;
  updated_at: number;
};

type VolIndexConfigSnapshot = {
  seriesManager: string | null;
  oracle: string | null;
  automation: string | null;
  coverManager: string | null;
  minLiquidityBps: string | null;
  staleSeconds: string | null;
  emaAlphaBps: string | null;
};

type VolIndexStateSnapshot = {
  impliedVolBps: string | null;
  realizedVolBps: string | null;
  varianceSpeedBps: string | null;
  sampleCount: string | null;
  eligibleSeries: string | null;
  lastPremiumTs: string | null;
  lastRealizedTs: string | null;
  lastPublishTs: string | null;
  lastSamplePrice: string | null;
  lastSampleTs: string | null;
};

type VolIndexRouteSnapshot = {
  exists: boolean;
  sourcePool: string | null;
  coverPolicyId: string | null;
};

type VolIndexSnapshotResponse = {
  vol_index: string;
  config: VolIndexConfigSnapshot | null;
  state: VolIndexStateSnapshot | null;
  pool: string | null;
  pool_state: VolIndexStateSnapshot | null;
  route_ids: number[];
  routes: Record<string, VolIndexRouteSnapshot>;
  source: 'lite' | 'http4';
  network: Network;
  updated_at: number;
};

type DefiSnapshotSectionOk<T> = {
  ok: true;
  data: T;
};

type DefiSnapshotSectionErr = {
  ok: false;
  error: string;
  data: null;
};

type DefiSnapshotSection<T> = DefiSnapshotSectionOk<T> | DefiSnapshotSectionErr;

type DefiSnapshotRequest = {
  owner?: string | null;
  include?: {
    activation?: boolean;
    dlmmRegistry?: boolean;
    reserveBalances?: boolean;
    systemHealth?: boolean;
    systemHealthDetailed?: boolean;
    modules?: boolean;
    moduleGovernance?: boolean;
    governance?: boolean;
    cover?: boolean;
  };
  options?: {
    governance?: { maxScan?: number; maxMisses?: number };
    cover?: { maxScan?: number; maxMisses?: number };
  };
  contracts: {
    activationGate?: string | null;
    dlmmRegistry?: string | null;
    t3Hub?: string | null;
    controlMesh?: string | null;
    riskController?: string | null;
    riskVault?: string | null;
    feeRouter?: string | null;
    buybackExecutor?: string | null;
    automationRegistry?: string | null;
    anchorGuard?: string | null;
    voting?: string | null;
    coverManager?: string | null;
  };
  modules?: Array<{
    key: string;
    address: string;
    enabledGetter?: string | null;
    governanceGetter?: string | null;
  }>;
};

type ActivationGateSnapshot = {
  burned: string | null;
  target: string | null;
  ready: boolean;
  activated: boolean;
  activatedAt: string | null;
};

type DlmmRegistryMetaSnapshot = {
  governance: string | null;
  enabled: boolean;
  withdrawalsOnly: boolean;
  perpsWeightEnabled: boolean;
};

type ReserveBalancesSnapshot = {
  usdt: string | null;
  usdc: string | null;
  kusd: string | null;
};

type ControlStateSnapshot = {
  governance: string | null;
  enabled: boolean;
  withdrawalsOnly: boolean;
  sequence: string | null;
  lastHeartbeatTs: string | null;
  pegMintFeeBps: string | null;
  pegRedeemFeeBps: string | null;
  pegQuotaBps: string | null;
  pegThrottleBps: string | null;
  pegHaircutBps: string | null;
  pegLevel: string | null;
  pegEscalationScore: string | null;
  pegRecoveryScore: string | null;
  gasPegSkimBps: string | null;
  gasPegIntegral: string | null;
  gasPerpsSkimBps: string | null;
  gasPerpsIntegral: string | null;
  gasOptionsSkimBps: string | null;
  gasOptionsIntegral: string | null;
  perpsMarket1WeightMillibps: string | null;
  perpsMarket1FeeDeltaBps: string | null;
  perpsMarket1FundingCapBps: string | null;
  perpsMarket2WeightMillibps: string | null;
  perpsMarket2FeeDeltaBps: string | null;
  perpsMarket2FundingCapBps: string | null;
  perpsMarket3WeightMillibps: string | null;
  perpsMarket3FeeDeltaBps: string | null;
  perpsMarket3FundingCapBps: string | null;
  perpsMarket4WeightMillibps: string | null;
  perpsMarket4FeeDeltaBps: string | null;
  perpsMarket4FundingCapBps: string | null;
  insuranceTonPremiumBps: string | null;
  insuranceTonTarget: string | null;
  insuranceTonCover: string | null;
  insuranceBtcPremiumBps: string | null;
  insuranceBtcTarget: string | null;
  insuranceBtcCover: string | null;
};

type RiskStateSnapshot = {
  totalLocked: string | null;
  totalOutstanding: string | null;
  totalPending: string | null;
  totalSurplus: string | null;
  flags: string | null;
  registryVersion: string | null;
};

type RiskBucketStateSnapshot = {
  exists: boolean;
  controller: string | null;
  payoutHook: string | null;
  liquidationHook: string | null;
  utilisationCapBps: string | null;
  payoutCapBps: string | null;
  collateralMultiplierBps: string | null;
  outstandingNotional: string | null;
  lockedCollateral: string | null;
  pendingPayouts: string | null;
  automationJobId: string | null;
  automationCadence: string | null;
  automationBacklog: string | null;
  registryVersion: string | null;
  surplus: string | null;
  utilisationBps: string | null;
  deficit: boolean;
  lastReportTs: string | null;
};

type FeeRouterStateSnapshot = {
  balance: string;
  lastSequence: string;
  lastTimestamp: string;
  lastProfitAmount: string;
};

type FeeRouterTargetsSnapshot = {
  t3Root: string | null;
  t3Wallet: string | null;
  treasuryTarget: string | null;
  referralTarget: string | null;
  referralRegistry: string | null;
};

/** Current first-release profit route only; old allocation tuples are invalid. */
export const decodeFeeRouterStateSnapshot = (stack: TupleItem[]): FeeRouterStateSnapshot | null => {
  if (stack.length !== 4) return null;
  const maxima = [(1n << 120n) - 1n, 0xffffffffn, 0x7fffffffffffffffn, (1n << 120n) - 1n];
  const values: string[] = [];
  for (let i = 0; i < stack.length; i++) {
    const item = stack[i];
    if (item.type !== 'int' || item.value < 0n || item.value > maxima[i]) return null;
    values.push(item.value.toString());
  }
  return { balance: values[0], lastSequence: values[1], lastTimestamp: values[2], lastProfitAmount: values[3] };
};

export const decodeFeeRouterTargetsSnapshot = (stack: TupleItem[]): FeeRouterTargetsSnapshot | null => {
  if (stack.length !== 5) return null;
  try {
    const values = stack.map(item => {
      if (item.type !== 'slice' && item.type !== 'cell') throw new Error('Invalid FeeRouter address item.');
      const slice = item.cell.beginParse(), address = slice.loadMaybeAddress();
      slice.endParse();
      return address?.toRawString() ?? null;
    });
    return { t3Root: values[0], t3Wallet: values[1], treasuryTarget: values[2],
      referralTarget: values[3], referralRegistry: values[4] };
  } catch { return null; }
};

type BuybackConfigSnapshot = {
  t3Root: string | null;
  tsRoot: string | null;
  tsBurnWallet: string | null;
  router: string | null;
  recordTarget: string | null;
  routerWalletForward: string | null;
  swapForwardValue: string | null;
};

type AutomationConfigSnapshot = {
  queue: string | null;
};

type AutomationModuleTelemetrySnapshot = {
  lastTimestamp: string | null;
  lastStatus: string | null;
  lastProcessed: string | null;
  lastRemaining: string | null;
  successCount: string | null;
  failureCount: string | null;
  totalProcessed: string | null;
};

type JobConfigSnapshot = {
  maxJobs: string | null;
  minValue: string | null;
  maxLaneJobs: string | null;
  maxPriorityJobs: string | null;
};

type JobRecordSnapshot = {
  exists: boolean;
  jobId: string | null;
  target: string | null;
  scheduledAt: string | null;
  forwardedValue: string | null;
  dispatchValue: string | null;
  payloadHash: string | null;
  attempts: string | null;
  maxAttempts: string | null;
  status: string | null;
  lastDispatchAt: string | null;
  lastResult: string | null;
  wakeAt: string | null;
  ackTimeoutAt: string | null;
  dispatchHash: string | null;
  owner: string | null;
  priority: string | null;
  lane: string | null;
  deadlineAt: string | null;
  maxWork: string | null;
};

type AnchorConfigSnapshot = {
  quorumBps: string | null;
  maxAgeSeconds: string | null;
  epsilonExtBps: string | null;
  epsilonClipBps: string | null;
  trimCount: string | null;
};

type AnchorStateSnapshot = {
  quorumBps: string | null;
  maxAgeSeconds: string | null;
  epsilonExtBps: string | null;
  epsilonClipBps: string | null;
  trimCount: string | null;
  totalWeight: string | null;
  ready: boolean;
  quorumMet: boolean;
  price: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  varianceBps: string | null;
  weight: string | null;
  quorumWeight: string | null;
  sampleCount: string | null;
  latestTimestamp: string | null;
};

type SystemHealthSnapshot = {
  riskControllerState: RiskControllerSnapshot | null;
  controlState: ControlStateSnapshot | null;
  riskState: RiskStateSnapshot | null;
  feeRouterState: FeeRouterStateSnapshot | null;
  feeRouterTargets: FeeRouterTargetsSnapshot | null;
  buybackConfig: BuybackConfigSnapshot | null;
  anchorGuardConfig: AnchorConfigSnapshot | null;
  anchorGuardState: AnchorStateSnapshot | null;
  anchorGuardEnabled: boolean | null;
  anchorGuardGovernance: string | null;
};

type SystemHealthDetailedSnapshot = {
  riskBucketStates: Record<number, RiskBucketStateSnapshot | null>;
  automationConfig: AutomationConfigSnapshot | null;
  automationModules: Record<number, AutomationModuleTelemetrySnapshot | null>;
  jobQueueConfig: JobConfigSnapshot | null;
  jobQueueJobs: Record<number, JobRecordSnapshot | null>;
};

type ModuleStatusSnapshot = {
  governance: string | null;
  enabled: boolean;
};

type DefiSnapshotResponse = {
  owner: string | null;
  network: Network;
  updated_at: number;
  sections: {
    activation?: DefiSnapshotSection<ActivationGateSnapshot | null>;
    dlmmRegistry?: DefiSnapshotSection<DlmmRegistryMetaSnapshot | null>;
    reserveBalances?: DefiSnapshotSection<ReserveBalancesSnapshot | null>;
    systemHealth?: DefiSnapshotSection<SystemHealthSnapshot>;
    systemHealthDetailed?: DefiSnapshotSection<SystemHealthDetailedSnapshot>;
    modules?: DefiSnapshotSection<Record<string, ModuleStatusSnapshot | null>>;
    governance?: DefiSnapshotSection<GovernanceSnapshotResponse>;
    cover?: DefiSnapshotSection<CoverSnapshotResponse>;
  };
};

type DlmmPoolsSnapshotRequest = {
  t3Root: string;
  dlmmRegistry?: string | null;
  dlmmFactory?: string | null;
  tokens: string[];
};

type DlmmPoolBinReserves = {
  reserveT: string | null;
  reserveX: string | null;
};

type DlmmPoolSnapshotEntry = {
  token: string;
  pool: string | null;
  kind: number | null;
  status: number | null;
  activeBinId: number | null;
  walletCodeHash: string | null;
  binReserves: DlmmPoolBinReserves | null;
};

type DlmmPoolsSnapshotResponse = {
  t3Root: string;
  registry: string | null;
  factory: string | null;
  pools: DlmmPoolSnapshotEntry[];
  network: Network;
  updated_at: number;
};

export class IndexerService {
  private swapLedgerReader?: SwapLedgerReader;

  setSwapLedgerReader(reader: SwapLedgerReader) { this.swapLedgerReader = reader; }
  private config: Config;
  private store: MemoryStore;
  private source: TonDataSource;
  private opcodes: OpcodeSets;
  private network: Network;
  private lastMasterSeqno?: number;
  private lastMasterTimestamp?: number;
  private enqueueBackfill?: (address: string) => void;
  private jettonRoots: Array<{ master: string; symbol?: string }>;
  private jettonMetaCache = new Map<string, { meta: JettonMetadata | null; updatedAt: number; revision: number }>();
  private jettonMetaInFlight = new Map<string, Promise<void>>();
  private jettonMetadataRevision = 0;
  private metrics?: MetricsCollector;
  private poolTracker?: PoolTracker;
  private balanceCache: LRUCache<string, { value: AccountBalance; signature: string }>;
  private balanceInFlight = new Map<string, Promise<AccountBalance>>();
  private nativeStateInFlight = new Map<string, Promise<AccountState>>();
  private txCache: LRUCache<string, { value: any; signature: string }>;
  private stateCache: LRUCache<string, { value: any; signature: string }>;
  private governanceSnapshotCache: LRUCache<string, GovernanceSnapshotResponse>;
  private governanceSnapshotInFlight = new Map<string, Promise<GovernanceSnapshotResponse>>();
  private optionsSnapshotInFlight = new Map<string, Promise<OptionsSnapshotResponse>>();
  private coverSnapshotCache: LRUCache<string, CoverSnapshotResponse>;
  private coverSnapshotInFlight = new Map<string, Promise<CoverSnapshotResponse>>();
  private defiSnapshotCache: LRUCache<string, DefiSnapshotResponse>;
  private defiSnapshotInFlight = new Map<string, Promise<DefiSnapshotResponse>>();
  private dlmmPoolsSnapshotCache: LRUCache<string, DlmmPoolsSnapshotResponse>;
  private dlmmPoolsSnapshotInFlight = new Map<string, Promise<DlmmPoolsSnapshotResponse>>();
  private getMethodSourceInFlight = new Map<string, Promise<{ exitCode: number; stack: TupleItem[] } | null>>();
  private healthCache?: { value: HealthStatus; expiresAt: number };
  private balanceEventEmitter = new EventEmitter();
  private balanceEventSeq = 0;
  private admissionExecutor?: AdmissionExecutor;

  setAdmissionExecutor(executor: AdmissionExecutor): void {
    if (this.admissionExecutor) throw new Error('Admission executor is already bound.');
    this.admissionExecutor = executor;
  }

  getAdmissionStatus(): { configured: boolean; ready: boolean } {
    return { configured: Boolean(this.admissionExecutor), ready: Boolean(this.admissionExecutor?.ready) };
  }

  constructor(
    config: Config,
    store: MemoryStore,
    source: TonDataSource,
    opcodes: OpcodeSets,
    jettonRoots: Array<{ master: string; symbol?: string }>,
    metrics?: MetricsCollector,
    poolTracker?: PoolTracker
  ) {
    this.config = config;
    this.store = store;
    this.source = source;
    this.opcodes = opcodes;
    this.network = config.network;
    this.jettonRoots = [...new Map(jettonRoots.map((root) => {
      const master = normalizeAddress(root.master);
      return [master, { ...root, master }] as const;
    })).values()].sort((left, right) => left.master.localeCompare(right.master));
    this.metrics = metrics;
    this.poolTracker = poolTracker;

    const balanceCacheMax = Math.max(1, config.maxAddresses);
    const stateCacheMax = Math.max(1, config.maxAddresses);
    const txCacheMax = Math.max(
      1000,
      Math.min(config.globalMaxPages, config.maxAddresses * config.maxPagesPerAddress)
    );

    this.balanceCache = new LRUCache({
      max: balanceCacheMax,
      ttl: config.balanceCacheTtlMs,
      allowStale: false,
    });
    this.stateCache = new LRUCache({
      max: stateCacheMax,
      ttl: config.stateCacheTtlMs,
      allowStale: false,
    });
    this.txCache = new LRUCache({
      max: txCacheMax,
      ttl: config.txCacheTtlMs,
      allowStale: false,
    });
    this.governanceSnapshotCache = new LRUCache({
      max: 512,
      ttl: GOVERNANCE_SNAPSHOT_CACHE_TTL_MS,
      allowStale: false
    });
    this.coverSnapshotCache = new LRUCache({
      max: 512,
      ttl: COVER_SNAPSHOT_CACHE_TTL_MS,
      allowStale: false
    });
    this.defiSnapshotCache = new LRUCache({
      max: 512,
      ttl: DEFI_SNAPSHOT_CACHE_TTL_MS,
      allowStale: false
    });
    this.dlmmPoolsSnapshotCache = new LRUCache({
      max: 512,
      ttl: DLMM_POOLS_SNAPSHOT_CACHE_TTL_MS,
      allowStale: false
    });
  }

  setBackfillEnqueue(fn: (address: string) => void) {
    this.enqueueBackfill = fn;
  }

  setMasterchainInfo(seqno: number, timestamp?: number) {
    this.lastMasterSeqno = seqno;
    this.lastMasterTimestamp = timestamp;
  }

  getHealth(): HealthStatus {
    if (this.config.responseCacheEnabled && this.config.healthCacheTtlMs > 0) {
      if (this.healthCache && this.healthCache.expiresAt > Date.now()) {
        return this.healthCache.value;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const lag = this.lastMasterTimestamp ? Math.max(0, now - this.lastMasterTimestamp) : undefined;
    const response = {
      lastMasterSeqno: this.lastMasterSeqno,
      indexerLagSec: lag,
      liteserverPoolStatus:
        this.config.dataSource === 'lite'
          ? this.config.liteserverPool
            ? 'liteserver:custom'
            : 'liteserver:ton.org'
          : this.config.httpEndpoint
            ? 'http4:custom'
            : 'http4:auto',
    };
    if (this.config.responseCacheEnabled && this.config.healthCacheTtlMs > 0) {
      this.healthCache = { value: response, expiresAt: Date.now() + this.config.healthCacheTtlMs };
    }
    return response;
  }

  async getBalance(address: string): Promise<AccountBalance> {
    address = normalizeAddress(address);
    const requestKey = `${this.store.getWorkflowGeneration()}:${address}`;
    const existing = this.balanceInFlight.get(requestKey);
    if (existing) return existing;
    const pending = this.readBalance(address).finally(() => {
      if (this.balanceInFlight.get(requestKey) === pending) {
        this.balanceInFlight.delete(requestKey);
      }
    });
    this.balanceInFlight.set(requestKey, pending);
    return pending;
  }

  private async readBalance(address: string): Promise<AccountBalance> {
    const metadataRevisionBeforeRead = this.jettonMetadataRevision;
    this.store.touch(address);
    const entry = this.store.get(address);
    const cached = Boolean(entry?.balance);
    this.metrics?.recordBalanceCache(cached);

    if (this.config.responseCacheEnabled && entry?.balance) {
      const signature = this.getBalanceAccountSignature(entry);
      if (signature) {
        const cachedValue = this.getCached(this.balanceCache, address, signature);
        if (cachedValue) return cachedValue;
      }
    }

    const nativeStatePromise = this.getNativeAccountState(address);
    const jettonPromise = Promise.all(
      this.jettonRoots.map(async (root) => {
        const balance = await this.withTimeoutOrNull(
          this.source.getJettonBalance(address, root.master),
          this.config.jettonBalanceTimeoutMs
        );
        if (balance) this.refreshJettonMetadata(root.master);
        return balance ? { root, balance } : null;
      })
    );
    const [jettonBalances, nativeSnapshot] = await Promise.all([jettonPromise, nativeStatePromise]);
    const updated = this.store.get(address)?.balance ?? nativeSnapshot;
    const jettons = jettonBalances.map((result) => {
      if (!result) return null;
      const { root, balance } = result;
      const meta = this.getCachedJettonMetadata(root.master, metadataRevisionBeforeRead);
      const decimals = meta?.decimals;
      return {
        master: root.master,
        wallet: normalizeAddress(balance.wallet),
        balance: balance.balance,
        symbol: meta?.symbol ?? root.symbol,
        ...(decimals === undefined ? {} : { decimals }),
      };
    });

    const response = {
      ton: {
        balance: updated.balance,
        last_tx_lt: updated.lastTxLt,
        last_tx_hash: updated.lastTxHash,
      },
      jettons: jettons.filter(Boolean) as AccountBalance['jettons'],
      confirmed: jettons.every((jetton) => jetton !== null),
      updated_at: Math.floor(updated.updatedAt / 1000),
      network: this.network,
    };
    const entryAfterRead = this.store.get(address);
    const signature = entryAfterRead?.balance === updated
      ? this.getBalanceAccountSignature(entryAfterRead)
      : null;
    this.setCached(this.balanceCache, address, response, signature, this.config.balanceCacheTtlMs);
    return response;
  }

  async getBalances(address: string): Promise<AccountBalances> {
    address = normalizeAddress(address);
    const snapshot = await this.getBalance(address);
    const tonRaw = snapshot.ton.balance ?? '0';
    const ton = this.formatRawAmount(tonRaw, 9);
    const assets = [
      {
        kind: 'native' as const,
        symbol: 'GRAM',
        address,
        wallet: address,
        balance_raw: tonRaw,
        balance: ton,
        decimals: 9,
      },
      ...snapshot.jettons.map((jetton) => {
        const decimals = typeof jetton.decimals === 'number' && Number.isFinite(jetton.decimals)
          ? Math.max(0, Math.trunc(jetton.decimals))
          : undefined;
        return {
          kind: 'jetton' as const,
          symbol: jetton.symbol,
          address: jetton.master,
          wallet: jetton.wallet,
          balance_raw: jetton.balance,
          ...(decimals === undefined
            ? {}
            : {
                balance: this.formatRawAmount(jetton.balance, decimals),
                decimals,
              }),
        };
      }),
    ];

    return {
      address,
      ton_raw: tonRaw,
      ton,
      assets,
      confirmed: snapshot.confirmed,
      updated_at: snapshot.updated_at,
      network: snapshot.network,
    };
  }

  getBalancesSignature(snapshot: AccountBalances) {
    const assetsSignature = [...snapshot.assets]
      .map((asset) => {
        const kind = asset.kind ?? 'unknown';
        const key = asset.address ?? asset.wallet ?? asset.symbol ?? '';
        return `${kind}:${key}:${asset.balance_raw ?? ''}:${asset.balance ?? ''}:${asset.decimals ?? ''}`;
      })
      .sort()
      .join('|');
    return `${snapshot.ton_raw ?? ''}:${snapshot.confirmed ? '1' : '0'}:${assetsSignature}`;
  }

  subscribeBalanceChanges(addresses: string[], listener: (event: BalanceChangeEvent) => void) {
    const normalized = new Set(addresses.map((value) => normalizeAddress(value)));
    const handler = (event: BalanceChangeEvent) => {
      const target = normalizeAddress(event.address);
      if (normalized.size > 0 && !normalized.has(target)) return;
      listener(event);
    };
    this.balanceEventEmitter.on('balances_changed', handler);
    return () => {
      this.balanceEventEmitter.off('balances_changed', handler);
    };
  }

  private emitBalanceChanged(address: string) {
    const event: BalanceChangeEvent = {
      type: 'balances_changed',
      address,
      seq: ++this.balanceEventSeq,
      ts: Date.now(),
      hints: { ton: true, jettons: null },
    };
    this.balanceEventEmitter.emit('balances_changed', event);
  }

  private getCachedJettonMetadata(master: string, revisionBeforeRead: number): JettonMetadata | null {
    const cached = this.jettonMetaCache.get(master);
    return cached && (
      cached.revision > revisionBeforeRead ||
      Date.now() - cached.updatedAt < this.config.jettonMetadataTtlMs
    )
      ? cached.meta
      : null;
  }

  private refreshJettonMetadata(master: string) {
    const cached = this.jettonMetaCache.get(master);
    if (cached && Date.now() - cached.updatedAt < this.config.jettonMetadataTtlMs) return;
    if (this.jettonMetaInFlight.has(master)) return;

    // Metadata enriches display amounts, but never holds up verified raw balances.
    const pending = (async () => {
      const meta = await this.source.getJettonMetadata(master);
      this.jettonMetadataRevision += 1;
      this.jettonMetaCache.set(master, { meta, updatedAt: Date.now(), revision: this.jettonMetadataRevision });
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.jettonMetaInFlight.get(master) === pending) {
          this.jettonMetaInFlight.delete(master);
        }
      });
    this.jettonMetaInFlight.set(master, pending);
  }

  private getBalanceAccountSignature(entry: Parameters<IndexerService['getAccountSignature']>[0]) {
    const signature = this.getAccountSignature(entry);
    return signature === null ? null : `${signature}:${this.jettonMetadataRevision}`;
  }

  private getAccountSignature(entry?: {
    balance?: AccountState;
    stats: { txCount: number; historyComplete: boolean; totalPagesMin: number };
  }) {
    if (!entry?.balance) return null;
    return [
      entry.balance.lastTxLt ?? '',
      entry.balance.lastTxHash ?? '',
      entry.balance.balance ?? '',
      entry.stats.txCount,
      entry.stats.historyComplete ? '1' : '0',
      entry.stats.totalPagesMin,
    ].join(':');
  }

  private formatRawAmount(rawValue: string, decimals: number) {
    let raw: bigint;
    try {
      raw = BigInt(rawValue);
    } catch (_err) {
      return '0';
    }
    const safeDecimals = Math.max(0, Math.trunc(decimals));
    if (safeDecimals === 0) return raw.toString(10);

    const divisor = 10n ** BigInt(safeDecimals);
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const whole = abs / divisor;
    const fraction = abs % divisor;
    if (fraction === 0n) {
      return `${negative ? '-' : ''}${whole.toString(10)}`;
    }
    const fractionStr = fraction
      .toString(10)
      .padStart(safeDecimals, '0')
      .replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString(10)}.${fractionStr}`;
  }

  private getTxPageSignature(
    entry: { stats: { txCount: number; historyComplete: boolean; totalPagesMin: number }; pageIndex: { lt: string; hash: string }[] } | undefined,
    page: number
  ) {
    if (!entry) return null;
    const cursor = entry.pageIndex[page - 1];
    return [
      entry.stats.txCount,
      entry.stats.historyComplete ? '1' : '0',
      entry.stats.totalPagesMin,
      cursor?.lt ?? '',
      cursor?.hash ?? '',
      page,
    ].join(':');
  }

  private getTxCursorSignature(
    entry: { stats: { txCount: number; historyComplete: boolean } } | undefined,
    lt: string,
    hash: string
  ) {
    if (!entry) return null;
    return [entry.stats.txCount, entry.stats.historyComplete ? '1' : '0', lt, hash].join(':');
  }

  private async withTimeoutOrNull<T>(operation: Promise<T | null>, timeoutMs: number): Promise<T | null> {
    const guarded = operation.catch(() => null);
    const ms = Math.max(0, Math.trunc(timeoutMs));
    if (ms <= 0) return guarded;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });

    try {
      return await Promise.race([guarded, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async withInitialHistoryTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    const ms = Math.max(1, Math.trunc(timeoutMs));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const guarded = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new InitialHistoryReadTimeoutError(ms)), ms);
    });

    try {
      const outcome = await Promise.race([guarded, timeout]);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getCached<T>(
    cache: LRUCache<string, { value: T; signature: string }>,
    key: string,
    signature: string
  ) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.signature !== signature) return null;
    return cached.value;
  }

  private setCached<T>(
    cache: LRUCache<string, { value: T; signature: string }>,
    key: string,
    value: T,
    signature: string | null,
    ttl: number
  ) {
    if (!this.config.responseCacheEnabled || !signature || ttl <= 0) return;
    cache.set(key, { value, signature }, { ttl });
  }

  async getState(address: string) {
    address = normalizeAddress(address);
    this.store.touch(address);
    let entry = this.store.get(address);
    if (!entry?.balance) {
      await this.refreshAccountState(address);
      entry = this.store.get(address);
    }
    const latest = entry?.txs?.[0];
    const signature = this.getAccountSignature(entry);
    if (this.config.responseCacheEnabled && signature) {
      const cachedValue = this.getCached(this.stateCache, address, signature);
      if (cachedValue) return cachedValue;
    }

    const response = {
      address,
      last_tx_lt: entry?.balance?.lastTxLt,
      last_tx_hash: entry?.balance?.lastTxHash,
      last_seen_utime: latest?.utime ?? null,
      last_confirmed_seqno: this.lastMasterSeqno ?? null,
      account_state: entry?.balance?.accountState ?? null,
      code_boc: entry?.balance?.codeBoc ?? null,
      data_boc: entry?.balance?.dataBoc ?? null,
      balance_raw: entry?.balance?.balance ?? '0',
      network: this.network,
    };
    this.setCached(this.stateCache, address, response, signature, this.config.stateCacheTtlMs);
    return response;
  }

  async getNativeState(address: string) {
    address = normalizeAddress(address);
    this.store.touch(address);
    const balance = await this.getNativeAccountState(address);
    const entry = this.store.get(address);
    const latest = entry?.txs?.[0];
    return {
      address,
      last_tx_lt: balance.lastTxLt,
      last_tx_hash: balance.lastTxHash,
      last_seen_utime: latest?.utime ?? null,
      last_confirmed_seqno: this.lastMasterSeqno ?? null,
      account_state: balance.accountState ?? null,
      code_boc: balance.codeBoc ?? null,
      data_boc: balance.dataBoc ?? null,
      balance_raw: balance.balance,
      network: this.network,
    };
  }

  async getJettonTransferPayload(jettonAddress: string, ownerAddress: string): Promise<JettonTransferPayloadResponse> {
    const normalizedJetton = normalizeAddress(jettonAddress);
    const normalizedOwner = normalizeAddress(ownerAddress);

    const walletFromBalance = await this.source.getJettonBalance(normalizedOwner, normalizedJetton).catch(() => null);
    const walletAddress = walletFromBalance?.wallet
      ? normalizeAddress(walletFromBalance.wallet)
      : await this.resolveJettonWalletAddress(normalizedJetton, normalizedOwner);

    if (!walletAddress) {
      return {
        custom_payload: null,
        state_init: null
      };
    }

    const walletState = await this.source.getAccountState(walletAddress).catch(() => null);
    if (walletState?.accountState === 'active') {
      return {
        custom_payload: null,
        state_init: null
      };
    }

    return {
      custom_payload: null,
      state_init: await this.buildJettonWalletStateInit(normalizedJetton, normalizedOwner)
    };
  }

  private async resolveJettonWalletAddress(jettonMaster: string, ownerAddress: string): Promise<string | null> {
    let ownerSlice: Cell;
    try {
      ownerSlice = buildSliceCell(ownerAddress);
    } catch {
      return null;
    }

    const result = await this.runGetMethodSource(
      jettonMaster,
      'get_wallet_address',
      [{ type: 'slice', cell: ownerSlice }]
    );
    if (!isSuccessfulGetterResult(result)) return null;
    const resolved = parseCanonicalJettonWalletAddress(result.stack);
    if (!resolved) return null;

    // This endpoint emits TONSWAP's wallet state-init, whose persistent-data
    // layout is implementation-specific rather than standardized by TEP-74.
    // Require the root getter to agree with that exact state-init; arbitrary
    // canonical Jettons with a different layout fail closed instead.
    const expected = await this.buildJettonWalletState(jettonMaster, ownerAddress);
    if (!expected || normalizeAddress(expected.address) !== resolved.toRawString()) {
      return null;
    }
    return resolved.toRawString();
  }

  private async loadJettonWalletCode(jettonMaster: string): Promise<Cell | null> {
    const result = await this.runGetMethodSource(jettonMaster, 'get_jetton_data', []);
    if (!isSuccessfulGetterResult(result)) return null;
    return parseCanonicalJettonRootData(result.stack)?.walletCode ?? null;
  }

  private async buildJettonWalletStateInit(jettonMaster: string, ownerAddress: string): Promise<string | null> {
    const state = await this.buildJettonWalletState(jettonMaster, ownerAddress);
    return state?.stateInit ?? null;
  }

  private async buildJettonWalletState(
    jettonMaster: string,
    ownerAddress: string
  ): Promise<{ address: string; stateInit: string } | null> {
    const walletCode = await this.loadJettonWalletCode(jettonMaster);
    if (!walletCode) return null;

    try {
      const owner = Address.parse(ownerAddress);
      const master = Address.parse(jettonMaster);
      const walletData = buildTonswapJettonWalletInitialData(owner, master);

      const stateInit = { code: walletCode, data: walletData };
      const stateCell = beginCell().store(storeStateInit(stateInit)).endCell();
      return {
        address: contractAddress(0, stateInit).toRawString(),
        stateInit: Buffer.from(stateCell.toBoc()).toString('base64')
      };
    } catch {
      return null;
    }
  }

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<ToncenterRunResult> {
    if (isAdmissionMethod(method)) {
      const admission = this.admissionExecutor;
      if (!admission || normalizeAddress(address) !== normalizeAddress(admission.engine)) throw new AdmissionError('admission_unavailable');
      // Explicit local verified execution. It cannot enter the generic remote
      // source, completed cache, retry, or resilient fallback path below.
      const result = await admission.run(method, args);
      return { stack: result.stack.map(tupleItemToToncenterStackEntry), exit_code: result.exitCode,
        gas_used: result.gasUsed, admission: result.execution };
    }
    const result = await this.runGetMethodSource(normalizeAddress(address), method, args);
    if (!result) {
      throw new Error('get method call unavailable from configured data source');
    }
    return {
      stack: result.stack.map(tupleItemToToncenterStackEntry),
      exit_code: result.exitCode,
      gas_used: null
    };
  }

  private async runGetMethodSource(
    normalizedAddress: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    // Latest-head getters can depend on the execution block and its time even
    // without arguments or account writes. The datasource does not expose that
    // immutable execution identity, so completed results must never be reused.
    // Share only concurrent identical reads at this one source boundary.
    const encodedArgs = serializeTuple(args);
    const key = JSON.stringify([normalizedAddress, method,
      encodedArgs.toBoc({ idx: false, crc32: false }).toString('base64')]);
    const pending = this.getMethodSourceInFlight.get(key);
    if (pending) return pending;

    // Decode our encoded snapshot so later caller mutation cannot change the
    // arguments after they have been bound to the in-flight identity.
    const sourceArgs = parseTuple(encodedArgs);
    type Result = { exitCode: number; stack: TupleItem[] } | null;
    let settle!: (result: Result) => void;
    const request = new Promise<Result>((resolve) => { settle = resolve; });
    this.getMethodSourceInFlight.set(key, request);
    try {
      const result = await this.source.runGetMethod(normalizedAddress, method, sourceArgs);
      settle(result);
      return result;
    } catch {
      settle(null);
      return null;
    } finally {
      if (this.getMethodSourceInFlight.get(key) === request) {
        this.getMethodSourceInFlight.delete(key);
      }
    }
  }

  async getPerpsSnapshot(
    engineAddress: string,
    options: { marketIds?: number[]; maxMarkets?: number } = {}
  ) {
    const normalizedEngine = normalizeAddress(engineAddress);
    const maxMarkets = options.maxMarkets ?? 64;
    if (!Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 128) {
      throw new Error('max_markets must be an integer from 1 to 128');
    }
    if (options.marketIds?.some((value) => !Number.isInteger(value) || value < 1 || value > 0xffffffff)) {
      throw new Error('market_ids must contain positive uint32 integers');
    }
    const requestedMarketIds = Array.from(new Set(options.marketIds ?? []));
    if (requestedMarketIds.length > maxMarkets) {
      throw new Error('market_ids exceeds max_markets');
    }
    const readMarkets = async (ids: number[]) => {
      const results: Array<{ exitCode: number; stack: TupleItem[] } | null> = new Array(ids.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const index = next++;
          results[index] = await this.runGetMethodSource(normalizedEngine, 'market_state', [
            { type: 'int', value: BigInt(ids[index]) }
          ]);
        }
      }));
      return results;
    };
    // Explicit markets do not depend on engine metadata. Start them immediately
    // so a slow status getter does not add another complete network round trip.
    const requestedMarkets = requestedMarketIds.length ? readMarkets(requestedMarketIds) : null;

    const [governanceRes, enabledRes, configRes, automationRes] = await Promise.all([
      this.runGetMethodSource(normalizedEngine, 'engine_governance', []),
      this.runGetMethodSource(normalizedEngine, 'engine_enabled', []),
      this.runGetMethodSource(normalizedEngine, 'engine_config', []),
      this.runGetMethodSource(normalizedEngine, 'automation_state', [])
    ]);

    if (!governanceRes && !enabledRes && !automationRes) {
      throw new Error('Perps snapshot is unavailable from the configured data source.');
    }

    const status =
      governanceRes?.exitCode === 0 && enabledRes?.exitCode === 0
        ? {
            governance: tupleItemAddress(governanceRes.stack[0]),
            enabled: tupleItemBool(enabledRes.stack[0]),
            feeBps: canonicalPerpsFeeBps(configRes)
          }
        : null;

    const automation =
      automationRes?.exitCode === 0 && automationRes.stack.length === 15
        ? {
            fundingCursor: tupleItemBigIntString(automationRes.stack[0]),
            lastFundingTimestamp: tupleItemBigIntString(automationRes.stack[1]),
            lastFundingProcessed: tupleItemBigIntString(automationRes.stack[2]),
            lastFundingRemaining: tupleItemBigIntString(automationRes.stack[3]),
            liquidationCursor: tupleItemBigIntString(automationRes.stack[4]),
            lastLiquidationTimestamp: tupleItemBigIntString(automationRes.stack[5]),
            lastLiquidationProcessed: tupleItemBigIntString(automationRes.stack[6]),
            lastLiquidationRemaining: tupleItemBigIntString(automationRes.stack[7]),
            maxMarketId: tupleItemBigIntString(automationRes.stack[8]),
            liquidationNonce: tupleItemBigIntString(automationRes.stack[9]),
            liquidationBacklog: tupleItemBigIntString(automationRes.stack[10]),
            controlAuthority: tupleItemAddress(automationRes.stack[11]),
            controlSequence: tupleItemBigIntString(automationRes.stack[12]),
            controlTimestamp: tupleItemBigIntString(automationRes.stack[13]),
            controlRequestHash: tupleItemBigIntString(automationRes.stack[14])
          }
        : null;

    const derivedMarketIds =
      requestedMarketIds.length > 0
        ? requestedMarketIds
        : (() => {
            const maxMarketId = automation?.maxMarketId ? Number(automation.maxMarketId) : 0;
            if (Number.isFinite(maxMarketId) && maxMarketId > 0) {
              return Array.from({ length: Math.min(maxMarkets, Math.trunc(maxMarketId)) }, (_, index) => index + 1);
            }
            return [];
          })();

    const markets: Record<string, any> = {};
    const marketIds: number[] = [];

    const marketResults = await (requestedMarkets ?? readMarkets(derivedMarketIds));
    for (const [index, marketId] of derivedMarketIds.entries()) {
      const marketRes = marketResults[index];
      if (!marketRes || marketRes.exitCode !== 0 || marketRes.stack.length !== 39) continue;
      const stack = marketRes.stack;
      markets[String(marketId)] = {
        exists: tupleItemBool(stack[0]),
        pool: tupleItemAddress(stack[1]),
        depthUnit: tupleItemBigIntString(stack[2]),
        impactAlpha: tupleItemBigIntString(stack[3]),
        impactBeta: tupleItemBigIntString(stack[4]),
        baseLeverageBps: tupleItemBigIntString(stack[5]),
        maxLeverageBps: tupleItemBigIntString(stack[6]),
        maintenanceBps: tupleItemBigIntString(stack[7]),
        oiCap: tupleItemBigIntString(stack[8]),
        fundingCapBps: tupleItemBigIntString(stack[9]),
        fundingIndex: tupleItemBigIntString(stack[10]),
        lastFundingTs: tupleItemBigIntString(stack[11]),
        oiLong: tupleItemBigIntString(stack[12]),
        oiShort: tupleItemBigIntString(stack[13]),
        longBase: tupleItemBigIntString(stack[14]),
        shortBase: tupleItemBigIntString(stack[15]),
        halted: tupleItemBool(stack[16]),
        oracleMark: tupleItemBigIntString(stack[17]),
        oracleMarkTs: tupleItemBigIntString(stack[18]),
        liquidationSlice: tupleItemBigIntString(stack[19]),
        liquidationCooldown: tupleItemBigIntString(stack[20]),
        liquidationPendingBase: tupleItemBigIntString(stack[21]),
        liquidationLastTs: tupleItemBigIntString(stack[22]),
        adlDeficit: tupleItemBigIntString(stack[23]),
        liquidityWeightBps: tupleItemBigIntString(stack[24]),
        utilizationWeightBps: tupleItemBigIntString(stack[25]),
        lastDynamicWeightBps: tupleItemBigIntString(stack[26]),
        rebalanceClampBps: tupleItemBigIntString(stack[27]),
        lastClampUpdateTs: tupleItemBigIntString(stack[28]),
        auctionActive: tupleItemBool(stack[29]),
        auctionOutstandingBase: tupleItemBigIntString(stack[30]),
        auctionMinPrice: tupleItemBigIntString(stack[31]),
        auctionMaxPrice: tupleItemBigIntString(stack[32]),
        auctionExpiryTs: tupleItemBigIntString(stack[33]),
        auctionClearingPrice: tupleItemBigIntString(stack[34]),
        controlWeightBps: tupleItemBigIntString(stack[35]),
        controlFeeDeltaBps: tupleItemBigIntString(stack[36]),
        lastFundingPayloadHash: tupleItemBigIntString(stack[37]),
        lastFundingPoolHash: tupleItemBigIntString(stack[38])
      };
      marketIds.push(marketId);
    }

    return {
      engine: normalizedEngine,
      status,
      automation,
      market_ids: marketIds,
      markets,
      source: this.config.dataSource === 'lite' ? 'lite' : 'http4',
      network: this.network,
      updated_at: Math.floor(Date.now() / 1000)
    };
  }

  private parseVolIndexState(stack: TupleItem[]): VolIndexStateSnapshot | null {
    if (stack.length !== 10) return null;
    return {
      impliedVolBps: tupleItemBigIntString(stack[0]),
      realizedVolBps: tupleItemBigIntString(stack[1]),
      varianceSpeedBps: tupleItemBigIntString(stack[2]),
      sampleCount: tupleItemBigIntString(stack[3]),
      eligibleSeries: tupleItemBigIntString(stack[4]),
      lastPremiumTs: tupleItemBigIntString(stack[5]),
      lastRealizedTs: tupleItemBigIntString(stack[6]),
      lastPublishTs: tupleItemBigIntString(stack[7]),
      lastSamplePrice: tupleItemBigIntString(stack[8]),
      lastSampleTs: tupleItemBigIntString(stack[9])
    };
  }

  async getVolIndexSnapshot(
    volIndexAddress: string,
    options: { sourcePool?: string | null; routeIds?: number[] } = {}
  ): Promise<VolIndexSnapshotResponse> {
    const normalizedVolIndex = normalizeAddress(volIndexAddress);
    const normalizedPool = options.sourcePool?.trim() ? normalizeAddress(options.sourcePool) : null;
    const requestedRouteIds = options.routeIds ?? [];
    if (requestedRouteIds.length > 64 || requestedRouteIds.some((value) =>
      !Number.isInteger(value) || value < 1 || value > 0xffffffff)) {
      throw new Error('route_ids must contain at most 64 positive uint32 integers');
    }
    const routeIds = Array.from(new Set(requestedRouteIds));

    const [configRes, stateRes, poolStateRes] = await Promise.all([
      this.runGetMethodSource(normalizedVolIndex, 'vol_index_config', []),
      this.runGetMethodSource(normalizedVolIndex, 'vol_index_state', []),
      normalizedPool
        ? this.runGetMethodSource(normalizedVolIndex, 'vol_index_pool_state', [
            { type: 'slice', cell: beginCell().storeAddress(Address.parse(normalizedPool)).endCell() }
          ])
        : Promise.resolve(null)
    ]);

    if (!configRes && !stateRes && !poolStateRes) {
      throw new Error('VolIndex snapshot is unavailable from the configured data source.');
    }

    const config =
      configRes?.exitCode === 0 && configRes.stack.length === 7
        ? {
            seriesManager: tupleItemAddress(configRes.stack[0]),
            oracle: tupleItemAddress(configRes.stack[1]),
            automation: tupleItemAddress(configRes.stack[2]),
            coverManager: tupleItemAddress(configRes.stack[3]),
            minLiquidityBps: tupleItemBigIntString(configRes.stack[4]),
            staleSeconds: tupleItemBigIntString(configRes.stack[5]),
            emaAlphaBps: tupleItemBigIntString(configRes.stack[6])
          }
        : null;

    const state = stateRes?.exitCode === 0 ? this.parseVolIndexState(stateRes.stack) : null;
    const poolState = poolStateRes?.exitCode === 0 ? this.parseVolIndexState(poolStateRes.stack) : null;
    const routes: Record<string, VolIndexRouteSnapshot> = {};
    const loadedRouteIds: number[] = [];

    for (const routeId of routeIds) {
      const routeRes = await this.runGetMethodSource(normalizedVolIndex, 'vol_index_route', [
        { type: 'int', value: BigInt(routeId) }
      ]);
      if (!routeRes || routeRes.exitCode !== 0 || routeRes.stack.length !== 3) continue;
      const stack = routeRes.stack;
      routes[String(routeId)] = {
        exists: tupleItemBool(stack[0]),
        sourcePool: tupleItemAddress(stack[1]),
        coverPolicyId: tupleItemBigIntString(stack[2])
      };
      loadedRouteIds.push(routeId);
    }

    return {
      vol_index: normalizedVolIndex,
      config,
      state,
      pool: normalizedPool,
      pool_state: poolState,
      route_ids: loadedRouteIds,
      routes,
      source: this.config.dataSource === 'lite' ? 'lite' : 'http4',
      network: this.network,
      updated_at: Math.floor(Date.now() / 1000)
    };
  }

  async getGovernanceSnapshot(
    votingAddress: string,
    options: { owner?: string | null; maxScan?: number; maxConsecutiveMisses?: number; startId?: string | number } = {}
  ): Promise<GovernanceSnapshotResponse> {
    const normalizedVoting = normalizeAddress(votingAddress);
    const normalizedOwner = options.owner ? normalizeAddress(options.owner) : null;
    const maxScan = Math.max(
      1,
      Math.min(GOVERNANCE_MAX_SCAN_LIMIT, Math.trunc(options.maxScan ?? GOVERNANCE_MAX_SCAN_DEFAULT))
    );
    const firstId = BigInt(options.startId ?? 1);
    if (firstId < 1n || firstId >= 1n << 64n) throw new Error('start_id must be a positive uint64');
    const cacheKey = [normalizedVoting, normalizedOwner ?? '', maxScan, firstId.toString()].join('|');

    if (this.config.responseCacheEnabled) {
      const cached = this.governanceSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.governanceSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = (async () => {
      // Fetch the persisted monotonic counter. Getter failures are never interpreted as absence.
      const account = await this.source.getAccountState(normalizedVoting).catch(() => null);
      const range = governanceProposalRange(account?.dataBoc);
      const lastId = range ? (range.nextProposalId - 1n < firstId + BigInt(maxScan) - 1n
        ? range.nextProposalId - 1n : firstId + BigInt(maxScan) - 1n) : firstId + BigInt(maxScan) - 1n;
      const issues: string[] = range ? [] : ['governance_range_unavailable'];
      let lockResponded = false;
      const lockPromise = (async (): Promise<GovernanceLockSnapshot | null> => {
        if (!normalizedOwner) return null;
        const owner = Address.parse(normalizedOwner);
        const ownerCell = beginCell().storeAddress(owner).endCell();
        const lockRes = await this.runGetMethodSource(normalizedVoting, 'governance_lock', [
          { type: 'slice', cell: ownerCell }
        ]);
        lockResponded = lockRes !== null;
        if (!lockRes || lockRes.exitCode !== 0) return null;
        const stack = lockRes.stack;
        return {
          amount: tupleItemBigIntString(stack[0]),
          unlockTime: tupleItemBigIntString(stack[1]),
          tier: tupleItemBigIntString(stack[2]),
          activatedAt: tupleItemBigIntString(stack[3]),
          weight: tupleItemBigIntString(stack[4])
        };
      })().catch(() => null);

      const proposals: GovernanceProposalSnapshot[] = [];
      let scanned = 0;
      let proposalResponded = false;
      for (let startId = firstId; startId <= lastId; startId += BigInt(GOVERNANCE_SCAN_BATCH_SIZE)) {
        const endId = lastId < startId + BigInt(GOVERNANCE_SCAN_BATCH_SIZE) - 1n ? lastId : startId + BigInt(GOVERNANCE_SCAN_BATCH_SIZE) - 1n;
        const batchIds = Array.from({ length: Number(endId - startId + 1n) }, (_, index) => startId + BigInt(index));
        const batch = await Promise.all(
          batchIds.map((proposalId) =>
            this.runGetMethodSource(normalizedVoting, 'governance_proposal', [
              { type: 'int', value: BigInt(proposalId) }
            ]).catch(() => null)
          )
        );

        for (let index = 0; index < batch.length; index += 1) {
          scanned += 1;
          const res = batch[index];
          if (res) {
            proposalResponded = true;
          }
          if (!res || res.exitCode !== 0) {
            issues.push(`proposal_unavailable:${batchIds[index]}`);
            continue;
          }
          const stack = res.stack;
          const id = tupleItemBigIntString(stack[0]);
          if (!id || id !== batchIds[index]!.toString()) {
            issues.push(`proposal_id_mismatch:${batchIds[index]}`);
            continue;
          }
          proposals.push({
            id,
            status: tupleItemBigIntString(stack[1]),
            passed: tupleItemBigIntString(stack[2]),
            yesWeight: tupleItemBigIntString(stack[3]),
            noWeight: tupleItemBigIntString(stack[4]),
            abstainWeight: tupleItemBigIntString(stack[5]),
            quorumWeight: tupleItemBigIntString(stack[6]),
            totalWeightSnapshot: tupleItemBigIntString(stack[7]),
            startTime: tupleItemBigIntString(stack[8]),
            minCloseTime: tupleItemBigIntString(stack[9]),
            maxCloseTime: tupleItemBigIntString(stack[10]),
            cooldownEnd: tupleItemBigIntString(stack[11]),
            target: tupleItemAddress(stack[12]),
            value: tupleItemBigIntString(stack[13]),
            descriptionHash: tupleItemBigIntString(stack[14])
          });
        }
      }

      const lock = await lockPromise;
      if (!proposalResponded && !lockResponded && !range) {
        throw new Error('Governance snapshot is unavailable from the configured data source.');
      }

      proposals.sort((left, right) => {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        if (leftId === rightId) return 0;
        return leftId > rightId ? -1 : 1;
      });
      const source: 'lite' | 'http4' = this.config.dataSource === 'lite' ? 'lite' : 'http4';

      return {
        voting: normalizedVoting,
        owner: normalizedOwner,
        lock,
        proposal_count: proposals.length,
        scanned,
        start_id: firstId.toString(),
        next_start_id: issues.length ? firstId.toString() : range && lastId + 1n < range.nextProposalId ? (lastId + 1n).toString() : null,
        coverage: { rangeKnown: Boolean(range), pageComplete: issues.length === 0,
          scanComplete: issues.length === 0 && Boolean(range) && lastId + 1n >= range!.nextProposalId,
          nextProposalId: range?.nextProposalId.toString() ?? null, dataHash: range?.dataHash ?? null, issues },
        proposals,
        source,
        network: this.network,
        updated_at: Math.floor(Date.now() / 1000)
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.governanceSnapshotInFlight.set(cacheKey, request);
    }

    try {
      const result = await request;
      if (this.config.responseCacheEnabled) {
        this.governanceSnapshotCache.set(cacheKey, result);
      }
      return result;
    } finally {
      this.governanceSnapshotInFlight.delete(cacheKey);
    }
  }

  async getFarmSnapshot(poolAddress: string, options: DlmmFarmSnapshotOptions = {}): Promise<FarmSnapshotResponse> {
    // Read directly: owner reward state changes with time and wallet actions.
    // A success certifies a complete current page, never a payout settlement.
    const pool = Address.parse(poolAddress).toRawString();
    const snapshot = await readDlmmFarmSnapshot(pool, options, (method, args) => this.source.runGetMethod(pool, method, args));
    return { ...snapshot, source: this.config.dataSource === 'lite' ? 'lite' : 'http4', network: this.network,
      updated_at: Math.floor(Date.now() / 1000) };
  }

  async getOptionsSnapshot(
    factoryAddress: string,
    options: { afterId?: string; limit?: number } = {}
  ): Promise<OptionsSnapshotResponse> {
    const factory = normalizeAddress(factoryAddress);
    const afterId = BigInt(options.afterId ?? '0');
    const limit = options.limit ?? 32;
    if (afterId < 0n || afterId >= 1n << 64n || !Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new Error('Invalid options catalog page.');
    }
    const page = await this.source.runGetMethod(factory, 'series_catalog', [
      { type: 'int', value: afterId }, { type: 'int', value: BigInt(limit) },
    ]);
    if (!page || page.exitCode !== 0) throw new Error('Current options catalog unavailable.');
    let node = tupleItemCell(page.stack[0]);
    const cursor = tupleItemBigInt(page.stack[1]), more = tupleItemBigInt(page.stack[2]);
    if (!node || cursor === null || (more !== 0n && more !== 1n)) throw new Error('Invalid options catalog response.');
    const ids: bigint[] = [];
    while (node.bits.length > 0 || node.refs.length > 0) {
      if (node.isExotic || node.bits.length !== 64 || node.refs.length !== 1 || ids.length >= limit) throw new Error('Incomplete options catalog page.');
      const slice = node.beginParse();
      ids.push(slice.loadUintBig(64));
      node = slice.loadRef();
    }
    ids.reverse();
    if (ids.some((id, index) => id <= (index === 0 ? afterId : ids[index - 1]!)) ||
      cursor !== (ids.at(-1) ?? afterId) || (more === 1n && ids.length !== limit)) throw new Error('Invalid options catalog continuation.');
    const [governance, enabled] = await Promise.all([
      this.source.runGetMethod(factory, 'governance', []),
      this.source.runGetMethod(factory, 'registry_enabled', []),
    ]);
    const status = governance?.exitCode === 0 && enabled?.exitCode === 0
      ? { governance: tupleItemAddress(governance.stack[0]), enabled: tupleItemBool(enabled.stack[0]) } : null;
    const series: OptionSeriesSnapshotRecord[] = [];
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = await Promise.all(ids.slice(offset, offset + 4).map(async seriesId => {
        const result = await this.source.runGetMethod(factory, 'series_info', [{ type: 'int', value: seriesId }]);
        if (!result || result.exitCode !== 0 || !tupleItemBool(result.stack[0])) throw new Error('Options catalog details unavailable.');
        const stack = result.stack, expiry = tupleItemBigInt(stack[4]), state = tupleItemBigInt(stack[9]),
          max = tupleItemBigInt(stack[5]), open = tupleItemBigInt(stack[8]), address = tupleItemAddress(stack[3]);
        const remaining = max !== null && open !== null && max >= 0n && open >= 0n ? (max > open ? max - open : 0n) : null;
        return {
          seriesId: seriesId.toString(), templateId: tupleItemBigIntString(stack[1]), optionKind: tupleItemBigIntString(stack[2]),
          optionAddress: address, expiry: tupleItemBigIntString(stack[4]), maxNotional: tupleItemBigIntString(stack[5]),
          premiumBps: tupleItemBigIntString(stack[6]), collateralMultiplierBps: tupleItemBigIntString(stack[7]),
          openNotional: tupleItemBigIntString(stack[8]), status: tupleItemBigIntString(stack[9]),
          settlementTimestamp: tupleItemBigIntString(stack[10]), underlyingPool: tupleItemAddress(stack[11]), quotePool: tupleItemAddress(stack[12]),
          collateralLocked: tupleItemBigIntString(stack[13]), correlationScaleBps: tupleItemBigIntString(stack[14]),
          correlationBps: tupleItemBigIntString(stack[15]), correlationDispersionBps: tupleItemBigIntString(stack[16]),
          correlationTimestamp: tupleItemBigIntString(stack[17]), remainingNotional: remaining?.toString() ?? null,
          isActive: Boolean(address && state === 0n && expiry !== null && expiry > BigInt(Math.floor(Date.now() / 1000))),
        };
      }));
      series.push(...batch);
    }
    return { factory, status, series_count: series.length, scanned: ids.length,
      next_after_id: more === 1n ? cursor.toString() : null, page_complete: true, series,
      source: this.config.dataSource === 'lite' ? 'lite' : 'http4', network: this.network, updated_at: Math.floor(Date.now() / 1000) };
  }

  async getCoverSnapshot(
    managerAddress: string,
    options: { owner?: string | null; maxScan?: number; maxConsecutiveMisses?: number } = {}
  ): Promise<CoverSnapshotResponse> {
    const normalizedManager = normalizeAddress(managerAddress);
    const normalizedOwner = options.owner ? normalizeAddress(options.owner) : null;
    const maxScan = Math.max(1, Math.min(COVER_MAX_SCAN_LIMIT, Math.trunc(options.maxScan ?? COVER_MAX_SCAN_DEFAULT)));
    const maxConsecutiveMisses = Math.max(
      1,
      Math.min(
        COVER_MAX_CONSECUTIVE_MISSES_LIMIT,
        Math.trunc(options.maxConsecutiveMisses ?? COVER_MAX_CONSECUTIVE_MISSES_DEFAULT)
      )
    );
    const cacheKey = [normalizedManager, normalizedOwner ?? '', maxScan, maxConsecutiveMisses].join('|');

    if (this.config.responseCacheEnabled) {
      const cached = this.coverSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.coverSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = (async () => {
      const [stateRes, enabledRes] = await Promise.all([
        this.runGetMethodSource(normalizedManager, 'get_state', []).catch(() => null),
        this.runGetMethodSource(normalizedManager, 'registry_enabled', []).catch(() => null)
      ]);

      const state =
        stateRes?.exitCode === 0 && stateRes.stack.length === 16
          ? {
              totalPolicies: tupleItemBigIntString(stateRes.stack[0]),
              activePolicies: tupleItemBigIntString(stateRes.stack[1]),
              breachingPolicies: tupleItemBigIntString(stateRes.stack[2]),
              claimablePolicies: tupleItemBigIntString(stateRes.stack[3]),
              claimedPolicies: tupleItemBigIntString(stateRes.stack[4]),
              nextWakeTimestamp: tupleItemBigIntString(stateRes.stack[5]),
              lastSender: tupleItemAddress(stateRes.stack[6]),
              lastJobId: tupleItemBigIntString(stateRes.stack[7]),
              lastWork: tupleItemBigIntString(stateRes.stack[8]),
              lastTimestamp: tupleItemBigIntString(stateRes.stack[9]),
              lastProcessed: tupleItemBigIntString(stateRes.stack[10]),
              lastRemaining: tupleItemBigIntString(stateRes.stack[11]),
              vault: tupleItemAddress(stateRes.stack[12]),
              governance: tupleItemAddress(stateRes.stack[13]),
              riskVault: tupleItemAddress(stateRes.stack[14]),
              riskBucketId: tupleItemBigIntString(stateRes.stack[15])
            }
          : null;
      const enabled = enabledRes?.exitCode === 0 ? tupleItemBool(enabledRes.stack[0]) : null;
      const totalPoliciesRaw = stateRes?.exitCode === 0 && stateRes.stack.length === 16
        ? tupleItemBigInt(stateRes.stack[0]) : null;
      if (totalPoliciesRaw !== null && totalPoliciesRaw <= 0n) {
        const source: 'lite' | 'http4' = this.config.dataSource === 'lite' ? 'lite' : 'http4';
        return {
          manager: normalizedManager,
          owner: normalizedOwner,
          enabled,
          state,
          policy_count: 0,
          scanned: 0,
          policies: [],
          source,
          network: this.network,
          updated_at: Math.floor(Date.now() / 1000)
        };
      }
      const totalPolicies = totalPoliciesRaw && totalPoliciesRaw > 0n ? totalPoliciesRaw : 0n;
      const scanCount = totalPolicies > 0n
        ? Number(totalPolicies < BigInt(maxScan) ? totalPolicies : BigInt(maxScan))
        : maxScan;
      const startPolicyId = totalPolicies > 0n ? totalPolicies : BigInt(maxScan);
      const scanFloor = startPolicyId - BigInt(scanCount) + 1n;

      const policies: CoverPolicySnapshot[] = [];
      let scanned = 0;
      let misses = 0;
      let policyResponded = false;

      outer: for (let startId = startPolicyId; startId >= scanFloor; startId -= BigInt(COVER_SCAN_BATCH_SIZE)) {
        const candidateEnd = startId - BigInt(COVER_SCAN_BATCH_SIZE) + 1n;
        const endId = candidateEnd > scanFloor ? candidateEnd : scanFloor;
        const batchIds = Array.from(
          { length: Number(startId - endId + 1n) },
          (_, index) => startId - BigInt(index),
        );
          const batch = await Promise.all(
            batchIds.map((policyId) =>
              this.runGetMethodSource(normalizedManager, 'get_policy', [{ type: 'int', value: policyId }]).catch(
                () => null
              )
            )
          );

        for (let index = 0; index < batch.length; index += 1) {
          scanned += 1;
          const res = batch[index];
          if (res) policyResponded = true;
          if (!res || res.exitCode !== 0 || res.stack.length !== 19) {
            misses += 1;
            if (misses >= maxConsecutiveMisses) break outer;
            continue;
          }
          const stack = res.stack;
          const exists = tupleItemBool(stack[0]);
          if (!exists) {
            misses += 1;
            if (misses >= maxConsecutiveMisses) break outer;
            continue;
          }
          const owner = tupleItemAddress(stack[1]);
          misses = 0;
          if (normalizedOwner && owner !== normalizedOwner) {
            continue;
          }
          policies.push({
            id: String(batchIds[index]),
            owner,
            pool: tupleItemAddress(stack[2]),
            lowerBound: tupleItemBigIntString(stack[3]),
            upperBound: tupleItemBigIntString(stack[4]),
            payout: tupleItemBigIntString(stack[5]),
            coveredNotional: tupleItemBigIntString(stack[6]),
            windowSeconds: tupleItemBigIntString(stack[7]),
            requiredObservations: tupleItemBigIntString(stack[8]),
            breachStart: tupleItemBigIntString(stack[9]),
            breachSeconds: tupleItemBigIntString(stack[10]),
            lastObservation: tupleItemBigIntString(stack[11]),
            lastHealthyObservation: tupleItemBigIntString(stack[12]),
            breachObservations: tupleItemBigIntString(stack[13]),
            lastVolatilityTimestamp: tupleItemBigIntString(stack[14]),
            lastVolatilityRequestHash: tupleItemBigIntString(stack[15]),
            status: tupleItemBigIntString(stack[16]),
            riskVault: tupleItemAddress(stack[17]),
            riskBucketId: tupleItemBigIntString(stack[18])
          });
        }
      }

      if (!policyResponded && !stateRes && !enabledRes) {
        throw new Error('Cover snapshot is unavailable from the configured data source.');
      }

      const source: 'lite' | 'http4' = this.config.dataSource === 'lite' ? 'lite' : 'http4';
      return {
        manager: normalizedManager,
        owner: normalizedOwner,
        enabled,
        state,
        policy_count: policies.length,
        scanned,
        policies,
        source,
        network: this.network,
        updated_at: Math.floor(Date.now() / 1000)
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.coverSnapshotInFlight.set(cacheKey, request);
    }

    try {
      const result = await request;
      if (this.config.responseCacheEnabled) {
        this.coverSnapshotCache.set(cacheKey, result);
      }
      return result;
    } finally {
      this.coverSnapshotInFlight.delete(cacheKey);
    }
  }

  async getDefiSnapshot(request: DefiSnapshotRequest): Promise<DefiSnapshotResponse> {
    const normalizeValidAddress = (value?: string | null) => {
      if (!value) return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return Address.parse(trimmed).toRawString();
      } catch {
        return null;
      }
    };

    const normalizedOwner = normalizeValidAddress(request.owner ?? null);
    const include = request.include ?? {};
    const includeActivation = include.activation ?? true;
    const includeDlmmRegistry = include.dlmmRegistry ?? true;
    const includeReserveBalances = include.reserveBalances ?? true;
    const includeSystemHealth = include.systemHealth ?? true;
    const includeSystemHealthDetailed = include.systemHealthDetailed ?? false;
    const includeModules = include.modules ?? true;
    const includeModuleGovernance = include.moduleGovernance ?? false;
    const includeGovernance = include.governance ?? true;
    const includeCover = include.cover ?? true;

    const normalizedContracts = Object.fromEntries(
      Object.entries(request.contracts ?? {}).map(([key, value]) => [key, normalizeValidAddress(value)])
    ) as Record<keyof DefiSnapshotRequest['contracts'], string | null>;

    const modulesRequested = Array.isArray(request.modules) ? request.modules : [];
    const normalizedModules = modulesRequested
      .map((entry) => ({
        key: entry.key?.trim() ?? '',
        address: normalizeValidAddress(entry.address),
        enabledGetter: entry.enabledGetter ?? null,
        governanceGetter: entry.governanceGetter ?? null
      }))
      .filter((entry) => Boolean(entry.key) && Boolean(entry.address))
      .sort((a, b) => a.key.localeCompare(b.key));

    const options = request.options ?? {};
    const govMaxScan =
      typeof options.governance?.maxScan === 'number' && Number.isFinite(options.governance.maxScan)
        ? Math.max(1, Math.trunc(options.governance.maxScan))
        : undefined;
    const govMaxMisses =
      typeof options.governance?.maxMisses === 'number' && Number.isFinite(options.governance.maxMisses)
        ? Math.max(1, Math.trunc(options.governance.maxMisses))
        : undefined;
    const coverMaxScan =
      typeof options.cover?.maxScan === 'number' && Number.isFinite(options.cover.maxScan)
        ? Math.max(1, Math.trunc(options.cover.maxScan))
        : undefined;
    const coverMaxMisses =
      typeof options.cover?.maxMisses === 'number' && Number.isFinite(options.cover.maxMisses)
        ? Math.max(1, Math.trunc(options.cover.maxMisses))
        : undefined;

    const cacheKey = [
      normalizedOwner ?? '',
      includeActivation ? 'a1' : 'a0',
      includeDlmmRegistry ? 'd1' : 'd0',
      includeReserveBalances ? 'r1' : 'r0',
      includeSystemHealth ? 's1' : 's0',
      includeSystemHealthDetailed ? 'sd1' : 'sd0',
      includeModules ? 'm1' : 'm0',
      includeModuleGovernance ? 'mg1' : 'mg0',
      includeGovernance ? 'g1' : 'g0',
      includeCover ? 'c1' : 'c0',
      `gov:${govMaxScan ?? ''}:${govMaxMisses ?? ''}`,
      `cover:${coverMaxScan ?? ''}:${coverMaxMisses ?? ''}`,
      ...Object.entries(normalizedContracts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}:${value ?? ''}`),
      `mods:${normalizedModules
        .map((module) => `${module.key}:${module.address}:${module.enabledGetter ?? ''}:${module.governanceGetter ?? ''}`)
        .join(',')}`
    ].join('|');

    if (this.config.responseCacheEnabled) {
      const cached = this.defiSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.defiSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

	    const requestPromise = (async () => {
	      const errorMessage = (error: unknown) => {
	        if (!error) return 'unknown error';
	        if (error instanceof Error) return error.message || 'unknown error';
	        return String(error);
	      };
	      const ok = <T>(data: T): DefiSnapshotSectionOk<T> => ({ ok: true, data });
	      const err = (error: unknown): DefiSnapshotSectionErr => ({ ok: false, error: errorMessage(error), data: null });

	      const sections: DefiSnapshotResponse['sections'] = {};
	      const tasks: Array<Promise<void>> = [];

	      if (includeActivation) {
	        tasks.push(
	          (async () => {
	            const activationGate = normalizedContracts.activationGate;
	            if (!activationGate) {
	              sections.activation = err('activationGate missing');
	              return;
	            }
	            try {
	              const res = await this.runGetMethodSource(activationGate, 'activation_status', []);
	              if (!res || res.exitCode !== 0) {
	                throw new Error('Activation status unavailable.');
	              }
	              const stack = res.stack;
	              sections.activation = ok({
	                burned: tupleItemBigIntString(stack[0]),
	                target: tupleItemBigIntString(stack[1]),
	                ready: tupleItemBool(stack[2]),
	                activated: tupleItemBool(stack[3]),
	                activatedAt: tupleItemBigIntString(stack[4])
	              });
	            } catch (error) {
	              sections.activation = err(error);
	            }
	          })()
	        );
	      }

	      if (includeDlmmRegistry) {
	        tasks.push(
	          (async () => {
	            const registry = normalizedContracts.dlmmRegistry;
	            if (!registry) {
	              sections.dlmmRegistry = err('dlmmRegistry missing');
	              return;
	            }
	            try {
	              const res = await this.runGetMethodSource(registry, 'registry_meta', []);
	              if (!res || res.exitCode !== 0) {
	                throw new Error('DLMM registry meta unavailable.');
	              }
	              const stack = unwrapTupleStack(res.stack);
	              sections.dlmmRegistry = ok({
	                governance: tupleItemAddress(stack[0]),
	                enabled: tupleItemBool(stack[1]),
	                withdrawalsOnly: tupleItemBool(stack[2]),
	                perpsWeightEnabled: tupleItemBool(stack[3])
	              });
	            } catch (error) {
	              sections.dlmmRegistry = err(error);
	            }
	          })()
	        );
	      }

	      if (includeReserveBalances) {
	        tasks.push(
	          (async () => {
	            const hub = normalizedContracts.t3Hub;
	            if (!hub) {
	              sections.reserveBalances = err('t3Hub missing');
	              return;
	            }
	            try {
	              const res = await this.runGetMethodSource(hub, 'pool_balances', []);
	              if (!res || res.exitCode !== 0) {
	                throw new Error('Reserve balances unavailable.');
	              }
	              const stack = unwrapTupleStack(res.stack);
	              sections.reserveBalances = ok({
	                usdt: tupleItemBigIntString(stack[0]),
	                usdc: tupleItemBigIntString(stack[1]),
	                kusd: tupleItemBigIntString(stack[2])
	              });
	            } catch (error) {
	              sections.reserveBalances = err(error);
	            }
	          })()
	        );
	      }

	      if (includeSystemHealth) {
	        tasks.push(
	          (async () => {
	            const controlMesh = normalizedContracts.controlMesh;
                const riskController = normalizedContracts.riskController;
	            const riskVault = normalizedContracts.riskVault;
	            const feeRouter = normalizedContracts.feeRouter;
	            const buybackExecutor = normalizedContracts.buybackExecutor;
	            const anchorGuard = normalizedContracts.anchorGuard;
	            try {
	              const [
	                controlRes,
	                riskControllerRes,
	                riskRes,
	                feeStateRes,
	                feeTargetsRes,
	                buybackRes,
	                anchorConfigRes,
	                anchorStateRes,
	                anchorEnabledRes,
	                anchorGovRes
	              ] = await Promise.all([
	                controlMesh ? this.runGetMethodSource(controlMesh, 'get_control_state', []) : Promise.resolve(null),
                    riskController ? this.runGetMethodSource(riskController, 'get_risk_controller_state', []) : Promise.resolve(null),
	                riskVault ? this.runGetMethodSource(riskVault, 'risk_state', []) : Promise.resolve(null),
	                feeRouter ? this.runGetMethodSource(feeRouter, 'get_router_state', []) : Promise.resolve(null),
	                feeRouter ? this.runGetMethodSource(feeRouter, 'router_targets', []) : Promise.resolve(null),
	                buybackExecutor ? this.runGetMethodSource(buybackExecutor, 'buyback_config', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSource(anchorGuard, 'anchor_config', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSource(anchorGuard, 'anchor_state', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSource(anchorGuard, 'enabled', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSource(anchorGuard, 'governance', []) : Promise.resolve(null)
	              ]);

	              const responded = Boolean(
	                controlRes || riskControllerRes ||
	                  riskRes ||
	                  feeStateRes ||
	                  feeTargetsRes ||
	                  buybackRes ||
	                  anchorConfigRes ||
	                  anchorStateRes ||
	                  anchorEnabledRes ||
	                  anchorGovRes
	              );
	              if (!responded) {
	                throw new Error('System health snapshot unavailable.');
	              }

	              const controlState: ControlStateSnapshot | null =
	                controlRes?.exitCode === 0 ? decodeControlMeshSnapshot(controlRes.stack) : null;

	              const riskState: RiskStateSnapshot | null =
	                riskRes?.exitCode === 0
	                  ? {
	                      totalLocked: tupleItemBigIntString(riskRes.stack[0]),
	                      totalOutstanding: tupleItemBigIntString(riskRes.stack[1]),
	                      totalPending: tupleItemBigIntString(riskRes.stack[2]),
	                      totalSurplus: tupleItemBigIntString(riskRes.stack[3]),
	                      flags: tupleItemBigIntString(riskRes.stack[4]),
	                      registryVersion: tupleItemBigIntString(riskRes.stack[5])
	                    }
	                  : null;

	              const feeRouterState = feeStateRes?.exitCode === 0
	                ? decodeFeeRouterStateSnapshot(feeStateRes.stack) : null;
	              const feeRouterTargets = feeTargetsRes?.exitCode === 0
	                ? decodeFeeRouterTargetsSnapshot(feeTargetsRes.stack) : null;

	              const buybackConfig: BuybackConfigSnapshot | null =
	                buybackRes?.exitCode === 0
	                  ? {
	                      t3Root: tupleItemAddress(buybackRes.stack[0]),
	                      tsRoot: tupleItemAddress(buybackRes.stack[1]),
	                      tsBurnWallet: tupleItemAddress(buybackRes.stack[2]),
	                      router: tupleItemAddress(buybackRes.stack[3]),
	                      recordTarget: tupleItemAddress(buybackRes.stack[4]),
	                      routerWalletForward: tupleItemBigIntString(buybackRes.stack[5]),
	                      swapForwardValue: tupleItemBigIntString(buybackRes.stack[6])
	                    }
	                  : null;

	              const anchorGuardConfig: AnchorConfigSnapshot | null =
	                anchorConfigRes?.exitCode === 0
	                  ? (() => {
	                      const stack = unwrapTupleStack(anchorConfigRes.stack);
	                      return {
	                        quorumBps: tupleItemBigIntString(stack[0]),
	                        maxAgeSeconds: tupleItemBigIntString(stack[1]),
	                        epsilonExtBps: tupleItemBigIntString(stack[2]),
	                        epsilonClipBps: tupleItemBigIntString(stack[3]),
	                        trimCount: tupleItemBigIntString(stack[4])
	                      };
	                    })()
	                  : null;

	              const anchorCell =
	                anchorStateRes?.exitCode === 0 ? tupleItemCell(anchorStateRes.stack[0]) : null;
	              const anchorGuardState = anchorCell ? parseAnchorStateCell(anchorCell) : null;
	              const anchorGuardEnabled = anchorEnabledRes?.exitCode === 0 ? tupleItemBool(anchorEnabledRes.stack[0]) : null;
	              const anchorGuardGovernance = anchorGovRes?.exitCode === 0 ? tupleItemAddress(anchorGovRes.stack[0]) : null;

	              sections.systemHealth = ok({
	                controlState,
                    riskControllerState: riskControllerRes?.exitCode === 0 ? decodeRiskControllerSnapshot(riskControllerRes.stack) : null,
	                riskState,
	                feeRouterState,
	                feeRouterTargets,
	                buybackConfig,
	                anchorGuardConfig,
	                anchorGuardState,
	                anchorGuardEnabled,
	                anchorGuardGovernance
	              });
	            } catch (error) {
	              sections.systemHealth = err(error);
	            }
	          })()
	        );
	      }

	      if (includeSystemHealthDetailed) {
	        tasks.push(
	          (async () => {
	            const riskVault = normalizedContracts.riskVault;
	            const automationRegistry = normalizedContracts.automationRegistry;
	            const bucketIds = [1, 2, 3];
	            const riskBucketStates: Record<number, RiskBucketStateSnapshot | null> = {};
	            bucketIds.forEach((id) => {
	              riskBucketStates[id] = null;
	            });
	            try {
	              let responded = false;
	              if (riskVault) {
	                const bucketResults = await Promise.all(
	                  bucketIds.map((id) =>
	                    this.runGetMethodSource(riskVault, 'bucket_state', [{ type: 'int', value: BigInt(id) }]).catch(
	                      () => null
	                    )
	                  )
	                );
	                bucketResults.forEach((res, index) => {
	                  if (!res || res.exitCode !== 0) return;
	                  responded = true;
	                  const stack = res.stack;
	                  const id = bucketIds[index];
	                  riskBucketStates[id] = {
	                    exists: tupleItemBool(stack[0]),
	                    controller: tupleItemAddress(stack[1]),
	                    payoutHook: tupleItemAddress(stack[2]),
	                    liquidationHook: tupleItemAddress(stack[3]),
	                    utilisationCapBps: tupleItemBigIntString(stack[4]),
	                    payoutCapBps: tupleItemBigIntString(stack[5]),
	                    collateralMultiplierBps: tupleItemBigIntString(stack[6]),
	                    outstandingNotional: tupleItemBigIntString(stack[7]),
	                    lockedCollateral: tupleItemBigIntString(stack[8]),
	                    pendingPayouts: tupleItemBigIntString(stack[9]),
	                    automationJobId: tupleItemBigIntString(stack[10]),
	                    automationCadence: tupleItemBigIntString(stack[11]),
	                    automationBacklog: tupleItemBigIntString(stack[12]),
	                    registryVersion: tupleItemBigIntString(stack[13]),
	                    surplus: tupleItemBigIntString(stack[14]),
	                    utilisationBps: tupleItemBigIntString(stack[15]),
	                    deficit: tupleItemBool(stack[16]),
	                    lastReportTs: tupleItemBigIntString(stack[17])
	                  };
	                });
	              }

	              let automationConfig: AutomationConfigSnapshot | null = null;
	              let jobQueueConfig: JobConfigSnapshot | null = null;
	              const automationModules: Record<number, AutomationModuleTelemetrySnapshot | null> = {};
	              const jobQueueJobs: Record<number, JobRecordSnapshot | null> = {};

	              const parseJobId = (value: string | null) => {
	                if (!value) return null;
	                try {
	                  const big = BigInt(value);
	                  if (big <= 0n) return null;
	                  const asNumber = Number(big);
	                  return Number.isFinite(asNumber) ? Math.trunc(asNumber) : null;
	                } catch {
	                  return null;
	                }
	              };

	              const moduleIds = Array.from(
	                new Set(
	                  Object.values(riskBucketStates)
	                    .map((state) => parseJobId(state?.automationJobId ?? null))
	                    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
	                )
	              ).sort((a, b) => a - b);

	              let queueAddress: string | null = null;
	              if (automationRegistry) {
	                const configRes = await this.runGetMethodSource(automationRegistry, 'config', []).catch(() => null);
	                if (configRes?.exitCode === 0) {
	                  responded = true;
	                  queueAddress = tupleItemAddress(configRes.stack[0]);
	                  automationConfig = { queue: queueAddress };
	                } else {
	                  automationConfig = null;
	                }
	              }

	              if (queueAddress) {
	                const jobConfigRes = await this.runGetMethodSource(queueAddress, 'job_config', []).catch(() => null);
	                if (jobConfigRes?.exitCode === 0) {
	                  responded = true;
	                  jobQueueConfig = {
	                    maxJobs: tupleItemBigIntString(jobConfigRes.stack[0]),
	                    minValue: tupleItemBigIntString(jobConfigRes.stack[1]),
	                    maxLaneJobs: tupleItemBigIntString(jobConfigRes.stack[2]),
	                    maxPriorityJobs: tupleItemBigIntString(jobConfigRes.stack[3])
	                  };
	                }
	              }

	              if (automationRegistry && moduleIds.length) {
	                const telemetryRes = await Promise.all(
	                  moduleIds.map((id) =>
	                    this.runGetMethodSource(automationRegistry, 'module', [{ type: 'int', value: BigInt(id) }]).catch(
	                      () => null
	                    )
	                  )
	                );
	                telemetryRes.forEach((res, index) => {
	                  const id = moduleIds[index];
	                  if (!res || res.exitCode !== 0) {
	                    automationModules[id] = null;
	                    return;
	                  }
	                  responded = true;
	                  const stack = res.stack;
	                  automationModules[id] = {
	                    lastTimestamp: tupleItemBigIntString(stack[0]),
	                    lastStatus: tupleItemBigIntString(stack[1]),
	                    lastProcessed: tupleItemBigIntString(stack[2]),
	                    lastRemaining: tupleItemBigIntString(stack[3]),
	                    successCount: tupleItemBigIntString(stack[4]),
	                    failureCount: tupleItemBigIntString(stack[5]),
	                    totalProcessed: tupleItemBigIntString(stack[6])
	                  };
	                });
	              }

	              if (queueAddress && moduleIds.length) {
	                const jobRes = await Promise.all(
	                  moduleIds.map((id) =>
	                    this.runGetMethodSource(queueAddress, 'job', [{ type: 'int', value: BigInt(id) }]).catch(
	                      () => null
	                    )
	                  )
	                );
	                jobRes.forEach((res, index) => {
	                  const id = moduleIds[index];
	                  if (!res || res.exitCode !== 0) {
	                    jobQueueJobs[id] = null;
	                    return;
	                  }
	                  responded = true;
	                  const stack = res.stack;
	                  jobQueueJobs[id] = {
	                    exists: tupleItemBool(stack[0]),
	                    jobId: tupleItemBigIntString(stack[1]),
	                    target: tupleItemAddress(stack[2]),
	                    scheduledAt: tupleItemBigIntString(stack[3]),
	                    forwardedValue: tupleItemBigIntString(stack[4]),
	                    dispatchValue: tupleItemBigIntString(stack[5]),
	                    payloadHash: tupleItemBigIntString(stack[6]),
	                    attempts: tupleItemBigIntString(stack[7]),
	                    maxAttempts: tupleItemBigIntString(stack[8]),
	                    status: tupleItemBigIntString(stack[9]),
	                    lastDispatchAt: tupleItemBigIntString(stack[10]),
	                    lastResult: tupleItemBigIntString(stack[11]),
	                    wakeAt: tupleItemBigIntString(stack[12]),
	                    ackTimeoutAt: tupleItemBigIntString(stack[13]),
	                    dispatchHash: tupleItemBigIntString(stack[14]),
	                    owner: tupleItemAddress(stack[15]),
	                    priority: tupleItemBigIntString(stack[16]),
	                    lane: tupleItemBigIntString(stack[17]),
	                    deadlineAt: tupleItemBigIntString(stack[18]),
	                    maxWork: tupleItemBigIntString(stack[19])
	                  };
	                });
	              }

	              if (!responded) {
	                throw new Error('System health detailed snapshot unavailable.');
	              }

	              sections.systemHealthDetailed = ok({
	                riskBucketStates,
	                automationConfig,
	                automationModules,
	                jobQueueConfig,
	                jobQueueJobs
	              });
	            } catch (error) {
	              sections.systemHealthDetailed = err(error);
	            }
	          })()
	        );
	      }

	      if (includeModules) {
	        tasks.push(
	          (async () => {
	            try {
	              const statuses: Record<string, ModuleStatusSnapshot | null> = {};
	              if (normalizedModules.length === 0) {
	                sections.modules = ok(statuses);
	              } else {
	                const results = await Promise.all(
	                  normalizedModules.map(async (module) => {
	                    const enabledGetter = module.enabledGetter?.trim() || 'registry_enabled';
	                    const governanceGetter = includeModuleGovernance ? module.governanceGetter : null;
	                    const [enabledRes, governanceRes] = await Promise.all([
	                      this.runGetMethodSource(module.address!, enabledGetter, []).catch(() => null),
	                      governanceGetter
	                        ? this.runGetMethodSource(module.address!, governanceGetter.trim(), []).catch(() => null)
	                        : Promise.resolve(null)
	                    ]);
	                    if (!enabledRes || enabledRes.exitCode !== 0) {
	                      return { key: module.key, status: null };
	                    }
	                    const enabled = tupleItemBool(enabledRes.stack[0]);
	                    const governance =
	                      governanceRes && governanceRes.exitCode === 0 ? tupleItemAddress(governanceRes.stack[0]) : null;
	                    return { key: module.key, status: { enabled, governance } as ModuleStatusSnapshot };
	                  })
	                );
	                results.forEach((entry) => {
	                  statuses[entry.key] = entry.status;
	                });
	                sections.modules = ok(statuses);
	              }
	            } catch (error) {
	              sections.modules = err(error);
	            }
	          })()
	        );
	      }

	      if (includeGovernance) {
	        tasks.push(
	          (async () => {
	            const voting = normalizedContracts.voting;
	            if (!voting) {
	              sections.governance = err('voting missing');
	              return;
	            }
	            try {
	              sections.governance = ok(
	                await this.getGovernanceSnapshot(voting, {
	                  owner: normalizedOwner ?? undefined,
	                  maxScan: govMaxScan,
	                  maxConsecutiveMisses: govMaxMisses
	                })
	              );
	            } catch (error) {
	              sections.governance = err(error);
	            }
	          })()
	        );
	      }

	      if (includeCover) {
	        tasks.push(
	          (async () => {
	            const manager = normalizedContracts.coverManager;
	            if (!manager) {
	              sections.cover = err('coverManager missing');
	              return;
	            }
	            try {
	              sections.cover = ok(
	                await this.getCoverSnapshot(manager, {
	                  owner: normalizedOwner ?? undefined,
	                  maxScan: coverMaxScan,
	                  maxConsecutiveMisses: coverMaxMisses
	                })
	              );
	            } catch (error) {
	              sections.cover = err(error);
	            }
	          })()
	        );
	      }

	      await Promise.all(tasks);

	      return {
	        owner: normalizedOwner,
	        network: this.network,
        updated_at: Math.floor(Date.now() / 1000),
        sections
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.defiSnapshotInFlight.set(cacheKey, requestPromise);
    }

    try {
      const response = await requestPromise;
      if (this.config.responseCacheEnabled) {
        this.defiSnapshotCache.set(cacheKey, response);
      }
      return response;
    } finally {
      this.defiSnapshotInFlight.delete(cacheKey);
    }
  }

  async getDlmmPoolsSnapshot(request: DlmmPoolsSnapshotRequest): Promise<DlmmPoolsSnapshotResponse> {
    const normalizeValidAddress = (value?: string | null) => {
      if (!value) return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return Address.parse(trimmed).toRawString();
      } catch {
        return null;
      }
    };

    const t3Root = normalizeValidAddress(request.t3Root);
    if (!t3Root) {
      throw new Error('Invalid t3Root address.');
    }
    const registry = normalizeValidAddress(request.dlmmRegistry ?? null);
    const factory = normalizeValidAddress(request.dlmmFactory ?? null);
    const tokens = Array.from(
      new Set((Array.isArray(request.tokens) ? request.tokens : []).map((token) => normalizeValidAddress(token)).filter((token): token is string => Boolean(token)))
    ).sort((a, b) => a.localeCompare(b));

    const cacheKey = [t3Root, registry ?? '', factory ?? '', tokens.join(',')].join('|');
    if (this.config.responseCacheEnabled) {
      const cached = this.dlmmPoolsSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.dlmmPoolsSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const requestPromise = (async () => {
      const decodeRecord = (res: { exitCode: number; stack: TupleItem[] } | null) => {
        if (!res || res.exitCode !== 0) return null;
        const stack = unwrapTupleStack(res.stack);
        const exists = tupleItemBool(stack[0]);
        if (!exists) {
          return { exists: false, pool: null as string | null, kind: null as number | null, status: null as number | null };
        }
        const pool = tupleItemAddress(stack[1]);
        const kindRaw = tupleItemBigInt(stack[2]);
        const statusRaw = tupleItemBigInt(stack[3]);
        const kind = kindRaw !== null ? Number(kindRaw) : null;
        const status = statusRaw !== null ? Number(statusRaw) : null;
        return {
          exists: true,
          pool,
          kind: Number.isFinite(kind ?? NaN) ? kind : null,
          status: Number.isFinite(status ?? NaN) ? status : null
        };
      };

      const poolEntries: DlmmPoolSnapshotEntry[] = [];

      await Promise.all(
        tokens.map(async (token) => {
          const [registryRes, factoryRes] = await Promise.all([
            registry
              ? this.runGetMethodSource(registry, 'pool_for', [
                  { type: 'slice', cell: buildSliceCell(t3Root) },
                  { type: 'slice', cell: buildSliceCell(token) }
                ]).catch(() => null)
              : Promise.resolve(null),
            factory
              ? this.runGetMethodSource(factory, 'pool_record', [
                  { type: 'slice', cell: buildSliceCell(t3Root) },
                  { type: 'slice', cell: buildSliceCell(token) }
                ]).catch(() => null)
              : Promise.resolve(null)
          ]);

          const registryRecord = decodeRecord(registryRes);
          const factoryRecord = decodeRecord(factoryRes);

          const registryPool =
            registryRecord?.exists && (registryRecord.status === null || registryRecord.status === 0)
              ? registryRecord.pool
              : null;
          const factoryPool =
            factoryRecord?.exists && (factoryRecord.status === null || factoryRecord.status === 0)
              ? factoryRecord.pool
              : null;

          const pool = registryPool ?? factoryPool ?? null;
          const kind = registryPool ? registryRecord?.kind ?? null : factoryPool ? factoryRecord?.kind ?? null : null;
          const status = registryPool ? registryRecord?.status ?? null : factoryPool ? factoryRecord?.status ?? null : null;

          let resolvedPool: string | null = pool;
          let activeBinId: number | null = null;
          let walletCodeHash: string | null = null;
          let binReserves: DlmmPoolBinReserves | null = null;

          if (resolvedPool) {
            const activeRes = await this.runGetMethodSource(resolvedPool, 'active_price_q64', []).catch(() => null);
            if (!activeRes || activeRes.exitCode !== 0) {
              // Pool address can be deterministic but not actually deployed. Hide it.
              resolvedPool = null;
            } else {
              const stack = unwrapTupleStack(activeRes.stack);
              const binRaw = tupleItemBigInt(stack[0]);
              if (binRaw !== null) {
                const asNumber = Number(binRaw);
                activeBinId = Number.isFinite(asNumber) ? Math.trunc(asNumber) : null;
              }
              if (activeBinId !== null) {
                const binRes = await this.runGetMethodSource(resolvedPool, 'bin_state', [
                  { type: 'int', value: BigInt(activeBinId) }
                ]).catch(() => null);
                if (binRes && binRes.exitCode === 0) {
                  const binStack = unwrapTupleStack(binRes.stack);
                  binReserves = {
                    reserveT: tupleItemBigIntString(binStack[0]),
                    reserveX: tupleItemBigIntString(binStack[1])
                  };
                }
              }
              const walletCodeHashRes = await this.runGetMethodSource(
                resolvedPool,
                'wallet_code_hash',
                []
              ).catch(() => null);
              if (walletCodeHashRes && walletCodeHashRes.exitCode === 0) {
                const walletCodeHashStack = unwrapTupleStack(walletCodeHashRes.stack);
                walletCodeHash = tupleItemBigIntString(walletCodeHashStack[0]);
              }
            }
          }

          poolEntries.push({
            token,
            pool: resolvedPool,
            kind,
            status,
            activeBinId,
            walletCodeHash,
            binReserves
          });
        })
      );

      poolEntries.sort((a, b) => a.token.localeCompare(b.token));

      return {
        t3Root,
        registry,
        factory,
        pools: poolEntries,
        network: this.network,
        updated_at: Math.floor(Date.now() / 1000)
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.dlmmPoolsSnapshotInFlight.set(cacheKey, requestPromise);
    }

    try {
      const response = await requestPromise;
      if (this.config.responseCacheEnabled) {
        this.dlmmPoolsSnapshotCache.set(cacheKey, response);
      }
      return response;
    } finally {
      this.dlmmPoolsSnapshotInFlight.delete(cacheKey);
    }
  }

  async getTransactionEvidence(address: string, limit: number, lt?: string, hash?: string) {
    if (Boolean(lt) !== Boolean(hash)) throw new Error('Transaction evidence requires both cursor fields.');
    const page = await this.withInitialHistoryTimeout(
      readOriginalTransactionEvidence(this.source, address, limit, lt && hash ? { lt, hash } : undefined,
        Date.now() + Math.max(1, this.config.initialHistoryTimeoutMs)),
      this.config.initialHistoryTimeoutMs,
    );
    return page.map(originalTransactionToToncenter);
  }

  async getTransactions(address: string, page: number) {
    address = normalizeAddress(address);
    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (error) {
      if (error instanceof InitialHistoryReadTimeoutError) throw error;
      const fallback = this.store.getPage(address, page);
      if (!fallback) {
        return {
          page,
          page_size: this.config.pageSize,
          total_txs: 0,
          total_pages: null,
          total_pages_min: 0,
          history_complete: false,
          txs: [],
          network: this.network,
        };
      }
    }

    const entry = this.store.get(address);
    const signature = this.getTxPageSignature(entry, page);
    const cacheKey = `${address}:page:${page}`;
    if (this.config.responseCacheEnabled && signature) {
      const cachedValue = this.getCached(this.txCache, cacheKey, signature);
      if (cachedValue) return cachedValue;
    }

    const result = this.store.getPage(address, page);
    this.metrics?.recordTxCache(Boolean(result));
    if (!result) {
      return {
        page,
        page_size: this.config.pageSize,
        total_txs: 0,
        total_pages: null,
        total_pages_min: 0,
        history_complete: false,
        txs: [],
        network: this.network,
      };
    }

    if (!result.historyComplete && this.enqueueBackfill) {
      const maxPages = Math.min(
        this.config.backfillMaxPagesPerAddress,
        this.config.maxPagesPerAddress
      );
      const backfillCapped = result.totalTxs >= this.config.pageSize * maxPages;
      if (!backfillCapped && page >= result.totalPagesMin) {
        this.enqueueBackfill(address);
      }
    }

    const txs = result.txs.map(this.toApiTx);

    const response = {
      page: result.page,
      page_size: result.pageSize,
      total_txs: result.totalTxs,
      total_pages: result.totalPages,
      total_pages_min: result.totalPagesMin,
      history_complete: result.historyComplete,
      txs,
      network: this.network,
    };
    this.setCached(this.txCache, cacheKey, response, signature, this.config.txCacheTtlMs);
    return response;
  }

  async getTransactionsByCursor(address: string, lt: string, hash: string) {
    address = normalizeAddress(address);
    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (error) {
      if (error instanceof InitialHistoryReadTimeoutError) throw error;
      const fallback = this.store.getPageByCursor(address, { lt, hash });
      if (!fallback) {
        return {
          page: 1,
          page_size: this.config.pageSize,
          total_txs: 0,
          total_pages: null,
          total_pages_min: 0,
          history_complete: false,
          txs: [],
          network: this.network,
        };
      }
    }

    const entry = this.store.get(address);
    const signature = this.getTxCursorSignature(entry, lt, hash);
    const cacheKey = `${address}:cursor:${lt}:${hash}`;
    if (this.config.responseCacheEnabled && signature) {
      const cachedValue = this.getCached(this.txCache, cacheKey, signature);
      if (cachedValue) return cachedValue;
    }

    const result = this.store.getPageByCursor(address, { lt, hash });
    this.metrics?.recordTxCache(Boolean(result));
    if (!result) {
      return {
        page: 1,
        page_size: this.config.pageSize,
        total_txs: 0,
        total_pages: null,
        total_pages_min: 0,
        history_complete: false,
        txs: [],
        network: this.network,
      };
    }

    const txs = result.txs.map(this.toApiTx);
    const response = {
      page: result.page,
      page_size: result.pageSize,
      total_txs: result.totalTxs,
      total_pages: result.totalPages,
      total_pages_min: result.totalPagesMin,
      history_complete: result.historyComplete,
      txs,
      network: this.network,
    };
    this.setCached(this.txCache, cacheKey, response, signature, this.config.txCacheTtlMs);
    return response;
  }

  async getSwapExecutions(
    address: string,
    options: {
      limit?: number;
      fromUtime?: number;
      toUtime?: number;
      payToken?: string;
      receiveToken?: string;
      executionType?: SwapExecutionType;
      status?: SwapExecutionStatus;
      includeReverse?: boolean;
    } = {}
  ): Promise<AccountSwapsResponse> {
    address = normalizeAddress(address);
    const syncedAt = Math.trunc(Date.now() / 1000);
    const emptySummary: AccountSwapsSummary = {
      status_counts: { success: 0, failed: 0, pending: 0 },
      execution_type_counts: { market: 0, limit: 0, twap: 0, unknown: 0 },
      twap_run_count: 0,
      pending_limit_count: 0,
    };

    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (_error) {
      const fallback = this.store.get(address);
      if (!fallback) {
        return {
          address,
          total_swaps: 0,
          returned_swaps: 0,
          history_complete: false,
          synced_at: syncedAt,
          network: this.network,
          swaps: [],
          summary: emptySummary,
          twap_runs: [],
          pending_limits: [],
        };
      }
    }

    const entry = this.store.get(address);
    if (!entry) {
      return {
        address,
        total_swaps: 0,
        returned_swaps: 0,
        history_complete: false,
        synced_at: syncedAt,
        network: this.network,
        swaps: [],
        summary: emptySummary,
        twap_runs: [],
        pending_limits: [],
      };
    }

    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const fromUtime =
      typeof options.fromUtime === 'number' && Number.isFinite(options.fromUtime)
        ? Math.max(1, Math.trunc(options.fromUtime))
        : null;
    const toUtime =
      typeof options.toUtime === 'number' && Number.isFinite(options.toUtime)
        ? Math.max(1, Math.trunc(options.toUtime))
        : null;
    const payToken = normalizeTokenSymbol(options.payToken);
    const receiveToken = normalizeTokenSymbol(options.receiveToken);
    const includeReverse = Boolean(options.includeReverse);
    const executionType = options.executionType;
    const status = options.status;

    const summary: AccountSwapsSummary = {
      status_counts: { success: 0, failed: 0, pending: 0 },
      execution_type_counts: { market: 0, limit: 0, twap: 0, unknown: 0 },
      twap_run_count: 0,
      pending_limit_count: 0,
    };
    const swaps: AccountSwapExecution[] = [];
    const pendingLimits: AccountPendingLimitOrder[] = [];
    const twapRuns = new Map<
      string,
      {
        id: string;
        payToken?: string;
        receiveToken?: string;
        totalSlices: number;
        confirmedSlices: number;
        pendingSlices: number;
        failedSlices: number;
        firstUtime: number;
        lastUtime: number;
      }
    >();
    let totalSwaps = 0;
    const pendingLimitCap = 64;
    const twapRunCap = 64;

    for (const tx of entry.txs) {
      const swap = this.toSwapExecution(tx);
      if (!swap) continue;
      // Decoded actions (including imported snapshots) are not receipt proofs.
      // Only the qualified owner-ledger reader below may publish actual output.
      swap.requestedPayAmount = swap.payAmount;
      swap.payAmount = undefined;
      swap.returnedPayAmount = undefined;
      swap.receiveAmount = undefined;
      swap.receiveAmountSource = undefined;
      if (fromUtime !== null && swap.utime < fromUtime) continue;
      if (toUtime !== null && swap.utime > toUtime) continue;
      if (status && swap.status !== status) continue;
      if (executionType && swap.executionType !== executionType) continue;
      if (!this.matchesSwapPairFilter(swap, payToken, receiveToken, includeReverse)) continue;
      totalSwaps += 1;
      summary.status_counts[swap.status] += 1;
      summary.execution_type_counts[swap.executionType] += 1;

      if (swap.executionType === 'limit' && swap.status === 'pending') {
        summary.pending_limit_count += 1;
        if (pendingLimits.length < pendingLimitCap) {
          pendingLimits.push({
            txId: swap.txId,
            lt: swap.lt,
            hash: swap.hash,
            utime: swap.utime,
            status: swap.status,
            payToken: swap.payToken,
            receiveToken: swap.receiveToken,
            payAmount: swap.requestedPayAmount,
            receiveAmount: swap.receiveAmount,
            minimumReceiveAmount: swap.minimumReceiveAmount,
            queryId: swap.queryId,
            querySequence: swap.querySequence,
            queryNonce: swap.queryNonce,
          });
        }
      }

      if (swap.executionType === 'twap' && swap.twapRunId) {
        const run = twapRuns.get(swap.twapRunId) ?? {
          id: swap.twapRunId,
          payToken: swap.payToken,
          receiveToken: swap.receiveToken,
          totalSlices: 0,
          confirmedSlices: 0,
          pendingSlices: 0,
          failedSlices: 0,
          firstUtime: swap.utime,
          lastUtime: swap.utime,
        };
        if (!run.payToken && swap.payToken) run.payToken = swap.payToken;
        if (!run.receiveToken && swap.receiveToken) run.receiveToken = swap.receiveToken;
        run.totalSlices = Math.max(run.totalSlices, swap.twapTotal ?? 0);
        run.firstUtime = Math.min(run.firstUtime, swap.utime);
        run.lastUtime = Math.max(run.lastUtime, swap.utime);
        if (swap.status === 'success') {
          run.confirmedSlices += 1;
        } else if (swap.status === 'failed') {
          run.failedSlices += 1;
        } else {
          run.pendingSlices += 1;
        }
        twapRuns.set(run.id, run);
      }

      if (swaps.length < limit) {
        swaps.push(swap);
      }
    }

    summary.twap_run_count = twapRuns.size;

    if (this.swapLedgerReader) await enrichSwapReceipts(this.network, address, swaps, entry.txs, this.swapLedgerReader);

    const twapRunSummaries: AccountTwapRunSummary[] = [...twapRuns.values()]
      .sort((left, right) => right.lastUtime - left.lastUtime)
      .slice(0, twapRunCap)
      .map((run) => {
        let runStatus: AccountTwapRunSummary['status'] = 'completed';
        if (run.pendingSlices > 0) {
          runStatus = 'running';
        } else if (run.failedSlices > 0 && run.confirmedSlices === 0) {
          runStatus = 'failed';
        } else if (run.failedSlices > 0 || (run.totalSlices > 0 && run.confirmedSlices < run.totalSlices)) {
          runStatus = 'partial';
        }
        return {
          id: run.id,
          payToken: run.payToken,
          receiveToken: run.receiveToken,
          totalSlices: run.totalSlices > 0 ? run.totalSlices : undefined,
          confirmedSlices: run.confirmedSlices,
          pendingSlices: run.pendingSlices,
          failedSlices: run.failedSlices,
          firstUtime: run.firstUtime,
          lastUtime: run.lastUtime,
          status: runStatus,
        };
      });

    return {
      address,
      total_swaps: totalSwaps,
      returned_swaps: swaps.length,
      history_complete: entry.stats.historyComplete,
      synced_at: syncedAt,
      network: this.network,
      swaps,
      summary,
      twap_runs: twapRunSummaries,
      pending_limits: pendingLimits,
    };
  }

  async getMarketCandles(
    marketKey: string,
    marketAddress: string,
    options: {
      assetSymbol: string;
      quoteSymbol: string;
      assetDecimals?: number;
      quoteDecimals?: number;
      interval?: MarketCandleInterval;
      fromUtime?: number;
      toUtime?: number;
      limit?: number;
    }
  ): Promise<MarketCandlesResponse> {
    marketAddress = normalizeAddress(marketAddress);
    const syncedAt = Math.trunc(Date.now() / 1000);
    const interval = options.interval ?? '1m';
    const intervalSeconds = MARKET_CANDLE_INTERVAL_SECONDS[interval];
    if (!intervalSeconds) {
      throw new Error('unsupported candle interval');
    }
    const fromUtime =
      typeof options.fromUtime === 'number' && Number.isFinite(options.fromUtime)
        ? Math.max(1, Math.trunc(options.fromUtime))
        : null;
    const toUtime =
      typeof options.toUtime === 'number' && Number.isFinite(options.toUtime)
        ? Math.max(1, Math.trunc(options.toUtime))
        : null;
    if (fromUtime !== null && toUtime !== null && fromUtime > toUtime) {
      throw new Error('fromUtime must be less than or equal to toUtime');
    }
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(1_000, Math.trunc(options.limit)))
        : 320;
    const assetSymbol = normalizeTokenSymbol(options.assetSymbol);
    const quoteSymbol = normalizeTokenSymbol(options.quoteSymbol);
    if (!assetSymbol || !quoteSymbol || assetSymbol === quoteSymbol) {
      throw new Error('assetSymbol and quoteSymbol must be distinct non-empty symbols');
    }
    const assetDecimals =
      typeof options.assetDecimals === 'number' && Number.isFinite(options.assetDecimals)
        ? Math.max(0, Math.min(30, Math.trunc(options.assetDecimals)))
        : 9;
    const quoteDecimals =
      typeof options.quoteDecimals === 'number' && Number.isFinite(options.quoteDecimals)
        ? Math.max(0, Math.min(30, Math.trunc(options.quoteDecimals)))
        : 9;

    this.store.touch(marketAddress);
    try {
      await this.ensureInitialTransactions(marketAddress);
    } catch (_error) {
      // Return any already-indexed confirmed history and report it as incomplete.
    }

    const entry = this.store.get(marketAddress);
    if (!entry) {
      return {
        market_key: marketKey,
        market_address: marketAddress,
        interval,
        from_utime: fromUtime,
        to_utime: toUtime,
        candle_count: 0,
        history_complete: false,
        synced_at: syncedAt,
        network: this.network,
        candles: [],
      };
    }

    const trades: Array<{
      utime: number;
      lt: bigint;
      txId: string;
      price: number;
      base: number;
      quote: number;
    }> = [];
    const poolSettlementEvidence = resolveDlmmPoolSettlementEvidence(marketAddress, entry.txs);
    for (const tx of entry.txs) {
      const swap = this.toSwapExecution(tx);
      if (!swap || swap.status !== 'success') continue;
      const receiveAmount =
        swap.receiveAmountSource === 'actual'
          ? swap.receiveAmount
          : poolSettlementEvidence.get(swap.txId)?.amountOutRaw;
      if (receiveAmount === undefined) continue;
      if (fromUtime !== null && swap.utime < fromUtime) continue;
      if (toUtime !== null && swap.utime > toUtime) continue;

      const paySymbolRaw = normalizeTokenSymbol(swap.payToken);
      const receiveSymbolRaw = normalizeTokenSymbol(swap.receiveToken);
      const paySymbol: string | null = paySymbolRaw === 'X' ? assetSymbol : paySymbolRaw;
      const receiveSymbol: string | null = receiveSymbolRaw === 'X' ? assetSymbol : receiveSymbolRaw;

      let baseRaw: string | undefined;
      let quoteRaw: string | undefined;
      if (paySymbol === assetSymbol && receiveSymbol === quoteSymbol) {
        baseRaw = swap.payAmount;
        quoteRaw = receiveAmount;
      } else if (paySymbol === quoteSymbol && receiveSymbol === assetSymbol) {
        baseRaw = receiveAmount;
        quoteRaw = swap.payAmount;
      } else {
        continue;
      }

      const base = rawAmountToNumber(baseRaw, assetDecimals);
      const quote = rawAmountToNumber(quoteRaw, quoteDecimals);
      if (base === null || quote === null) continue;
      const price = quote / base;
      if (!Number.isFinite(price) || price <= 0) continue;
      trades.push({
        utime: swap.utime,
        lt: BigInt(swap.lt),
        txId: swap.txId,
        price,
        base,
        quote,
      });
    }

    trades.sort((left, right) => {
      if (left.utime !== right.utime) return left.utime - right.utime;
      if (left.lt !== right.lt) return left.lt < right.lt ? -1 : 1;
      return left.txId.localeCompare(right.txId);
    });

    const byBucket = new Map<number, MarketCandle>();
    for (const trade of trades) {
      const ts = Math.floor(trade.utime / intervalSeconds) * intervalSeconds;
      const candle = byBucket.get(ts);
      if (!candle) {
        byBucket.set(ts, {
          ts,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volumeBase: trade.base,
          volumeQuote: trade.quote,
          tradeCount: 1,
          sourceTxIds: [trade.txId],
        });
        continue;
      }
      candle.high = Math.max(candle.high, trade.price);
      candle.low = Math.min(candle.low, trade.price);
      candle.close = trade.price;
      candle.volumeBase += trade.base;
      candle.volumeQuote += trade.quote;
      candle.tradeCount += 1;
      if (!candle.sourceTxIds.includes(trade.txId)) {
        candle.sourceTxIds.push(trade.txId);
      }
    }

    const candles = [...byBucket.values()]
      .sort((left, right) => left.ts - right.ts)
      .slice(-limit);
    return {
      market_key: marketKey,
      market_address: marketAddress,
      interval,
      from_utime: fromUtime,
      to_utime: toUtime,
      candle_count: candles.length,
      history_complete: entry.stats.historyComplete,
      synced_at: syncedAt,
      network: this.network,
      candles,
    };
  }

  async refreshAccountState(
    address: string,
    options: { lite?: boolean } = {},
    expectedWorkflowGeneration?: number
  ) {
    address = normalizeAddress(address);
    return this.store.withAddressLock(
      address,
      () => this.refreshAccountStateUnlocked(address, options),
      expectedWorkflowGeneration
    );
  }

  private async getNativeAccountState(address: string): Promise<AccountState> {
    const cached = this.store.get(address)?.balance;
    if (cached) return cached;
    const generation = this.store.getWorkflowGeneration();
    const requestKey = `${generation}:${address}`;
    const existing = this.nativeStateInFlight.get(requestKey);
    if (existing) return existing;

    const pending = (async () => {
      const state = this.source.getAccountStateLite
        ? await this.source.getAccountStateLite(address)
        : await this.source.getAccountState(address);
      const balance: AccountState = { ...state, address, updatedAt: Date.now() };
      // History may hold the address lock while fetching remote pages. Read-only
      // balance responses need not wait for it; publish later without replacing
      // state that another workflow has already observed or restored. Keep the
      // resolved read shared until publication so follow-up requests also reuse it.
      void this.store.withAddressLock(address, () => {
        if (!this.store.get(address)?.balance) this.storeAccountState(address, balance);
      }, generation).finally(() => {
        if (this.nativeStateInFlight.get(requestKey) === pending) {
          this.nativeStateInFlight.delete(requestKey);
        }
      }).catch(() => undefined);
      return this.store.get(address)?.balance ?? balance;
    })().catch((error) => {
      if (this.nativeStateInFlight.get(requestKey) === pending) {
        this.nativeStateInFlight.delete(requestKey);
      }
      throw error;
    });
    this.nativeStateInFlight.set(requestKey, pending);
    return pending;
  }

  /** Caller must already hold MemoryStore's lock for this normalized address. */
  async refreshAccountStateWithinAddressLock(
    address: string,
    options: { lite?: boolean } = {}
  ) {
    address = normalizeAddress(address);
    return this.refreshAccountStateUnlocked(address, options);
  }

  private async refreshAccountStateUnlocked(address: string, options: { lite?: boolean } = {}) {
    const previous = this.store.get(address)?.balance;
    const state =
      options.lite && this.source.getAccountStateLite
        ? await this.source.getAccountStateLite(address)
        : await this.source.getAccountState(address);
    const accountState: AccountState = {
      address,
      balance: state.balance,
      lastTxLt: state.lastTxLt,
      lastTxHash: state.lastTxHash,
      accountState: state.accountState ?? null,
      codeBoc: state.codeBoc ?? previous?.codeBoc ?? null,
      dataBoc: state.dataBoc ?? previous?.dataBoc ?? null,
      updatedAt: Date.now(),
    };
    this.storeAccountState(address, accountState);
  }

  /** Caller must hold MemoryStore's lock for this normalized address. */
  private storeAccountState(address: string, accountState: AccountState) {
    const previousSignature = balanceStateSignature(this.store.get(address)?.balance);
    this.store.setBalance(address, accountState);
    const retainedHead = this.store.get(address)?.txs[0];
    const hasHeadLt = typeof accountState.lastTxLt === 'string' && accountState.lastTxLt.length > 0;
    const hasHeadHash = typeof accountState.lastTxHash === 'string' && accountState.lastTxHash.length > 0;
    const retainedHeadMatches =
      hasHeadLt &&
      hasHeadHash &&
      retainedHead?.lt === accountState.lastTxLt &&
      retainedHead?.hash === accountState.lastTxHash;
    if (
      hasHeadLt !== hasHeadHash ||
      (hasHeadLt && hasHeadHash && !retainedHeadMatches) ||
      (!hasHeadLt && !hasHeadHash && retainedHead)
    ) {
      this.store.markHistoryIncomplete(address);
    }
    const nextSignature = balanceStateSignature(accountState);
    if (nextSignature !== previousSignature) {
      this.emitBalanceChanged(address);
    }
  }

  async ensureInitialTransactions(address: string) {
    address = normalizeAddress(address);
    return this.store.withAddressLock(address, () =>
      this.ensureInitialTransactionsUnlocked(address)
    );
  }

  private async ensureInitialTransactionsUnlocked(address: string) {
    const entry = this.store.get(address);
    let replaceRetainedHistory = false;
    const maxPages = Math.min(
      this.config.backfillMaxPagesPerAddress,
      this.config.maxPagesPerAddress
    );
    const maxTransactions = this.config.pageSize * maxPages;
    if (entry && entry.txs.length > 0) {
      const newest = entry.txs[0];
      const oldest = entry.txs[entry.txs.length - 1];
      const retainedSegmentIsLinked = Boolean(
        newest &&
        oldest &&
        transactionPageIsLinkedInclusiveSegment(entry.txs, newest, oldest)
      );
      const retainedCompleteHistoryIsValid = Boolean(
        retainedSegmentIsLinked &&
        newest &&
        entry.balance?.lastTxLt === newest.lt &&
        entry.balance?.lastTxHash === newest.hash &&
        transactionPageReachesHistoryStart(entry.txs, newest)
      );
      const hasBalanceHeadLt = Boolean(entry.balance?.lastTxLt);
      const hasBalanceHeadHash = Boolean(entry.balance?.lastTxHash);
      const retainedHistoryContradictsBalance = Boolean(
        entry.balance &&
        (
          hasBalanceHeadLt !== hasBalanceHeadHash ||
          (!hasBalanceHeadLt && !hasBalanceHeadHash) ||
          (hasBalanceHeadLt &&
            hasBalanceHeadHash &&
            (entry.balance.lastTxLt !== newest?.lt || entry.balance.lastTxHash !== newest?.hash))
        )
      );
      if (entry.stats.historyComplete && !retainedCompleteHistoryIsValid) {
        this.store.markHistoryIncomplete(address);
      }
      if (!retainedSegmentIsLinked || retainedHistoryContradictsBalance) {
        // Legacy or malformed snapshots cannot be extended safely because the
        // retained transactions no longer prove one predecessor chain or its
        // head is contradicted by the last observed account state. Keep the
        // old incomplete suffix available until a replacement source page has
        // been fetched, linked, and anchored to a fresh account head.
        replaceRetainedHistory = true;
        this.store.markHistoryIncomplete(address);
        this.store.setLastBackfillLt(address, undefined);
      } else {
        if (
          !entry.stats.historyComplete &&
          entry.stats.txCount < maxTransactions &&
          this.enqueueBackfill
        ) {
          this.enqueueBackfill(address);
        }
        return;
      }
    }

    const limit = Math.min(
      this.config.pageSize * this.config.backfillPageBatch,
      maxTransactions
    );
    const receivedRaw = await this.withInitialHistoryTimeout(
      this.source.getTransactions(address, limit),
      this.config.initialHistoryTimeoutMs
    );
    const initialResponseTruncated = receivedRaw.length > limit;
    const raw = receivedRaw.slice(0, limit);
    if (raw.length === 0) {
      await this.refreshAccountStateUnlocked(address, { lite: true });
      const balance = this.store.get(address)?.balance;
      const hasHeadLt = typeof balance?.lastTxLt === 'string' && balance.lastTxLt.length > 0;
      const hasHeadHash = typeof balance?.lastTxHash === 'string' && balance.lastTxHash.length > 0;
      this.store.setLastBackfillLt(address, undefined);
      if (!hasHeadLt && !hasHeadHash) {
        if (replaceRetainedHistory) this.store.replaceTransactions(address, []);
        this.store.markHistoryComplete(address);
        return;
      }
      this.store.markHistoryIncomplete(address);
      if (this.enqueueBackfill) this.enqueueBackfill(address);
      return;
    }

    this.store.markHistoryIncomplete(address);
    const firstRaw = raw[0];
    const lastRaw = raw[raw.length - 1];
    if (
      !firstRaw ||
      !lastRaw ||
      !transactionPageIsLinkedInclusiveSegment(
        raw,
        { lt: firstRaw.lt, hash: firstRaw.hash },
        { lt: lastRaw.lt, hash: lastRaw.hash }
      )
    ) {
      this.store.setLastBackfillLt(address, undefined);
      await this.refreshAccountStateUnlocked(address, { lite: true });
      const current = this.store.get(address)?.balance;
      if (current?.lastTxLt && current.lastTxHash && this.enqueueBackfill) {
        this.enqueueBackfill(address);
      }
      return;
    }
    await this.refreshAccountStateUnlocked(address, { lite: true });
    const observedHead = this.store.get(address)?.balance;
    if (
      observedHead?.lastTxLt !== firstRaw.lt ||
      observedHead?.lastTxHash !== firstRaw.hash
    ) {
      this.store.setLastBackfillLt(address, undefined);
      this.store.markHistoryIncomplete(address);
      if (observedHead?.lastTxLt && observedHead.lastTxHash && this.enqueueBackfill) {
        this.enqueueBackfill(address);
      }
      return;
    }
    const reachesHistoryStart = transactionPageReachesHistoryStart(raw);

    this.poolTracker?.observeTransactions(raw);
    const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
    if (replaceRetainedHistory) {
      this.store.replaceTransactions(address, indexed);
    } else {
      this.store.addTransactions(address, indexed);
    }

    const updated = this.store.get(address);
    if (!updated) return;
    const oldest = updated.txs[updated.txs.length - 1];
    this.store.setLastBackfillLt(address, oldest?.lt);
    if (
      !initialResponseTruncated &&
      reachesHistoryStart &&
      retainedExactInitialTransactionPage(raw, updated.txs)
    ) {
      const confirmed = this.store.get(address);
      const newest = confirmed?.txs[0];
      if (
        confirmed &&
        newest &&
        confirmed.balance?.lastTxLt === newest.lt &&
        confirmed.balance?.lastTxHash === newest.hash &&
        transactionPageReachesHistoryStart(confirmed.txs, {
          lt: newest.lt,
          hash: newest.hash
        }) &&
        retainedExactInitialTransactionPage(raw, confirmed.txs)
      ) {
        this.store.markHistoryComplete(address);
        return;
      }
    }
    // Lite servers may return a proof-size-capped short page even when older
    // transactions exist. Without an intact predecessor chain through the
    // canonical history-start marker, the page remains incomplete.
    this.store.markHistoryIncomplete(address);
    if (updated.stats.txCount < maxTransactions && this.enqueueBackfill) {
      this.enqueueBackfill(address);
    }
  }

  async updateWithNewTransactions(address: string, rawTxs: IndexedTx[]) {
    address = normalizeAddress(address);
    if (rawTxs.length === 0) return;
    await this.store.withAddressLock(address, () => {
      this.store.addTransactions(address, rawTxs);
    });
  }

  classify(address: string, raw: any[]): IndexedTx[] {
    address = normalizeAddress(address);
    return raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
  }

  private toSwapExecution(tx: IndexedTx): AccountSwapExecution | null {
    const detail = tx.ui.detail.kind === 'swap' ? tx.ui.detail : null;
    const swapAction = tx.actions.find((action): action is Extract<TxAction, { kind: 'swap' }> => action.kind === 'swap');
    if (!detail && !swapAction) return null;

    const actionPayToken =
      swapAction?.tokenIn?.kind === 'jetton'
        ? swapAction.tokenIn.symbol
        : swapAction?.tokenIn?.kind === 'ton'
          ? 'GRAM'
          : undefined;
    const actionReceiveToken =
      swapAction?.tokenOut?.kind === 'jetton'
        ? swapAction.tokenOut.symbol
        : swapAction?.tokenOut?.kind === 'ton'
          ? 'GRAM'
          : undefined;
    const executionType = detail?.executionType ?? swapAction?.executionType ?? 'unknown';
    const querySequence = detail?.querySequence ?? swapAction?.querySequence;
    const queryNonce = detail?.queryNonce ?? swapAction?.queryNonce;
    const twapRunId = executionType === 'twap' && querySequence !== undefined ? `seq:${querySequence}` : undefined;

    const actualReceiveAmount = tx.ui.status === 'success' ? swapAction?.amountOut : undefined;

    return {
      txId: tx.ui.txId,
      lt: tx.lt,
      hash: tx.hash,
      utime: tx.ui.utime,
      status: tx.ui.status,
      reason: tx.ui.reason,
      payToken: detail?.payToken ?? actionPayToken,
      receiveToken: detail?.receiveToken ?? actionReceiveToken,
      payAmount: detail?.payAmount ?? swapAction?.amountIn,
      receiveAmount: actualReceiveAmount,
      receiveAmountSource: actualReceiveAmount !== undefined ? 'actual' : undefined,
      minimumReceiveAmount: swapAction?.minOut,
      queryId: detail?.queryId ?? swapAction?.queryId,
      executionType,
      twapSlice: detail?.twapSlice ?? swapAction?.twapSlice,
      twapTotal: detail?.twapTotal ?? swapAction?.twapTotal,
      querySequence,
      queryNonce,
      twapRunId,
    };
  }

  private matchesSwapPairFilter(
    swap: AccountSwapExecution,
    payToken: string | null,
    receiveToken: string | null,
    includeReverse: boolean
  ) {
    if (!payToken && !receiveToken) return true;

    const swapPayToken = normalizeTokenSymbol(swap.payToken);
    const swapReceiveToken = normalizeTokenSymbol(swap.receiveToken);

    const directPayMatch = !payToken || swapPayToken === payToken;
    const directReceiveMatch = !receiveToken || swapReceiveToken === receiveToken;
    if (directPayMatch && directReceiveMatch) return true;

    if (!includeReverse || !payToken || !receiveToken) return false;
    return swapPayToken === receiveToken && swapReceiveToken === payToken;
  }

  private toApiTx(tx: IndexedTx): UiTx & {
    kind: string;
    actions: any[];
    lt: string;
    hash: string;
    totalFeesRaw?: string;
    inMessage?: IndexedTx['inMessage'];
    outMessages?: IndexedTx['outMessages'];
  } {
    return {
      ...tx.ui,
      kind: tx.kind,
      actions: tx.actions,
      lt: tx.lt,
      hash: tx.hash,
      totalFeesRaw: tx.totalFeesRaw,
      inMessage: tx.inMessage,
      outMessages: tx.outMessages,
    };
  }
}
