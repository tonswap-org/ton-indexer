import { OpcodeSets } from './opcodes';
import { IndexedTx, MessageSummary, SwapExecutionType, TxAction, TxKind, UiDetail, UiTx } from '../models';
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

type DecodedJettonTransfer = {
  queryId: bigint;
  amount: string;
  destination?: string;
  responseDestination?: string;
  forwardTonAmount?: string;
  forwardOp?: number;
  forwardPayload?: Cell;
};

const decodeJettonTransfer = (body?: string): DecodedJettonTransfer | null => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return null;
    const op = slice.loadUint(32);
    if (op !== 0x0f8a7ea5) return null;
    if (slice.remainingBits < 64) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const destination = slice.loadAddressAny();
    const responseDestination = slice.loadAddressAny();

    let forwardTonAmount: bigint | undefined;
    let forwardPayload: Cell | undefined;
    let forwardOp: number | undefined;

    // Tonswap jetton wallets encode transfer as:
    // customPayload: ref Cell, forwardTonAmount: coins, forwardPayload: ref Cell
    try {
      if (slice.remainingRefs > 0) slice.loadRef(); // customPayload
      if (slice.remainingBits >= 4) forwardTonAmount = slice.loadCoins();
      if (slice.remainingRefs > 0) forwardPayload = slice.loadRef();
      if (forwardPayload) {
        const f = forwardPayload.beginParse();
        if (f.remainingBits >= 32) forwardOp = f.loadUint(32);
      }
    } catch {
      // Ignore decoding tail; base fields are still useful.
    }
    return {
      queryId,
      amount: amount.toString(),
      destination: toFriendlyAddress(destination),
      responseDestination: toFriendlyAddress(responseDestination),
      forwardTonAmount: forwardTonAmount?.toString(),
      forwardOp,
      forwardPayload,
    };
  } catch {
    return null;
  }
};

type DecodedJettonNotification = {
  queryId: bigint;
  amount: string;
  sender?: string;
  senderWallet?: string;
  forwardTonAmount?: string;
  forwardOp?: number;
  forwardPayload?: Cell;
};

const decodeJettonNotification = (body?: string): DecodedJettonNotification | null => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const slice = cell.beginParse();
    if (slice.remainingBits < 32) return null;
    const op = slice.loadUint(32);
    if (op !== 0x7362d09c) return null;
    if (slice.remainingBits < 64) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const sender = slice.loadAddressAny();

    // Tonswap jetton wallets extend notification with sender wallet + forward payload.
    let senderWallet: unknown;
    let forwardTonAmount: bigint | undefined;
    let forwardPayload: Cell | undefined;
    let forwardOp: number | undefined;
    try {
      if (slice.remainingBits >= 2) senderWallet = slice.loadAddressAny();
      if (slice.remainingBits >= 4) forwardTonAmount = slice.loadCoins();
      if (slice.remainingRefs > 0) forwardPayload = slice.loadRef();
      if (forwardPayload) {
        const f = forwardPayload.beginParse();
        if (f.remainingBits >= 32) forwardOp = f.loadUint(32);
      }
    } catch {
      // ignore
    }
    return {
      queryId,
      amount: amount.toString(),
      sender: toFriendlyAddress(sender),
      senderWallet: toFriendlyAddress(senderWallet),
      forwardTonAmount: forwardTonAmount?.toString(),
      forwardOp,
      forwardPayload,
    };
  } catch {
    return null;
  }
};

const OP_SWAP_FORWARD = 0x53574150;
const OP_DLMM_SWAP_EXACT_IN = 0x44535750;
const OP_DLMM_ADD_LIQUIDITY_FORWARD = 0x444c4144;
const OP_ADD_LIQ = 0x41444c51;
const OP_REMOVE_LIQ = 0x524d4c51;
const OP_INCREASE_POS = 0x49504f53;
const OP_DECREASE_POS = 0x44504f53;
const OP_DLMM_ADD_LIQUIDITY = 0x44414444;
const OP_DLMM_ADD_LIQUIDITY_FOR = 0x444c4146;
const OP_DLMM_REMOVE_LIQUIDITY = 0x44524d56;

type DecodedSwap = {
  queryId?: string;
  zeroForOne?: number;
  amountIn?: string;
  minAmountOut?: string;
  recipient?: string;
};

type SwapExecutionHint = {
  executionType: SwapExecutionType;
  twapSlice?: number;
  twapTotal?: number;
  payTokenSymbol?: string;
  receiveTokenSymbol?: string;
  querySequence?: number;
  queryNonce?: number;
};

const SWAP_EXECUTION_QUERY_MAGIC_V1 = 0xd1n;
const SWAP_EXECUTION_QUERY_MAGIC_V2 = 0xd2n;
const SWAP_EXECUTION_MODE_MARKET = 0;
const SWAP_EXECUTION_MODE_LIMIT = 1;
const SWAP_EXECUTION_MODE_TWAP = 2;
const SWAP_EXECUTION_MAX_STEP_V1 = 255;
const SWAP_EXECUTION_MAX_STEP_V2 = 31;
const SWAP_QUERY_TOKEN_SYMBOL_BY_CODE: Record<number, string> = {
  1: 'TON',
  2: 'T3',
  3: 'USDT',
  4: 'USDC',
  5: 'KUSD',
  6: 'TS',
};

const mapExecutionMode = (
  mode: number,
  twapSlice?: number,
  twapTotal?: number
): SwapExecutionHint => {
  if (mode === SWAP_EXECUTION_MODE_LIMIT) {
    return { executionType: 'limit' };
  }
  if (mode === SWAP_EXECUTION_MODE_TWAP) {
    return { executionType: 'twap', twapSlice, twapTotal };
  }
  if (mode === SWAP_EXECUTION_MODE_MARKET) {
    return { executionType: 'market' };
  }
  return { executionType: 'unknown' };
};

const decodeSwapExecutionHint = (queryId?: bigint | null): SwapExecutionHint | null => {
  if (queryId === null || queryId === undefined || queryId < 0n) return null;
  const magic = (queryId >> 56n) & 0xffn;
  if (magic === SWAP_EXECUTION_QUERY_MAGIC_V2) {
    const mode = Number((queryId >> 54n) & 0x03n);
    const rawSlice = Number((queryId >> 49n) & 0x1fn);
    const rawTotal = Number((queryId >> 44n) & 0x1fn);
    const payTokenCode = Number((queryId >> 38n) & 0x3fn);
    const receiveTokenCode = Number((queryId >> 32n) & 0x3fn);
    const querySequence = Number((queryId >> 8n) & 0xffffffn);
    const queryNonce = Number(queryId & 0xffn);
    const twapSlice = rawSlice > 0 && rawSlice <= SWAP_EXECUTION_MAX_STEP_V2 ? rawSlice : undefined;
    const twapTotal = rawTotal > 0 && rawTotal <= SWAP_EXECUTION_MAX_STEP_V2 ? rawTotal : undefined;
    const hint = mapExecutionMode(mode, twapSlice, twapTotal);
    return {
      ...hint,
      payTokenSymbol: SWAP_QUERY_TOKEN_SYMBOL_BY_CODE[payTokenCode],
      receiveTokenSymbol: SWAP_QUERY_TOKEN_SYMBOL_BY_CODE[receiveTokenCode],
      querySequence,
      queryNonce,
    };
  }
  if (magic === SWAP_EXECUTION_QUERY_MAGIC_V1) {
    const mode = Number((queryId >> 54n) & 0x03n);
    const rawSlice = Number((queryId >> 46n) & 0xffn);
    const rawTotal = Number((queryId >> 38n) & 0xffn);
    const querySequence = Number((queryId >> 7n) & 0x7fffffffn);
    const queryNonce = Number(queryId & 0x7fn);
    const twapSlice = rawSlice > 0 && rawSlice <= SWAP_EXECUTION_MAX_STEP_V1 ? rawSlice : undefined;
    const twapTotal = rawTotal > 0 && rawTotal <= SWAP_EXECUTION_MAX_STEP_V1 ? rawTotal : undefined;
    return { ...mapExecutionMode(mode, twapSlice, twapTotal), querySequence, queryNonce };
  }
  return null;
};

type DecodedDlmmAddLiquidityForward = {
  owner?: string;
  binId?: number;
  minLpOut?: string;
};

const decodeDlmmAddLiquidityForward = (payload?: Cell): DecodedDlmmAddLiquidityForward | null => {
  if (!payload) return null;
  try {
    const slice = payload.beginParse();
    if (slice.remainingBits < 32) return null;
    const op = slice.loadUint(32);
    if (op !== OP_DLMM_ADD_LIQUIDITY_FORWARD) return null;
    const owner = slice.loadAddressAny();
    if (slice.remainingBits < 32) {
      return { owner: toFriendlyAddress(owner) };
    }
    const rawBin = slice.loadUint(32);
    const binId = rawBin > 0x7fffffff ? rawBin - 0x1_0000_0000 : rawBin;
    if (slice.remainingBits < 256) {
      return { owner: toFriendlyAddress(owner), binId };
    }
    const minLpOut = slice.loadUintBig(256);
    return { owner: toFriendlyAddress(owner), binId, minLpOut: minLpOut.toString() };
  } catch {
    return null;
  }
};

const decodeSwap = (body?: string | Cell): DecodedSwap | null => {
  if (!body) return null;
  try {
    const cell = typeof body === 'string' ? Cell.fromBase64(body) : body;
    const base = cell.beginParse();
    if (base.remainingBits < 32) return null;
    const op = base.loadUint(32);
    if (op === OP_DLMM_SWAP_EXACT_IN) {
      try {
        const amountIn = base.loadUintBig(128);
        const zeroForOne = base.loadUint(8);
        const minAmountOut = base.loadUintBig(128);
        const recipient = base.loadAddressAny();
        return {
          zeroForOne,
          amountIn: amountIn.toString(),
          minAmountOut: minAmountOut.toString(),
          recipient: toFriendlyAddress(recipient),
        };
      } catch {
        return null;
      }
    }

    if (op !== OP_SWAP_FORWARD) return null;

    const forward = (() => {
      try {
        const slice = base.clone();
        const queryId = slice.loadUintBig(64);
        if (slice.remainingBits < 2) return null;
        // DLMM swap forward always includes an internal recipient address after queryId.
        const tag = slice.preloadUint(2);
        if (tag !== 2) return null;
        const recipient = slice.loadAddressAny();
        const minAmountOut = slice.loadCoins();
        const zeroForOne = slice.loadUint(8);
        return {
          queryId: queryId.toString(),
          zeroForOne,
          minAmountOut: minAmountOut.toString(),
          recipient: toFriendlyAddress(recipient),
        };
      } catch {
        return null;
      }
    })();

    if (forward) return forward;

    const exact = (() => {
      try {
        const slice = base.clone();
        const queryId = slice.loadUintBig(64);
        const zeroForOne = slice.loadUint(8);
        const amountIn = slice.loadCoins();
        const minAmountOut = slice.loadCoins();
        return {
          queryId: queryId.toString(),
          zeroForOne,
          amountIn: amountIn.toString(),
          minAmountOut: minAmountOut.toString(),
        };
      } catch {
        return null;
      }
    })();

    return exact;
  } catch {
    return null;
  }
};

type DecodedLpDeposit = {
  amountA?: string;
  amountB?: string;
  binId?: number;
};

const decodeLpDeposit = (body?: string): DecodedLpDeposit | null => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const base = cell.beginParse();
    if (base.remainingBits < 32) return null;
    const op = base.loadUint(32);
    if (op === OP_DLMM_ADD_LIQUIDITY) {
      const rawBin = base.loadUint(32);
      const binId = rawBin > 0x7fffffff ? rawBin - 0x1_0000_0000 : rawBin;
      const amountT3 = base.loadUintBig(128);
      const amountX = base.loadUintBig(128);
      return { amountA: amountT3.toString(), amountB: amountX.toString(), binId };
    }
    if (op === OP_DLMM_ADD_LIQUIDITY_FOR) {
      base.loadAddressAny();
      const rawBin = base.loadUint(32);
      const binId = rawBin > 0x7fffffff ? rawBin - 0x1_0000_0000 : rawBin;
      const amountT3 = base.loadUintBig(128);
      const amountX = base.loadUintBig(128);
      return { amountA: amountT3.toString(), amountB: amountX.toString(), binId };
    }
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

type DecodedLpWithdraw = {
  liquidity?: string;
  amountA?: string;
  amountB?: string;
  lpBurned?: string;
  binId?: number;
};

const decodeLpWithdraw = (body?: string): DecodedLpWithdraw | null => {
  if (!body) return null;
  try {
    const cell = Cell.fromBase64(body);
    const base = cell.beginParse();
    if (base.remainingBits < 32) return null;
    const op = base.loadUint(32);
    if (op === OP_DLMM_REMOVE_LIQUIDITY) {
      const rawBin = base.loadUint(32);
      const binId = rawBin > 0x7fffffff ? rawBin - 0x1_0000_0000 : rawBin;
      const shares = base.loadUintBig(256);
      return { lpBurned: shares.toString(), binId };
    }
    if (op === OP_REMOVE_LIQ) {
      base.loadUintBig(64);
      const liquidity = base.loadCoins();
      return { liquidity: liquidity.toString(), lpBurned: liquidity.toString() };
    }
    if (op === OP_DECREASE_POS) {
      base.loadUintBig(64);
      base.loadUint(32);
      const liquidity = base.loadCoins();
      const minAmount0 = base.loadCoins();
      const minAmount1 = base.loadCoins();
      return {
        liquidity: liquidity.toString(),
        amountA: minAmount0.toString(),
        amountB: minAmount1.toString(),
        lpBurned: liquidity.toString(),
      };
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

  const allMsgs = [inMsg, ...outMsgs].filter((m): m is MessageSummary => Boolean(m));
  const jettonTransfers = allMsgs
    .map((msg) => ({ msg, decoded: decodeJettonTransfer(msg.body) }))
    .filter((t): t is { msg: MessageSummary; decoded: DecodedJettonTransfer } => Boolean(t.decoded));
  const jettonNotifies = allMsgs
    .map((msg) => ({ msg, decoded: decodeJettonNotification(msg.body) }))
    .filter((t): t is { msg: MessageSummary; decoded: DecodedJettonNotification } => Boolean(t.decoded));

  const swapViaTransfer = jettonTransfers.find(
    (t) => t.decoded.forwardOp !== undefined && opcodes.swap.has(t.decoded.forwardOp)
  );
  const swapViaNotify = jettonNotifies.find(
    (t) => t.decoded.forwardOp !== undefined && opcodes.swap.has(t.decoded.forwardOp)
  );
  const lpDepositViaTransfer = jettonTransfers.filter(
    (t) => t.decoded.forwardOp !== undefined && opcodes.lpDeposit.has(t.decoded.forwardOp)
  );
  const lpDepositViaNotify = jettonNotifies.filter(
    (t) => t.decoded.forwardOp !== undefined && opcodes.lpDeposit.has(t.decoded.forwardOp)
  );

  let kind: TxKind = 'unknown';

  if (swapViaTransfer || swapViaNotify) {
    kind = 'swap';
  } else if (lpDepositViaTransfer.length > 0 || lpDepositViaNotify.length > 0) {
    kind = 'lp_deposit';
  } else if (opMatches(inMsg, opcodes.swap) || outMsgs.some((m) => opMatches(m, opcodes.swap))) {
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
    if (swapViaTransfer?.decoded.forwardPayload) {
      const swap = decodeSwap(swapViaTransfer.decoded.forwardPayload);
      const queryId = swapViaTransfer.decoded.queryId.toString();
      const executionHint = decodeSwapExecutionHint(swapViaTransfer.decoded.queryId);
      const amountIn = swapViaTransfer.decoded.amount;
      const inferredPayToken = swap?.zeroForOne === 1 ? 'T3' : swap?.zeroForOne === 0 ? 'X' : undefined;
      const inferredReceiveToken = swap?.zeroForOne === 1 ? 'X' : swap?.zeroForOne === 0 ? 'T3' : undefined;
      const payToken = executionHint?.payTokenSymbol ?? inferredPayToken;
      const receiveToken = executionHint?.receiveTokenSymbol ?? inferredReceiveToken;
      actions.push({
        kind: 'swap',
        pool: swapViaTransfer.decoded.destination,
        amountIn,
        minOut: swap?.minAmountOut,
        queryId,
        executionType: executionHint?.executionType,
        twapSlice: executionHint?.twapSlice,
        twapTotal: executionHint?.twapTotal,
        querySequence: executionHint?.querySequence,
        queryNonce: executionHint?.queryNonce,
      });
      detail = {
        kind: 'swap',
        payAmount: amountIn,
        receiveAmount: swap?.minAmountOut,
        payToken,
        receiveToken,
        queryId,
        executionType: executionHint?.executionType,
        twapSlice: executionHint?.twapSlice,
        twapTotal: executionHint?.twapTotal,
        querySequence: executionHint?.querySequence,
        queryNonce: executionHint?.queryNonce,
      };
    } else if (swapViaNotify?.decoded.forwardPayload) {
      const swap = decodeSwap(swapViaNotify.decoded.forwardPayload);
      const queryId = swapViaNotify.decoded.queryId.toString();
      const executionHint = decodeSwapExecutionHint(swapViaNotify.decoded.queryId);
      const amountIn = swapViaNotify.decoded.amount;
      const inferredPayToken = swap?.zeroForOne === 1 ? 'T3' : swap?.zeroForOne === 0 ? 'X' : undefined;
      const inferredReceiveToken = swap?.zeroForOne === 1 ? 'X' : swap?.zeroForOne === 0 ? 'T3' : undefined;
      const payToken = executionHint?.payTokenSymbol ?? inferredPayToken;
      const receiveToken = executionHint?.receiveTokenSymbol ?? inferredReceiveToken;
      const recipientWallet = swap?.recipient;
      const amountOut =
        recipientWallet
          ? jettonTransfers.find((t) => t.decoded.destination === recipientWallet)?.decoded.amount
          : undefined;
      actions.push({
        kind: 'swap',
        pool: pickPool(swapViaNotify.msg),
        amountIn,
        amountOut,
        minOut: swap?.minAmountOut,
        sender: swapViaNotify.decoded.sender,
        queryId,
        executionType: executionHint?.executionType,
        twapSlice: executionHint?.twapSlice,
        twapTotal: executionHint?.twapTotal,
        querySequence: executionHint?.querySequence,
        queryNonce: executionHint?.queryNonce,
      });
      detail = {
        kind: 'swap',
        payAmount: amountIn,
        receiveAmount: amountOut ?? swap?.minAmountOut,
        payToken,
        receiveToken,
        queryId,
        executionType: executionHint?.executionType,
        twapSlice: executionHint?.twapSlice,
        twapTotal: executionHint?.twapTotal,
        querySequence: executionHint?.querySequence,
        queryNonce: executionHint?.queryNonce,
      };
    } else {
      const swapMsg = [inMsg, ...outMsgs].find((msg) => msg && opMatches(msg, opcodes.swap));
      const swap = decodeSwap(swapMsg?.body);
      const queryIdRaw = swap?.queryId;
      const queryIdBigInt = queryIdRaw && /^\d+$/.test(queryIdRaw) ? BigInt(queryIdRaw) : null;
      const executionHint = decodeSwapExecutionHint(queryIdBigInt);
      const inferredPayToken = swap?.zeroForOne === 1 ? 'T3' : swap?.zeroForOne === 0 ? 'X' : undefined;
      const inferredReceiveToken = swap?.zeroForOne === 1 ? 'X' : swap?.zeroForOne === 0 ? 'T3' : undefined;
      const payToken = executionHint?.payTokenSymbol ?? inferredPayToken;
      const receiveToken = executionHint?.receiveTokenSymbol ?? inferredReceiveToken;
      actions.push({
        kind: 'swap',
        pool: pickPool(inMsg ?? outMsgs[0]),
        amountIn: swap?.amountIn,
        minOut: swap?.minAmountOut,
        queryId: queryIdRaw,
        executionType: executionHint?.executionType,
        twapSlice: executionHint?.twapSlice,
        twapTotal: executionHint?.twapTotal,
        querySequence: executionHint?.querySequence,
        queryNonce: executionHint?.queryNonce,
      });
      detail = {
        kind: 'swap',
        payToken,
        receiveToken,
        payAmount: swap?.amountIn,
        receiveAmount: swap?.minAmountOut,
        queryId: queryIdRaw,
        executionType: executionHint?.executionType,
        twapSlice: executionHint?.twapSlice,
        twapTotal: executionHint?.twapTotal,
        querySequence: executionHint?.querySequence,
        queryNonce: executionHint?.queryNonce,
      };
    }
  } else if (kind === 'lp_deposit') {
    if (lpDepositViaTransfer.length > 0) {
      const amountA = lpDepositViaTransfer[0]?.decoded.amount;
      const amountB = lpDepositViaTransfer[1]?.decoded.amount;
      const forward = decodeDlmmAddLiquidityForward(lpDepositViaTransfer[0]?.decoded.forwardPayload);
      actions.push({
        kind: 'lp_deposit',
        pool: lpDepositViaTransfer[0]?.decoded.destination,
        amountA,
        amountB,
        binId: forward?.binId,
        minLpOut: forward?.minLpOut,
        owner: forward?.owner,
      });
      detail = { kind: 'lp', amountA, amountB };
    } else if (lpDepositViaNotify.length > 0) {
      // DLMM pool contracts receive a single JettonTransferNotification per token; liquidity adds usually span two txs.
      const amountA = lpDepositViaNotify[0]?.decoded.amount;
      const forward = decodeDlmmAddLiquidityForward(lpDepositViaNotify[0]?.decoded.forwardPayload);
      actions.push({
        kind: 'lp_deposit',
        pool: pickPool(lpDepositViaNotify[0]?.msg),
        amountA,
        binId: forward?.binId,
        minLpOut: forward?.minLpOut,
        owner: forward?.owner,
      });
      detail = { kind: 'lp', amountA };
    } else {
      const lpMsg = [inMsg, ...outMsgs].find((msg) => msg && opMatches(msg, opcodes.lpDeposit));
      const lp = decodeLpDeposit(lpMsg?.body);
      actions.push({
        kind: 'lp_deposit',
        pool: pickPool(inMsg ?? outMsgs[0]),
        amountA: lp?.amountA,
        amountB: lp?.amountB,
        binId: lp?.binId,
      });
      detail = { kind: 'lp', amountA: lp?.amountA, amountB: lp?.amountB };
    }
  } else if (kind === 'lp_withdraw') {
    const lpMsg = [inMsg, ...outMsgs].find((msg) => msg && opMatches(msg, opcodes.lpWithdraw));
    const lp = decodeLpWithdraw(lpMsg?.body);
    actions.push({
      kind: 'lp_withdraw',
      pool: pickPool(inMsg ?? outMsgs[0]),
      amountA: lp?.amountA,
      amountB: lp?.amountB,
      lpBurned: lp?.lpBurned,
      binId: lp?.binId,
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
