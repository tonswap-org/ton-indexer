import { decodeOriginalTransaction, assertOriginalTransactionPage } from './transactionEvidence';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { LiteClient, LiteSingleEngine, LiteEngine } from 'ton-lite-client';
import { BoundedLiteEngine } from './boundedLiteEngine';
import { errorDiagnostic, type Logger } from '../utils/logger';
import { Functions } from 'ton-lite-client/dist/schema';
import { Network } from '../models';
import {
  AccountStateResponse,
  MasterchainInfo,
  RawTransaction,
  TonDataSource,
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

type LiteServerConfig = {
  ip: number;
  port: number;
  id: { key: string };
};

type GlobalConfig = {
  liteservers?: LiteServerConfig[];
};

type LiteServer = {
  host: string;
  publicKey: Buffer;
};

const intToIP = (int: number) => {
  const part1 = int & 255;
  const part2 = (int >> 8) & 255;
  const part3 = (int >> 16) & 255;
  const part4 = (int >> 24) & 255;
  return `${part4}.${part3}.${part2}.${part1}`;
};

const parseGlobalConfig = (data: GlobalConfig): LiteServer[] => {
  const servers = data.liteservers ?? [];
  return servers
    .filter((entry) => entry?.ip && entry?.port && entry?.id?.key)
    .map((entry) => ({
      host: `tcp://${intToIP(entry.ip)}:${entry.port}`,
      publicKey: Buffer.from(entry.id.key, 'base64'),
    }));
};

const readConfigFromPath = (path: string): LiteServer[] => {
  const raw = readFileSync(path, 'utf8');
  return parseGlobalConfig(JSON.parse(raw));
};

const readConfigFromUrl = async (url: string): Promise<LiteServer[]> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = (await res.json()) as GlobalConfig;
  return parseGlobalConfig(data);
};

const parsePoolList = (pool: string): LiteServer[] => {
  const items = pool.split(',').map((entry) => entry.trim()).filter(Boolean);
  const servers: LiteServer[] = [];
  for (const item of items) {
    const [hostPart, portPart, keyPart] = item.split(':');
    if (!hostPart || !portPart || !keyPart) continue;
    const host = hostPart.match(/^\d+$/) ? intToIP(Number(hostPart)) : hostPart;
    const port = Number(portPart);
    if (!Number.isFinite(port)) continue;
    servers.push({
      host: `tcp://${host}:${port}`,
      publicKey: Buffer.from(keyPart, 'base64'),
    });
  }
  return servers;
};

const normalizePoolInput = (network: Network, pool?: string): string | undefined => {
  if (!pool) return pool;
  const trimmed = pool.trim();
  if (
    network === 'testnet' &&
    /^https?:\/\/ton\.org\/global\.config\.json\/?$/i.test(trimmed)
  ) {
    return 'https://ton.org/testnet-global.config.json';
  }
  return trimmed;
};

const resolveLiteServers = async (network: Network, pool?: string): Promise<LiteServer[]> => {
  const normalizedPool = normalizePoolInput(network, pool);
  if (normalizedPool) {
    if (normalizedPool.startsWith('http://') || normalizedPool.startsWith('https://')) {
      return await readConfigFromUrl(normalizedPool);
    }
    const resolvedPath = resolve(process.cwd(), normalizedPool);
    if (normalizedPool.endsWith('.json') || existsSync(resolvedPath)) {
      return readConfigFromPath(normalizedPool.endsWith('.json') ? normalizedPool : resolvedPath);
    }
    const list = parsePoolList(normalizedPool);
    if (list.length > 0) return list;
  }

  const defaultUrl =
    network === 'mainnet'
      ? 'https://ton.org/global.config.json'
      : network === 'testnet'
        ? 'https://ton.org/testnet-global.config.json'
        : null;
  if (!defaultUrl) {
    throw new Error('LITESERVER_POOL_LOCALNET is required when TON_NETWORK=localnet');
  }
  return await readConfigFromUrl(defaultUrl);
};

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

const MASTERCHAIN_INFO_TTL_MS = 1_000;
type LiteMasterchainRef = Awaited<ReturnType<LiteClient['getMasterchainInfo']>>;

export class LiteClientDataSource implements TonDataSource {
  network: Network;
  private client: LiteClient;
  private masterchainRef: LiteMasterchainRef | null = null;
  private masterchainRefExpiresAt = 0;
  private masterchainRefPending: Promise<LiteMasterchainRef> | null = null;

  private constructor(network: Network, client: LiteClient, private readonly logger: Logger) {
    this.network = network;
    this.client = client;
  }

  static async create(network: Network, pool: string | undefined, logger: Logger) {
    const servers = await resolveLiteServers(network, pool);
    if (servers.length === 0) {
      throw new Error('No liteserver endpoints resolved');
    }
    const engines: LiteEngine[] = servers.map(
      (server) =>
        new LiteSingleEngine({
          host: server.host,
          publicKey: server.publicKey,
        })
    );
    const engine = new BoundedLiteEngine(engines);
    const client = new LiteClient({ engine });
    return new LiteClientDataSource(network, client, logger);
  }

  private async call<T>(fn: (client: LiteClient) => Promise<T>): Promise<T> {
    // Failover belongs to the wire-query engine. Retrying a compound client
    // operation here multiplies latency and can repeat already completed reads.
    return fn(this.client);
  }

  private async getMasterchainRef(force = false): Promise<LiteMasterchainRef> {
    const now = Date.now();
    if (!force && this.masterchainRef && this.masterchainRefExpiresAt > now) {
      return this.masterchainRef;
    }
    if (!force && this.masterchainRefPending) {
      return this.masterchainRefPending;
    }
    const pending = this.call((client) => client.getMasterchainInfo())
      .then((master) => {
        this.masterchainRef = master;
        this.masterchainRefExpiresAt = Date.now() + MASTERCHAIN_INFO_TTL_MS;
        return master;
      })
      .finally(() => {
        this.masterchainRefPending = null;
      });
    this.masterchainRefPending = pending;
    return pending;
  }

  private async queryLite<T>(fn: () => Promise<T>): Promise<T> {
    return this.call((_client) => fn());
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
    const master = await this.call((client) => client.getMasterchainInfoExt());
    return {
      seqno: master.last.seqno,
      timestamp: Number.isSafeInteger(master.lastUtime) && master.lastUtime >= 0 ? master.lastUtime : undefined,
    };
  }

  async getAccountState(address: string): Promise<AccountStateResponse> {
    const master = await this.getMasterchainRef();
    return this.readAccountStateAtBlock(address, master.last);
  }

  async getAccountStateAtSeqno(address: string, seqno: number): Promise<AccountStateResponse> {
    if (!Number.isSafeInteger(seqno) || seqno < 0) throw new Error('Invalid archival block');
    return this.readAccountStateAtBlock(address, (await this.lookupMasterchainBlock(seqno)).id);
  }

  async getAccountStateAtTransaction(address: string, cursor: TransactionCursor, containingSeqno: number): Promise<AccountStateResponse> {
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
    return replayHistoricalAccount({ address: parsed, cursor, predecessor, steps });
  }

  private async readAccountStateAtBlock(address: string, block: LiteBlockId): Promise<AccountStateResponse> {
    const parsed = Address.parse(address);
    const state = await this.call((client) => client.getAccountState(parsed, block));
    const lastTx = state.lastTx;
    const account = state.state ?? null;
    const storageState = account?.storage?.state;
    const storageType = storageState?.type;
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
      balance: state.balance.coins.toString(),
      lastTxLt: lastTx?.lt?.toString(),
      lastTxHash: lastTx ? bigintToBuffer(lastTx.hash).toString('base64') : undefined,
      accountState,
      codeBoc: codeCell ? Buffer.from(codeCell.toBoc()).toString('base64') : null,
      dataBoc: dataCell ? Buffer.from(dataCell.toBoc()).toString('base64') : null
    };
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]> {
    const parsed = Address.parse(address);
    let cursorLt = lt;
    let cursorHash = hash;

    if (!cursorLt || !cursorHash) {
      const master = await this.getMasterchainRef();
      const state = await this.call((client) => client.getAccountState(parsed, master.last));
      const lastTx = state.lastTx;
      if (!lastTx) return [];
      cursorLt = lastTx.lt.toString();
      cursorHash = bigintToBuffer(lastTx.hash).toString('base64');
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

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    try {
      const target = Address.parse(address);
      const master = await this.getMasterchainRef();
      return await this.runGetMethodAtBlock(target, method, args, master.last);
    } catch (error) {
      this.logger.warn('liteserver getter unavailable', { address, method, error: errorDiagnostic(error) });
      return null;
    }
  }

  private async runGetMethodAtBlock(
    target: Address,
    method: string,
    args: TupleItem[],
    block: LiteBlockId
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    const params = args.length > 0 ? serializeTuple(args).toBoc({ idx: false, crc32: false }) : Buffer.alloc(0);
    const res = await this.call((client) => client.runMethod(target, method, params, block));
    assertBlockId(res.block, block, `Getter ${method} masterchain block`);
    const exitCode = typeof res?.exitCode === 'number' ? res.exitCode : Number.NaN;
    if (!Number.isFinite(exitCode)) return null;
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

  async close(): Promise<void> {
    // lite client has no explicit close
  }
}
