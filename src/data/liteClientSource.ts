import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, TupleItem, TupleReader, beginCell, loadTransaction, parseTuple, serializeTuple } from '@ton/core';
import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine, LiteEngine } from 'ton-lite-client';
import { Network } from '../models';
import {
  AccountStateResponse,
  MasterchainInfo,
  RawMessage,
  RawTransaction,
  RawTransactionStatus,
  TonDataSource,
} from './dataSource';
import { parseJettonMetadata } from '../utils/jettonMetadata';

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
      : 'https://ton.org/testnet-global.config.json';
  return await readConfigFromUrl(defaultUrl);
};

const cellToBase64 = (cell: Cell | null | undefined): string | undefined => {
  if (!cell) return undefined;
  return cell.toBoc({ idx: false }).toString('base64');
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
  let parseFailures = 0;
  let lastParseError: Error | null = null;

  for (const cell of cells) {
    try {
      parsed.push(loadTransaction(cell.beginParse()));
    } catch (error) {
      parseFailures += 1;
      if (error instanceof Error) {
        lastParseError = error;
      }
    }
  }

  if (parseFailures > 0 && parsed.length === 0 && cells.length > 0) {
    const suffix = lastParseError?.message ? `: ${lastParseError.message}` : '';
    throw new Error(`Failed to decode transaction page${suffix}`);
  }

  return parsed;
};

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;

export class LiteClientDataSource implements TonDataSource {
  network: Network;
  private client: LiteClient;

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

  private async runGetMethod(address: Address, method: string, args: TupleItem[] = []): Promise<TupleReader> {
    const master = await this.call((client) => client.getMasterchainInfo());
    const params = args.length > 0 ? serializeTuple(args).toBoc({ idx: false, crc32: false }) : Buffer.alloc(0);
    const res = await this.call((client) => client.runMethod(address, method, params, master.last));
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`runMethod ${method} failed with exit code ${res.exitCode}`);
    }
    const tuple = res.result ? parseTuple(Cell.fromBoc(Buffer.from(res.result, 'base64'))[0]) : [];
    return new TupleReader(tuple);
  }

  async getMasterchainInfo(): Promise<MasterchainInfo> {
    const master = await this.call((client) => client.getMasterchainInfoExt());
    return {
      seqno: master.last.seqno,
      timestamp: master.now ?? undefined,
    };
  }

  async getAccountState(address: string): Promise<AccountStateResponse> {
    const master = await this.call((client) => client.getMasterchainInfo());
    const parsed = Address.parse(address);
    const state = await this.call((client) => client.getAccountState(parsed, master.last));
    const lastTx = state.lastTx;
    return {
      balance: state.balance.coins.toString(),
      lastTxLt: lastTx?.lt?.toString(),
      lastTxHash: lastTx ? bigintToBuffer(lastTx.hash).toString('base64') : undefined,
    };
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]> {
    const parsed = Address.parse(address);
    let cursorLt = lt;
    let cursorHash = hash;

    if (!cursorLt || !cursorHash) {
      const master = await this.call((client) => client.getMasterchainInfo());
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
        utime: tx.now,
        success: statusInfo.success,
        status: statusInfo.status,
        reason: statusInfo.reason,
        inMessage: mapMessage(tx.inMessage ? tx.inMessage : undefined),
        outMessages: Array.from(tx.outMessages.values()).map(mapMessage).filter(Boolean) as RawMessage[],
      };
    });
  }

  async getJettonBalance(owner: string, master: string): Promise<{ wallet: string; balance: string } | null> {
    try {
      const ownerAddr = Address.parse(owner);
      const masterAddr = Address.parse(master);
      const args: TupleItem[] = [{ type: 'slice', cell: beginCell().storeAddress(ownerAddr).endCell() }];
      let walletAddr: Address | null = null;
      for (const method of ['wallet_address', 'get_wallet_address']) {
        try {
          const walletReader = await this.runGetMethod(masterAddr, method, args);
          walletAddr = walletReader.readAddress();
          break;
        } catch {
          continue;
        }
      }
      if (!walletAddr) return null;
      let balance: bigint | null = null;
      for (const method of ['wallet_data', 'get_wallet_data']) {
        try {
          const balanceReader = await this.runGetMethod(walletAddr, method);
          balance = balanceReader.readBigNumber();
          break;
        } catch {
          continue;
        }
      }
      if (balance === null) return null;
      return {
        wallet: walletAddr.toString({ urlSafe: true, bounceable: true }),
        balance: balance.toString(),
      };
    } catch {
      return null;
    }
  }

  async getJettonMetadata(master: string) {
    try {
      const masterAddr = Address.parse(master);
      const reader = await this.runGetMethod(masterAddr, 'get_jetton_data');
      reader.readBigNumber();
      reader.readBoolean();
      reader.readAddressOpt();
      const content = reader.readCell();
      return parseJettonMetadata(content);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    // lite client has no explicit close
  }
}
