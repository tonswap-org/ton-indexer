import { Address, Cell, Message, beginCell, loadTransaction, storeStateInit } from '@ton/core';
import {
  RawMessage, RawTransaction, RawTransactionStatus, TonDataSource, TransactionCursor,
  transactionPageIsLinkedInclusiveSegment, transactionPageReachesHistoryStart,
} from './dataSource';

const cellToBase64 = (cell: Cell) => cell.toBoc().toString('base64');
const hash256 = (value: bigint) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex').toString('base64');

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

const mapMessage = (message: Message | null | undefined): RawMessage | undefined => {
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
    createdLt: info?.type === 'internal' ? info.createdLt?.toString() : undefined,
    bounced: info?.type === 'internal' ? info.bounced : undefined,
    forwardFeeRaw: info?.type === 'internal' ? info.forwardFee?.toString() : undefined,
    extraFlagsRaw: info?.type === 'internal' ? info.ihrFee?.toString() : undefined,
  };
};

const formatComputeSkipReason = (reason?: string) => {
  if (!reason) return 'Compute phase skipped.';
  return `Compute phase skipped: ${reason}.`;
};

export const evaluateTransactionStatus = (
  tx: any
): { status: RawTransactionStatus; reason?: string; success: boolean } => {
  const description = tx.description;
  if (!description) return { status: 'pending', success: false };
  // An empty, non-bouncing TON funding message is delivered to an uninitialized
  // account without running code. TVM reports compute-skipped/aborted, but the
  // credit phase has successfully credited its TON. Do not label that receipt a
  // failed transfer; contract calls, bounces and VM failures stay failures.
  const incoming = tx.inMessage;
  if (description.type === 'generic' && description.computePhase?.type === 'skipped' &&
      description.computePhase.reason === 'no-state' &&
      description.creditPhase?.credit?.coins > 0n &&
      incoming?.info?.type === 'internal' && incoming.info.bounce === false &&
      incoming.info.bounced === false && !incoming.init &&
      ((incoming.body.bits.length === 0 && incoming.body.refs.length === 0) || decodeOp(incoming.body) === 0) &&
      tx.outMessages?.size === 0 && !description.bouncePhase) {
    return { status: 'success', success: true };
  }
  if (description.aborted === true) {
    const computeExit = description.computePhase?.exitCode;
    const reason =
      typeof computeExit === 'number'
        ? `Transaction aborted (VM exit code ${computeExit}).`
        : 'Transaction aborted by contract.';
    return { status: 'failed', reason, success: false };
  }
  if (description.type === 'split-install' && description.installed === false) {
    return { status: 'failed', reason: 'Split installation failed.', success: false };
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

  // Lite servers only return transactions already included in a block. Some
  // valid finalized descriptions (notably storage-only transactions) have no
  // compute or action phase, so absence of those phases is not "pending".
  return { status: 'success', success: true };
};


/** Preserve the provider's original cell graph; never reconstruct a transaction from decoded fields. */
export const decodeOriginalTransaction = (cell: Cell, account: Address): RawTransaction => {
  if (cell.isExotic) throw new Error('Transaction evidence must contain an ordinary root cell.');
  const slice = cell.beginParse();
  const tx = loadTransaction(slice);
  slice.endParse();
  if (tx.address !== BigInt(`0x${account.hash.toString('hex')}`)) {
    throw new Error('Transaction evidence belongs to a different account.');
  }
  // The account ID does not encode its workchain; bind all internal/external
  // message endpoints that TL-B provides to the requested complete address.
  if (tx.inMessage && (tx.inMessage.info.type === 'external-out' || !tx.inMessage.info.dest.equals(account))) {
    throw new Error('Transaction input destination does not match the requested account.');
  }
  for (const message of tx.outMessages.values()) {
    if (message.info.type === 'external-in' || !message.info.src.equals(account)) {
      throw new Error('Transaction output source does not match the requested account.');
    }
  }
  if (tx.lt <= 0n || tx.prevTransactionLt >= tx.lt ||
      ((tx.prevTransactionLt === 0n) !== (tx.prevTransactionHash === 0n))) {
    throw new Error('Transaction evidence has an invalid predecessor identity.');
  }
  const status = evaluateTransactionStatus(tx);
  return {
    rawBoc: cell.toBoc().toString('base64'),
    lt: tx.lt.toString(), hash: cell.hash().toString('base64'),
    prevTransactionLt: tx.prevTransactionLt.toString(), prevTransactionHash: hash256(tx.prevTransactionHash),
    utime: tx.now, ...status, totalFeesRaw: tx.totalFees.coins.toString(),
    inMessage: mapMessage(tx.inMessage),
    outMessages: Array.from(tx.outMessages.values()).map(mapMessage).filter(Boolean) as RawMessage[],
  };
};

export const assertOriginalTransactionPage = (
  page: readonly RawTransaction[], account: Address, cursor: TransactionCursor,
): RawTransaction[] => {
  const decoded = page.map((entry) => {
    if (!entry.rawBoc || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.rawBoc)) {
      throw new Error('Original transaction BOC is unavailable or malformed.');
    }
    const bytes = Buffer.from(entry.rawBoc, 'base64');
    if (bytes.toString('base64') !== entry.rawBoc) throw new Error('Transaction BOC is not canonical base64.');
    const roots = Cell.fromBoc(bytes);
    if (roots.length !== 1) throw new Error('Transaction evidence must contain exactly one original root.');
    const original = decodeOriginalTransaction(roots[0], account);
    if (original.lt !== entry.lt || original.hash !== entry.hash ||
        original.prevTransactionLt !== entry.prevTransactionLt || original.prevTransactionHash !== entry.prevTransactionHash) {
      throw new Error('Transaction metadata does not match its original cell.');
    }
    // All response fields come from the original cell, never source summaries.
    return original;
  });
  const last = decoded[decoded.length - 1];
  if (!last || !transactionPageIsLinkedInclusiveSegment(decoded, cursor, last)) {
    throw new Error('Original transaction evidence is not an exact cursor-inclusive linked account segment.');
  }
  return decoded;
};

const canonicalCursor = (lt: string, hash: string): TransactionCursor => {
  if (!/^[0-9]+$/.test(lt) || BigInt(lt) <= 0n || BigInt(lt) > 0xffffffffffffffffn) {
    throw new Error('Invalid transaction evidence logical time.');
  }
  const normalized = hash.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes = /^[0-9a-fA-F]{64}$/.test(hash) ? Buffer.from(hash, 'hex') : Buffer.from(normalized, 'base64');
  if (bytes.length !== 32 || (!/^[0-9a-fA-F]{64}$/.test(hash) && bytes.toString('base64').replace(/=+$/, '') !== normalized)) {
    throw new Error('Invalid transaction evidence hash.');
  }
  return { lt: BigInt(lt).toString(), hash: bytes.toString('base64') };
};

/** Read fresh original evidence directly, independently of the activity-summary cache. */
export const readOriginalTransactionEvidence = async (
  source: TonDataSource, address: string, limit: number, requestedCursor?: TransactionCursor, deadlineAt = Number.POSITIVE_INFINITY,
): Promise<RawTransaction[]> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Transaction evidence limit must be 1 through 50.');
  const account = Address.parse(address);
  const rawAddress = account.toRawString();
  let cursor: TransactionCursor;
  if (requestedCursor) {
    cursor = canonicalCursor(requestedCursor.lt, requestedCursor.hash);
  } else {
    const state = source.getAccountStateLite
      ? await source.getAccountStateLite(rawAddress)
      : await source.getAccountState(rawAddress);
    if (state.lastTxLt === undefined && state.lastTxHash === undefined) {
      if (state.accountState !== 'uninitialized') throw new Error('Existing account transaction evidence anchor is missing.');
      return [];
    }
    if (state.lastTxLt === '0' && state.lastTxHash && Buffer.from(state.lastTxHash, 'base64').equals(Buffer.alloc(32))) return [];
    if (!state.lastTxLt || !state.lastTxHash) throw new Error('Account transaction evidence anchor is incomplete.');
    cursor = canonicalCursor(state.lastTxLt, state.lastTxHash);
  }
  const result: RawTransaction[] = [];
  // Each nonempty page adds at least one strictly older transaction. At most
  // limit source reads are possible even for one-transaction provider pages.
  while (result.length < limit) {
    if (Date.now() >= deadlineAt) throw new Error('Transaction evidence read deadline exceeded.');
    const remaining = limit - result.length;
    const page = assertOriginalTransactionPage(
      await source.getTransactions(rawAddress, remaining, cursor.lt, cursor.hash), account, cursor,
    );
    if (page.length > remaining) throw new Error('Transaction evidence provider exceeded the requested page bound.');
    result.push(...page);
    if (transactionPageReachesHistoryStart(page, cursor)) break;
    const oldest = page[page.length - 1];
    // Continue at the authenticated predecessor, without trusting page size
    // as a history-completeness signal or silently deduplicating bad pages.
    cursor = { lt: oldest.prevTransactionLt!, hash: oldest.prevTransactionHash! };
  }
  return result;
};

const toncenterMessage = (message: Message) => {
  const info = message.info;
  const internal = info.type === 'internal' ? info : undefined;
  return {
    source: info.type === 'external-in' ? '' : info.src.toString(),
    destination: info.type === 'external-out' ? '' : info.dest.toString(),
    value: internal ? internal.value.coins.toString() : '0',
    fwd_fee: internal ? internal.forwardFee.toString() : '0',
    // The upstream JSON codec retains its wire-slot name; current semantics are extra_flags.
    ihr_fee: internal ? internal.ihrFee.toString() : '0',
    created_lt: info.type === 'external-in' ? '0' : info.createdLt.toString(),
    body_hash: message.body.hash().toString('base64'),
    msg_data: {
      '@type': 'msg.dataRaw', body: message.body.toBoc().toString('base64'),
      init_state: message.init ? beginCell().store(storeStateInit(message.init)).endCell().toBoc().toString('base64') : '',
    },
    message: '',
  };
};

export const originalTransactionToToncenter = (entry: RawTransaction) => {
  if (!entry.rawBoc) throw new Error('Original transaction BOC is unavailable.');
  const tx = loadTransaction(Cell.fromBase64(entry.rawBoc).beginParse());
  const description = tx.description;
  const storageFee = 'storagePhase' in description ? description.storagePhase?.storageFeesCollected ?? 0n : 0n;
  const compute = 'computePhase' in description ? description.computePhase : undefined;
  const action = 'actionPhase' in description ? description.actionPhase : undefined;
  return {
    data: entry.rawBoc, transaction_id: { lt: tx.lt.toString(), hash: tx.hash().toString('base64') }, utime: tx.now,
    fee: tx.totalFees.coins.toString(), storage_fee: storageFee.toString(), other_fee: (tx.totalFees.coins - storageFee).toString(),
    in_msg: tx.inMessage ? toncenterMessage(tx.inMessage) : undefined,
    out_msgs: Array.from(tx.outMessages.values()).map(toncenterMessage),
    description: {
      type: description.type,
      ...('aborted' in description ? { aborted: description.aborted } : {}),
      ...(compute ? { compute_ph: compute.type === 'vm' ? { type: compute.type, success: compute.success, exit_code: compute.exitCode } : { type: compute.type, reason: compute.reason } } : {}),
      ...(action ? { action: { success: action.success, valid: action.valid, result_code: action.resultCode } } : {}),
    },
  };
};
