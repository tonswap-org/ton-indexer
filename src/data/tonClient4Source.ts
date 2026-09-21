import { decodeOriginalTransaction, assertOriginalTransactionPage } from './transactionEvidence';
import { Address, Cell, Transaction, TupleItem } from '@ton/core';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { getHttpV4Endpoint, getHttpV4Endpoints } from '@orbs-network/ton-access';
import { Network } from '../models';
import {
  AccountStateResponse,
  MasterchainInfo,
  RawTransaction,
  TonDataSource
} from './dataSource';
import { parseJettonMetadata } from '../utils/jettonMetadata';
import {
  cellFromAccountCodeBoc,
  isSuccessfulGetterResult,
  parseCanonicalJettonRootData,
  readCanonicalJettonBalance
} from './jettonAbi';

type TonClient4Like = {
  getLastBlock(): Promise<any>;
  getAccount(seqno: number, address: Address): Promise<any>;
  getAccountLite(seqno: number, address: Address): Promise<any>;
  getAccountTransactions(address: Address, lt: bigint, hash: Buffer): Promise<Array<{ tx: Transaction; block: { workchain: number } }>>;
  runMethod(seqno: number, address: Address, name: string, args?: TupleItem[]): Promise<any>;
};

export type TonClient4HttpAdapter = (
  config: unknown
) => Promise<{ data: unknown; [key: string]: unknown }>;

type TonClient4Ctor = new (args: {
  endpoint: string;
  httpAdapter?: TonClient4HttpAdapter;
}) => TonClient4Like;

const tonExports = require('ton') as {
  TonClient4?: TonClient4Ctor;
};

const TonClient4Ctor = tonExports.TonClient4;

const hasTonClient4 =
  typeof TonClient4Ctor === 'function' && typeof (TonClient4Ctor as any).prototype === 'object';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const STORAGE_STAT_JSON_FIELD = '"storageStat"';

const parseHttpJson = (value: unknown): unknown => {
  if (typeof value === 'string') {
    if (!value.includes(STORAGE_STAT_JSON_FIELD)) return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (Buffer.isBuffer(value)) {
    if (!value.includes(STORAGE_STAT_JSON_FIELD)) return value;
    try {
      return JSON.parse(value.toString('utf8'));
    } catch {
      return value;
    }
  }
  return value;
};

export const normalizeTonClient4AccountResponse = (value: unknown): unknown => {
  const parsed = parseHttpJson(value);
  const root = asRecord(parsed);
  const account = asRecord(root?.account);
  const storageStat = asRecord(account?.storageStat);
  const used = asRecord(storageStat?.used);
  if (
    !root ||
    !account ||
    !storageStat ||
    !used ||
    used.publicCells !== undefined ||
    typeof used.bits !== 'number' ||
    !Number.isFinite(used.bits) ||
    typeof used.cells !== 'number' ||
    !Number.isFinite(used.cells)
  ) {
    return value;
  }

  // ton@13.9.0 requires this obsolete field, while current Ton API V4
  // responses omit it. It is not consumed by the indexer; supplying zero only
  // restores compatibility with the old codec before our account mapper runs.
  return {
    ...root,
    account: {
      ...account,
      storageStat: {
        ...storageStat,
        used: {
          ...used,
          publicCells: 0
        }
      }
    }
  };
};

export const createTonClient4CompatibilityAdapter = (
  adapter: TonClient4HttpAdapter
): TonClient4HttpAdapter => async (config) => {
  const response = await adapter(config);
  return {
    ...response,
    data: normalizeTonClient4AccountResponse(response.data)
  };
};

const resolveTonClient4DefaultAdapter = (): TonClient4HttpAdapter | undefined => {
  try {
    // Resolve Axios from ton itself so the compatibility layer does not depend
    // on a separately hoisted, undeclared package.
    const tonRequire = createRequire(require.resolve('ton/package.json'));
    const axios = tonRequire('axios') as {
      defaults?: { adapter?: unknown };
      getAdapter?: (adapter: unknown) => unknown;
    };
    const candidate =
      typeof axios.getAdapter === 'function'
        ? axios.getAdapter(axios.defaults?.adapter ?? 'http')
        : axios.defaults?.adapter;
    return typeof candidate === 'function'
      ? (candidate as TonClient4HttpAdapter)
      : undefined;
  } catch {
    return undefined;
  }
};

const defaultTonClient4Adapter = resolveTonClient4DefaultAdapter();

const createTonClient4 = (endpoint: string): TonClient4Like => {
  if (!TonClient4Ctor) {
    throw new Error('TonClient4 is unavailable.');
  }
  return new TonClient4Ctor({
    endpoint,
    ...(defaultTonClient4Adapter
      ? { httpAdapter: createTonClient4CompatibilityAdapter(defaultTonClient4Adapter) }
      : {})
  });
};

const readStateKind = (value: unknown): 'active' | 'uninitialized' | 'frozen' | null => {
  const record = asRecord(value);
  const typeRaw = typeof value === 'string' ? value : typeof record?.type === 'string' ? record.type : null;
  const normalized = (typeRaw ?? '').trim().toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'frozen') return 'frozen';
  if (normalized === 'uninit' || normalized === 'uninitialized' || normalized === 'inactive') return 'uninitialized';
  return null;
};

const readBocString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (value && typeof value === 'object' && 'bytes' in value) {
    const bytes = (value as Record<string, unknown>).bytes;
    if (typeof bytes === 'string' && bytes.trim().length > 0) return bytes.trim();
  }
  return null;
};

const readCellLikeBoc = (value: unknown): string | null => {
  const direct = readBocString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { toBoc?: (...args: unknown[]) => Buffer | Uint8Array };
  if (typeof candidate.toBoc !== 'function') return null;
  try {
    const boc = candidate.toBoc();
    return Buffer.from(boc).toString('base64');
  } catch {
    return null;
  }
};

const readNestedRecord = (value: unknown, key: string): Record<string, unknown> | null => {
  const record = asRecord(value);
  if (!record) return null;
  return asRecord(record[key]);
};

const readBalanceString = (value: unknown): string => {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'bigint') return value.toString(10);
  const record = asRecord(value);
  if (!record) return '0';
  const coins = record.coins;
  if (typeof coins === 'string' && coins.trim().length > 0) return coins.trim();
  if (typeof coins === 'number' && Number.isFinite(coins)) return String(Math.trunc(coins));
  if (typeof coins === 'bigint') return coins.toString(10);
  return '0';
};

const readLastTxLt = (lastTx: unknown): string | undefined => {
  const record = asRecord(lastTx);
  if (!record) return undefined;
  const lt = record.lt;
  if (typeof lt === 'string' && lt.trim().length > 0) return lt.trim();
  if (typeof lt === 'number' && Number.isFinite(lt)) return String(Math.trunc(lt));
  if (typeof lt === 'bigint') return lt.toString(10);
  return undefined;
};

const decodeHash32 = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value.length === 32 ? Buffer.from(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (normalized.length % 4 === 1) return null;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length !== 32) return null;
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) return null;
  return decoded;
};

const requireHash32 = (value: unknown, label: string): Buffer => {
  const decoded = decodeHash32(value);
  if (!decoded) throw new Error(`${label} must be a 32-byte hex or base64 transaction hash.`);
  return decoded;
};

const readLastTxHash = (lastTx: unknown): string | undefined => {
  const record = asRecord(lastTx);
  if (!record) return undefined;
  return decodeHash32(record.hash)?.toString('base64');
};

const parseRunMethodResponse = (response: unknown): { exitCode: number; stack: TupleItem[] } | null => {
  const record = asRecord(response);
  if (!record) return null;
  const rawExitCode = record.exitCode ?? record.exit_code;
  const exitCode = typeof rawExitCode === 'number' ? rawExitCode : Number.NaN;
  if (!Number.isFinite(exitCode)) return null;

  let stack: TupleItem[] = [];
  const result = record.result;
  if (Array.isArray(result)) {
    stack = result as TupleItem[];
  } else if (Array.isArray(record.stack)) {
    stack = record.stack as TupleItem[];
  } else {
    const readerRecord = asRecord(record.reader);
    if (readerRecord && Array.isArray(readerRecord.items)) {
      stack = readerRecord.items as TupleItem[];
    }
  }
  return { exitCode, stack };
};

export class TonClient4DataSource implements TonDataSource {
  network: Network;
  private client: TonClient4Like;
  private endpoints: string[];
  private endpointIndex = 0;
  private lastBlock: any | null = null;
  private lastBlockExpiresAt = 0;
  private lastBlockPending: Promise<any> | null = null;

  private static readonly LAST_BLOCK_TTL_MS = 1_000;

  private constructor(network: Network, client: TonClient4Like, endpoints: string[]) {
    this.network = network;
    this.client = client;
    this.endpoints = endpoints;
  }

  static isAvailable() {
    return hasTonClient4;
  }

  static async create(network: Network, endpoint?: string) {
    if (!hasTonClient4) {
      throw new Error(
        'TonClient4 is not available from the installed "ton" package. Set TON_DATASOURCE=lite or upgrade "ton".'
      );
    }
    if (!TonClient4Ctor) {
      throw new Error(
        'TonClient4 is not available from the installed "ton" package. Set TON_DATASOURCE=lite or upgrade "ton".'
      );
    }
    if (endpoint) {
      const client = createTonClient4(endpoint);
      return new TonClient4DataSource(network, client, [endpoint]);
    }
    if (network === 'localnet') {
      throw new Error('TON_HTTP_ENDPOINT is required when TON_NETWORK=localnet and TON_DATASOURCE=http');
    }

    let endpoints = await getHttpV4Endpoints({ network });
    if (!endpoints || endpoints.length === 0) {
      endpoints = [await getHttpV4Endpoint({ network })];
    }
    const client = createTonClient4(endpoints[0]);
    return new TonClient4DataSource(network, client, endpoints);
  }

  async getMasterchainInfo(): Promise<MasterchainInfo> {
    const last = await this.getLastBlockCached();
    return {
      seqno: last.last.seqno,
      // V4 exposes server time, not the canonical masterblock creation time.
      // Do not report server clock as a chain freshness watermark.
    };
  }

  async getAccountState(address: string): Promise<AccountStateResponse> {
    const last = await this.getLastBlockCached();
    const parsed = Address.parse(address);
    const account = await this.call((client) => client.getAccount(last.last.seqno, parsed));
    return this.mapAccountStateResponse(account);
  }

  async getAccountStateAtSeqno(address: string, seqno: number): Promise<AccountStateResponse> {
    if (!Number.isSafeInteger(seqno) || seqno < 0) throw new Error('Invalid archival block');
    return this.mapAccountStateResponse(await this.call(client => client.getAccount(seqno, Address.parse(address))));
  }

  async getAccountStateLite(address: string): Promise<AccountStateResponse> {
    const last = await this.getLastBlockCached();
    const parsed = Address.parse(address);
    const account = await this.call((client) => client.getAccountLite(last.last.seqno, parsed));
    return this.mapAccountStateResponse(account);
  }

  private mapAccountStateResponse(account: unknown): AccountStateResponse {
    const accountRecord = asRecord(account);
    const accountStateRecord = readNestedRecord(accountRecord, 'account');
    const stateRaw = accountStateRecord?.state;
    const stateType = readStateKind(stateRaw);
    const stateRecord = asRecord(stateRaw);
    const nestedStateRecord = readNestedRecord(stateRecord, 'state');

    const codeBoc =
      readCellLikeBoc(stateRecord?.code) ??
      readCellLikeBoc(nestedStateRecord?.code) ??
      readCellLikeBoc(accountStateRecord?.code) ??
      null;
    const dataBoc =
      readCellLikeBoc(stateRecord?.data) ??
      readCellLikeBoc(nestedStateRecord?.data) ??
      readCellLikeBoc(accountStateRecord?.data) ??
      null;
    const lastTx = accountStateRecord?.last ?? accountRecord?.last;

    return {
      balance: readBalanceString(accountStateRecord?.balance ?? accountRecord?.balance),
      lastTxLt: readLastTxLt(lastTx),
      lastTxHash: readLastTxHash(lastTx),
      accountState: stateType,
      codeBoc,
      dataBoc
    };
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]> {
    const parsed = Address.parse(address);

    let cursorLt = lt;
    let cursorHash = hash;

    if (!cursorLt || !cursorHash) {
      const last = await this.getLastBlockCached();
      const account = await this.call((client) => client.getAccount(last.last.seqno, parsed));
      const lastTx = account.account.last;
      if (!lastTx) return [];
      cursorLt = lastTx.lt;
      cursorHash = lastTx.hash;
    }

    if (!cursorLt || !cursorHash) {
      return [];
    }

    const cursorHashBytes = requireHash32(cursorHash, 'Transaction cursor hash');
    const txs = await this.call((client) => client.getAccountTransactions(parsed, BigInt(cursorLt), cursorHashBytes));
    const page = txs.slice(0, limit).map(({ tx, block }) => {
      if (block.workchain !== parsed.workChain) throw new Error('Transaction evidence block belongs to a different workchain.');
      return decodeOriginalTransaction(tx.raw, parsed);
    });
    if (page.length === 0) return [];
    return assertOriginalTransactionPage(page, parsed, { lt: BigInt(cursorLt).toString(), hash: cursorHashBytes.toString('base64') });
  }

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    const parsed = Address.parse(address);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const forceFreshBlock = attempt > 0;
        const last = await this.getLastBlockCached(forceFreshBlock);
        const response = await this.call((client) => client.runMethod(last.last.seqno, parsed, method, args));
        const parsedResponse = parseRunMethodResponse(response);
        if (!parsedResponse) {
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
            continue;
          }
          return null;
        }

        if (parsedResponse.exitCode === 0) {
          return parsedResponse;
        }

        // Non-zero exit codes from TonClient4 can be transient around recent blocks; retry on
        // negative codes and generic VM failures before surfacing them.
        if (parsedResponse.exitCode < 0 && attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
          continue;
        }

        return parsedResponse;
      } catch {
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  private async getLastBlockCached(force = false): Promise<any> {
    const now = Date.now();
    if (!force && this.lastBlock && this.lastBlockExpiresAt > now) {
      return this.lastBlock;
    }
    if (!force && this.lastBlockPending) {
      return this.lastBlockPending;
    }
    const pending = this.call((client) => client.getLastBlock())
      .then((last) => {
        this.lastBlock = last;
        this.lastBlockExpiresAt = Date.now() + TonClient4DataSource.LAST_BLOCK_TTL_MS;
        return last;
      })
      .finally(() => {
        this.lastBlockPending = null;
      });
    this.lastBlockPending = pending;
    return pending;
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

  private async call<T>(fn: (client: TonClient4Like) => Promise<T>): Promise<T> {
    let lastError: unknown;
    const attempts = Math.max(1, this.endpoints.length);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fn(this.client);
      } catch (error) {
        lastError = error;
        if (this.endpoints.length <= 1) break;
        this.rotateEndpoint();
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private rotateEndpoint() {
    if (this.endpoints.length <= 1) return;
    this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    if (!TonClient4Ctor) {
      throw new Error('TonClient4 unavailable while rotating endpoint');
    }
    this.client = createTonClient4(this.endpoints[this.endpointIndex]);
    // Drop cached masterchain references on endpoint rotation to avoid sticking to a stale instance.
    this.lastBlock = null;
    this.lastBlockExpiresAt = 0;
    this.lastBlockPending = null;
  }

  async close(): Promise<void> {
    // TonClient4 has no explicit close.
  }
}
