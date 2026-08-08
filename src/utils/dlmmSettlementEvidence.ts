import { Address, Cell } from '@ton/core';
import { IndexedTx, MessageSummary, TxAction } from '../models';

const OP_JETTON_TRANSFER = 0x0f8a7ea5;
const OP_JETTON_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_SWAP_FORWARD = 0x53574150;
const OP_JETTON_SETTLEMENT_TRANSFER = 0x4a535454; // JSTT
const OP_JETTON_SETTLEMENT_SUCCEEDED = 0x4a535543; // JSUC
const OP_JETTON_TRANSFER_BOUNCED = 0x4a544246; // JTBF
const OP_DLMM_RETRY_SETTLEMENT = 0x44535259; // DSRY
const OP_JETTON_SETTLEMENT_FINALIZE = 0x4a53464e; // JSFN
const OP_BOUNCED_MESSAGE_PREFIX = 0xffffffff;
const DLMM_SETTLEMENT_ID_START = 0x4453000000000001n;
const MAX_UINT64 = 0xffffffffffffffffn;

const RELEVANT_OPS = new Set([
  OP_JETTON_TRANSFER,
  OP_JETTON_TRANSFER_NOTIFICATION,
  OP_JETTON_SETTLEMENT_SUCCEEDED,
  OP_JETTON_TRANSFER_BOUNCED,
  OP_DLMM_RETRY_SETTLEMENT,
  OP_JETTON_SETTLEMENT_FINALIZE,
  OP_BOUNCED_MESSAGE_PREFIX,
]);

type MessageDirection = 'in' | 'out';

type MessageEnvelope = {
  cell: Cell;
  op: number;
  source: string;
  destination: string;
};

type EvidenceContext = {
  direction: MessageDirection;
  index: number;
  lt: bigint;
  txIdentity: string;
  txId: string;
  successful: boolean;
  outCount: number;
};

type JettonTransfer = {
  queryId: bigint;
  amount: bigint;
  destination: string;
  responseDestination: string | null;
  customPayload: Cell;
  forwardTonAmount: bigint;
  forwardPayload: Cell;
};

type JettonNotification = {
  queryId: bigint;
  amount: bigint;
  from: string;
  senderWallet: string;
  forwardPayload: Cell;
};

type SwapForward = {
  queryId: bigint;
  recipient: string;
  minAmountOut: bigint;
  zeroForOne: number;
};

type SettlementTuple = {
  queryId: bigint;
  amount: bigint;
  destination: string;
};

type TransferEvidence = EvidenceContext & {
  queryId: bigint;
  amount: bigint;
  destinationOwner: string;
  responseDestination: string | null;
  source: string;
  sourceWallet: string;
  exactMarker: boolean;
  emptyForwardPayload: boolean;
  forwardTonAmount: bigint;
};

type TupleEvidence = EvidenceContext & SettlementTuple & {
  source: string;
  destinationAddress: string;
};

type RetryEvidence = EvidenceContext & {
  queryId: bigint;
  source: string;
  destinationAddress: string;
};

type BounceEvidence = {
  queryId: bigint;
  lt: bigint;
  source: string;
  destinationAddress: string;
};

type SwapCandidate = {
  txId: string;
  txIdentity: string;
  lt: bigint;
  settlementId: bigint;
  amount: bigint;
  sourceWallet: string;
};

const canonicalUint = (value: unknown, max = MAX_UINT64): bigint | null => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= max ? parsed : null;
  } catch {
    return null;
  }
};

const canonicalAddress = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  try {
    return Address.parse(value).toRawString();
  } catch {
    return null;
  }
};

const loadedAddress = (value: unknown): string | null => {
  if (!Address.isAddress(value)) return null;
  return value.toRawString();
};

const isEmptyCell = (cell: Cell) => {
  const slice = cell.beginParse();
  return slice.remainingBits === 0 && slice.remainingRefs === 0;
};

const isExactMarker = (cell: Cell, expected: number) => {
  try {
    const slice = cell.beginParse();
    if (slice.remainingBits !== 32 || slice.remainingRefs !== 0) return false;
    if (slice.loadUint(32) !== expected) return false;
    slice.endParse();
    return true;
  } catch {
    return false;
  }
};

const markerOpcode = (cell: Cell): number | null => {
  try {
    const slice = cell.beginParse();
    return slice.remainingBits >= 32 ? slice.loadUint(32) : null;
  } catch {
    return null;
  }
};

const strictBodyCell = (body: unknown): Cell | null => {
  if (typeof body !== 'string' || body.length === 0 || body.trim() !== body) return null;
  if (
    body.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(body, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== body) return null;
    const roots = Cell.fromBoc(bytes);
    return roots.length === 1 ? roots[0] : null;
  } catch {
    return null;
  }
};

const bodyOpcode = (cell: Cell): number | null => {
  try {
    const slice = cell.beginParse();
    return slice.remainingBits >= 32 ? slice.loadUint(32) : null;
  } catch {
    return null;
  }
};

const messageEnvelope = (message: MessageSummary): MessageEnvelope | null => {
  const cell = strictBodyCell(message.body);
  if (!cell) return null;
  const op = bodyOpcode(cell);
  const source = canonicalAddress(message.source);
  const destination = canonicalAddress(message.destination);
  if (op === null || message.op !== op || !source || !destination) return null;
  return { cell, op, source, destination };
};

const parseJettonTransfer = (cell: Cell): JettonTransfer | null => {
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== OP_JETTON_TRANSFER) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const destination = loadedAddress(slice.loadAddressAny());
    const responseDestinationValue = slice.loadAddressAny();
    const responseDestination = Address.isAddress(responseDestinationValue)
      ? responseDestinationValue.toRawString()
      : responseDestinationValue === null
        ? null
        : undefined;
    const customPayload = slice.loadRef();
    const forwardTonAmount = slice.loadCoins();
    const forwardPayload = slice.loadRef();
    if (
      !destination ||
      responseDestination === undefined ||
      slice.remainingBits !== 0 ||
      slice.remainingRefs !== 0
    ) {
      return null;
    }
    return {
      queryId,
      amount,
      destination,
      responseDestination,
      customPayload,
      forwardTonAmount,
      forwardPayload,
    };
  } catch {
    return null;
  }
};

const parseJettonNotification = (cell: Cell): JettonNotification | null => {
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== OP_JETTON_TRANSFER_NOTIFICATION) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const from = loadedAddress(slice.loadAddressAny());
    const senderWallet = loadedAddress(slice.loadAddressAny());
    slice.loadCoins();
    const forwardPayload = slice.loadRef();
    if (!from || !senderWallet || slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return { queryId, amount, from, senderWallet, forwardPayload };
  } catch {
    return null;
  }
};

const parseSwapForward = (cell: Cell): SwapForward | null => {
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== OP_SWAP_FORWARD) return null;
    const queryId = slice.loadUintBig(64);
    const recipient = loadedAddress(slice.loadAddressAny());
    const minAmountOut = slice.loadCoins();
    const zeroForOne = slice.loadUint(8);
    const callback = slice.loadAddressAny();
    if (callback !== null && !Address.isAddress(callback)) return null;
    slice.loadRef();
    slice.loadCoins();
    slice.loadCoins();
    slice.loadRef();
    if (
      !recipient ||
      (zeroForOne !== 0 && zeroForOne !== 1) ||
      slice.remainingBits !== 0 ||
      slice.remainingRefs !== 0
    ) {
      return null;
    }
    return { queryId, recipient, minAmountOut, zeroForOne };
  } catch {
    return null;
  }
};

const parseSettlementTuple = (cell: Cell, expectedOp: number): SettlementTuple | null => {
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== expectedOp) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const destination = loadedAddress(slice.loadAddressAny());
    if (!destination || slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return { queryId, amount, destination };
  } catch {
    return null;
  }
};

const parseRetry = (cell: Cell): bigint | null => {
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== OP_DLMM_RETRY_SETTLEMENT) return null;
    const queryId = slice.loadUintBig(64);
    return slice.remainingBits === 0 && slice.remainingRefs === 0 ? queryId : null;
  } catch {
    return null;
  }
};

const parseBouncedQueryId = (cell: Cell): bigint | null | undefined => {
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== OP_BOUNCED_MESSAGE_PREFIX) return undefined;
    if (slice.remainingBits < 32) return null;
    const bouncedOp = slice.loadUint(32);
    if (bouncedOp !== OP_JETTON_TRANSFER && bouncedOp !== OP_JETTON_SETTLEMENT_FINALIZE) {
      return undefined;
    }
    if (slice.remainingBits < 64) return null;
    return slice.loadUintBig(64);
  } catch {
    return null;
  }
};

const pushById = <T>(map: Map<string, T[]>, id: bigint, value: T) => {
  const key = id.toString(10);
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
};

const isConfirmedTransaction = (tx: IndexedTx) =>
  tx.success === true &&
  tx.ui.status === 'success' &&
  tx.ui.utime === tx.utime &&
  tx.ui.outCount === tx.outMessages.length;

const strictSwapAction = (
  tx: IndexedTx
): Extract<TxAction, { kind: 'swap' }> | null => {
  const actions = tx.actions.filter(
    (action): action is Extract<TxAction, { kind: 'swap' }> => action.kind === 'swap'
  );
  return actions.length === 1 ? actions[0] : null;
};

/**
 * Resolve only outputs proven by the complete durable DLMM settlement chain.
 * The returned map is candle-specific evidence; it intentionally does not
 * mutate transactions or upgrade the `/swaps` receive-amount provenance.
 */
export const resolveConfirmedDlmmSwapOutputs = (
  marketAddress: string,
  transactions: readonly IndexedTx[]
): ReadonlyMap<string, string> => {
  const pool = canonicalAddress(marketAddress);
  if (!pool) return new Map();

  const transfers = new Map<string, TransferEvidence[]>();
  const succeeded = new Map<string, TupleEvidence[]>();
  const retries = new Map<string, RetryEvidence[]>();
  const finalizers = new Map<string, TupleEvidence[]>();
  const bounces = new Map<string, BounceEvidence[]>();
  const txIdCounts = new Map<string, number>();
  let malformedEvidence = false;

  for (const tx of transactions) {
    txIdCounts.set(tx.ui.txId, (txIdCounts.get(tx.ui.txId) ?? 0) + 1);
    const lt = canonicalUint(tx.lt);
    const txAddress = canonicalAddress(tx.address);
    const txIdentity = `${tx.lt}:${tx.hash}`;
    const successful = isConfirmedTransaction(tx);
    const messages: Array<{ message: MessageSummary; direction: MessageDirection; index: number }> = [];
    if (tx.inMessage) messages.push({ message: tx.inMessage, direction: 'in', index: 0 });
    tx.outMessages.forEach((message, index) => messages.push({ message, direction: 'out', index }));

    for (const { message, direction, index } of messages) {
      const envelope = messageEnvelope(message);
      if (!envelope) {
        const decodedCell = strictBodyCell(message.body);
        const decodedOp = decodedCell ? bodyOpcode(decodedCell) : null;
        if (
          (message.op !== undefined && RELEVANT_OPS.has(message.op)) ||
          (decodedOp !== null && RELEVANT_OPS.has(decodedOp))
        ) {
          malformedEvidence = true;
        }
        continue;
      }
      if (!RELEVANT_OPS.has(envelope.op)) continue;
      if (lt === null || lt <= 0n || txAddress !== pool) {
        malformedEvidence = true;
        continue;
      }
      const context: EvidenceContext = {
        direction,
        index,
        lt,
        txIdentity,
        txId: tx.ui.txId,
        successful,
        outCount: tx.outMessages.length,
      };

      if (envelope.op === OP_JETTON_TRANSFER) {
        const transfer = parseJettonTransfer(envelope.cell);
        if (!transfer) {
          malformedEvidence = true;
          continue;
        }
        const customOp = markerOpcode(transfer.customPayload);
        if (customOp !== OP_JETTON_SETTLEMENT_TRANSFER) continue;
        const evidence: TransferEvidence = {
          ...context,
          queryId: transfer.queryId,
          amount: transfer.amount,
          destinationOwner: transfer.destination,
          responseDestination: transfer.responseDestination,
          source: envelope.source,
          sourceWallet: envelope.destination,
          exactMarker: isExactMarker(transfer.customPayload, OP_JETTON_SETTLEMENT_TRANSFER),
          emptyForwardPayload: isEmptyCell(transfer.forwardPayload),
          forwardTonAmount: transfer.forwardTonAmount,
        };
        pushById(transfers, transfer.queryId, evidence);
        continue;
      }

      if (envelope.op === OP_JETTON_SETTLEMENT_SUCCEEDED) {
        const tuple = parseSettlementTuple(envelope.cell, OP_JETTON_SETTLEMENT_SUCCEEDED);
        if (!tuple) {
          malformedEvidence = true;
          continue;
        }
        pushById(succeeded, tuple.queryId, {
          ...context,
          ...tuple,
          source: envelope.source,
          destinationAddress: envelope.destination,
        });
        continue;
      }

      if (envelope.op === OP_DLMM_RETRY_SETTLEMENT) {
        const queryId = parseRetry(envelope.cell);
        if (queryId === null) {
          malformedEvidence = true;
          continue;
        }
        pushById(retries, queryId, {
          ...context,
          queryId,
          source: envelope.source,
          destinationAddress: envelope.destination,
        });
        continue;
      }

      if (envelope.op === OP_JETTON_SETTLEMENT_FINALIZE) {
        const tuple = parseSettlementTuple(envelope.cell, OP_JETTON_SETTLEMENT_FINALIZE);
        if (!tuple) {
          malformedEvidence = true;
          continue;
        }
        pushById(finalizers, tuple.queryId, {
          ...context,
          ...tuple,
          source: envelope.source,
          destinationAddress: envelope.destination,
        });
        continue;
      }

      if (envelope.op === OP_JETTON_TRANSFER_BOUNCED) {
        const tuple = parseSettlementTuple(envelope.cell, OP_JETTON_TRANSFER_BOUNCED);
        if (!tuple) {
          malformedEvidence = true;
          continue;
        }
        pushById(bounces, tuple.queryId, {
          queryId: tuple.queryId,
          lt,
          source: envelope.source,
          destinationAddress: envelope.destination,
        });
        continue;
      }

      if (envelope.op === OP_BOUNCED_MESSAGE_PREFIX) {
        const queryId = parseBouncedQueryId(envelope.cell);
        if (queryId === null) {
          malformedEvidence = true;
        } else if (queryId !== undefined) {
          pushById(bounces, queryId, {
            queryId,
            lt,
            source: envelope.source,
            destinationAddress: envelope.destination,
          });
        }
      }
    }
  }

  if (malformedEvidence) return new Map();

  const candidates: SwapCandidate[] = [];
  for (const tx of transactions) {
    const lt = canonicalUint(tx.lt);
    const action = strictSwapAction(tx);
    if (
      lt === null ||
      lt <= 0n ||
      !action ||
      action.amountOut !== undefined ||
      tx.kind !== 'swap' ||
      tx.ui.kind !== 'swap' ||
      tx.ui.txId !== `${tx.lt}:${tx.hash}` ||
      txIdCounts.get(tx.ui.txId) !== 1 ||
      canonicalAddress(tx.address) !== pool ||
      !isConfirmedTransaction(tx) ||
      !tx.inMessage
    ) {
      continue;
    }
    const notificationEnvelope = messageEnvelope(tx.inMessage);
    if (!notificationEnvelope || notificationEnvelope.op !== OP_JETTON_TRANSFER_NOTIFICATION) continue;
    const notification = parseJettonNotification(notificationEnvelope.cell);
    const forward = notification ? parseSwapForward(notification.forwardPayload) : null;
    const amountIn = canonicalUint(action.amountIn);
    const minOut = canonicalUint(action.minOut);
    const businessQueryId = canonicalUint(action.queryId);
    if (
      !notification ||
      !forward ||
      amountIn === null ||
      amountIn <= 0n ||
      minOut === null ||
      businessQueryId === null ||
      notificationEnvelope.source === pool ||
      notificationEnvelope.destination !== pool ||
      canonicalAddress(action.pool) !== pool ||
      canonicalAddress(action.sender) !== notification.from ||
      notification.amount !== amountIn ||
      notification.queryId !== businessQueryId ||
      forward.queryId !== businessQueryId ||
      forward.minAmountOut !== minOut
    ) {
      continue;
    }

    const initiationRecords = [...transfers.values()]
      .flat()
      .filter(
        (record) =>
          record.txIdentity === `${tx.lt}:${tx.hash}` &&
          record.direction === 'out' &&
          record.successful &&
          record.source === pool &&
          record.sourceWallet !== notificationEnvelope.source &&
          record.destinationOwner === forward.recipient &&
          record.responseDestination === pool &&
          record.amount > 0n &&
          record.amount >= minOut &&
          record.queryId >= DLMM_SETTLEMENT_ID_START &&
          record.queryId < MAX_UINT64 &&
          record.queryId !== businessQueryId &&
          record.exactMarker &&
          record.forwardTonAmount === 0n &&
          record.emptyForwardPayload
      );
    if (initiationRecords.length !== 1) continue;
    const initiation = initiationRecords[0];
    candidates.push({
      txId: tx.ui.txId,
      txIdentity: initiation.txIdentity,
      lt,
      settlementId: initiation.queryId,
      amount: initiation.amount,
      sourceWallet: initiation.sourceWallet,
    });
  }

  const candidateIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const id = candidate.settlementId.toString(10);
    candidateIdCounts.set(id, (candidateIdCounts.get(id) ?? 0) + 1);
  }

  const resolved = new Map<string, string>();
  for (const candidate of candidates) {
    const id = candidate.settlementId.toString(10);
    const transferRecords = transfers.get(id) ?? [];
    const successRecords = succeeded.get(id) ?? [];
    const retryRecords = retries.get(id) ?? [];
    const finalizeRecords = finalizers.get(id) ?? [];
    if (
      candidateIdCounts.get(id) !== 1 ||
      transferRecords.length !== 1 ||
      successRecords.length !== 1 ||
      retryRecords.length !== 1 ||
      finalizeRecords.length !== 1 ||
      (bounces.get(id)?.length ?? 0) !== 0
    ) {
      continue;
    }

    const transfer = transferRecords[0];
    const success = successRecords[0];
    const retry = retryRecords[0];
    const finalize = finalizeRecords[0];
    if (
      transfer.txIdentity !== candidate.txIdentity ||
      success.direction !== 'in' ||
      !success.successful ||
      success.outCount !== 0 ||
      success.source !== candidate.sourceWallet ||
      success.destinationAddress !== pool ||
      success.amount !== candidate.amount ||
      success.lt <= candidate.lt ||
      retry.direction !== 'in' ||
      !retry.successful ||
      retry.destinationAddress !== pool ||
      retry.outCount !== 1 ||
      retry.lt <= success.lt ||
      finalize.direction !== 'out' ||
      finalize.index !== 0 ||
      !finalize.successful ||
      finalize.txIdentity !== retry.txIdentity ||
      finalize.source !== pool ||
      finalize.destinationAddress !== candidate.sourceWallet ||
      finalize.amount !== candidate.amount ||
      finalize.destination !== success.destination ||
      finalize.lt !== retry.lt
    ) {
      continue;
    }
    resolved.set(candidate.txId, candidate.amount.toString(10));
  }

  return resolved;
};
