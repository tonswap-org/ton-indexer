import { Address, Cell, TupleItem, beginCell } from '@ton/core';
import { EventEmitter } from 'node:events';
import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import { TonDataSource } from './data/dataSource';
import { OpcodeSets } from './utils/opcodes';
import { AccountBalance, AccountBalances, AccountState, HealthStatus, IndexedTx, Network, UiTx } from './models';
import { classifyTransaction } from './utils/txClassifier';
import { JettonMetadata } from './models';
import { MetricsCollector } from './metricsCollector';
import { PoolTracker } from './poolTracker';
import { LRUCache } from 'lru-cache';

type ToncenterStackEntry = [string, unknown];
type ToncenterRunResult = {
  stack: ToncenterStackEntry[];
  exit_code: number;
  gas_used: number;
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

const normalizeAddress = (value: string) => {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return value.trim().toLowerCase();
  }
};

const balanceStateSignature = (state?: AccountState) => {
  if (!state) return '';
  return [state.balance ?? '', state.lastTxLt ?? '', state.lastTxHash ?? ''].join(':');
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

const toBocBase64 = (cell: any): string | null => {
  if (!cell) return null;
  try {
    return Buffer.from(cell.toBoc()).toString('base64');
  } catch {
    return null;
  }
};

const tupleItemToToncenterStackEntry = (item: TupleItem): ToncenterStackEntry => {
  if (item.type === 'null') return ['null', null];
  if (item.type === 'int') return ['num', item.value.toString(10)];
  if (item.type === 'nan') return ['nan', null];
  if (item.type === 'cell') {
    const b64 = toBocBase64(item.cell);
    return ['tvm.Cell', b64];
  }
  if (item.type === 'slice') {
    const b64 = toBocBase64(item.cell);
    return ['tvm.Slice', b64];
  }
  if (item.type === 'builder') {
    const b64 = toBocBase64(item.cell);
    return ['tvm.Builder', b64];
  }
  if (item.type === 'tuple') {
    return ['tuple', item.items.map(tupleItemToToncenterStackEntry)];
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
const FARM_SNAPSHOT_CACHE_TTL_MS = 30_000;
const FARM_MAX_SCAN_DEFAULT = 20;
const FARM_MAX_SCAN_LIMIT = 64;
const FARM_MAX_CONSECUTIVE_MISSES_DEFAULT = 2;
const FARM_MAX_CONSECUTIVE_MISSES_LIMIT = 8;
const FARM_SCAN_BATCH_SIZE = 5;
const COVER_SNAPSHOT_CACHE_TTL_MS = 30_000;
const COVER_MAX_SCAN_DEFAULT = 20;
const COVER_MAX_SCAN_LIMIT = 64;
const COVER_MAX_CONSECUTIVE_MISSES_DEFAULT = 2;
const COVER_MAX_CONSECUTIVE_MISSES_LIMIT = 8;
const COVER_SCAN_BATCH_SIZE = 5;

const GET_METHOD_CACHE_TTL_MS = 1_000;
const GET_METHOD_CACHE_NO_ARGS_MIN_TTL_MS = 30_000;
const GET_METHOD_CACHE_ENTRY_MIN_TTL_MS = 60_000;

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
  proposals: GovernanceProposalSnapshot[];
  source: 'lite' | 'http4';
  network: Network;
  updated_at: number;
};

type FarmFactoryStatusSnapshot = {
  governance: string | null;
  enabled: boolean;
};

type FarmSnapshotRecord = {
  id: string;
  farm: string | null;
  staker: string | null;
  sponsor: string | null;
  rewardRoot: string | null;
  rewardWallet: string | null;
  rewardAmount: string | null;
  duration: string | null;
  sponsorFeeBps: string | null;
  startTime: string | null;
  endTime: string | null;
  gasBudget: string | null;
  status: string | null;
  createdAt: string | null;
  backlogLimit: string | null;
  resumeBacklog: string | null;
};

type FarmSnapshotResponse = {
  factory: string;
  status: FarmFactoryStatusSnapshot | null;
  next_id: string | null;
  farm_count: number;
  scanned: number;
  farms: FarmSnapshotRecord[];
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
  admin: string | null;
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
  windowSeconds: string | null;
  requiredObservations: string | null;
  breachStart: string | null;
  breachSeconds: string | null;
  lastObservation: string | null;
  lastHealthyObservation: string | null;
  breachObservations: string | null;
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
    farms?: boolean;
    cover?: boolean;
  };
  options?: {
    governance?: { maxScan?: number; maxMisses?: number };
    farms?: { maxScan?: number; maxMisses?: number };
    cover?: { maxScan?: number; maxMisses?: number };
  };
  contracts: {
    activationGate?: string | null;
    dlmmRegistry?: string | null;
    t3Hub?: string | null;
    controlMesh?: string | null;
    riskVault?: string | null;
    feeRouter?: string | null;
    buybackExecutor?: string | null;
    automationRegistry?: string | null;
    anchorGuard?: string | null;
    clusterGuard?: string | null;
    voting?: string | null;
    farmFactory?: string | null;
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
  balance: string | null;
  lastSequence: string | null;
  lastTimestamp: string | null;
  allocationPeg: string | null;
  allocationLiquidations: string | null;
  allocationBuyback: string | null;
  allocationGas: string | null;
  allocationEmissions: string | null;
  allocationReferrals: string | null;
  referralDemand: string | null;
  referralPriority: string | null;
  referralFloor: string | null;
  referralWeightDirectBps: string | null;
  referralFlags: string | null;
  referralThrottleMask: string | null;
};

type FeeRouterTargetsSnapshot = {
  t3Peg: string | null;
  t3Liquidations: string | null;
  peg: string | null;
  liquidations: string | null;
  buyback: string | null;
  gas: string | null;
  emissions: string | null;
  referrals: string | null;
  referralRegistry: string | null;
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

type ClusterGuardConfigSnapshot = {
  reporter: string | null;
  registry: string | null;
  vestingSeconds: string | null;
  warnThreshold: string | null;
  slashThreshold: string | null;
};

type SystemHealthSnapshot = {
  controlState: ControlStateSnapshot | null;
  riskState: RiskStateSnapshot | null;
  feeRouterState: FeeRouterStateSnapshot | null;
  feeRouterTargets: FeeRouterTargetsSnapshot | null;
  buybackConfig: BuybackConfigSnapshot | null;
  anchorGuardConfig: AnchorConfigSnapshot | null;
  anchorGuardState: AnchorStateSnapshot | null;
  anchorGuardEnabled: boolean | null;
  anchorGuardGovernance: string | null;
  clusterGuardConfig: ClusterGuardConfigSnapshot | null;
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
    farms?: DefiSnapshotSection<FarmSnapshotResponse>;
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
  private config: Config;
  private store: MemoryStore;
  private source: TonDataSource;
  private opcodes: OpcodeSets;
  private network: Network;
  private lastMasterSeqno?: number;
  private lastMasterTimestamp?: number;
  private enqueueBackfill?: (address: string) => void;
  private jettonRoots: Array<{ master: string; symbol?: string }>;
  private jettonMetaCache = new Map<string, { meta: JettonMetadata | null; updatedAt: number }>();
  private metrics?: MetricsCollector;
  private poolTracker?: PoolTracker;
  private balanceCache: LRUCache<string, { value: AccountBalance; signature: string }>;
  private txCache: LRUCache<string, { value: any; signature: string }>;
  private stateCache: LRUCache<string, { value: any; signature: string }>;
  private governanceSnapshotCache: LRUCache<string, GovernanceSnapshotResponse>;
  private governanceSnapshotInFlight = new Map<string, Promise<GovernanceSnapshotResponse>>();
  private farmSnapshotCache: LRUCache<string, FarmSnapshotResponse>;
  private farmSnapshotInFlight = new Map<string, Promise<FarmSnapshotResponse>>();
  private coverSnapshotCache: LRUCache<string, CoverSnapshotResponse>;
  private coverSnapshotInFlight = new Map<string, Promise<CoverSnapshotResponse>>();
  private defiSnapshotCache: LRUCache<string, DefiSnapshotResponse>;
  private defiSnapshotInFlight = new Map<string, Promise<DefiSnapshotResponse>>();
  private dlmmPoolsSnapshotCache: LRUCache<string, DlmmPoolsSnapshotResponse>;
  private dlmmPoolsSnapshotInFlight = new Map<string, Promise<DlmmPoolsSnapshotResponse>>();
  private getMethodSourceCache: LRUCache<string, { exitCode: number; stack: TupleItem[] }>;
  private getMethodSourceInFlight = new Map<string, Promise<{ exitCode: number; stack: TupleItem[] } | null>>();
  private getMethodCache: LRUCache<string, ToncenterRunResult>;
  private getMethodInFlight = new Map<string, Promise<ToncenterRunResult>>();
  private healthCache?: { value: HealthStatus; expiresAt: number };
  private balanceEventEmitter = new EventEmitter();
  private balanceEventSeq = 0;

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
    this.jettonRoots = jettonRoots;
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
    this.farmSnapshotCache = new LRUCache({
      max: 512,
      ttl: FARM_SNAPSHOT_CACHE_TTL_MS,
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

    this.getMethodSourceCache = new LRUCache({
      max: 5_000,
      ttl: Math.max(0, Math.trunc(config.stateCacheTtlMs ?? GET_METHOD_CACHE_TTL_MS)),
      allowStale: false,
    });

    this.getMethodCache = new LRUCache({
      max: 5_000,
      ttl: Math.max(0, Math.trunc(config.stateCacheTtlMs ?? GET_METHOD_CACHE_TTL_MS)),
      allowStale: false,
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
    this.store.touch(address);
    const entry = this.store.get(address);
    const cached = Boolean(entry?.balance);
    this.metrics?.recordBalanceCache(cached);

    if (this.config.responseCacheEnabled && entry?.balance) {
      const signature = this.getAccountSignature(entry);
      if (signature) {
        const cachedValue = this.getCached(this.balanceCache, address, signature);
        if (cachedValue) return cachedValue;
      }
    }

    const refreshStatePromise = cached ? Promise.resolve() : this.refreshAccountState(address);
    const jettonPromise = Promise.all(
      this.jettonRoots.map(async (root) => {
        const balance = await this.source.getJettonBalance(address, root.master);
        if (!balance) return null;
        try {
          if (BigInt(balance.balance) === 0n) return null;
        } catch {
          // Keep malformed balances visible so issues can be diagnosed upstream.
        }
        const meta = await this.getJettonMetadata(root.master);
        return {
          master: root.master,
          wallet: balance.wallet,
          balance: balance.balance,
          symbol: meta?.symbol ?? root.symbol,
          decimals: meta?.decimals ?? this.fallbackJettonDecimals(meta?.symbol ?? root.symbol),
        };
      })
    );
    const [jettons] = await Promise.all([jettonPromise, refreshStatePromise]);
    const updated = this.store.get(address)?.balance;
    const now = Math.floor(Date.now() / 1000);

    const response = {
      ton: {
        balance: updated?.balance ?? '0',
        last_tx_lt: updated?.lastTxLt,
        last_tx_hash: updated?.lastTxHash,
      },
      jettons: jettons.filter(Boolean) as AccountBalance['jettons'],
      confirmed: true,
      updated_at: now,
      network: this.network,
    };
    const signature = this.getAccountSignature(this.store.get(address));
    this.setCached(this.balanceCache, address, response, signature, this.config.balanceCacheTtlMs);
    return response;
  }

  async getBalances(address: string): Promise<AccountBalances> {
    const snapshot = await this.getBalance(address);
    const tonRaw = snapshot.ton.balance ?? '0';
    const ton = this.formatRawAmount(tonRaw, 9);
    const assets = [
      {
        kind: 'native' as const,
        symbol: 'TON',
        address,
        wallet: address,
        balance_raw: tonRaw,
        balance: ton,
        decimals: 9,
      },
      ...snapshot.jettons.map((jetton) => {
        const decimals = typeof jetton.decimals === 'number' && Number.isFinite(jetton.decimals)
          ? Math.max(0, Math.trunc(jetton.decimals))
          : this.fallbackJettonDecimals(jetton.symbol) ?? 9;
        return {
          kind: 'jetton' as const,
          symbol: jetton.symbol,
          address: jetton.master,
          wallet: jetton.wallet,
          balance_raw: jetton.balance,
          balance: this.formatRawAmount(jetton.balance, decimals),
          decimals,
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
        return `${kind}:${key}:${asset.balance_raw ?? ''}`;
      })
      .sort()
      .join('|');
    return `${snapshot.ton_raw ?? ''}:${assetsSignature}`;
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

  private async getJettonMetadata(master: string): Promise<JettonMetadata | null> {
    const cached = this.jettonMetaCache.get(master);
    const now = Date.now();
    if (cached && now - cached.updatedAt < this.config.jettonMetadataTtlMs) {
      return cached.meta;
    }

    const meta = await this.source.getJettonMetadata(master);
    this.jettonMetaCache.set(master, { meta, updatedAt: now });
    return meta;
  }

  private fallbackJettonDecimals(symbol?: string | null): number | null {
    const normalized = (symbol ?? '').trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'USDT' || normalized === 'USDC' || normalized === 'KUSD') return 6;
    if (normalized === 'T3' || normalized === 'TS') return 9;
    return null;
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
      network: this.network,
    };
    this.setCached(this.stateCache, address, response, signature, this.config.stateCacheTtlMs);
    return response;
  }

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<ToncenterRunResult> {
    const normalized = normalizeAddress(address);
    const { cacheKey, cacheTtlMs } = this.getMethodCacheKey(normalized, method, args);

    if (this.config.responseCacheEnabled) {
      const cached = this.getMethodCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.getMethodInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = (async () => {
      const result = await this.runGetMethodSourceCached(normalized, method, args);
      if (!result) {
        throw new Error('get method call unavailable from configured data source');
      }
      return {
        stack: result.stack.map(tupleItemToToncenterStackEntry),
        exit_code: result.exitCode,
        gas_used: 0
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.getMethodInFlight.set(cacheKey, request);
    }

    try {
      const response = await request;
      if (this.config.responseCacheEnabled) {
        if (cacheTtlMs > 0) {
          this.getMethodCache.set(cacheKey, response, { ttl: cacheTtlMs });
        }
      }
      return response;
    } finally {
      this.getMethodInFlight.delete(cacheKey);
    }
  }

  private getMethodCacheKey(normalizedAddress: string, method: string, args: TupleItem[]) {
    const argsSignature = args
      .map((arg) => {
        if (arg.type === 'null') return 'null';
        if (arg.type === 'int') return `int:${arg.value.toString(10)}`;
        if (arg.type === 'nan') return 'nan';
        if (arg.type === 'cell') return `cell:${toBocBase64(arg.cell) ?? ''}`;
        if (arg.type === 'slice') return `slice:${toBocBase64(arg.cell) ?? ''}`;
        if (arg.type === 'builder') return `builder:${toBocBase64(arg.cell) ?? ''}`;
        if (arg.type === 'tuple') return `tuple:[${arg.items.map((item) => item.type).join(',')}]`;
        return 'unknown';
      })
      .join('|');
    const cacheKey = [normalizedAddress, method, argsSignature].join('|');
    const baseCacheTtlMs = Math.max(0, Math.trunc(this.config.stateCacheTtlMs ?? GET_METHOD_CACHE_TTL_MS));
    let cacheTtlMs = baseCacheTtlMs;
    if (method === 'get_entry') {
      cacheTtlMs = Math.max(baseCacheTtlMs, GET_METHOD_CACHE_ENTRY_MIN_TTL_MS);
    } else if (args.length === 0) {
      cacheTtlMs = Math.max(baseCacheTtlMs, GET_METHOD_CACHE_NO_ARGS_MIN_TTL_MS);
    }
    return { cacheKey, cacheTtlMs };
  }

  private async runGetMethodSourceCached(
    normalizedAddress: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    const { cacheKey, cacheTtlMs } = this.getMethodCacheKey(normalizedAddress, method, args);

    if (this.config.responseCacheEnabled) {
      const cached = this.getMethodSourceCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.getMethodSourceInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = this.source.runGetMethod(normalizedAddress, method, args).catch(() => null);
    if (this.config.responseCacheEnabled) {
      this.getMethodSourceInFlight.set(cacheKey, request);
    }

    try {
      const response = await request;
      if (this.config.responseCacheEnabled && response && cacheTtlMs > 0) {
        this.getMethodSourceCache.set(cacheKey, response, { ttl: cacheTtlMs });
      }
      return response;
    } finally {
      this.getMethodSourceInFlight.delete(cacheKey);
    }
  }

  async getPerpsSnapshot(
    engineAddress: string,
    options: { marketIds?: number[]; maxMarkets?: number } = {}
  ) {
    const normalizedEngine = normalizeAddress(engineAddress);
    const maxMarkets = Math.max(1, Math.min(128, Math.trunc(options.maxMarkets ?? 64)));
    const requestedMarketIds = Array.from(
      new Set(
        (options.marketIds ?? [])
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.trunc(value))
      )
    ).slice(0, maxMarkets);

    const [governanceRes, enabledRes, automationRes] = await Promise.all([
      this.runGetMethodSourceCached(normalizedEngine, 'engine_governance', []),
      this.runGetMethodSourceCached(normalizedEngine, 'engine_enabled', []),
      this.runGetMethodSourceCached(normalizedEngine, 'automation_state', [])
    ]);

    if (!governanceRes && !enabledRes && !automationRes) {
      throw new Error('Perps snapshot is unavailable from the configured data source.');
    }

    const status =
      governanceRes?.exitCode === 0 && enabledRes?.exitCode === 0
        ? {
            governance: tupleItemAddress(governanceRes.stack[0]),
            enabled: tupleItemBool(enabledRes.stack[0])
          }
        : null;

    const automation =
      automationRes?.exitCode === 0
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
            controlTimestamp: tupleItemBigIntString(automationRes.stack[13])
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
            return [1, 2, 3];
          })();

    const markets: Record<string, any> = {};
    const marketIds: number[] = [];

    for (const marketId of derivedMarketIds.slice(0, maxMarkets)) {
      const marketRes = await this.runGetMethodSourceCached(normalizedEngine, 'market_state', [
        { type: 'int', value: BigInt(marketId) }
      ]);
      if (!marketRes || marketRes.exitCode !== 0) continue;
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
        marketKind: tupleItemBigIntString(stack[37]),
        timerVolatilityBps: tupleItemBigIntString(stack[38]),
        timerEmaVolatilityBps: tupleItemBigIntString(stack[39]),
        timerLastUpdateTs: tupleItemBigIntString(stack[40]),
        timerWeightBps: tupleItemBigIntString(stack[41]),
        correlationBps: tupleItemBigIntString(stack[42]),
        correlationDispersionBps: tupleItemBigIntString(stack[43]),
        correlationLastUpdateTs: tupleItemBigIntString(stack[44]),
        correlationWeightBps: tupleItemBigIntString(stack[45]),
        lastFundingPayloadHash: tupleItemBigIntString(stack[46]),
        lastFundingPoolHash: tupleItemBigIntString(stack[47])
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

  async getGovernanceSnapshot(
    votingAddress: string,
    options: { owner?: string | null; maxScan?: number; maxConsecutiveMisses?: number } = {}
  ): Promise<GovernanceSnapshotResponse> {
    const normalizedVoting = normalizeAddress(votingAddress);
    const normalizedOwner = options.owner ? normalizeAddress(options.owner) : null;
    const maxScan = Math.max(
      1,
      Math.min(GOVERNANCE_MAX_SCAN_LIMIT, Math.trunc(options.maxScan ?? GOVERNANCE_MAX_SCAN_DEFAULT))
    );
    const maxConsecutiveMisses = Math.max(
      1,
      Math.min(
        GOVERNANCE_MAX_CONSECUTIVE_MISSES_LIMIT,
        Math.trunc(options.maxConsecutiveMisses ?? GOVERNANCE_MAX_CONSECUTIVE_MISSES_DEFAULT)
      )
    );
    const cacheKey = [normalizedVoting, normalizedOwner ?? '', maxScan, maxConsecutiveMisses].join('|');

    if (this.config.responseCacheEnabled) {
      const cached = this.governanceSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.governanceSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = (async () => {
      let lockResponded = false;
      const lockPromise = (async (): Promise<GovernanceLockSnapshot | null> => {
        if (!normalizedOwner) return null;
        const owner = Address.parse(normalizedOwner);
        const ownerCell = beginCell().storeAddress(owner).endCell();
        const lockRes = await this.runGetMethodSourceCached(normalizedVoting, 'governance_lock', [
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
      let misses = 0;
      let proposalResponded = false;

      outer: for (let startId = 1; startId <= maxScan; startId += GOVERNANCE_SCAN_BATCH_SIZE) {
        const endId = Math.min(maxScan, startId + GOVERNANCE_SCAN_BATCH_SIZE - 1);
        const batchIds = Array.from({ length: endId - startId + 1 }, (_, index) => startId + index);
        const batch = await Promise.all(
          batchIds.map((proposalId) =>
            this.runGetMethodSourceCached(normalizedVoting, 'governance_proposal', [
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
            misses += 1;
            if (misses >= maxConsecutiveMisses) {
              break outer;
            }
            continue;
          }
          const stack = res.stack;
          const id = tupleItemBigIntString(stack[0]);
          if (!id) {
            misses += 1;
            if (misses >= maxConsecutiveMisses) {
              break outer;
            }
            continue;
          }
          misses = 0;
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
      if (!proposalResponded && !lockResponded) {
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

  async getFarmSnapshot(
    factoryAddress: string,
    options: { maxScan?: number; maxConsecutiveMisses?: number } = {}
  ): Promise<FarmSnapshotResponse> {
    const normalizedFactory = normalizeAddress(factoryAddress);
    const maxScan = Math.max(1, Math.min(FARM_MAX_SCAN_LIMIT, Math.trunc(options.maxScan ?? FARM_MAX_SCAN_DEFAULT)));
    const maxConsecutiveMisses = Math.max(
      1,
      Math.min(
        FARM_MAX_CONSECUTIVE_MISSES_LIMIT,
        Math.trunc(options.maxConsecutiveMisses ?? FARM_MAX_CONSECUTIVE_MISSES_DEFAULT)
      )
    );
    const cacheKey = [normalizedFactory, maxScan, maxConsecutiveMisses].join('|');

    if (this.config.responseCacheEnabled) {
      const cached = this.farmSnapshotCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.farmSnapshotInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const request = (async () => {
      const [governanceRes, enabledRes, nextIdRes] = await Promise.all([
        this.runGetMethodSourceCached(normalizedFactory, 'governance', []).catch(() => null),
        this.runGetMethodSourceCached(normalizedFactory, 'registry_enabled', []).catch(() => null),
        this.runGetMethodSourceCached(normalizedFactory, 'next_farm_id', []).catch(() => null)
      ]);

      const status =
        governanceRes?.exitCode === 0 && enabledRes?.exitCode === 0
          ? {
              governance: tupleItemAddress(governanceRes.stack[0]),
              enabled: tupleItemBool(enabledRes.stack[0])
            }
          : null;

      const nextId = nextIdRes?.exitCode === 0 ? tupleItemBigInt(nextIdRes.stack[0]) : null;
      const nextIdString = nextId !== null ? nextId.toString(10) : null;
      const maxKnownFromNextId = nextId && nextId > 1n ? Number(nextId - 1n) : 0;
      const scanLimit =
        nextId !== null
          ? Number.isFinite(maxKnownFromNextId) && maxKnownFromNextId > 0
            ? Math.min(maxScan, Math.trunc(maxKnownFromNextId))
            : 0
          : maxScan;

      const farms: FarmSnapshotRecord[] = [];
      let scanned = 0;
      let misses = 0;
      let farmResponded = false;

      if (scanLimit > 0) {
        outer: for (let startId = 1; startId <= scanLimit; startId += FARM_SCAN_BATCH_SIZE) {
          const endId = Math.min(scanLimit, startId + FARM_SCAN_BATCH_SIZE - 1);
          const batchIds = Array.from({ length: endId - startId + 1 }, (_, index) => startId + index);
          const batch = await Promise.all(
            batchIds.map((farmId) =>
              this.runGetMethodSourceCached(normalizedFactory, 'get_farm', [{ type: 'int', value: BigInt(farmId) }]).catch(
                () => null
              )
            )
          );

          for (let index = 0; index < batch.length; index += 1) {
            scanned += 1;
            const res = batch[index];
            if (res) farmResponded = true;
            if (!res || res.exitCode !== 0) {
              misses += 1;
              if (misses >= maxConsecutiveMisses) break outer;
              continue;
            }
            const stack = res.stack;
            const farm = tupleItemAddress(stack[0]);
            if (!farm) {
              misses += 1;
              if (misses >= maxConsecutiveMisses) break outer;
              continue;
            }
            misses = 0;
            const id = batchIds[index];
            farms.push({
              id: String(id),
              farm,
              staker: tupleItemAddress(stack[1]),
              sponsor: tupleItemAddress(stack[2]),
              rewardRoot: tupleItemAddress(stack[3]),
              rewardWallet: tupleItemAddress(stack[4]),
              rewardAmount: tupleItemBigIntString(stack[5]),
              duration: tupleItemBigIntString(stack[6]),
              sponsorFeeBps: tupleItemBigIntString(stack[7]),
              startTime: tupleItemBigIntString(stack[8]),
              endTime: tupleItemBigIntString(stack[9]),
              gasBudget: tupleItemBigIntString(stack[10]),
              status: tupleItemBigIntString(stack[11]),
              createdAt: tupleItemBigIntString(stack[12]),
              backlogLimit: tupleItemBigIntString(stack[13]),
              resumeBacklog: tupleItemBigIntString(stack[14])
            });
          }
        }
      }

      if (!farmResponded && !governanceRes && !enabledRes && !nextIdRes) {
        throw new Error('Farm snapshot is unavailable from the configured data source.');
      }

      farms.sort((left, right) => {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        if (leftId === rightId) return 0;
        return leftId > rightId ? 1 : -1;
      });
      const source: 'lite' | 'http4' = this.config.dataSource === 'lite' ? 'lite' : 'http4';
      return {
        factory: normalizedFactory,
        status,
        next_id: nextIdString,
        farm_count: farms.length,
        scanned,
        farms,
        source,
        network: this.network,
        updated_at: Math.floor(Date.now() / 1000)
      };
    })();

    if (this.config.responseCacheEnabled) {
      this.farmSnapshotInFlight.set(cacheKey, request);
    }

    try {
      const result = await request;
      if (this.config.responseCacheEnabled) {
        this.farmSnapshotCache.set(cacheKey, result);
      }
      return result;
    } finally {
      this.farmSnapshotInFlight.delete(cacheKey);
    }
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
        this.runGetMethodSourceCached(normalizedManager, 'get_state', []).catch(() => null),
        this.runGetMethodSourceCached(normalizedManager, 'registry_enabled', []).catch(() => null)
      ]);

      const state =
        stateRes?.exitCode === 0
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
              admin: tupleItemAddress(stateRes.stack[13]),
              riskVault: tupleItemAddress(stateRes.stack[14]),
              riskBucketId: tupleItemBigIntString(stateRes.stack[15])
            }
          : null;
      const enabled = enabledRes?.exitCode === 0 ? tupleItemBool(enabledRes.stack[0]) : null;
      const totalPoliciesRaw = stateRes?.exitCode === 0 ? tupleItemBigInt(stateRes.stack[0]) : null;
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
      const totalPolicies =
        totalPoliciesRaw && totalPoliciesRaw > 0n && Number.isFinite(Number(totalPoliciesRaw))
          ? Math.max(0, Math.trunc(Number(totalPoliciesRaw)))
          : 0;
      const scanCount = totalPolicies > 0 ? Math.min(maxScan, totalPolicies) : maxScan;
      const startPolicyId = totalPolicies > 0 ? totalPolicies : maxScan;
      const scanFloor = Math.max(1, startPolicyId - scanCount + 1);

      const policies: CoverPolicySnapshot[] = [];
      let scanned = 0;
      let misses = 0;
      let policyResponded = false;

      outer: for (let startId = startPolicyId; startId >= scanFloor; startId -= COVER_SCAN_BATCH_SIZE) {
        const endId = Math.max(scanFloor, startId - COVER_SCAN_BATCH_SIZE + 1);
        const batchIds = Array.from({ length: startId - endId + 1 }, (_, index) => startId - index);
          const batch = await Promise.all(
            batchIds.map((policyId) =>
              this.runGetMethodSourceCached(normalizedManager, 'get_policy', [{ type: 'int', value: BigInt(policyId) }]).catch(
                () => null
              )
            )
          );

        for (let index = 0; index < batch.length; index += 1) {
          scanned += 1;
          const res = batch[index];
          if (res) policyResponded = true;
          if (!res || res.exitCode !== 0) {
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
            windowSeconds: tupleItemBigIntString(stack[6]),
            requiredObservations: tupleItemBigIntString(stack[7]),
            breachStart: tupleItemBigIntString(stack[8]),
            breachSeconds: tupleItemBigIntString(stack[9]),
            lastObservation: tupleItemBigIntString(stack[10]),
            lastHealthyObservation: tupleItemBigIntString(stack[11]),
            breachObservations: tupleItemBigIntString(stack[12]),
            status: tupleItemBigIntString(stack[13]),
            riskVault: tupleItemAddress(stack[14]),
            riskBucketId: tupleItemBigIntString(stack[15])
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
    const includeFarms = include.farms ?? true;
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
    const farmMaxScan =
      typeof options.farms?.maxScan === 'number' && Number.isFinite(options.farms.maxScan)
        ? Math.max(1, Math.trunc(options.farms.maxScan))
        : undefined;
    const farmMaxMisses =
      typeof options.farms?.maxMisses === 'number' && Number.isFinite(options.farms.maxMisses)
        ? Math.max(1, Math.trunc(options.farms.maxMisses))
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
      includeFarms ? 'f1' : 'f0',
      includeCover ? 'c1' : 'c0',
      `gov:${govMaxScan ?? ''}:${govMaxMisses ?? ''}`,
      `farm:${farmMaxScan ?? ''}:${farmMaxMisses ?? ''}`,
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
	              const res = await this.runGetMethodSourceCached(activationGate, 'activation_status', []);
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
	              const res = await this.runGetMethodSourceCached(registry, 'registry_meta', []);
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
	              const res = await this.runGetMethodSourceCached(hub, 'pool_balances', []);
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
	            const riskVault = normalizedContracts.riskVault;
	            const feeRouter = normalizedContracts.feeRouter;
	            const buybackExecutor = normalizedContracts.buybackExecutor;
	            const anchorGuard = normalizedContracts.anchorGuard;
	            const clusterGuard = normalizedContracts.clusterGuard;
	            try {
	              const [
	                controlRes,
	                riskRes,
	                feeStateRes,
	                feeTargetsRes,
	                buybackRes,
	                anchorConfigRes,
	                anchorStateRes,
	                anchorEnabledRes,
	                anchorGovRes,
	                clusterConfigRes
	              ] = await Promise.all([
	                controlMesh ? this.runGetMethodSourceCached(controlMesh, 'get_control_state', []) : Promise.resolve(null),
	                riskVault ? this.runGetMethodSourceCached(riskVault, 'risk_state', []) : Promise.resolve(null),
	                feeRouter ? this.runGetMethodSourceCached(feeRouter, 'get_router_state', []) : Promise.resolve(null),
	                feeRouter ? this.runGetMethodSourceCached(feeRouter, 'router_targets', []) : Promise.resolve(null),
	                buybackExecutor ? this.runGetMethodSourceCached(buybackExecutor, 'buyback_config', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSourceCached(anchorGuard, 'anchor_config', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSourceCached(anchorGuard, 'anchor_state', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSourceCached(anchorGuard, 'enabled', []) : Promise.resolve(null),
	                anchorGuard ? this.runGetMethodSourceCached(anchorGuard, 'governance', []) : Promise.resolve(null),
	                clusterGuard ? this.runGetMethodSourceCached(clusterGuard, 'cluster_guard_config', []) : Promise.resolve(null)
	              ]);

	              const responded = Boolean(
	                controlRes ||
	                  riskRes ||
	                  feeStateRes ||
	                  feeTargetsRes ||
	                  buybackRes ||
	                  anchorConfigRes ||
	                  anchorStateRes ||
	                  anchorEnabledRes ||
	                  anchorGovRes ||
	                  clusterConfigRes
	              );
	              if (!responded) {
	                throw new Error('System health snapshot unavailable.');
	              }

	              const controlState: ControlStateSnapshot | null =
	                controlRes?.exitCode === 0
	                  ? {
	                      governance: tupleItemAddress(controlRes.stack[0]),
	                      enabled: tupleItemBool(controlRes.stack[1]),
	                      withdrawalsOnly: tupleItemBool(controlRes.stack[2]),
	                      sequence: tupleItemBigIntString(controlRes.stack[3]),
	                      lastHeartbeatTs: tupleItemBigIntString(controlRes.stack[4]),
	                      pegMintFeeBps: tupleItemBigIntString(controlRes.stack[5]),
	                      pegRedeemFeeBps: tupleItemBigIntString(controlRes.stack[6]),
	                      pegQuotaBps: tupleItemBigIntString(controlRes.stack[7]),
	                      pegThrottleBps: tupleItemBigIntString(controlRes.stack[8]),
	                      pegHaircutBps: tupleItemBigIntString(controlRes.stack[9]),
	                      pegLevel: tupleItemBigIntString(controlRes.stack[10]),
	                      pegEscalationScore: tupleItemBigIntString(controlRes.stack[11]),
	                      pegRecoveryScore: tupleItemBigIntString(controlRes.stack[12])
	                    }
	                  : null;

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

	              const feeRouterState: FeeRouterStateSnapshot | null =
	                feeStateRes?.exitCode === 0
	                  ? {
	                      balance: tupleItemBigIntString(feeStateRes.stack[0]),
	                      lastSequence: tupleItemBigIntString(feeStateRes.stack[1]),
	                      lastTimestamp: tupleItemBigIntString(feeStateRes.stack[2]),
	                      allocationPeg: tupleItemBigIntString(feeStateRes.stack[3]),
	                      allocationLiquidations: tupleItemBigIntString(feeStateRes.stack[4]),
	                      allocationBuyback: tupleItemBigIntString(feeStateRes.stack[5]),
	                      allocationGas: tupleItemBigIntString(feeStateRes.stack[6]),
	                      allocationEmissions: tupleItemBigIntString(feeStateRes.stack[7]),
	                      allocationReferrals: tupleItemBigIntString(feeStateRes.stack[8]),
	                      referralDemand: tupleItemBigIntString(feeStateRes.stack[9]),
	                      referralPriority: tupleItemBigIntString(feeStateRes.stack[10]),
	                      referralFloor: tupleItemBigIntString(feeStateRes.stack[11]),
	                      referralWeightDirectBps: tupleItemBigIntString(feeStateRes.stack[12]),
	                      referralFlags: tupleItemBigIntString(feeStateRes.stack[13]),
	                      referralThrottleMask: tupleItemBigIntString(feeStateRes.stack[14])
	                    }
	                  : null;

	              const feeRouterTargets: FeeRouterTargetsSnapshot | null =
	                feeTargetsRes?.exitCode === 0
	                  ? {
	                      t3Peg: tupleItemAddress(feeTargetsRes.stack[0]),
	                      t3Liquidations: tupleItemAddress(feeTargetsRes.stack[1]),
	                      peg: tupleItemAddress(feeTargetsRes.stack[2]),
	                      liquidations: tupleItemAddress(feeTargetsRes.stack[3]),
	                      buyback: tupleItemAddress(feeTargetsRes.stack[4]),
	                      gas: tupleItemAddress(feeTargetsRes.stack[5]),
	                      emissions: tupleItemAddress(feeTargetsRes.stack[6]),
	                      referrals: tupleItemAddress(feeTargetsRes.stack[7]),
	                      referralRegistry: tupleItemAddress(feeTargetsRes.stack[8])
	                    }
	                  : null;

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

	              const clusterGuardConfig: ClusterGuardConfigSnapshot | null =
	                clusterConfigRes?.exitCode === 0
	                  ? (() => {
	                      const stack = unwrapTupleStack(clusterConfigRes.stack);
	                      return {
	                        reporter: tupleItemAddress(stack[0]),
	                        registry: tupleItemAddress(stack[1]),
	                        vestingSeconds: tupleItemBigIntString(stack[2]),
	                        warnThreshold: tupleItemBigIntString(stack[3]),
	                        slashThreshold: tupleItemBigIntString(stack[4])
	                      };
	                    })()
	                  : null;

	              sections.systemHealth = ok({
	                controlState,
	                riskState,
	                feeRouterState,
	                feeRouterTargets,
	                buybackConfig,
	                anchorGuardConfig,
	                anchorGuardState,
	                anchorGuardEnabled,
	                anchorGuardGovernance,
	                clusterGuardConfig
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
	                    this.runGetMethodSourceCached(riskVault, 'bucket_state', [{ type: 'int', value: BigInt(id) }]).catch(
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
	                const configRes = await this.runGetMethodSourceCached(automationRegistry, 'config', []).catch(() => null);
	                if (configRes?.exitCode === 0) {
	                  responded = true;
	                  queueAddress = tupleItemAddress(configRes.stack[0]);
	                  automationConfig = { queue: queueAddress };
	                } else {
	                  automationConfig = null;
	                }
	              }

	              if (queueAddress) {
	                const jobConfigRes = await this.runGetMethodSourceCached(queueAddress, 'job_config', []).catch(() => null);
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
	                    this.runGetMethodSourceCached(automationRegistry, 'module', [{ type: 'int', value: BigInt(id) }]).catch(
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
	                    this.runGetMethodSourceCached(queueAddress, 'job', [{ type: 'int', value: BigInt(id) }]).catch(
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
	                      this.runGetMethodSourceCached(module.address!, enabledGetter, []).catch(() => null),
	                      governanceGetter
	                        ? this.runGetMethodSourceCached(module.address!, governanceGetter.trim(), []).catch(() => null)
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

	      if (includeFarms) {
	        tasks.push(
	          (async () => {
	            const factory = normalizedContracts.farmFactory;
	            if (!factory) {
	              sections.farms = err('farmFactory missing');
	              return;
	            }
	            try {
	              sections.farms = ok(
	                await this.getFarmSnapshot(factory, {
	                  maxScan: farmMaxScan,
	                  maxConsecutiveMisses: farmMaxMisses
	                })
	              );
	            } catch (error) {
	              sections.farms = err(error);
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
              ? this.runGetMethodSourceCached(registry, 'pool_for', [
                  { type: 'slice', cell: buildSliceCell(t3Root) },
                  { type: 'slice', cell: buildSliceCell(token) }
                ]).catch(() => null)
              : Promise.resolve(null),
            factory
              ? this.runGetMethodSourceCached(factory, 'pool_record', [
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
          let binReserves: DlmmPoolBinReserves | null = null;

          if (resolvedPool) {
            const activeRes = await this.runGetMethodSourceCached(resolvedPool, 'active_price_q64', []).catch(() => null);
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
                const binRes = await this.runGetMethodSourceCached(resolvedPool, 'bin_state', [
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
            }
          }

          poolEntries.push({
            token,
            pool: resolvedPool,
            kind,
            status,
            activeBinId,
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

  async getTransactions(address: string, page: number) {
    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (_error) {
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
      const backfillCapped = result.totalPagesMin >= this.config.backfillMaxPagesPerAddress;
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
    this.store.touch(address);
    try {
      await this.ensureInitialTransactions(address);
    } catch (_error) {
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

  async refreshAccountState(address: string) {
    const previous = this.store.get(address)?.balance;
    const previousSignature = balanceStateSignature(previous);
    const state = await this.source.getAccountState(address);
    const accountState: AccountState = {
      address,
      balance: state.balance,
      lastTxLt: state.lastTxLt,
      lastTxHash: state.lastTxHash,
      accountState: state.accountState ?? null,
      codeBoc: state.codeBoc ?? null,
      dataBoc: state.dataBoc ?? null,
      updatedAt: Date.now(),
    };
    this.store.setBalance(address, accountState);
    const nextSignature = balanceStateSignature(accountState);
    if (nextSignature !== previousSignature) {
      this.emitBalanceChanged(address);
    }
  }

  async ensureInitialTransactions(address: string) {
    const entry = this.store.get(address);
    if (entry && entry.txs.length > 0) return;

    const limit = this.config.pageSize * this.config.backfillPageBatch;
    const raw = await this.source.getTransactions(address, limit);
    this.poolTracker?.observeTransactions(raw);
    const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
    this.store.addTransactions(address, indexed);

    const updated = this.store.get(address);
    if (!updated) return;
    const oldest = updated.txs[updated.txs.length - 1];
    this.store.setLastBackfillLt(address, oldest?.lt);

    if (raw.length < limit) {
      this.store.markHistoryComplete(address);
    } else if (this.enqueueBackfill) {
      this.enqueueBackfill(address);
    }
  }

  async updateWithNewTransactions(address: string, rawTxs: IndexedTx[]) {
    if (rawTxs.length === 0) return;
    this.store.addTransactions(address, rawTxs);
  }

  classify(address: string, raw: any[]): IndexedTx[] {
    return raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
  }

  private toApiTx(tx: IndexedTx): UiTx & {
    kind: string;
    actions: any[];
    lt: string;
    hash: string;
    inMessage?: IndexedTx['inMessage'];
    outMessages?: IndexedTx['outMessages'];
  } {
    return {
      ...tx.ui,
      kind: tx.kind,
      actions: tx.actions,
      lt: tx.lt,
      hash: tx.hash,
      inMessage: tx.inMessage,
      outMessages: tx.outMessages,
    };
  }
}
