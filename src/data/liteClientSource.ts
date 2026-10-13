import { decodeOriginalTransaction, assertOriginalTransactionPage } from './transactionEvidence';
import {
  Address,
  Cell,
  CellType,
  Dictionary,
  type DictionaryValue,
  TupleItem,
  beginCell,
  loadAccount,
  loadDepthBalanceInfo,
  loadShardStateUnsplit,
  loadTransaction,
  parseTuple,
  serializeTuple,
} from '@ton/core';
import { LiteClient, type LiteEngine } from 'ton-lite-client';
import { AbortableLitePeer, BoundedLiteEngine, BoundedLiteQueryError } from './boundedLiteEngine';
import { loadLiteserverPool, type LiteserverPeer } from './liteserverPool';
import { HeadTracker } from './headTracker';
import { readAccountAnchor, blockHeaderTime } from './accountAnchor';
import { assertFreshBlock, assertFreshNetwork, assertFreshReadBatch, executeFreshCalls, freshMasterchainBlock,
  FreshReadUnavailableError, type FreshReadBatch, type FreshReadCall } from './freshRead';
import { errorDiagnostic, type Logger } from '../utils/logger';
import { Functions } from 'ton-lite-client/dist/schema';
import { Network } from '../models';
import {
  AccountStateResponse,
  MasterchainInfo,
  RawTransaction,
  ChainReadError, type ChainSource, type ChainHead, type ReadOptions,
  TransactionCursor,
} from './dataSource';
import {
  MAX_HISTORICAL_REPLAY_TRANSACTIONS, replayHistoricalAccount, replayBlockContext,
  verifiedReplayBlock, type HistoricalReplayStep,
} from './historicalReplay';
import { parseJettonMetadata } from '../utils/jettonMetadata';
import {
  cellFromAccountCodeBoc,
  isSuccessfulGetterResult,
  parseCanonicalJettonRootData,
  readCanonicalJettonBalance
} from './jettonAbi';

const cellToBase64 = (cell: Cell | null | undefined): string | undefined => {
  if (!cell) return undefined;
  return cell.toBoc({ idx: false }).toString('base64');
};



type LiteBlockId = {
  seqno: number;
  workchain: number;
  shard: string;
  rootHash: Buffer;
  fileHash: Buffer;
};

const blockIdsEqual = (actual: LiteBlockId, expected: LiteBlockId) =>
  actual.seqno === expected.seqno &&
  actual.workchain === expected.workchain &&
  actual.shard === expected.shard &&
  actual.rootHash.equals(expected.rootHash) &&
  actual.fileHash.equals(expected.fileHash);

const assertBlockId = (actual: LiteBlockId, expected: LiteBlockId, label: string) => {
  if (!blockIdsEqual(actual, expected)) {
    throw new Error(`${label} does not match the requested block.`);
  }
};

const decodeTaggedShard = (raw: string) => {
  const tagged = BigInt.asUintN(64, BigInt(raw));
  if (tagged === 0n) throw new Error('Tagged shard identifier cannot be zero.');
  const terminator = tagged & -tagged;
  let trailingZeroes = 0;
  for (let cursor = terminator; (cursor & 1n) === 0n; cursor >>= 1n) {
    trailingZeroes += 1;
  }
  const shardPrefixBits = 63 - trailingZeroes;
  if (shardPrefixBits < 0 || shardPrefixBits > 60) {
    throw new Error('Tagged shard identifier has an invalid prefix length.');
  }
  return {
    shardPrefixBits,
    shardPrefix: tagged ^ terminator,
  };
};

const assertShardStateIdentity = (cell: Cell, expected: LiteBlockId, label: string) => {
  if (cell.type !== CellType.Ordinary) {
    throw new Error(`${label} does not contain an ordinary shard-state root.`);
  }
  const expectedShard = decodeTaggedShard(expected.shard);
  const state = loadShardStateUnsplit(cell.beginParse());
  if (
    state.seqno !== expected.seqno ||
    state.shardId.workchainId !== expected.workchain ||
    state.shardId.shardPrefixBits !== expectedShard.shardPrefixBits ||
    state.shardId.shardPrefix !== expectedShard.shardPrefix
  ) {
    throw new Error(`${label} shard-state identity does not match the requested block.`);
  }
};

const parseMerkleProofRoots = (proof: Buffer, expectedRoots: number, label: string) => {
  if (!Buffer.isBuffer(proof) || proof.length === 0) {
    throw new Error(`${label} is empty.`);
  }
  const roots = Cell.fromBoc(proof);
  if (roots.length !== expectedRoots) {
    throw new Error(`${label} must contain exactly ${expectedRoots} Merkle-proof root(s).`);
  }
  for (const root of roots) {
    if (root.type !== CellType.MerkleProof || root.refs.length !== 1) {
      throw new Error(`${label} contains a malformed Merkle-proof root.`);
    }
  }
  return roots;
};

const assertBlockProofRoot = (root: Cell, expected: LiteBlockId, label: string) => {
  if (!root.refs[0].hash(0).equals(expected.rootHash)) {
    throw new Error(`${label} does not bind the requested block root hash.`);
  }
};

const shardAccountReferenceValue: DictionaryValue<Cell> = {
  parse: (slice) => {
    loadDepthBalanceInfo(slice);
    const accountRef = slice.loadRef();
    slice.loadUintBig(256);
    slice.loadUintBig(64);
    return accountRef;
  },
  serialize: () => {
    throw new Error('Shard-account proof values are read-only.');
  },
};

const loadShardAccountsRoot = (shardStateRoot: Cell) => {
  const slice = shardStateRoot.beginParse();
  if (slice.loadUint(32) !== 0x9023afe2) throw new Error('Invalid shard-state root.');
  slice.loadInt(32);
  if (slice.loadUint(2) !== 0) throw new Error('Invalid shard identifier prefix.');
  slice.loadUint(6);
  slice.loadInt(32);
  slice.loadUintBig(64);
  slice.loadUint(32);
  slice.loadUint(32);
  slice.loadUint(32);
  slice.loadUintBig(64);
  slice.loadUint(32);
  slice.loadRef();
  slice.loadBit();
  return slice.loadRef();
};

const parseBoundAccountRoot = (raw: Buffer, jettonMaster: Address) => {
  const roots = Cell.fromBoc(raw);
  if (roots.length !== 1 || roots[0].type !== CellType.Ordinary) {
    throw new Error('Jetton-master account state must contain exactly one ordinary root.');
  }
  const accountRoot = roots[0];
  const slice = accountRoot.beginParse();
  if (!slice.loadBit()) throw new Error('Jetton-master account is absent from the account-state response.');
  const account = loadAccount(slice);
  if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) {
    throw new Error('Jetton-master account state contains trailing data.');
  }
  if (!account.addr.equals(jettonMaster)) {
    throw new Error('Jetton-master account state belongs to another address.');
  }
  const storage = account.storage.state;
  if (storage.type !== 'active' || !storage.state.code || !storage.state.data) {
    throw new Error('Jetton-master account state is not active with exact code and data.');
  }
  return accountRoot;
};

const graftAccountIntoShardState = (
  shardStateRoot: Cell,
  accountRoot: Cell,
  jettonMaster: Address
) => {
  const accountsRoot = loadShardAccountsRoot(shardStateRoot);
  const accountRefs = Dictionary.load(
    Dictionary.Keys.BigUint(256),
    shardAccountReferenceValue,
    accountsRoot.beginParse()
  );
  const accountId = BigInt(`0x${jettonMaster.hash.toString('hex')}`);
  const provenAccountRef = accountRefs.get(accountId);
  if (!provenAccountRef || provenAccountRef.type !== CellType.PrunedBranch) {
    throw new Error('Jetton-master account proof does not contain one pruned account branch.');
  }
  if (
    !provenAccountRef.hash(0).equals(accountRoot.hash(0)) ||
    provenAccountRef.depth(0) !== accountRoot.depth(0)
  ) {
    throw new Error('Jetton-master account state does not match its proven pruned branch.');
  }

  let replacements = 0;
  const graft = (cell: Cell): Cell => {
    if (cell === provenAccountRef) {
      replacements += 1;
      return accountRoot;
    }
    const refs = cell.refs.map(graft);
    if (refs.every((ref, index) => ref === cell.refs[index])) return cell;
    const next = new Cell({ exotic: cell.isExotic, bits: cell.bits, refs });
    if (!next.hash(0).equals(cell.hash(0)) || next.depth(0) !== cell.depth(0)) {
      throw new Error('Account-proof graft changed a proven ancestor hash or depth.');
    }
    return next;
  };
  const expanded = graft(shardStateRoot);
  if (replacements !== 1) {
    throw new Error('Jetton-master account proof must expose exactly one bound account branch.');
  }
  if (!expanded.hash(0).equals(shardStateRoot.hash(0)) || expanded.depth(0) !== shardStateRoot.depth(0)) {
    throw new Error('Expanded shard-state proof changed its root hash or depth.');
  }

  const verified = loadShardStateUnsplit(expanded.beginParse()).accounts?.get(accountId)?.shardAccount.account;
  if (
    !verified ||
    !verified.addr.equals(jettonMaster) ||
    verified.storage.state.type !== 'active' ||
    !verified.storage.state.state.code ||
    !verified.storage.state.state.data
  ) {
    throw new Error('Expanded shard-state proof does not reveal the bound active jetton master.');
  }
  return expanded;
};

const bigintToBuffer = (value: bigint, bytes = 32) => {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length === bytes) return buf;
  if (buf.length > bytes) return buf.slice(-bytes);
  return Buffer.concat([Buffer.alloc(bytes - buf.length, 0), buf]);
};

export type ChainSourceObserver = { query?(peer: number, ok: boolean, ms: number): void; head?(head: ChainHead): void };
type SourceOptions = { network: Network; peers: LiteserverPeer[]; logger: Logger; observer?: ChainSourceObserver;
  engineFactory?: (peer: LiteserverPeer) => LiteEngine };
type Flight = { controller: AbortController; promise: Promise<unknown>; users: number };
const liteBlock = (head: ChainHead): LiteBlockId => ({ workchain: head.workchain, shard: head.shard, seqno: head.seqno,
  rootHash: Buffer.from(head.rootHashHex, 'hex'), fileHash: Buffer.from(head.fileHashHex, 'hex') });

export function createLiteChainSource(options: SourceOptions): LiteClientDataSource { return new LiteClientDataSource(options); }

export class LiteClientDataSource implements ChainSource {
  readonly network: Network;
  private client!: LiteClient;
  private engine?: BoundedLiteEngine;
  private closed = false;
  private readonly heads: HeadTracker;
  private readonly flights = new Map<string, Flight>();
  private readonly logger: Logger;
  constructor(private readonly options: SourceOptions) {
    if (!options.peers.length) throw new Error('No liteserver endpoints configured');
    this.network = options.network;
    this.logger = options.logger;
    this.heads = new HeadTracker(this.network, options.observer?.head);
  }
  static async create(network: Network, pool: string | undefined, logger: Logger) {
    return createLiteChainSource({ network, peers: loadLiteserverPool(pool), logger });
  }
  private ensure(): BoundedLiteEngine {
    if (this.closed) throw new ChainReadError('upstream_unavailable');
    if (!this.engine) {
      const engines = this.options.peers.map(peer => this.options.engineFactory?.(peer)
        ?? new AbortableLitePeer(`tcp://${peer.host}:${peer.port}`, peer.publicKey));
      this.engine = new BoundedLiteEngine(engines, undefined, this.options.observer?.query);
      this.client = new LiteClient({ engine: this.engine });
    }
    return this.engine;
  }
  private async call<T>(fn: (client: LiteClient) => Promise<T>): Promise<T> { this.ensure(); return fn(this.client); }
  private async queryLite<T>(fn: () => Promise<T>): Promise<T> { this.ensure(); return fn(); }
  private async scope<T>(options: { signal?: AbortSignal; at?: ChainHead }, run: (signal: AbortSignal) => Promise<T>, timeout = 5_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ChainReadError('upstream_timeout')), timeout);
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      if (signal.aborted) throw new ChainReadError('upstream_timeout');
      return await this.ensure().withOptions({ signal, awaitSeqno: options.at?.seqno }, () => new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new ChainReadError('upstream_timeout')); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => run(signal)).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      }));
    } catch (cause) {
      if (cause instanceof ChainReadError) throw cause;
      throw new ChainReadError(signal.aborted || (cause instanceof BoundedLiteQueryError && cause.timedOut)
        ? 'upstream_timeout' : 'upstream_unavailable', { cause });
    } finally { clearTimeout(timer); }
  }
  private shared<T>(key: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new ChainReadError('upstream_timeout'));
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => run(controller.signal));
      flight = { controller, promise, users: 0 }; this.flights.set(key, flight);
      const current = flight;
      const cleanup = () => { if (this.flights.get(key) === current) this.flights.delete(key); };
      void promise.then(cleanup, cleanup);
    }
    const current = flight; current.users++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (done) return; done = true;
        signal.removeEventListener('abort', abort);
        if (--current.users === 0 && this.flights.get(key) === current) {
          this.flights.delete(key); current.controller.abort(new ChainReadError('upstream_timeout'));
        }
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => finish(new ChainReadError('upstream_timeout'));
      signal.addEventListener('abort', abort, { once: true });
      current.promise.then(value => finish(undefined, value), error => finish(error));
    });
  }
  async head(options: { signal?: AbortSignal } = {}): Promise<ChainHead> {
    return this.scope(options, async signal => {
      const cached = this.heads.fresh();
      if (cached) return cached;
      return this.shared('head', signal, async signal => {
        await this.ensure().query(Functions.liteServer_getMasterchainInfoExt, { kind: 'liteServer.getMasterchainInfoExt', mode: 0 }, {
          signal, validate: candidate => { this.heads.accept(candidate as Parameters<HeadTracker['accept']>[0]); },
        });
        return this.heads.current()!;
      });
    });
  }
  private async lookupMasterchainBlock(seqno: number) {
    return this.queryLite(() =>
      this.client.lookupBlockByID({
        workchain: -1,
        shard: '-9223372036854775808',
        seqno,
      })
    );
  }

  private async getBlockData(block: {
    seqno: number;
    workchain: number;
    shard: string;
    rootHash: Buffer;
    fileHash: Buffer;
  }) {
    return this.queryLite(() =>
      this.client.engine.query(Functions.liteServer_getBlock, {
        kind: 'liteServer.getBlock',
        id: {
          kind: 'tonNode.blockIdExt',
          seqno: block.seqno,
          shard: block.shard,
          workchain: block.workchain,
          rootHash: block.rootHash,
          fileHash: block.fileHash,
        },
      })
    );
  }

  private async getMasterchainConfigProof(block: {
    seqno: number;
    workchain: number;
    shard: string;
    rootHash: Buffer;
    fileHash: Buffer;
  }) {
    return this.queryLite(() =>
      this.client.engine.query(Functions.liteServer_getConfigAll, {
        kind: 'liteServer.getConfigAll',
        mode: 0,
        id: {
          kind: 'tonNode.blockIdExt',
          seqno: block.seqno,
          shard: block.shard,
          workchain: block.workchain,
          rootHash: block.rootHash,
          fileHash: block.fileHash,
        },
      })
    );
  }

  async getMasterchainInfo(): Promise<MasterchainInfo> {
    const head = await this.head(); return { seqno: head.seqno, timestamp: head.utime };
  }
  async getAccountState(address: string, options: ReadOptions = {}): Promise<AccountStateResponse> {
    return this.scope(options, async signal => {
      const head = options.at ?? await this.head({ signal });
      const normalized = Address.parse(address).toRawString();
      return this.shared(`account:${head.rootHashHex}:${normalized}`, signal, signal =>
        this.ensure().withOptions({ signal, awaitSeqno: head.seqno }, () => this.readAccountStateAtBlock(normalized, liteBlock(head), head)));
    });
  }
  async read(calls: FreshReadCall[], options: ReadOptions = {}) {
    return this.scope(options, async signal => {
      const head = options.at ?? await this.head({ signal });
      const results = await executeFreshCalls(calls, async call => {
        if (signal.aborted) throw new ChainReadError('upstream_timeout');
        const address = Address.parse(call.address).toRawString();
        if (call.kind === 'account') return { kind: 'account', address, state: await this.getAccountState(address, { at: head, signal }) };
        return { kind: 'getter', address, ...await this.runGetMethod(address, call.method, call.args, { at: head, signal }) };
      });
      return { head, results };
    }, 18_000);
  }
  async readFresh(calls: FreshReadCall[]): Promise<FreshReadBatch> {
    const queriedAt = Date.now(), { head, results } = await this.read(calls);
    const batch: FreshReadBatch = { network: this.network, readContext: { source: 'lite', head, queriedAt }, results };
    assertFreshReadBatch(batch, calls, this.network, queriedAt);
    return batch;
  }
  async getAccountStateAtSeqno(address: string, seqno: number, options: { signal?: AbortSignal } = {}): Promise<AccountStateResponse> {
    return this.scope(options, async signal => this.ensure().withOptions({ signal, awaitSeqno: seqno }, async () => {
      if (!Number.isSafeInteger(seqno) || seqno < 1) throw new Error('Invalid archival block');
      const header = await this.lookupMasterchainBlock(seqno);
      const proof = Cell.fromBoc(header.headerProof);
      if (proof.length !== 1 || proof[0].type !== CellType.MerkleProof) throw new Error('Invalid archival header proof');
      const head = { ...freshMasterchainBlock(header.id), utime: blockHeaderTime(proof[0].refs[0], header.id) };
      return this.ensure().withOptions({ signal, awaitSeqno: seqno }, () => this.readAccountStateAtBlock(address, header.id, head));
    }));
  }
  async getAccountStateAtTransaction(address: string, cursor: TransactionCursor, containingSeqno: number, options: { signal?: AbortSignal } = {}): Promise<AccountStateResponse> {
    return this.scope(options, signal => this.ensure().withOptions({ signal, awaitSeqno: containingSeqno },
      () => this.readAccountStateAtTransaction(address, cursor, containingSeqno, signal)), 30_000);
  }
  private async readAccountStateAtTransaction(address: string, cursor: TransactionCursor, containingSeqno: number, signal: AbortSignal): Promise<AccountStateResponse> {
    if (!Number.isSafeInteger(containingSeqno) || containingSeqno < 1 ||
        !/^[1-9][0-9]*$/.test(cursor.lt)) throw new Error('Invalid exact archival cursor.');
    const parsed = Address.parse(address);
    if (parsed.workChain !== 0) throw new Error('Intermediate replay supports basechain accounts only.');
    const beforeBlock = (await this.lookupMasterchainBlock(containingSeqno - 1)).id;
    const before = await this.call((client) => client.getAccountStateRaw(parsed, beforeBlock));
    assertBlockId(before.block, beforeBlock, 'Historical predecessor masterchain block');
    if (!before.lastTx || before.lastTx.lt >= BigInt(cursor.lt)) {
      throw new Error('Historical predecessor is not before the requested cursor.');
    }
    const accountRoot = parseBoundAccountRoot(before.raw, parsed);
    const predecessor = beginCell().storeRef(accountRoot)
      .storeUint(before.lastTx.hash, 256).storeUint(before.lastTx.lt, 64).endCell();
    const hash = /^[0-9a-f]{64}$/i.test(cursor.hash)
      ? Buffer.from(cursor.hash, 'hex') : Buffer.from(cursor.hash, 'base64');
    if (hash.length !== 32) throw new Error('Invalid exact archival hash.');
    const page = await this.call((client) => client.getAccountTransactions(
      parsed, cursor.lt, hash, MAX_HISTORICAL_REPLAY_TRANSACTIONS));
    const roots = Cell.fromBoc(page.transactions);
    if (!roots.length || roots.length !== page.ids.length || !roots[0].hash().equals(hash)) {
      throw new Error('Historical transaction page identity mismatch.');
    }
    const selected: { transaction: Cell; blockId: LiteBlockId }[] = [];
    let complete = false;
    for (let index = 0; index < roots.length; index++) {
      const tx = loadTransaction(roots[index].beginParse());
      selected.push({ transaction: roots[index], blockId: page.ids[index] });
      if (tx.prevTransactionLt === before.lastTx.lt && tx.prevTransactionHash === before.lastTx.hash) {
        complete = true; break;
      }
    }
    if (!complete) throw new Error('Historical transaction replay exceeds its bounded predecessor segment.');
    const contexts = new Map<string, { block: Cell; config: Cell }>();
    const steps: HistoricalReplayStep[] = [];
    for (const item of selected.reverse()) {
      if (signal.aborted) throw new ChainReadError('upstream_timeout');
      const key = item.blockId.rootHash.toString('hex');
      let context = contexts.get(key);
      if (!context) {
        const blockResponse = await this.getBlockData(item.blockId);
        assertBlockId(blockResponse.id, item.blockId, 'Historical shard block');
        const block = verifiedReplayBlock(blockResponse.data, item.blockId);
        const { masterRef } = replayBlockContext(block);
        const [masterResponse, configResponse] = await Promise.all([
          this.getBlockData(masterRef), this.getMasterchainConfigProof(masterRef),
        ]);
        assertBlockId(masterResponse.id, masterRef, 'Historical config masterchain block');
        assertBlockId(configResponse.id, masterRef, 'Historical config response');
        const master = verifiedReplayBlock(masterResponse.data, masterRef);
        const stateProof = parseMerkleProofRoots(configResponse.stateProof, 1, 'Historical config block proof')[0];
        assertBlockProofRoot(stateProof, masterRef, 'Historical config block proof');
        const configRoot = parseMerkleProofRoots(configResponse.configProof, 1, 'Historical config state proof')[0].refs[0];
        if (master.refs[2]?.type !== CellType.MerkleUpdate ||
            !master.refs[2].refs[1].hash(0).equals(configRoot.hash(0))) {
          throw new Error('Historical config is not committed by its masterchain block.');
        }
        const state = loadShardStateUnsplit(configRoot.beginParse());
        if (state.seqno !== masterRef.seqno || !state.extras) throw new Error('Historical config state identity.');
        context = { block, config: beginCell().storeDictDirect(state.extras.config).endCell() };
        contexts.set(key, context);
      }
      steps.push({ transaction: item.transaction, ...context });
    }
    const state = await replayHistoricalAccount({ address: parsed, cursor, predecessor, steps });
    const final = selected.at(-1)!;
    const genUtime = blockHeaderTime(steps.at(-1)!.block, final.blockId);
    return Object.freeze({ ...state, anchor: { shardBlock: { workchain: final.blockId.workchain, shard: final.blockId.shard,
      seqno: final.blockId.seqno, rootHashHex: final.blockId.rootHash.toString('hex'), fileHashHex: final.blockId.fileHash.toString('hex') }, genUtime } });
  }

  private async readAccountStateAtBlock(address: string, block: LiteBlockId, head: ChainHead): Promise<AccountStateResponse> {
    const parsed = Address.parse(address);
    const state = await this.call(client => client.getAccountStateRaw(parsed, block));
    assertBlockId(state.block, block, 'Account masterchain block');
    const anchor = await readAccountAnchor(state, head, shard => this.client.getBlockHeader(shard), address);
    if (state.state === undefined || typeof state.balance?.coins !== 'bigint' || state.balance.coins < 0n)
      throw new Error('Invalid current lite account state.');
    const lastTx = state.lastTx;
    if (lastTx !== null && (typeof lastTx?.lt !== 'bigint' || lastTx.lt < 0n || lastTx.lt > 0xffffffffffffffffn
      || typeof lastTx.hash !== 'bigint' || lastTx.hash < 0n || lastTx.hash >= (1n << 256n)
      || (lastTx.lt === 0n) !== (lastTx.hash === 0n))) throw new Error('Invalid current lite account transaction pointer.');
    const account = state.state ?? null;
    if (account && !account.addr.equals(parsed)) throw new Error('Current lite account belongs to another address.');
    const storageState = account?.storage?.state;
    const storageType = storageState?.type;
    if (account && !['uninit', 'active', 'frozen'].includes(storageType ?? '')) throw new Error('Invalid current lite account storage state.');
    const accountState =
      !account || storageType === 'uninit'
        ? ('uninitialized' as const)
        : storageType === 'frozen'
          ? ('frozen' as const)
          : ('active' as const);
    const activeState = storageType === 'active' && storageState ? storageState.state : null;
    const codeCell = activeState?.code ?? null;
    const dataCell = activeState?.data ?? null;
    return {
      anchor,
      balance: state.balance.coins.toString(),
      lastTxLt: lastTx?.lt?.toString(),
      lastTxHash: lastTx ? bigintToBuffer(lastTx.hash).toString('base64') : undefined,
      accountState,
      codeBoc: codeCell ? Buffer.from(codeCell.toBoc()).toString('base64') : null,
      dataBoc: dataCell ? Buffer.from(dataCell.toBoc()).toString('base64') : null
    };
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string, options: { signal?: AbortSignal } = {}): Promise<RawTransaction[]> {
    return this.scope(options, signal => this.readTransactions(address, limit, lt, hash, signal));
  }
  private async readTransactions(address: string, limit: number, lt: string | undefined, hash: string | undefined, signal: AbortSignal): Promise<RawTransaction[]> {
    const parsed = Address.parse(address);
    let cursorLt = lt;
    let cursorHash = hash;

    if (!cursorLt || !cursorHash) {
      const state = await this.getAccountState(address, { signal });
      if (!state.lastTxLt || state.lastTxLt === '0') return [];
      cursorLt = state.lastTxLt; cursorHash = state.lastTxHash!;
    }

    const txs = await this.call((client) =>
      client.getAccountTransactions(parsed, cursorLt, Buffer.from(cursorHash, 'base64'), limit)
    );

    const cells = Cell.fromBoc(txs.transactions);
    if (txs.ids.length !== cells.length || txs.ids.some((block) => block.workchain !== parsed.workChain)) {
      throw new Error('Transaction evidence block identities do not match the requested account workchain.');
    }
    const page = cells.map((cell) => decodeOriginalTransaction(cell, parsed));
    if (page.length === 0) return [];
    return assertOriginalTransactionPage(page, parsed, { lt: BigInt(cursorLt).toString(), hash: Buffer.from(cursorHash, 'base64').toString('base64') });
  }

  async runGetMethod(address: string, method: string, args: TupleItem[] = [], options: ReadOptions = {}): Promise<{ exitCode: number; stack: TupleItem[] }> {
    try {
      return await this.scope(options, async signal => {
        const head = options.at ?? await this.head({ signal }), target = Address.parse(address);
        const encoded = serializeTuple(args).toBoc({ idx: false }).toString('base64');
        return this.shared(`getter:${head.rootHashHex}:${target.toRawString()}:${method}:${encoded}`, signal, signal =>
          this.ensure().withOptions({ signal, awaitSeqno: head.seqno }, () => this.runGetMethodAtBlock(target, method, args, liteBlock(head))));
      });
    } catch (error) {
      this.logger.warn('liteserver getter unavailable', { address, method, error: errorDiagnostic(error) });
      throw error;
    }
  }
  private async runGetMethodAtBlock(
    target: Address,
    method: string,
    args: TupleItem[],
    block: LiteBlockId
  ): Promise<{ exitCode: number; stack: TupleItem[] }> {
    const params = args.length > 0 ? serializeTuple(args).toBoc({ idx: false, crc32: false }) : Buffer.alloc(0);
    const res = await this.call((client) => client.runMethod(target, method, params, block));
    assertBlockId(res.block, block, `Getter ${method} masterchain block`);
    if (!Number.isSafeInteger(res.exitCode) || (res.result !== null && typeof res.result !== 'string'))
      throw new FreshReadUnavailableError();
    const exitCode = typeof res?.exitCode === 'number' ? res.exitCode : Number.NaN;
    if (!Number.isSafeInteger(exitCode)) throw new ChainReadError('upstream_unavailable');
    const stack =
      res?.result && typeof res.result === 'string'
        ? parseTuple(Cell.fromBoc(Buffer.from(res.result, 'base64'))[0])
        : [];
    return {
      exitCode,
      stack
    };
  }

  async getJettonBalance(owner: string, master: string): Promise<{ wallet: string; balance: string } | null> {
    return readCanonicalJettonBalance({
      owner,
      master,
      runGetMethod: (address, method, args = []) => this.runGetMethod(address, method, args),
      readAccountCode: async (address) => {
        const state = await this.getAccountState(address);
        if (state.accountState !== 'active') return null;
        return cellFromAccountCodeBoc(state.codeBoc);
      }
    });
  }

  async getJettonMetadata(master: string) {
    try {
      const result = await this.runGetMethod(master, 'get_jetton_data', []);
      if (!isSuccessfulGetterResult(result)) return null;
      const data = parseCanonicalJettonRootData(result.stack);
      return data ? parseJettonMetadata(data.content) : null;
    } catch {
      return null;
    }
  }

  async sendMessage(boc: Buffer, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.scope(options, async () => { await this.client.sendMessage(boc); });
  }
  health() {
    const peers = this.engine?.health() ?? this.options.peers.map((_, index) => ({ index, ready: false, open: false, failures: 0, latencyMs: null }));
    return { peersConfigured: peers.length, peersReady: peers.filter(peer => peer.ready && !peer.open).length, head: this.heads.current(), peers };
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const flight of this.flights.values()) flight.controller.abort(new ChainReadError('upstream_unavailable'));
    this.flights.clear(); this.engine?.close();
  }
}
