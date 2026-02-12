import { Address, Cell, TupleItem } from '@ton/core';
import { getHttpV4Endpoint, getHttpV4Endpoints } from '@orbs-network/ton-access';
import { Network } from '../models';
import { AccountStateResponse, MasterchainInfo, RawMessage, RawTransaction, TonDataSource } from './dataSource';
import { parseJettonMetadata } from '../utils/jettonMetadata';

type TonClient4Like = {
  getLastBlock(): Promise<any>;
  getAccount(seqno: number, address: Address): Promise<any>;
  getAccountTransactionsParsed(address: Address, lt: bigint, hash: Buffer, limit: number): Promise<any>;
  runMethod(seqno: number, address: Address, name: string, args?: TupleItem[]): Promise<any>;
  open<T>(contract: T): T;
};

type TonClient4Ctor = new (args: { endpoint: string }) => TonClient4Like;

const tonExports = require('ton') as {
  TonClient4?: TonClient4Ctor;
  JettonMaster?: { create: (address: Address) => any };
  JettonWallet?: { create: (address: Address) => any };
};

const TonClient4Ctor = tonExports.TonClient4;
const JettonMaster = tonExports.JettonMaster;
const JettonWallet = tonExports.JettonWallet;

const hasTonClient4 =
  typeof TonClient4Ctor === 'function' && typeof (TonClient4Ctor as any).prototype === 'object';

const decodeOp = (bodyBase64?: string): number | undefined => {
  if (!bodyBase64) return undefined;
  try {
    const cell = Cell.fromBase64(bodyBase64);
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return undefined;
    const op = slice.loadUint(32);
    return Number(op);
  } catch {
    return undefined;
  }
};

const parseAddress = (raw?: string | null): string | undefined => {
  if (!raw) return undefined;
  return raw;
};

const mapMessage = (message: any): RawMessage | undefined => {
  if (!message) return undefined;
  const info = message.info;
  let source: string | undefined;
  let destination: string | undefined;
  let value: string | undefined;

  if (info?.type === 'internal') {
    source = parseAddress(info.src);
    destination = parseAddress(info.dest);
    value = info.value;
  } else if (info?.type === 'external-in') {
    destination = parseAddress(info.dest);
  } else if (info?.type === 'external-out') {
    // external-out dest can be null or an object; keep it undefined for now.
  }

  const op = decodeOp(message.body);

  return {
    source,
    destination,
    value,
    op,
    body: message.body ?? undefined,
  };
};

export class TonClient4DataSource implements TonDataSource {
  network: Network;
  private client: TonClient4Like;
  private endpoints: string[];
  private endpointIndex = 0;

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
      const client = new TonClient4Ctor({ endpoint });
      return new TonClient4DataSource(network, client, [endpoint]);
    }

    let endpoints = await getHttpV4Endpoints({ network });
    if (!endpoints || endpoints.length === 0) {
      endpoints = [await getHttpV4Endpoint({ network })];
    }
    const client = new TonClient4Ctor({ endpoint: endpoints[0] });
    return new TonClient4DataSource(network, client, endpoints);
  }

  async getMasterchainInfo(): Promise<MasterchainInfo> {
    const last = await this.call((client) => client.getLastBlock());
    return {
      seqno: last.last.seqno,
      timestamp: last.now,
    };
  }

  async getAccountState(address: string): Promise<AccountStateResponse> {
    const last = await this.call((client) => client.getLastBlock());
    const parsed = Address.parse(address);
    const account = await this.call((client) => client.getAccount(last.last.seqno, parsed));
    const lastTx = account.account.last;
    return {
      balance: account.account.balance.coins,
      lastTxLt: lastTx?.lt ?? undefined,
      lastTxHash: lastTx?.hash ?? undefined,
    };
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]> {
    const parsed = Address.parse(address);

    let cursorLt = lt;
    let cursorHash = hash;

    if (!cursorLt || !cursorHash) {
      const last = await this.call((client) => client.getLastBlock());
      const account = await this.call((client) => client.getAccount(last.last.seqno, parsed));
      const lastTx = account.account.last;
      if (!lastTx) return [];
      cursorLt = lastTx.lt;
      cursorHash = lastTx.hash;
    }

    if (!cursorLt || !cursorHash) {
      return [];
    }

    const txs = await this.call((client) =>
      client.getAccountTransactionsParsed(
        parsed,
        BigInt(cursorLt),
        Buffer.from(cursorHash, 'base64'),
        limit
      )
    );

    return txs.transactions.map((tx: any) => {
      const parsedStatus = tx.parsed?.status;
      const status = parsedStatus === 'success' ? 'success' : parsedStatus === 'failed' ? 'failed' : 'pending';
      return {
        lt: tx.lt,
        hash: tx.hash,
        utime: tx.time,
        success: status === 'success',
        status,
        inMessage: mapMessage(tx.inMessage),
        outMessages: (tx.outMessages ?? []).map(mapMessage).filter(Boolean),
      };
    });
  }

  async runGetMethod(
    address: string,
    method: string,
    args: TupleItem[] = []
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null> {
    try {
      const parsed = Address.parse(address);
      const last = await this.call((client) => client.getLastBlock());
      const response = await this.call((client) => client.runMethod(last.last.seqno, parsed, method, args));
      const exitCode =
        typeof response?.exitCode === 'number'
          ? response.exitCode
          : typeof response?.exit_code === 'number'
            ? response.exit_code
            : Number.NaN;
      if (!Number.isFinite(exitCode)) return null;
      let stack: TupleItem[] = [];
      if (Array.isArray(response?.result)) {
        stack = response.result as TupleItem[];
      } else if (Array.isArray(response?.stack)) {
        stack = response.stack as TupleItem[];
      } else if (response?.reader && Array.isArray(response.reader?.items)) {
        stack = response.reader.items as TupleItem[];
      }
      return {
        exitCode,
        stack
      };
    } catch {
      return null;
    }
  }

  async getJettonBalance(owner: string, master: string): Promise<{ wallet: string; balance: string } | null> {
    try {
      if (!JettonMaster || !JettonWallet) return null;
      const ownerAddr = Address.parse(owner);
      const masterAddr = Address.parse(master);
      return await this.call(async (client) => {
        const masterContract = client.open(JettonMaster.create(masterAddr));
        const walletAddr = await masterContract.getWalletAddress(ownerAddr);
        const walletContract = client.open(JettonWallet.create(walletAddr));
        const balance = await walletContract.getBalance();
        return {
          wallet: walletAddr.toString({ urlSafe: true, bounceable: true }),
          balance: balance.toString(),
        };
      });
    } catch {
      return null;
    }
  }

  async getJettonMetadata(master: string) {
    try {
      if (!JettonMaster) return null;
      const masterAddr = Address.parse(master);
      return await this.call(async (client) => {
        const masterContract = client.open(JettonMaster.create(masterAddr));
        const data = await masterContract.getJettonData();
        return parseJettonMetadata(data.content);
      });
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
    this.client = new TonClient4Ctor({ endpoint: this.endpoints[this.endpointIndex] });
  }

  async close(): Promise<void> {
    // TonClient4 has no explicit close.
  }
}
