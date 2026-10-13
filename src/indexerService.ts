import { readCoverPolicyPage, type CoverPageOptions, type CoverPolicySnapshot } from './utils/cover';
import { readOriginalTransactionEvidence, originalTransactionToToncenter } from './data/transactionEvidence';
import { AdmissionExecutor } from './data/admission/nativePool';
import { AdmissionError, AdmissionExecution, isAdmissionMethod } from './data/admission/protocol';
import { readDlmmFarmSnapshot, type DlmmFarmSnapshot, type DlmmFarmSnapshotOptions } from './utils/dlmmFarming';
import { Address, Cell, TupleItem, beginCell, parseTuple, serializeTuple } from '@ton/core';
import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import {
  RawTransaction,
  ChainSource, ChainHead, ChainReadError,
  transactionPageIsLinkedInclusiveSegment,
  transactionPageReachesHistoryStart
} from './data/dataSource';
import { OpcodeSets } from './utils/opcodes';
import { governanceProposalRange } from './utils/governanceStorage';
import {
  AccountState,
  HealthStatus,
  IndexedTx,
  Network,
  SwapExecutionType,
  TxAction,
  UiTx,
} from './models';
import { classifyTransaction } from './utils/txClassifier';
import { MetricsCollector } from './metricsCollector';
import { PoolTracker } from './poolTracker';
import { LRUCache } from 'lru-cache';
import { resolveDlmmPoolSettlementEvidence } from './utils/dlmmSettlementEvidence';
import { assertFreshReadBatch, FreshReadUnavailableError, type FreshReadCall } from './data/freshRead';

import { createSnapshotReader, type SnapshotReader, type SnapshotReadOptions } from './api/snapshotReader';

type ServiceReadOptions = { signal?: AbortSignal };

// Bound work even if a faulty source ignores its signal. The source still receives
// the real cancellation signal, and an abandoned operation cannot publish state.
async function withReadDeadline<T>(options: ServiceReadOptions, ms: number, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const reason = () => options.signal?.reason instanceof ChainReadError ? options.signal.reason
    : new ChainReadError(options.signal?.reason?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unavailable');
  const cancel = () => controller.abort(reason());
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new ChainReadError('upstream_timeout')), Math.max(1, ms));
  if (options.signal?.aborted) cancel();
  let onAbort!: () => void;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([load(controller.signal), new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    })]);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

type ToncenterStackEntry = [string, unknown];
type ToncenterRunResult = {
  stack: ToncenterStackEntry[];
  exit_code: number;
  gas_used: number | null;
  admission?: AdmissionExecution;
};

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

const GOVERNANCE_SNAPSHOT_CACHE_TTL_MS = 30_000;
const GOVERNANCE_MAX_SCAN_DEFAULT = 20;
const GOVERNANCE_MAX_SCAN_LIMIT = 64;
const GOVERNANCE_SCAN_BATCH_SIZE = 5;
const COVER_SNAPSHOT_CACHE_TTL_MS = 30_000;

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


type CoverSnapshotResponse = {
  manager: string;
  owner: string | null;
  enabled: boolean | null;
  state: CoverStateSnapshot | null;
  policy_count: number;
  scanned: number;
  policies: CoverPolicySnapshot[];
  live_revision: string;
  next_after_slot: number | null;
  page_complete: true;
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
  private config: Config;
  private store: MemoryStore;
  private source: ChainSource;
  private opcodes: OpcodeSets;
  private network: Network;
  private lastHead?: ChainHead;
  private readonly snapshotReader: SnapshotReader;
  private enqueueBackfill?: (address: string) => void;
  private metrics?: MetricsCollector;
  private poolTracker?: PoolTracker;
  private txCache: LRUCache<string, { value: any; signature: string }>;
  private healthCache?: { value: HealthStatus; expiresAt: number };
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
    source: ChainSource,
    opcodes: OpcodeSets,
    jettonRoots: Array<{ master: string; symbol?: string }>,
    metrics?: MetricsCollector,
    poolTracker?: PoolTracker,
    private readonly runtime: { ledgerStatus?: () => HealthStatus['ledger']; diskState?: () => HealthStatus['disk'] } = {}
  ) {
    this.config = config;
    this.store = store;
    this.source = source;
    this.opcodes = opcodes;
    this.network = config.network;
    this.snapshotReader = createSnapshotReader(source);
    this.metrics = metrics;
    this.poolTracker = poolTracker;

    const txCacheMax = Math.max(
      1000,
      Math.min(config.globalMaxPages, config.maxAddresses * config.maxPagesPerAddress)
    );

    this.txCache = new LRUCache({
      max: txCacheMax,
      ttl: config.txCacheTtlMs,
      allowStale: false,
    });
  }

  setBackfillEnqueue(fn: (address: string) => void) {
    this.enqueueBackfill = fn;
  }

  setMasterchainInfo(head: ChainHead) {
    this.lastHead = head;
    this.healthCache = undefined;
  }

  getHealth(): HealthStatus {
    if (this.config.responseCacheEnabled && this.config.healthCacheTtlMs > 0) {
      if (this.healthCache && this.healthCache.expiresAt > Date.now()) {
        return this.healthCache.value;
      }
    }

    const chain = this.source.health();
    const head = chain.head;
    const response: HealthStatus = {
      lastMasterSeqno: this.lastHead?.seqno ?? head?.seqno,
      indexerLagSec: head ? Math.max(0, Math.floor(Date.now() / 1000) - head.utime) : undefined,
      chain: { peersConfigured: chain.peersConfigured, peersReady: chain.peersReady,
        headSeqno: head?.seqno ?? null, headAgeSec: head ? Math.max(0, Math.floor(Date.now() / 1000) - head.utime) : null },
      ledger: this.runtime.ledgerStatus?.() ?? 'disabled', disk: this.runtime.diskState?.() ?? 'ok',
    };
    if (this.config.responseCacheEnabled && this.config.healthCacheTtlMs > 0) {
      this.healthCache = { value: response, expiresAt: Date.now() + this.config.healthCacheTtlMs };
    }
    return response;
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

  async getAccountAnchor(address: string, options: ServiceReadOptions = {}) {
    address = normalizeAddress(address);
    return withReadDeadline(options, 5_000, async signal => {
      const head = await this.source.head({ signal });
      const state = await this.source.getAccountState(address, { at: head, signal });
      signal.throwIfAborted();
      const anchor = state.anchor;
      const validBlock = (block: ChainHead | NonNullable<typeof anchor>['shardBlock']) =>
        Number.isSafeInteger(block.seqno) && block.seqno >= 0 && Number.isSafeInteger(block.workchain) &&
        /^-?\d+$/.test(block.shard) && [block.rootHashHex, block.fileHashHex].every(hash => /^[a-f0-9]{64}$/i.test(hash) && !/^0+$/.test(hash));
      if (!anchor || !validBlock(head) || !validBlock(anchor.shardBlock) ||
        !Number.isSafeInteger(head.utime) || head.utime <= 0 || !Number.isSafeInteger(anchor.genUtime) || anchor.genUtime <= 0)
        throw new ChainReadError('upstream_unavailable');
      return { state, head, anchor };
    });
  }

  async getState(address: string, options: ServiceReadOptions = {}) {
    address = normalizeAddress(address);
    const { state, head, anchor } = await this.getAccountAnchor(address, options);
    return { address, last_tx_lt: state.lastTxLt, last_tx_hash: state.lastTxHash,
      last_seen_utime: this.store.get(address)?.txs[0]?.utime ?? null,
      last_confirmed_seqno: head.seqno, account_state: state.accountState ?? null,
      code_boc: state.codeBoc ?? null, data_boc: state.dataBoc ?? null,
      balance_raw: state.balance, network: this.network,
      shard_block: anchor.shardBlock, shard_utime: anchor.genUtime };
  }

  async readFresh(calls: FreshReadCall[], options: ServiceReadOptions = {}) {
    const startedAt = Date.now();
    if (this.source.network !== this.network
      || calls.some(call => call.kind === 'getter' && isAdmissionMethod(call.method))) throw new FreshReadUnavailableError();
    // Capture the complete tuple before handing it to a source. This path never
    // enters MemoryStore or any ordinary read's pending/completed cache.
    const captured = calls.map(call => call.kind === 'account' ? { ...call } :
      { ...call, args: parseTuple(serializeTuple(call.args)) });
    const read = await withReadDeadline(options, 18_000, signal => this.source.read(captured, { signal }));
    const batch = { network: this.source.network, readContext: { source: 'lite' as const, head: read.head, queriedAt: startedAt }, results: read.results };
    assertFreshReadBatch(batch, captured, this.network, startedAt);
    return { network: batch.network, readContext: batch.readContext, results: batch.results.map(result => {
      if (result.kind === 'getter') return { kind: result.kind, address: result.address,
        stack: result.stack.map(tupleItemToToncenterStackEntry), exit_code: result.exitCode, gas_used: null };
      const state = result.state;
      return { kind: result.kind, address: result.address, balance_raw: state.balance,
        account_state: state.accountState, code_boc: state.codeBoc ?? null, data_boc: state.dataBoc ?? null,
        last_tx_lt: state.lastTxLt ?? null, last_tx_hash: state.lastTxHash ?? null,
        shard_block: state.anchor?.shardBlock ?? null, shard_utime: state.anchor?.genUtime ?? null };
    }) };
  }

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = [], options: ServiceReadOptions = {}
  ): Promise<ToncenterRunResult> {
    if (isAdmissionMethod(method)) {
      const admission = this.admissionExecutor;
      if (!admission || normalizeAddress(address) !== normalizeAddress(admission.engine)) throw new AdmissionError('admission_unavailable');
      // Explicit local verified execution. It cannot enter the generic remote
      // source, completed cache, retry, or resilient fallback path below.
      const result = await withReadDeadline(options, 5_000, () => admission.run(method, args));
      return { stack: result.stack.map(tupleItemToToncenterStackEntry), exit_code: result.exitCode,
        gas_used: result.gasUsed, admission: result.execution };
    }
    const result = await this.runGetMethodSource(normalizeAddress(address), method, args, options);
    return {
      stack: result.stack.map(tupleItemToToncenterStackEntry),
      exit_code: result.exitCode,
      gas_used: null
    };
  }

  private async runGetMethodSource(address: string, method: string, args: TupleItem[] = [], options: ServiceReadOptions = {}) {
    const encoded = serializeTuple(args);
    const key = JSON.stringify(['getter', address, method, encoded.toBoc({idx: false, crc32: false}).toString('base64')]);
    const result = await this.snapshotReader.read({ key, deadlineMs: 5_000, signal: options.signal,
      load: ({head, signal}) => this.source.runGetMethod(address, method, parseTuple(encoded), {at: head, signal}) });
    return { exitCode: result.exitCode, stack: result.stack };
  }

  private async readSnapshot<T extends object>(options: SnapshotReadOptions<T>): Promise<T> {
    const {asOfSeqno: _asOfSeqno, ...value} = await this.snapshotReader.read(options);
    // The reader keeps the execution identity internally; public snapshot bodies
    // retain their existing contract, including the original cached updated_at.
    return value as T;
  }

  private pinnedGetter(head: ChainHead, signal: AbortSignal) {
    return async (address: string, method: string, args: TupleItem[] = []) => {
      const result = await this.source.read([{kind: 'getter', address, method, args}], {at: head, signal});
      const row = result.results[0];
      if (result.head.seqno !== head.seqno || result.head.rootHashHex !== head.rootHashHex ||
        result.head.fileHashHex !== head.fileHashHex || result.results.length !== 1 || row?.kind !== 'getter' || row.address !== address)
        throw new ChainReadError('upstream_unavailable');
      return {exitCode: row.exitCode, stack: row.stack};
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
    options: { sourcePool?: string | null; routeIds?: number[] } = {}, readOptions: ServiceReadOptions = {}
  ): Promise<VolIndexSnapshotResponse> {
    const normalizedVolIndex = normalizeAddress(volIndexAddress);
    const normalizedPool = options.sourcePool?.trim() ? normalizeAddress(options.sourcePool) : null;
    const requestedRouteIds = options.routeIds ?? [];
    if (requestedRouteIds.length > 64 || requestedRouteIds.some((value) =>
      !Number.isInteger(value) || value < 1 || value > 0xffffffff)) {
      throw new Error('route_ids must contain at most 64 positive uint32 integers');
    }
    const routeIds = Array.from(new Set(requestedRouteIds));

    return this.readSnapshot({ key: JSON.stringify(['vol', normalizedVolIndex, normalizedPool, routeIds]),
      deadlineMs: 10_000, signal: readOptions.signal, load: async ({head, signal}) => {
      const getter = this.pinnedGetter(head, signal);
    const [configRes, stateRes, poolStateRes] = await Promise.all([
      getter(normalizedVolIndex, 'vol_index_config', []),
      getter(normalizedVolIndex, 'vol_index_state', []),
      normalizedPool
        ? getter(normalizedVolIndex, 'vol_index_pool_state', [
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
      const routeRes = await getter(normalizedVolIndex, 'vol_index_route', [
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
      source: 'lite' as const,
      network: this.network,
      updated_at: Math.floor(Date.now() / 1000)
    };
    }});
  }

  async getGovernanceSnapshot(
    votingAddress: string,
    options: { owner?: string | null; maxScan?: number; maxConsecutiveMisses?: number; startId?: string | number } = {}, readOptions: ServiceReadOptions = {}
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

    return this.readSnapshot({ key: 'getGovernanceSnapshot|' + cacheKey, deadlineMs: 10_000, signal: readOptions.signal,
      reuse: { account: normalizedVoting, maxAgeMs: GOVERNANCE_SNAPSHOT_CACHE_TTL_MS }, load: async ({head, signal}) => {
      const getter = this.pinnedGetter(head, signal);
      // Fetch the persisted monotonic counter. Getter failures are never interpreted as absence.
      const account = await this.source.getAccountState(normalizedVoting, {at: head, signal});
      const range = governanceProposalRange(account?.dataBoc);
      const lastId = range ? (range.nextProposalId - 1n < firstId + BigInt(maxScan) - 1n
        ? range.nextProposalId - 1n : firstId + BigInt(maxScan) - 1n) : firstId + BigInt(maxScan) - 1n;
      const issues: string[] = range ? [] : ['governance_range_unavailable'];
      let lockResponded = false;
      const lock = await (async (): Promise<GovernanceLockSnapshot | null> => {
        if (!normalizedOwner) return null;
        const owner = Address.parse(normalizedOwner);
        const ownerCell = beginCell().storeAddress(owner).endCell();
        const lockRes = await getter(normalizedVoting, 'governance_lock', [
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
      })();

      const proposals: GovernanceProposalSnapshot[] = [];
      let scanned = 0;
      let proposalResponded = false;
      for (let startId = firstId; startId <= lastId; startId += BigInt(GOVERNANCE_SCAN_BATCH_SIZE)) {
        const endId = lastId < startId + BigInt(GOVERNANCE_SCAN_BATCH_SIZE) - 1n ? lastId : startId + BigInt(GOVERNANCE_SCAN_BATCH_SIZE) - 1n;
        const batchIds = Array.from({ length: Number(endId - startId + 1n) }, (_, index) => startId + BigInt(index));
        const batch = await Promise.all(
          batchIds.map((proposalId) =>
            getter(normalizedVoting, 'governance_proposal', [
              { type: 'int', value: BigInt(proposalId) }
            ])
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

      if (!proposalResponded && !lockResponded && !range) {
        throw new Error('Governance snapshot is unavailable from the configured data source.');
      }

      proposals.sort((left, right) => {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        if (leftId === rightId) return 0;
        return leftId > rightId ? -1 : 1;
      });
      const source = 'lite' as const;

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
    }});
  }

  async getFarmSnapshot(poolAddress: string, options: DlmmFarmSnapshotOptions = {}, readOptions: ServiceReadOptions = {}): Promise<FarmSnapshotResponse> {
    const pool = Address.parse(poolAddress).toRawString();
    return this.readSnapshot({ key: JSON.stringify(['farm', pool, options]), deadlineMs: 10_000, signal: readOptions.signal,
      load: async ({head, signal}) => {
        const getter = this.pinnedGetter(head, signal);
        const snapshot = await readDlmmFarmSnapshot(pool, options, (method, args) => getter(pool, method, args));
        return { ...snapshot, source: 'lite' as const, network: this.network, updated_at: Math.floor(Date.now() / 1000) };
      } });
  }

  async getCoverSnapshot(
    managerAddress: string,
    options: CoverPageOptions = {}, readOptions: ServiceReadOptions = {}
  ): Promise<CoverSnapshotResponse> {
    const normalizedManager = normalizeAddress(managerAddress);
    const normalizedOwner = options.owner ? normalizeAddress(options.owner) : null;
    const cacheKey = [normalizedManager, normalizedOwner ?? '', options.limit ?? 40, options.afterSlot ?? 0, options.revision ?? ''].join('|');

    return this.readSnapshot({ key: 'getCoverSnapshot|' + cacheKey, deadlineMs: 10_000, signal: readOptions.signal,
      reuse: { account: normalizedManager, maxAgeMs: COVER_SNAPSHOT_CACHE_TTL_MS }, load: async ({head, signal}) => {
      const getter = this.pinnedGetter(head, signal);
      const [stateRes, enabledRes] = await Promise.all([
        getter(normalizedManager, 'get_state', []),
        getter(normalizedManager, 'registry_enabled', [])
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
      const page = await readCoverPolicyPage({ ...options, owner: normalizedOwner },
        (method, args) => getter(normalizedManager, method, args));

      const source = 'lite' as const;
      return {
        manager: normalizedManager,
        owner: normalizedOwner,
        enabled,
        state,
        policy_count: page.policies.length,
        ...page,
        source,
        network: this.network,
        updated_at: Math.floor(Date.now() / 1000)
      };
    }});
  }

  async getDlmmPoolsSnapshot(request: DlmmPoolsSnapshotRequest, readOptions: ServiceReadOptions = {}): Promise<DlmmPoolsSnapshotResponse> {
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
    return this.readSnapshot({ key: 'getDlmmPoolsSnapshot|' + cacheKey, deadlineMs: 10_000, signal: readOptions.signal,
      reuse: { maxAgeMs: DLMM_POOLS_SNAPSHOT_CACHE_TTL_MS }, load: async ({head, signal}) => {
      const getter = this.pinnedGetter(head, signal);
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
              ? getter(registry, 'pool_for', [
                  { type: 'slice', cell: buildSliceCell(t3Root) },
                  { type: 'slice', cell: buildSliceCell(token) }
                ])
              : Promise.resolve(null),
            factory
              ? getter(factory, 'pool_record', [
                  { type: 'slice', cell: buildSliceCell(t3Root) },
                  { type: 'slice', cell: buildSliceCell(token) }
                ])
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
            const activeRes = await getter(resolvedPool, 'active_price_q64', []);
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
                const binRes = await getter(resolvedPool, 'bin_state', [
                  { type: 'int', value: BigInt(activeBinId) }
                ]);
                if (binRes && binRes.exitCode === 0) {
                  const binStack = unwrapTupleStack(binRes.stack);
                  binReserves = {
                    reserveT: tupleItemBigIntString(binStack[0]),
                    reserveX: tupleItemBigIntString(binStack[1])
                  };
                }
              }
              const walletCodeHashRes = await getter(
                resolvedPool,
                'wallet_code_hash',
                []
              );
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
    }});
  }

  async getTransactionEvidence(address: string, limit: number, lt?: string, hash?: string, options: ServiceReadOptions = {}) {
    if (Boolean(lt) !== Boolean(hash)) throw new Error('Transaction evidence requires both cursor fields.');
    const page = await withReadDeadline(options, this.config.initialHistoryTimeoutMs, signal =>
      readOriginalTransactionEvidence(this.source, address, limit, lt && hash ? {lt, hash} : undefined, {signal}));
    return page.map(originalTransactionToToncenter);
  }

  async getTransactions(address: string, page: number, options: ServiceReadOptions = {}) {
    address = normalizeAddress(address);
    this.store.touch(address);
    await this.ensureInitialTransactions(address, options);

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

  async getTransactionsByCursor(address: string, lt: string, hash: string, options: ServiceReadOptions = {}) {
    address = normalizeAddress(address);
    this.store.touch(address);
    await this.ensureInitialTransactions(address, options);

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
    }, readOptions: ServiceReadOptions = {}
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
    await this.ensureInitialTransactions(marketAddress, readOptions);

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
    options: ServiceReadOptions = {},
    expectedWorkflowGeneration?: number
  ) {
    address = normalizeAddress(address);
    return this.store.withAddressLock(
      address,
      () => this.refreshAccountStateUnlocked(address, options),
      expectedWorkflowGeneration
    );
  }

  /** Caller must already hold MemoryStore's lock for this normalized address. */
  async refreshAccountStateWithinAddressLock(
    address: string,
    options: ServiceReadOptions = {}
  ) {
    address = normalizeAddress(address);
    return this.refreshAccountStateUnlocked(address, options);
  }

  private async refreshAccountStateUnlocked(address: string, options: ServiceReadOptions = {}) {
    const state = await withReadDeadline(options, 5_000, signal => this.source.getAccountState(address, {signal}));
    options.signal?.throwIfAborted();
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
    this.storeAccountState(address, accountState);
  }

  /** Caller must hold MemoryStore's lock for this normalized address. */
  private storeAccountState(address: string, accountState: AccountState) {
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
  }

  async ensureInitialTransactions(address: string, options: ServiceReadOptions = {}) {
    address = normalizeAddress(address);
    return withReadDeadline(options, this.config.initialHistoryTimeoutMs, signal =>
      this.store.withAddressLock(address, () => this.ensureInitialTransactionsUnlocked(address, {signal}))
    );
  }

  private async ensureInitialTransactionsUnlocked(address: string, options: ServiceReadOptions) {
    options.signal?.throwIfAborted();
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
    const head = await withReadDeadline(options, this.config.initialHistoryTimeoutMs, signal => this.source.getAccountState(address, {signal}));
    options.signal?.throwIfAborted();
    const receivedRaw = ((!head.lastTxLt && !head.lastTxHash && head.accountState === 'uninitialized') || head.lastTxLt === '0') ? [] :
      head.lastTxLt && head.lastTxHash ? await withReadDeadline(options, this.config.initialHistoryTimeoutMs, signal => this.source.getTransactions(address, limit, head.lastTxLt!, head.lastTxHash!, {signal})) :
      (() => { throw new ChainReadError('upstream_unavailable'); })();
    options.signal?.throwIfAborted();
    const initialResponseTruncated = receivedRaw.length > limit;
    const raw = receivedRaw.slice(0, limit);
    if (raw.length === 0) {
      await this.refreshAccountStateUnlocked(address, options);
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
      await this.refreshAccountStateUnlocked(address, options);
      const current = this.store.get(address)?.balance;
      if (current?.lastTxLt && current.lastTxHash && this.enqueueBackfill) {
        this.enqueueBackfill(address);
      }
      return;
    }
    await this.refreshAccountStateUnlocked(address, options);
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
