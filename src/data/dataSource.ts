import { TupleItem } from '@ton/core';
import { Buffer } from 'node:buffer';
import { Network } from '../models';

export type RawMessage = {
  source?: string;
  destination?: string;
  value?: string;
  op?: number;
  body?: string;
  createdLt?: string;
  bounced?: boolean;
  forwardFeeRaw?: string;
  /** TVM12+ message extra_flags (the SDK calls this ihrFee); never a coin amount. */
  extraFlagsRaw?: string;
};

export type RawTransactionStatus = 'success' | 'failed' | 'pending';

export type RawTransaction = {
  /** Original provider transaction Cell BOC, never reconstructed from summaries. Required for evidence reads. */
  rawBoc?: string;
  lt: string;
  hash: string;
  prevTransactionLt?: string;
  prevTransactionHash?: string;
  utime: number;
  success: boolean;
  status?: RawTransactionStatus;
  reason?: string;
  /** Total native transaction fees in atomic units; absent when the source did not supply them. */
  totalFeesRaw?: string;
  inMessage?: RawMessage;
  outMessages: RawMessage[];
};

export type TransactionCursor = {
  lt: string;
  hash: string;
};

const MAX_UINT64 = 0xffffffffffffffffn;

const parseCanonicalLt = (value: unknown): bigint | null => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT64 ? parsed : null;
  } catch {
    return null;
  }
};

const parseHash32 = (value: unknown): Buffer | null => {
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

const sameHash32 = (left: Buffer, right: Buffer) => left.equals(right);

type ParsedLinkedTransaction = {
  lt: bigint;
  hash: Buffer;
  prevLt: bigint;
  prevHash: Buffer;
};

const parseLinkedTransactionPage = (
  transactions: readonly RawTransaction[]
): ParsedLinkedTransaction[] | null => {
  if (transactions.length === 0) return null;
  const parsed = transactions.map((transaction) => ({
    lt: parseCanonicalLt(transaction.lt),
    hash: parseHash32(transaction.hash),
    prevLt: parseCanonicalLt(transaction.prevTransactionLt),
    prevHash: parseHash32(transaction.prevTransactionHash),
  }));
  if (
    parsed.some(
      (transaction) =>
        transaction.lt === null ||
        transaction.lt <= 0n ||
        transaction.hash === null ||
        transaction.prevLt === null ||
        transaction.prevHash === null
    )
  ) {
    return null;
  }
  return parsed as ParsedLinkedTransaction[];
};

const transactionMatchesCursor = (
  transaction: ParsedLinkedTransaction | undefined,
  cursor: TransactionCursor | undefined
) => {
  if (!cursor) return true;
  const cursorLt = parseCanonicalLt(cursor.lt);
  const cursorHash = parseHash32(cursor.hash);
  return Boolean(
    transaction &&
      cursorLt !== null &&
      cursorLt > 0n &&
      cursorHash &&
      transaction.lt === cursorLt &&
      sameHash32(transaction.hash, cursorHash)
  );
};

const parseLinkedInclusiveSegment = (
  transactions: readonly RawTransaction[],
  expectedFirst?: TransactionCursor,
  expectedLast?: TransactionCursor
): ParsedLinkedTransaction[] | null => {
  const parsed = parseLinkedTransactionPage(transactions);
  if (
    !parsed ||
    !transactionMatchesCursor(parsed[0], expectedFirst) ||
    !transactionMatchesCursor(parsed[parsed.length - 1], expectedLast)
  ) {
    return null;
  }
  for (let index = 0; index < parsed.length - 1; index += 1) {
    const current = parsed[index];
    const next = parsed[index + 1];
    if (
      !current ||
      !next ||
      current.prevLt !== next.lt ||
      current.lt <= next.lt ||
      !sameHash32(current.prevHash, next.hash)
    ) {
      return null;
    }
  }
  return parsed;
};

/** Proves one exact, ordered, cursor-inclusive transaction chain segment. */
export const transactionPageIsLinkedInclusiveSegment = (
  transactions: readonly RawTransaction[],
  expectedFirst: TransactionCursor,
  expectedLast: TransactionCursor
): boolean => Boolean(parseLinkedInclusiveSegment(transactions, expectedFirst, expectedLast));

/**
 * Proves that an inclusive transaction page contains one unbroken account
 * history chain through the canonical first-transaction predecessor marker.
 * Missing predecessor data, partial pages, reordered links, and malformed
 * identities all fail closed.
 */
export const transactionPageReachesHistoryStart = (
  transactions: readonly RawTransaction[],
  expectedInclusiveCursor?: TransactionCursor
): boolean => {
  const parsed = parseLinkedInclusiveSegment(
    transactions,
    expectedInclusiveCursor
  );
  if (!parsed) return false;
  const oldest = parsed[parsed.length - 1];
  return Boolean(oldest && oldest.prevLt === 0n && oldest.prevHash.equals(Buffer.alloc(32)));
};

export type AccountStateResponse = {
  anchor?: AccountAnchor;
  balance: string;
  lastTxLt?: string;
  lastTxHash?: string;
  accountState?: 'active' | 'uninitialized' | 'frozen' | null;
  codeBoc?: string | null;
  dataBoc?: string | null;
  /** Exact final transaction boundary retained by authenticated historical replay. */
  replayBoundary?: Readonly<{
    beforeShardAccountBoc: string;
    afterShardAccountBoc: string;
    transactionBoc: string;
    blockBoc: string;
    configBoc: string;
  }>;
};

export type TonBlockIdExt = {
  seqno: number;
  workchain: number;
  shard: string;
  rootHashHex: string;
  fileHashHex: string;
};

export type ChainHead = TonBlockIdExt & { utime: number };
export type AccountAnchor = { shardBlock: TonBlockIdExt; genUtime: number };
export type ReadOptions = { signal?: AbortSignal; at?: ChainHead };
export class ChainReadError extends Error {
  constructor(readonly code: 'upstream_timeout' | 'upstream_unavailable', options?: ErrorOptions) {
    super(code === 'upstream_timeout' ? 'Chain read deadline exceeded.' : 'Chain read unavailable.', options);
    this.name = 'ChainReadError';
  }
}
export interface ChainSource {
  readonly network: Network;
  head(options?: { signal?: AbortSignal }): Promise<ChainHead>;
  read(calls: import('./freshRead').FreshReadCall[], options?: ReadOptions): Promise<{ head: ChainHead; results: import('./freshRead').FreshReadResult[] }>;
  getAccountState(address: string, options?: ReadOptions): Promise<AccountStateResponse>;
  runGetMethod(address: string, method: string, args?: TupleItem[], options?: ReadOptions): Promise<{ exitCode: number; stack: TupleItem[] }>;
  getAccountStateAtSeqno(address: string, seqno: number, options?: { signal?: AbortSignal }): Promise<AccountStateResponse>;
  getAccountStateAtTransaction(address: string, cursor: TransactionCursor, containingSeqno: number, options?: { signal?: AbortSignal }): Promise<AccountStateResponse>;
  getTransactions(address: string, limit: number, lt: string, hash: string, options?: { signal?: AbortSignal }): Promise<RawTransaction[]>;
  sendMessage(boc: Buffer, options?: { signal?: AbortSignal }): Promise<void>;
  health(): { peersConfigured: number; peersReady: number; head: ChainHead | null;
    peers: Array<{ index: number; ready: boolean; open: boolean; failures: number; latencyMs: number | null }> };
  close(): Promise<void>;
}
