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
import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine, LiteEngine } from 'ton-lite-client';
import { Codecs, Functions } from 'ton-lite-client/dist/schema';
import { Network } from '../models';
import {
  AccountStateResponse,
  MasterchainInfo,
  RawMessage,
  RawTransaction,
  RawTransactionStatus,
  TonBlockIdExt,
  TonSccpBurnProofMaterial,
  TonSccpBurnProofMaterialRequest,
  TonDataSource,
} from './dataSource';
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

const bytesToBase64 = (value: Buffer | Uint8Array) => Buffer.from(value).toString('base64');
const bytesToHex = (value: Buffer | Uint8Array) => `0x${Buffer.from(value).toString('hex')}`;

const isHex256 = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value.trim());

const parseHex256 = (value: string, label: string) => {
  const trimmed = value.trim();
  if (!isHex256(trimmed)) {
    throw new Error(`${label} must be 0x-prefixed 32-byte hex`);
  }
  return Buffer.from(trimmed.slice(2), 'hex');
};

const blockIdToResponse = (id: {
  seqno: number;
  workchain: number;
  shard: string;
  rootHash: Buffer;
  fileHash: Buffer;
}): TonBlockIdExt => ({
  seqno: id.seqno,
  workchain: id.workchain,
  shard: id.shard,
  rootHashHex: bytesToHex(id.rootHash),
  fileHashHex: bytesToHex(id.fileHash),
});

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

const decodeOp = (cell: Cell | null | undefined): number | undefined => {
  if (!cell) return undefined;
  try {
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return undefined;
    return Number(slice.loadUint(32));
  } catch {
    return undefined;
  }
};

const toFriendlyAddress = (addr?: Address | null): string | undefined => {
  if (!addr) return undefined;
  return addr.toString({ urlSafe: true, bounceable: true });
};

const mapMessage = (message: any): RawMessage | undefined => {
  if (!message) return undefined;
  const info = message.info;
  let source: string | undefined;
  let destination: string | undefined;
  let value: string | undefined;

  if (info?.type === 'internal') {
    source = toFriendlyAddress(info.src);
    destination = toFriendlyAddress(info.dest);
    value = info.value?.coins?.toString();
  } else if (info?.type === 'external-in') {
    destination = toFriendlyAddress(info.dest);
  } else if (info?.type === 'external-out') {
    source = toFriendlyAddress(info.src);
  }

  const body = cellToBase64(message.body);
  const op = decodeOp(message.body);

  return {
    source,
    destination,
    value,
    op,
    body,
  };
};

const bigintToBuffer = (value: bigint, bytes = 32) => {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length === bytes) return buf;
  if (buf.length > bytes) return buf.slice(-bytes);
  return Buffer.concat([Buffer.alloc(bytes - buf.length, 0), buf]);
};

const formatComputeSkipReason = (reason?: string) => {
  if (!reason) return 'Compute phase skipped.';
  return `Compute phase skipped: ${reason}.`;
};

const evaluateStatus = (tx: any): { status: RawTransactionStatus; reason?: string; success: boolean } => {
  const description = tx.description;
  if (!description) return { status: 'pending', success: false };
  if (description.aborted === true) {
    const computeExit = description.computePhase?.exitCode;
    const reason =
      typeof computeExit === 'number'
        ? `Transaction aborted (VM exit code ${computeExit}).`
        : 'Transaction aborted by contract.';
    return { status: 'failed', reason, success: false };
  }

  const compute = description.computePhase;
  if (compute?.type === 'skipped') {
    return { status: 'failed', reason: formatComputeSkipReason(compute.reason), success: false };
  }
  if (compute?.type === 'vm' && compute.success === false) {
    const reason =
      typeof compute.exitCode === 'number'
        ? `VM execution failed (exit code ${compute.exitCode}).`
        : 'VM execution failed.';
    return { status: 'failed', reason, success: false };
  }

  const action = description.actionPhase;
  if (
    action &&
    (action.valid === false ||
      action.success === false ||
      (typeof action.resultCode === 'number' && action.resultCode !== 0))
  ) {
    const reason =
      typeof action.resultCode === 'number' && action.resultCode !== 0
        ? `Action phase failed (result code ${action.resultCode}).`
        : 'Action phase failed.';
    return { status: 'failed', reason, success: false };
  }

  const computeOk = compute?.type === 'vm' && compute.success === true;
  const actionOk = action?.success === true || action?.resultCode === 0;
  if (computeOk || actionOk) {
    return { status: 'success', success: true };
  }

  return { status: 'pending', success: false };
};

const decodeTransactions = (payload: Buffer): any[] => {
  const cells = Cell.fromBoc(payload);
  const parsed: any[] = [];

  for (const cell of cells) {
    try {
      parsed.push(loadTransaction(cell.beginParse()));
    } catch (error) {
      const suffix = error instanceof Error && error.message ? `: ${error.message}` : '';
      throw new Error(`Failed to decode complete transaction page${suffix}`);
    }
  }

  return parsed;
};

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;
const MASTERCHAIN_INFO_TTL_MS = 1_000;
type LiteMasterchainRef = Awaited<ReturnType<LiteClient['getMasterchainInfo']>>;

// ton-lite-client 3.1.1 predates TON's boxed Simplex signature-set arm. Keep
// the compatibility decoder release-owned and scoped to getBlockProof so an
// unrelated response can never be reinterpreted through a global codec patch.
const PARTIAL_BLOCK_PROOF_TL_ID = -1898917183;
const BLOCK_LINK_BACK_TL_ID = -276947985;
const BLOCK_LINK_FORWARD_TL_ID = 1376767516;
const ORDINARY_SIGNATURE_SET_TL_ID = -163272986;
const SIMPLEX_SIGNATURE_SET_TL_ID = -1406887936;
const CANDIDATE_HASH_DATA_ORDINARY_TL_ID = -386286372;
const CANDIDATE_HASH_DATA_EMPTY_TL_ID = 1924454707;
const CANDIDATE_ID_TL_ID = -1231958721;
const CANDIDATE_PARENT_TL_ID = 441162481;
const CANDIDATE_WITHOUT_PARENTS_TL_ID = 583781545;
const MAX_BLOCK_PROOF_STEPS = 16;
const MAX_BLOCK_SIGNATURES = 1024;

type BlockProofDecoder = Parameters<typeof Functions.liteServer_getBlockProof.decodeResponse>[0];

const decodeBoundedVector = <T>(
  decoder: BlockProofDecoder,
  max: number,
  label: string,
  decode: (decoder: BlockProofDecoder) => T
) => {
  const count = decoder.readUInt32();
  if (count > max) {
    throw new Error(`${label} exceeds ${max} entries.`);
  }
  const values: T[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(decode(decoder));
  }
  return values;
};

const decodeOwnedSignature = (decoder: BlockProofDecoder) => {
  const nodeIdShort = decoder.readInt256();
  const signature = decoder.readBuffer();
  if (nodeIdShort.length !== 32 || signature.length !== 64) {
    throw new Error('TON block-proof signature has an invalid width.');
  }
  return {
    kind: 'liteServer.signature' as const,
    nodeIdShort,
    signature,
  };
};

const decodeOwnedSignatureSet = (decoder: BlockProofDecoder) => {
  const constructor = decoder.readInt32();
  if (constructor === ORDINARY_SIGNATURE_SET_TL_ID) {
    const validatorSetHash = decoder.readInt32();
    const catchainSeqno = decoder.readInt32();
    const signatures = decodeBoundedVector(
      decoder,
      MAX_BLOCK_SIGNATURES,
      'TON block-proof signature set',
      decodeOwnedSignature
    );
    return {
      kind: 'liteServer.signatureSet' as const,
      validatorSetHash,
      catchainSeqno,
      signatures,
    };
  }
  if (constructor === SIMPLEX_SIGNATURE_SET_TL_ID) {
    const ccSeqno = decoder.readInt32();
    const validatorSetHash = decoder.readInt32();
    const signatures = decodeBoundedVector(
      decoder,
      MAX_BLOCK_SIGNATURES,
      'TON Simplex block-proof signature set',
      decodeOwnedSignature
    );
    const sessionId = decoder.readInt256();
    const slot = decoder.readInt32() >>> 0;
    const candidate = decoder.readBuffer();
    return {
      kind: 'liteServer.signatureSet.simplex' as const,
      ccSeqno,
      validatorSetHash,
      signatures,
      sessionId,
      slot,
      candidate,
    };
  }
  throw new Error(`Unknown TON block-proof signature-set constructor: ${constructor}`);
};

const decodeOwnedBlockLink = (decoder: BlockProofDecoder) => {
  const constructor = decoder.readInt32();
  if (constructor === BLOCK_LINK_BACK_TL_ID) {
    return Codecs.liteServer_blockLinkBack.decode(decoder);
  }
  if (constructor === BLOCK_LINK_FORWARD_TL_ID) {
    const toKeyBlock = decoder.readBool();
    const from = Codecs.tonNode_blockIdExt.decode(decoder);
    const to = Codecs.tonNode_blockIdExt.decode(decoder);
    const destProof = decoder.readBuffer();
    const configProof = decoder.readBuffer();
    const signatures = decodeOwnedSignatureSet(decoder);
    return {
      kind: 'liteServer.blockLinkForward' as const,
      toKeyBlock,
      from,
      to,
      destProof,
      configProof,
      signatures,
    };
  }
  throw new Error(`Unknown TON block-proof link constructor: ${constructor}`);
};

const ownedGetBlockProofFunction = {
  encodeRequest: Functions.liteServer_getBlockProof.encodeRequest,
  decodeResponse: (decoder: BlockProofDecoder) => {
    const constructor = decoder.readInt32();
    if (constructor !== PARTIAL_BLOCK_PROOF_TL_ID) {
      throw new Error(`Unexpected TON partial-block-proof constructor: ${constructor}`);
    }
    const complete = decoder.readBool();
    const from = Codecs.tonNode_blockIdExt.decode(decoder);
    const to = Codecs.tonNode_blockIdExt.decode(decoder);
    const steps = decodeBoundedVector(
      decoder,
      MAX_BLOCK_PROOF_STEPS,
      'TON partial block-proof chain',
      decodeOwnedBlockLink
    );
    return {
      kind: 'liteServer.partialBlockProof' as const,
      complete,
      from,
      to,
      steps,
    };
  },
};

const assertSimplexCandidateBindsTarget = (candidate: Buffer, target: LiteBlockId) => {
  let offset = 0;
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > candidate.length) {
      throw new Error('Simplex candidate is truncated.');
    }
    const value = candidate.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const readInt32 = () => take(4).readInt32LE(0);
  const readInt64 = () => take(8).readBigInt64LE(0).toString();
  const readHash = () => Buffer.from(take(32));

  const constructor = readInt32();
  if (
    constructor !== CANDIDATE_HASH_DATA_ORDINARY_TL_ID &&
    constructor !== CANDIDATE_HASH_DATA_EMPTY_TL_ID
  ) {
    throw new Error('Simplex candidate has an unsupported constructor.');
  }
  const block: LiteBlockId = {
    workchain: readInt32(),
    shard: readInt64(),
    seqno: readInt32(),
    rootHash: readHash(),
    fileHash: readHash(),
  };
  assertBlockId(block, target, 'Simplex candidate block');

  if (constructor === CANDIDATE_HASH_DATA_ORDINARY_TL_ID) {
    readHash();
    const parentConstructor = readInt32();
    if (parentConstructor === CANDIDATE_PARENT_TL_ID) {
      if (readInt32() !== CANDIDATE_ID_TL_ID) {
        throw new Error('Simplex candidate parent has an invalid candidate-id constructor.');
      }
      readInt32();
      readHash();
    } else if (parentConstructor !== CANDIDATE_WITHOUT_PARENTS_TL_ID) {
      throw new Error('Simplex candidate has an invalid parent constructor.');
    }
  } else {
    readInt32();
    readHash();
  }

  if (offset !== candidate.length) {
    throw new Error('Simplex candidate contains trailing data.');
  }
};

export class LiteClientDataSource implements TonDataSource {
  network: Network;
  private client: LiteClient;
  private masterchainRef: LiteMasterchainRef | null = null;
  private masterchainRefExpiresAt = 0;
  private masterchainRefPending: Promise<LiteMasterchainRef> | null = null;

  private constructor(network: Network, client: LiteClient) {
    this.network = network;
    this.client = client;
  }

  static async create(network: Network, pool?: string) {
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
    const engine = new LiteRoundRobinEngine(engines);
    const client = new LiteClient({ engine });
    return new LiteClientDataSource(network, client);
  }

  private async call<T>(fn: (client: LiteClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await fn(this.client);
      } catch (error) {
        lastError = error;
        if (attempt < RETRY_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
        }
      }
    }
    throw lastError;
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

  private async getBlockProof(
    knownBlock: {
      seqno: number;
      workchain: number;
      shard: string;
      rootHash: Buffer;
      fileHash: Buffer;
    },
    targetBlock: {
      seqno: number;
      workchain: number;
      shard: string;
      rootHash: Buffer;
      fileHash: Buffer;
    }
  ) {
    return this.queryLite(() =>
      this.client.engine.query(ownedGetBlockProofFunction, {
        kind: 'liteServer.getBlockProof',
        // Bit 0 is mandatory when targetBlock is supplied. Without it the
        // liteserver silently proves its moving latest head instead.
        mode: 1,
        knownBlock: {
          kind: 'tonNode.blockIdExt',
          seqno: knownBlock.seqno,
          shard: knownBlock.shard,
          workchain: knownBlock.workchain,
          rootHash: knownBlock.rootHash,
          fileHash: knownBlock.fileHash,
        },
        targetBlock: {
          kind: 'tonNode.blockIdExt',
          seqno: targetBlock.seqno,
          shard: targetBlock.shard,
          workchain: targetBlock.workchain,
          rootHash: targetBlock.rootHash,
          fileHash: targetBlock.fileHash,
        },
      })
    );
  }

  private extractForwardSignatureSet(
    proof: any,
    target: {
      seqno: number;
      workchain: number;
      shard: string;
      rootHash: Buffer;
      fileHash: Buffer;
    }
  ) {
    const steps = Array.isArray(proof?.steps) ? proof.steps : [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (!step || step.kind !== 'liteServer.blockLinkForward') continue;
      const to = step.to;
      if (
        to?.seqno !== target.seqno ||
        to?.workchain !== target.workchain ||
        to?.shard !== target.shard ||
        !Buffer.isBuffer(to?.rootHash) ||
        !Buffer.isBuffer(to?.fileHash)
      ) {
        continue;
      }
      if (!to.rootHash.equals(target.rootHash) || !to.fileHash.equals(target.fileHash)) {
        continue;
      }
      const signatures = Array.isArray(step.signatures?.signatures) ? step.signatures.signatures : [];
      if (signatures.length === 0) {
        throw new Error('Target masterchain block proof does not contain validator signatures.');
      }
      const mappedSignatures = signatures.map((signature: any) => ({
        nodeIdShortHex: bytesToHex(signature.nodeIdShort),
        signatureHex: bytesToHex(signature.signature),
      }));
      if (step.signatures?.kind === 'liteServer.signatureSet.simplex') {
        const sessionId = step.signatures.sessionId;
        const candidate = step.signatures.candidate;
        const slot = Number(step.signatures.slot);
        if (!Buffer.isBuffer(sessionId) || sessionId.length !== 32) {
          throw new Error('Simplex signature set has an invalid session id.');
        }
        if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
          throw new Error('Simplex signature set has an empty candidate.');
        }
        if (!Number.isInteger(slot) || slot < 0 || slot > 0xffffffff) {
          throw new Error('Simplex signature set has an invalid slot.');
        }
        assertSimplexCandidateBindsTarget(candidate, target);
        return {
          scheme: 'simplex' as const,
          // TL decodes these uint32 protocol fields through signed int32 values.
          validatorListHashShort: Number(step.signatures.validatorSetHash) >>> 0,
          catchainSeqno: Number(step.signatures.ccSeqno) >>> 0,
          signatures: mappedSignatures,
          sessionIdHex: bytesToHex(sessionId),
          slot,
          candidateBase64: bytesToBase64(candidate),
        };
      }
      if (step.signatures?.kind !== 'liteServer.signatureSet') {
        throw new Error('Target masterchain block proof has an unsupported signature-set kind.');
      }
      return {
        scheme: 'ordinary' as const,
        // TL decodes these uint32 protocol fields through signed int32 values.
        validatorListHashShort: Number(step.signatures.validatorSetHash) >>> 0,
        catchainSeqno: Number(step.signatures.catchainSeqno) >>> 0,
        signatures: mappedSignatures,
      };
    }
    throw new Error('Failed to locate a forward block-proof step for the target masterchain block.');
  }

  async getMasterchainInfo(): Promise<MasterchainInfo> {
    const master = await this.call((client) => client.getMasterchainInfoExt());
    return {
      seqno: master.last.seqno,
      timestamp: master.now ?? undefined,
    };
  }

  async getTonSccpBurnProofMaterial(
    request: TonSccpBurnProofMaterialRequest
  ): Promise<TonSccpBurnProofMaterial> {
    if (request.trustedCheckpointSeqno === undefined || request.trustedCheckpointHashHex === undefined) {
      throw new Error('trusted checkpoint must be resolved before querying TON proof material.');
    }
    const jettonMaster = Address.parse(request.jettonMaster);
    const trustedCheckpointHash = parseHex256(request.trustedCheckpointHashHex, 'trustedCheckpointHashHex');
    const trustedCheckpoint = await this.lookupMasterchainBlock(request.trustedCheckpointSeqno);
    if (!trustedCheckpoint.id.rootHash.equals(trustedCheckpointHash)) {
      throw new Error('Trusted checkpoint hash does not match the resolved masterchain block.');
    }

    const targetBlockId =
      request.targetSeqno !== undefined
        ? (await this.lookupMasterchainBlock(request.targetSeqno)).id
        : (await this.getMasterchainRef()).last;
    if (targetBlockId.seqno < trustedCheckpoint.id.seqno) {
      throw new Error('Target masterchain block precedes the trusted checkpoint.');
    }

    const burnRecord = await this.runGetMethod(jettonMaster.toRawString(), 'get_sccp_burn_record', [
      { type: 'int', value: BigInt(request.messageIdHex) },
    ]);
    const burnRecordPresent = Boolean(
      burnRecord &&
        burnRecord.exitCode === 0 &&
        Array.isArray(burnRecord.stack) &&
        burnRecord.stack[0]?.type !== 'null'
    );
    if (!burnRecordPresent) {
      throw new Error('Burn record is not available on the jetton master yet.');
    }

    const accountState = await this.call((client) => client.getAccountStateRaw(jettonMaster, targetBlockId));
    assertBlockId(accountState.block, targetBlockId, 'SCCP account-state masterchain block');

    const shardBlockId = accountState.shardBlock;
    const [checkpointBlockData, checkpointConfig, targetBlockData, targetProof, shardBlockData] =
      await Promise.all([
        this.getBlockData(trustedCheckpoint.id),
        this.getMasterchainConfigProof(trustedCheckpoint.id),
        this.getBlockData(targetBlockId),
        this.getBlockProof(trustedCheckpoint.id, targetBlockId),
        this.getBlockData(shardBlockId),
      ]);
    assertBlockId(checkpointBlockData.id, trustedCheckpoint.id, 'Trusted-checkpoint block response');
    assertBlockId(checkpointConfig.id, trustedCheckpoint.id, 'Trusted-checkpoint config response');
    assertBlockId(targetBlockData.id, targetBlockId, 'Target masterchain block response');
    assertBlockId(shardBlockData.id, shardBlockId, 'Target shard block response');
    if (!targetProof.complete) {
      throw new Error('TON block proof is incomplete for the requested target masterchain block.');
    }
    assertBlockId(targetProof.from, trustedCheckpoint.id, 'TON block-proof checkpoint');
    assertBlockId(targetProof.to, targetBlockId, 'TON block-proof target');

    const checkpointBlockProof = parseMerkleProofRoots(
      checkpointConfig.stateProof,
      1,
      'trusted-checkpoint block proof'
    )[0];
    assertBlockProofRoot(checkpointBlockProof, trustedCheckpoint.id, 'Trusted-checkpoint block proof');
    const checkpointState = parseMerkleProofRoots(
      checkpointConfig.configProof,
      1,
      'trusted-checkpoint config proof'
    )[0].refs[0];
    assertShardStateIdentity(checkpointState, trustedCheckpoint.id, 'Trusted-checkpoint config proof');

    const targetProofRoots = parseMerkleProofRoots(
      accountState.shardProof,
      2,
      'target masterchain shard proof'
    );
    assertBlockProofRoot(targetProofRoots[0], targetBlockId, 'Target masterchain block proof');
    const targetState = targetProofRoots[1].refs[0];
    assertShardStateIdentity(targetState, targetBlockId, 'Target masterchain shard proof');

    const accountProofRoots = parseMerkleProofRoots(
      accountState.proof,
      2,
      'jetton-master account proof'
    );
    assertBlockProofRoot(accountProofRoots[0], shardBlockId, 'Target shard block proof');
    const partialShardState = accountProofRoots[1].refs[0];
    assertShardStateIdentity(partialShardState, shardBlockId, 'Jetton-master account proof');
    const accountRoot = parseBoundAccountRoot(accountState.raw, jettonMaster);
    const shardState = graftAccountIntoShardState(partialShardState, accountRoot, jettonMaster);

    return {
      trustedCheckpoint: blockIdToResponse(trustedCheckpoint.id),
      targetMasterchain: blockIdToResponse(targetBlockId),
      targetSignatures: this.extractForwardSignatureSet(targetProof, targetBlockId),
      targetShard: blockIdToResponse(shardBlockId),
      checkpointBlockBoc: bytesToBase64(checkpointBlockData.data),
      checkpointStateBoc: bytesToBase64(checkpointState.toBoc({ idx: false })),
      targetBlockBoc: bytesToBase64(targetBlockData.data),
      targetStateBoc: bytesToBase64(targetState.toBoc({ idx: false })),
      shardBlockBoc: bytesToBase64(shardBlockData.data),
      shardStateBoc: bytesToBase64(shardState.toBoc({ idx: false })),
      burnRecordPresent,
    };
  }

  async getAccountState(address: string): Promise<AccountStateResponse> {
    const master = await this.getMasterchainRef();
    const parsed = Address.parse(address);
    const state = await this.call((client) => client.getAccountState(parsed, master.last));
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

    const parsedTxs = decodeTransactions(txs.transactions);

    return parsedTxs.map((tx) => {
      const statusInfo = evaluateStatus(tx);
      return {
        lt: tx.lt.toString(),
        hash: tx.hash().toString('base64'),
        prevTransactionLt: tx.prevTransactionLt.toString(),
        prevTransactionHash: bigintToBuffer(tx.prevTransactionHash).toString('base64'),
        utime: tx.now,
        success: statusInfo.success,
        status: statusInfo.status,
        reason: statusInfo.reason,
        inMessage: mapMessage(tx.inMessage ? tx.inMessage : undefined),
        outMessages: Array.from(tx.outMessages.values()).map(mapMessage).filter(Boolean) as RawMessage[],
      };
    });
  }

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    try {
      const target = Address.parse(address);
      const master = await this.getMasterchainRef();
      const params = args.length > 0 ? serializeTuple(args).toBoc({ idx: false, crc32: false }) : Buffer.alloc(0);
      const res = await this.call((client) => client.runMethod(target, method, params, master.last));
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
    } catch {
      return null;
    }
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
