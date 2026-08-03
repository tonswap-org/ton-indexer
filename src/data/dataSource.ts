import { TupleItem } from '@ton/core';
import { Buffer } from 'node:buffer';
import { Network } from '../models';
import { JettonMetadata } from '../models';

export type RawMessage = {
  source?: string;
  destination?: string;
  value?: string;
  op?: number;
  body?: string;
};

export type RawTransactionStatus = 'success' | 'failed' | 'pending';

export type RawTransaction = {
  lt: string;
  hash: string;
  prevTransactionLt?: string;
  prevTransactionHash?: string;
  utime: number;
  success: boolean;
  status?: RawTransactionStatus;
  reason?: string;
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
  balance: string;
  lastTxLt?: string;
  lastTxHash?: string;
  accountState?: 'active' | 'uninitialized' | 'frozen' | null;
  codeBoc?: string | null;
  dataBoc?: string | null;
};

export type MasterchainInfo = {
  seqno: number;
  timestamp?: number;
};

export type TonBlockIdExt = {
  seqno: number;
  workchain: number;
  shard: string;
  rootHashHex: string;
  fileHashHex: string;
};

export type TonSccpProofSignature = {
  nodeIdShortHex: string;
  signatureHex: string;
};

export type TonSccpProofOrdinarySignatureSet = {
  scheme?: 'ordinary';
  validatorListHashShort: number;
  catchainSeqno: number;
  signatures: TonSccpProofSignature[];
};

export type TonSccpProofSimplexSignatureSet = {
  scheme: 'simplex';
  validatorListHashShort: number;
  catchainSeqno: number;
  signatures: TonSccpProofSignature[];
  sessionIdHex: string;
  slot: number;
  candidateBase64: string;
};

export type TonSccpProofSignatureSet =
  | TonSccpProofOrdinarySignatureSet
  | TonSccpProofSimplexSignatureSet;

export type TonSccpBurnProofMaterialRequest = {
  jettonMaster: string;
  messageIdHex: string;
  trustedCheckpointSeqno?: number;
  trustedCheckpointHashHex?: string;
  targetSeqno?: number;
};

export type TonSccpBurnProofMaterial = {
  trustedCheckpoint: TonBlockIdExt;
  targetMasterchain: TonBlockIdExt;
  targetSignatures: TonSccpProofSignatureSet;
  targetShard: TonBlockIdExt;
  checkpointBlockBoc: string;
  checkpointStateBoc: string;
  targetBlockBoc: string;
  targetStateBoc: string;
  shardBlockBoc: string;
  shardStateBoc: string;
  burnRecordPresent: boolean;
};

export interface TonDataSource {
  network: Network;
  getMasterchainInfo(): Promise<MasterchainInfo>;
  getAccountState(address: string): Promise<AccountStateResponse>;
  getAccountStateLite?(address: string): Promise<AccountStateResponse>;
  getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]>;
  runGetMethod(
    address: string,
    method: string,
    args?: TupleItem[]
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null>;
  getTonSccpBurnProofMaterial?(request: TonSccpBurnProofMaterialRequest): Promise<TonSccpBurnProofMaterial>;
  // Canonical TEP-74 only. Implementations return null unless the root and
  // wallet getters have exact canonical shapes and the wallet owner/root/code
  // identities can be verified against active account code.
  getJettonBalance(owner: string, master: string): Promise<{ wallet: string; balance: string } | null>;
  getJettonMetadata(master: string): Promise<JettonMetadata | null>;
  close(): Promise<void>;
}
