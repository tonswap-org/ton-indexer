import { decodeOriginalTransaction, assertOriginalTransactionPage } from './transactionEvidence';
import {
  Address,
  Cell,
  CellType,
  TupleItem,
  beginCell,
  loadShardAccount,
  loadTransaction,
  parseTuple,
  serializeTuple,
} from '@ton/core';
import { provenShardAccount, provenConfig, proofRoots } from './liteProof';
import { LiteClient, type LiteEngine } from 'ton-lite-client';
import { AbortableLitePeer, BoundedLiteEngine, BoundedLiteQueryError } from './boundedLiteEngine';
import type { LiteserverPeer } from './liteserverPool';
import { HeadTracker } from './headTracker';
import { assertFreshHeadTime } from './freshHead';
import { createLiteClientCache } from './liteAccountCache';
import { readAccountAnchor, blockHeaderTime } from './accountAnchor';
import { executeFreshCalls, freshMasterchainBlock,
  FreshReadUnavailableError, type FreshReadCall } from './freshRead';
import { errorDiagnostic, type Logger } from '../utils/logger';
import { Functions } from 'ton-lite-client/dist/schema';
import { Network } from '../models';
import {
  AccountStateResponse,
  RawTransaction,
  ChainReadError, type ChainSource, type ChainHead, type ReadOptions,
  TransactionCursor,
  type RecoveryProofAnchor, type RecoveryProofHistory,
} from './dataSource';
import { validateRecoveryProofHistory } from './t3ProofBundle';
import {
  MAX_HISTORICAL_REPLAY_TRANSACTIONS, replayHistoricalAccount, replayBlockContext,
  verifiedReplayBlock, type HistoricalReplayStep,
} from './historicalReplay';
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
  private ensure(): BoundedLiteEngine {
    if (this.closed) throw new ChainReadError('upstream_unavailable');
    if (!this.engine) {
      const engines = this.options.peers.map(peer => this.options.engineFactory?.(peer)
        ?? new AbortableLitePeer(`tcp://${peer.host}:${peer.port}`, peer.publicKey));
      this.engine = new BoundedLiteEngine(engines, undefined, this.options.observer?.query);
      this.client = new LiteClient({ engine: this.engine, cacheMap: createLiteClientCache });
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
          signal, awaitSeqno: this.heads.current()?.seqno, validate: candidate => { this.heads.accept(candidate as Parameters<HeadTracker['accept']>[0]); },
        });
        return this.heads.current()!;
      });
    });
  }
  private async lookupMasterchainBlock(seqno: number) {
    const block = await this.queryLite(() =>
      this.client.lookupBlockByID({
        workchain: -1,
        shard: '-9223372036854775808',
        seqno,
      })
    );
    if (block.id.seqno !== seqno) throw new Error('Masterchain lookup returned another sequence number.');
    freshMasterchainBlock(block.id);
    return block;
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

  private async readConfigAtBlock(expected: LiteBlockId, signal: AbortSignal, expectedTime?: number): Promise<Cell> {
    const owned = new AbortController();
    const combined = AbortSignal.any([signal, owned.signal]);
    const fail = (error: unknown): never => { owned.abort(error); throw error; };
    // Drain both physical calls on either failure before releasing this read.
    const [blockResult, configResult] = await this.ensure().withOptions({ signal: combined, awaitSeqno: expected.seqno }, () =>
      Promise.allSettled([this.getBlockData(expected).catch(fail), this.getMasterchainConfigProof(expected).catch(fail)]));
    if (blockResult.status === 'rejected') throw blockResult.reason;
    if (configResult.status === 'rejected') throw configResult.reason;
    const blockResponse = blockResult.value, configResponse = configResult.value;
    assertBlockId(blockResponse.id, expected, 'Config block response');
    assertBlockId(configResponse.id, expected, 'Config proof response');
    const block = verifiedReplayBlock(blockResponse.data, expected);
    const [blockProof] = proofRoots(configResponse.stateProof, 1);
    if (!blockProof.hash(0).equals(block.hash(0))) throw new Error('Config block proof identity mismatch.');
    const [state] = proofRoots(configResponse.configProof, 1);
    return provenConfig(block, state, expected, expectedTime ?? blockHeaderTime(block, expected));
  }

  async getConfig(options: ReadOptions = {}): Promise<{ head: ChainHead; configBoc: string }> {
    return this.scope(options, async signal => {
      const head = { ...(options.at ?? await this.head({ signal })) };
      const expected = liteBlock(head);
      // Re-resolve the requested masterchain identity. Caller-supplied labels
      // alone never authenticate config, including a caller-supplied timestamp.
      const selected = await this.lookupMasterchainBlock(head.seqno);
      assertBlockId(selected.id, expected, 'Config selected masterchain block');
      const config = await this.readConfigAtBlock(expected, signal, head.utime);
      return { head: { ...head }, configBoc: config.toBoc().toString('base64') };
    });
  }

  async getAccountState(address: string, options: ReadOptions = {}): Promise<AccountStateResponse> {
    return this.scope(options, async signal => {
      const head = options.at ?? await this.head({ signal });
      const normalized = Address.parse(address).toRawString();
      return this.shared(`account:${head.seqno}:${head.rootHashHex}:${head.fileHashHex}:${head.utime}:${normalized}`, signal, signal =>
        this.ensure().withOptions({ signal, awaitSeqno: head.seqno }, () => this.readAccountStateAtBlock(normalized, liteBlock(head), head)));
    });
  }

  async getRecoveryProofAnchor(address: string, options: ReadOptions = {}): Promise<RecoveryProofAnchor> {
    return this.scope(options, async signal => {
      const head = { ...(options.at ?? await this.head({ signal })) }, parsed = Address.parse(address);
      if (parsed.workChain !== 0) throw new Error('Recovery proofs require a basechain account.');
      return this.ensure().withOptions({ signal, awaitSeqno: head.seqno }, async () => {
        const selected = await this.lookupMasterchainBlock(head.seqno);
        assertBlockId(selected.id, liteBlock(head), 'Recovery selected masterchain block');
        const state = await this.call(client => client.getAccountStateRaw(parsed, liteBlock(head)));
        const exact = provenShardAccount(state, head, parsed);
        if (!exact) throw new Error('Recovery account is absent.');
        const id = state.shardBlock;
        return { account: parsed.toRawString(), head, shardBlock: { workchain: id.workchain, shard: id.shard,
          seqno: id.seqno, rootHashHex: id.rootHash.toString('hex'), fileHashHex: id.fileHash.toString('hex') },
          masterchainProofBoc: state.shardProof.toString('base64'), accountProofBoc: state.proof.toString('base64'),
          accountBoc: state.raw.toString('base64'), shardAccountBoc: exact.toBoc().toString('base64') };
      });
    });
  }

  async getRecoveryProofHistory(anchor: ChainHead, options: ReadOptions = {}): Promise<RecoveryProofHistory> {
    return this.scope(options, async signal => {
      const head = { ...(options.at ?? await this.head({ signal })) };
      if (anchor.seqno >= head.seqno) throw new Error('Recovery historical anchor is not earlier than the current head.');
      return this.ensure().withOptions({ signal, awaitSeqno: head.seqno }, async () => {
        const selected = await this.lookupMasterchainBlock(head.seqno);
        assertBlockId(selected.id, liteBlock(head), 'Recovery current masterchain block');
        const old = await this.lookupMasterchainBlock(anchor.seqno);
        assertBlockId(old.id, liteBlock(anchor), 'Recovery historical masterchain block');
        const response = await this.queryLite(() => this.client.engine.query(Functions.liteServer_getBlockProof, {
          kind: 'liteServer.getBlockProof', mode: 1,
          knownBlock: { kind: 'tonNode.blockIdExt', ...liteBlock(head) },
          targetBlock: { kind: 'tonNode.blockIdExt', ...liteBlock(anchor) },
        }));
        assertBlockId(response.from, liteBlock(head), 'Recovery history source');
        assertBlockId(response.to, liteBlock(anchor), 'Recovery history target');
        if (!response.complete || response.steps.length !== 1 || response.steps[0].kind !== 'liteServer.blockLinkBack') {
          throw new Error('Direct original prev_blocks path is unavailable.');
        }
        const link = response.steps[0];
        assertBlockId(link.from, liteBlock(head), 'Recovery history link source');
        assertBlockId(link.to, liteBlock(anchor), 'Recovery history link target');
        const [block] = proofRoots(link.proof, 1), [state] = proofRoots(link.stateProof, 1);
        const result = { head, anchor: { ...anchor }, blockBoc: block.toBoc().toString('base64'), stateBoc: state.toBoc().toString('base64') };
        validateRecoveryProofHistory(result);
        return result;
      });
    });
  }
  async read(calls: FreshReadCall[], options: ReadOptions = {}) {
    return this.scope(options, async signal => {
      const head = options.at ?? await this.head({ signal });
      const results = await executeFreshCalls(calls, async (call, ownedSignal) => {
        if (ownedSignal.aborted) throw new ChainReadError('upstream_timeout');
        const address = Address.parse(call.address).toRawString();
        if (call.kind === 'account') return { kind: 'account', address, state: await this.getAccountState(address, { at: head, signal: ownedSignal }) };
        return { kind: 'getter', address, ...await this.runGetMethod(address, call.method, call.args, { at: head, signal: ownedSignal }) };
      }, signal);
      // Unpinned reads are current preflight batches. Explicit historical/cycle
      // boundaries retain their original block identity without wall-time reuse.
      if (!options.at) assertFreshHeadTime(head.utime);
      return { head, results };
    }, 18_000);
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
    const beforeHeader = await this.lookupMasterchainBlock(containingSeqno - 1);
    const beforeBlock = beforeHeader.id;
    const [beforeHeaderRoot] = proofRoots(beforeHeader.headerProof, 1);
    const beforeHead = { ...freshMasterchainBlock(beforeBlock), utime: blockHeaderTime(beforeHeaderRoot, beforeBlock) };
    const before = await this.call((client) => client.getAccountStateRaw(parsed, beforeBlock));
    const original = provenShardAccount(before, beforeHead, parsed);
    // An absent dictionary entry has no serialized ShardAccount to preserve.
    // Only authenticated absence permits the canonical empty genesis boundary.
    const predecessor = original ?? beginCell().storeRef(beginCell().storeBit(false).endCell())
      .storeUint(0, 256).storeUint(0, 64).endCell();
    const beforePointer = loadShardAccount(predecessor.beginParse());
    if (beforePointer.lastTransactionLt >= BigInt(cursor.lt)) {
      throw new Error('Historical predecessor is not before the requested cursor.');
    }
    const containingHeader = await this.lookupMasterchainBlock(containingSeqno);
    const [containingRoot] = proofRoots(containingHeader.headerProof, 1);
    const containingHead = { ...freshMasterchainBlock(containingHeader.id), utime: blockHeaderTime(containingRoot, containingHeader.id) };
    const containing = await this.call(client => client.getAccountStateRaw(parsed, containingHeader.id));
    provenShardAccount(containing, containingHead, parsed);
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
      // Until an explicit shard ancestry proof is available, support only the
      // block selected by this authenticated masterchain account boundary.
      // Transaction-page block labels alone are not proof of chain membership.
      assertBlockId(page.ids[index], containing.shardBlock, 'Historical transaction containing shard block');
      selected.push({ transaction: roots[index], blockId: page.ids[index] });
      if (tx.prevTransactionLt === beforePointer.lastTransactionLt && tx.prevTransactionHash === beforePointer.lastTransactionHash) {
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
        const config = await this.readConfigAtBlock(masterRef, signal);
        context = { block, config };
        contexts.set(key, context);
      }
      steps.push({ transaction: item.transaction, ...context });
    }
    const state = await replayHistoricalAccount({ address: parsed, cursor, predecessor, steps });
    const final = selected.at(-1)!;
    const genUtime = blockHeaderTime(steps.at(-1)!.block, final.blockId);
    return Object.freeze({ ...state, sourceMasterchain: Object.freeze({ ...containingHead }), anchor: { shardBlock: { workchain: final.blockId.workchain, shard: final.blockId.shard,
      seqno: final.blockId.seqno, rootHashHex: final.blockId.rootHash.toString('hex'), fileHashHex: final.blockId.fileHash.toString('hex') }, genUtime } });
  }

  private async readAccountStateAtBlock(address: string, block: LiteBlockId, head: ChainHead): Promise<AccountStateResponse> {
    const parsed = Address.parse(address);
    const state = await this.call(client => client.getAccountStateRaw(parsed, block));
    assertBlockId(state.block, block, 'Account masterchain block');
    const anchor = await readAccountAnchor(state, head, shard => this.client.getBlockHeader(shard), address);
    const exact = provenShardAccount(state, head, parsed);
    const proven = exact ? loadShardAccount(exact.beginParse()) : null;
    const lastTx = proven ? { lt: proven.lastTransactionLt, hash: proven.lastTransactionHash } : null;
    if (lastTx && (lastTx.lt === 0n) !== (lastTx.hash === 0n)) throw new Error('Invalid proven account transaction pointer.');
    const account = proven?.account ?? null;
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
      sourceMasterchain: Object.freeze({ ...head }),
      balance: account?.storage.balance.coins.toString() ?? '0',
      shardAccountBoc: exact?.toBoc().toString('base64'),
      ...(exact === null ? { provenAbsent: true as const } : {}),
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
