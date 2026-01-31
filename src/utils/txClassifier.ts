import { OpcodeSets } from './opcodes';
import { IndexedTx, MessageSummary, TxAction, TxKind, UiDetail, UiTx } from '../models';
import { Address, Cell } from '@ton/core';
import { RawTransaction } from '../data/dataSource';

const buildTxType = (kind: TxKind): string => {
  switch (kind) {
    case 'swap':
      return 'Swap';
    case 'lp_deposit':
      return 'LP Deposit';
    case 'lp_withdraw':
      return 'LP Withdraw';
    case 'transfer':
      return 'Transfer';
    case 'contract_call':
      return 'Contract Call';
    default:
      return 'Unknown';
  }
};

const opMatches = (message: MessageSummary | undefined, set: Set<number>) => {
  if (!message?.op) return false;
  return set.has(message.op);
};

const pickPool = (message?: MessageSummary): string | undefined => {
  return message?.destination ?? message?.source;
};

const parseAmount = (value?: string): string | undefined => {
  if (!value) return undefined;
  return value;
};

const toFriendlyAddress = (addr?: unknown): string | undefined => {
  if (!addr || !Address.isAddress(addr)) return undefined;
  return addr.toString({ urlSafe: true, bounceable: true });
};

const decodeJettonTransfer = (body?: string) => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return null;
    const op = slice.loadUint(32);
    if (op !== 0x0f8a7ea5) return null;
    if (slice.remainingBits < 64) return null;
    slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const destination = slice.loadAddress();
    const responseDestination = slice.loadAddress();
    if (slice.remainingBits > 0 || slice.remainingRefs > 0) {
      // custom payload (Maybe<Cell>) + forward TON amount + payload
      if (slice.remainingBits > 0) {
        try {
          slice.loadMaybeRef();
        } catch {
          // ignore
        }
      }
    }
    return {
      amount: amount.toString(),
      destination: toFriendlyAddress(destination),
      responseDestination: toFriendlyAddress(responseDestination),
    };
  } catch {
    return null;
  }
};

const decodeJettonNotification = (body?: string) => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return null;
    const op = slice.loadUint(32);
    if (op !== 0x7362d09c) return null;
    if (slice.remainingBits < 64) return null;
    slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const sender = slice.loadAddress();
    return {
      amount: amount.toString(),
      sender: toFriendlyAddress(sender),
    };
  } catch {
    return null;
  }
};

const OP_SWAP = 0x53574150;
const OP_ADD_LIQ = 0x41444c51;
const OP_REMOVE_LIQ = 0x524d4c51;
const OP_INCREASE_POS = 0x49504f53;
const OP_DECREASE_POS = 0x44504f53;

type DecodedSwap = {
  zeroForOne?: number;
  amountIn?: string;
  minAmountOut?: string;
  recipient?: string;
};

const decodeSwap = (body?: string): DecodedSwap | null => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const base = cell.beginParse();
    if (base.remainingBits < 32) return null;
    const op = base.loadUint(32);
    if (op !== OP_SWAP) return null;

    const exact = (() => {
      try {
        const slice = base.clone();
        slice.loadUintBig(64);
        const zeroForOne = slice.loadUint(8);
        const amountIn = slice.loadCoins();
        const minAmountOut = slice.loadCoins();
        return {
          zeroForOne,
          amountIn: amountIn.toString(),
          minAmountOut: minAmountOut.toString(),
        };
      } catch {
        return null;
      }
    })();

    if (exact) return exact;

    const forward = (() => {
      try {
        const slice = base.clone();
        slice.loadUintBig(64);
        const recipient = slice.loadAddressAny();
        const minAmountOut = slice.loadCoins();
        const zeroForOne = slice.loadUint(8);
        return {
          zeroForOne,
          minAmountOut: minAmountOut.toString(),
          recipient: toFriendlyAddress(recipient as Address),
        };
      } catch {
        return null;
      }
    })();

    return forward;
  } catch {
    return null;
  }
};

const decodeLpDeposit = (body?: string) => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const base = cell.beginParse();
    if (base.remainingBits < 32) return null;
    const op = base.loadUint(32);
    if (op === OP_ADD_LIQ) {
      base.loadUintBig(64);
      const amount0 = base.loadCoins();
      const amount1 = base.loadCoins();
      return { amountA: amount0.toString(), amountB: amount1.toString() };
    }
    if (op === OP_INCREASE_POS) {
      base.loadUintBig(64);
      base.loadUint(32);
      const amount0 = base.loadCoins();
      const amount1 = base.loadCoins();
      return { amountA: amount0.toString(), amountB: amount1.toString() };
    }
    return null;
  } catch {
    return null;
  }
};

const decodeLpWithdraw = (body?: string) => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const base = cell.beginParse();
    if (base.remainingBits < 32) return null;
    const op = base.loadUint(32);
    if (op === OP_REMOVE_LIQ) {
      base.loadUintBig(64);
      const liquidity = base.loadCoins();
      return { liquidity: liquidity.toString() };
    }
    if (op === OP_DECREASE_POS) {
      base.loadUintBig(64);
      base.loadUint(32);
      const liquidity = base.loadCoins();
      const minAmount0 = base.loadCoins();
      const minAmount1 = base.loadCoins();
      return { liquidity: liquidity.toString(), amountA: minAmount0.toString(), amountB: minAmount1.toString() };
    }
    return null;
  } catch {
    return null;
  }
};

export const classifyTransaction = (
  address: string,
  tx: RawTransaction,
  opcodes: OpcodeSets
): IndexedTx => {
  const inMsg = tx.inMessage;
  const outMsgs = tx.outMessages ?? [];

  let kind: TxKind = 'unknown';

  if (opMatches(inMsg, opcodes.swap) || outMsgs.some((m) => opMatches(m, opcodes.swap))) {
    kind = 'swap';
  } else if (opMatches(inMsg, opcodes.lpDeposit) || outMsgs.some((m) => opMatches(m, opcodes.lpDeposit))) {
    kind = 'lp_deposit';
  } else if (opMatches(inMsg, opcodes.lpWithdraw) || outMsgs.some((m) => opMatches(m, opcodes.lpWithdraw))) {
    kind = 'lp_withdraw';
  } else if (
    opMatches(inMsg, opcodes.jettonTransfer) ||
    opMatches(inMsg, opcodes.jettonNotify) ||
    outMsgs.some((m) => opMatches(m, opcodes.jettonTransfer) || opMatches(m, opcodes.jettonNotify))
  ) {
    kind = 'transfer';
  } else if (inMsg?.value || outMsgs.some((m) => m.value)) {
    kind = 'transfer';
  } else if (inMsg?.op || outMsgs.some((m) => m.op)) {
    kind = 'contract_call';
  }

  const actions: TxAction[] = [];
  let detail: UiDetail = { kind: 'unknown' };

  if (kind === 'swap') {
    const swapMsg = [inMsg, ...outMsgs].find((msg) => msg && opMatches(msg, opcodes.swap));
    const swap = decodeSwap(swapMsg?.body);
    actions.push({
      kind: 'swap',
      pool: pickPool(inMsg ?? outMsgs[0]),
      amountIn: swap?.amountIn,
      minOut: swap?.minAmountOut,
    });
    detail = {
      kind: 'swap',
      payAmount: swap?.amountIn,
      receiveAmount: swap?.minAmountOut,
    };
  } else if (kind === 'lp_deposit') {
    const lpMsg = [inMsg, ...outMsgs].find((msg) => msg && opMatches(msg, opcodes.lpDeposit));
    const lp = decodeLpDeposit(lpMsg?.body);
    actions.push({
      kind: 'lp_deposit',
      pool: pickPool(inMsg ?? outMsgs[0]),
      amountA: lp?.amountA,
      amountB: lp?.amountB,
    });
    detail = { kind: 'lp', amountA: lp?.amountA, amountB: lp?.amountB };
  } else if (kind === 'lp_withdraw') {
    const lpMsg = [inMsg, ...outMsgs].find((msg) => msg && opMatches(msg, opcodes.lpWithdraw));
    const lp = decodeLpWithdraw(lpMsg?.body);
    actions.push({
      kind: 'lp_withdraw',
      pool: pickPool(inMsg ?? outMsgs[0]),
      amountA: lp?.amountA,
      amountB: lp?.amountB,
    });
    detail = { kind: 'lp', amountA: lp?.amountA, amountB: lp?.amountB };
  } else if (kind === 'transfer') {
    const jettonMsg = [inMsg, ...outMsgs].find(
      (msg) =>
        msg &&
        (opMatches(msg, opcodes.jettonTransfer) || opMatches(msg, opcodes.jettonNotify))
    );
    const jettonTransfer = decodeJettonTransfer(jettonMsg?.body);
    const jettonNotify = decodeJettonNotification(jettonMsg?.body);
    const amount =
      jettonTransfer?.amount ??
      jettonNotify?.amount ??
      parseAmount(inMsg?.value ?? outMsgs[0]?.value);
    const isJetton =
      opMatches(inMsg, opcodes.jettonTransfer) ||
      opMatches(inMsg, opcodes.jettonNotify) ||
      outMsgs.some((m) => opMatches(m, opcodes.jettonTransfer) || opMatches(m, opcodes.jettonNotify));
    const asset = isJetton
      ? ({ kind: 'jetton', master: 'unknown' } as const)
      : ({ kind: 'ton' } as const);
    const toAddress = jettonTransfer?.destination ?? inMsg?.destination ?? outMsgs[0]?.destination;
    const fromAddress = jettonNotify?.sender ?? inMsg?.source ?? outMsgs[0]?.source;
    actions.push({
      kind: 'transfer',
      asset,
      amount: amount ?? '0',
      from: fromAddress,
      to: toAddress,
      source: toAddress === address ? 'in' : 'out',
    });
    detail = { kind: 'transfer', asset: isJetton ? 'jetton' : 'ton', amount };
  } else if (kind === 'contract_call') {
    actions.push({ kind: 'contract_call', contract: inMsg?.destination ?? outMsgs[0]?.destination, op: inMsg?.op });
    detail = { kind: 'unknown' };
  }

  const status = tx.status ?? (tx.success ? 'success' : 'failed');
  const reason = tx.reason ?? (status === 'failed' ? 'aborted' : undefined);

  const ui: UiTx = {
    txId: `${tx.lt}:${tx.hash}`,
    utime: tx.utime,
    status,
    reason,
    txType: buildTxType(kind),
    inSource: inMsg?.source,
    inValue: inMsg?.value,
    outCount: outMsgs.length,
    detail,
    kind,
    actions,
  };

  return {
    address,
    lt: tx.lt,
    hash: tx.hash,
    utime: tx.utime,
    success: tx.success,
    inMessage: inMsg,
    outMessages: outMsgs,
    kind,
    actions,
    ui,
  };
};
