import { Address, beginCell, Cell } from '@ton/core';

/** Current spot_order_messages.tolk and jetton_quotes.tolk wire layouts only. */
export type OrderWalletBudget = {
  senderGas: number; walletBounceGas: number; burnWalletGas: number;
  smallPayloadCells: number; largeWalletGas: number; largeSenderGas: number;
  rentSeconds: number; rentBits: number; rentCells: number;
  initBits: number; initCells: number; initCopies: number;
  transferBits: number; transferCells: number; transferCopies: number;
  creditProtection: boolean;
};

export type OrderTerms = {
  inputMaster: Address; pool: Address; sellIndex: 0 | 1; recipient: Address;
  amountIn: bigint; minOutTotal: bigint; slices: number; interval: number;
  startAt: number; expiresAt: number; tipPerSlice: bigint; forwardGas: number;
  walletGas: number; walletGram: bigint; executor: Address | null;
  budget: OrderWalletBudget;
};

export type OrderState = {
  factory: Address; owner: Address; nonce: bigint; dataHash: string;
  /** 0 is the uninitialized StateInit; a present body must be 1, 2, or 3. */
  state: 0 | 1 | 2 | 3;
  /** 0 none, 1 filled, 2 cancelled, 3 expired. */
  closeReason: 0 | 1 | 2 | 3;
  executedSlices: number; execId: number; lastExecutedAt: number; attemptAt: number;
  cancelRequested: boolean; refundSeen: boolean;
  /** 0 none, 1 matching SWR3 credit, 2 matching JCLR credit to the order wallet. */
  refundKind: 0 | 1 | 2;
  /** Pool outcome: 0 none, 1 REFUND, 2 INPUT_OWED; neither alone proves cash. */
  refusal: 0 | 1 | 2;
  inputWallet: Address | null; keeper: Address | null; prevKeeper: Address | null;
  terms: OrderTerms | null; termsCell: Cell | null; termsHash: string | null;
  /** Getter accounting, not wallet balances or proof of recipient/owner payment. */
  soldIn: bigint; inFlight: bigint; unexecutedIn: bigint;
};

const budgetFields = [
  ['senderGas', 32], ['walletBounceGas', 32], ['burnWalletGas', 32],
  ['smallPayloadCells', 16], ['largeWalletGas', 32], ['largeSenderGas', 32],
  ['rentSeconds', 32], ['rentBits', 32], ['rentCells', 16],
  ['initBits', 32], ['initCells', 16], ['initCopies', 8],
  ['transferBits', 16], ['transferCells', 8], ['transferCopies', 8],
] as const;

function uint(value: number, bits: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
    throw Error(`Invalid order ${label}`);
  }
}

function coins(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 120n) {
    throw Error(`Invalid order ${label}`);
  }
}

function ordinary(cell: Cell, label: string): ReturnType<Cell['beginParse']> {
  if (cell.isExotic) throw Error(`Exotic order ${label}`);
  return cell.beginParse();
}

function validateTermsShape(t: OrderTerms): void {
  for (const [key, bits] of [['sellIndex', 1], ['slices', 8], ['interval', 32],
    ['startAt', 32], ['expiresAt', 32], ['forwardGas', 32], ['walletGas', 32]] as const) {
    uint(t[key], bits, key);
  }
  for (const key of ['amountIn', 'minOutTotal', 'tipPerSlice', 'walletGram'] as const) coins(t[key], key);
  if (t.inputMaster.workChain !== 0 || t.pool.workChain !== 0 || t.recipient.workChain !== 0 ||
      (t.executor !== null && t.executor.workChain !== 0) || t.pool.equals(t.inputMaster) ||
      t.recipient.equals(t.pool) || t.slices < 1 || t.slices > 50 || t.amountIn < BigInt(t.slices) ||
      t.minOutTotal === 0n || (t.slices === 1 ? t.interval !== 0 : t.interval < 120 || t.interval > 86400) ||
      t.startAt + (t.slices - 1) * t.interval >= t.expiresAt || t.tipPerSlice < 20_000_000n ||
      t.forwardGas < 400_000 || t.walletGas < 10_000 || t.walletGas > 500_000 ||
      t.walletGram > 500_000_000n) throw Error('Invalid order terms');
  const p = t.budget;
  if (!p) throw Error('Missing order wallet budget');
  for (const [key, bits] of budgetFields) uint(p[key], bits, `wallet budget ${key}`);
  // These are the contract's bounds, not an allowlist of familiar profiles.
  if (typeof p.creditProtection !== 'boolean' || p.senderGas < 10_000 || p.senderGas > t.walletGas ||
      p.smallPayloadCells === 0 || p.largeSenderGas < p.senderGas || p.largeWalletGas < t.walletGas ||
      p.largeSenderGas > p.largeWalletGas || p.largeWalletGas > 2_000_000 || p.walletBounceGas > 500_000 ||
      p.burnWalletGas < p.senderGas || p.burnWalletGas > 2_000_000 || p.rentSeconds === 0 ||
      p.rentBits === 0 || p.rentCells === 0 || p.initBits === 0 || p.initCells === 0 ||
      p.initCopies === 0 || p.initCopies > 4 || p.transferBits < 880 || p.transferCells === 0 ||
      p.transferCopies < 3 || p.transferCopies > 8) throw Error('Invalid order wallet budget');
}

/** Parse every referenced cell completely. Creation-time bounds require validateOrderTerms. */
export function parseOrderTerms(cell: Cell): OrderTerms {
  const s = ordinary(cell, 'terms');
  const inputMaster = s.loadAddress(), pool = s.loadAddress(), sellIndex = s.loadUint(1) as 0 | 1;
  const recipient = s.loadAddress(), n = ordinary(s.loadRef(), 'numbers');
  s.endParse();
  const amountIn = n.loadCoins(), minOutTotal = n.loadCoins(), slices = n.loadUint(8);
  const interval = n.loadUint(32), startAt = n.loadUint(32), expiresAt = n.loadUint(32);
  const tipPerSlice = n.loadCoins(), forwardGas = n.loadUint(32), walletGas = n.loadUint(32);
  const walletGram = n.loadCoins(), executor = n.loadMaybeAddress();
  const p = ordinary(n.loadRef(), 'wallet budget');
  n.endParse();
  if (p.remainingBits !== 345 || p.remainingRefs !== 0) throw Error('Invalid order wallet budget layout');
  const fields = {} as Omit<OrderWalletBudget, 'creditProtection'>;
  for (const [key, bits] of budgetFields) fields[key] = p.loadUint(bits);
  const budget: OrderWalletBudget = { ...fields, creditProtection: p.loadBoolean() };
  p.endParse();
  const terms: OrderTerms = { inputMaster, pool, sellIndex, recipient, amountIn, minOutTotal,
    slices, interval, startAt, expiresAt, tipPerSlice, forwardGas, walletGas, walletGram, executor, budget };
  validateTermsShape(terms);
  return terms;
}

export function orderTermsToCell(t: OrderTerms): Cell {
  validateTermsShape(t);
  const budget = beginCell();
  for (const [key, bits] of budgetFields) budget.storeUint(t.budget[key], bits);
  budget.storeBit(t.budget.creditProtection);
  const nums = beginCell().storeCoins(t.amountIn).storeCoins(t.minOutTotal).storeUint(t.slices, 8)
    .storeUint(t.interval, 32).storeUint(t.startAt, 32).storeUint(t.expiresAt, 32).storeCoins(t.tipPerSlice)
    .storeUint(t.forwardGas, 32).storeUint(t.walletGas, 32).storeCoins(t.walletGram)
    .storeAddress(t.executor).storeRef(budget.endCell()).endCell();
  return beginCell().storeAddress(t.inputMaster).storeAddress(t.pool).storeUint(t.sellIndex, 1)
    .storeAddress(t.recipient).storeRef(nums).endCell();
}

/** Mirror order_validate at the original factory transaction's timestamp, never wall time. */
export function validateOrderTerms(t: OrderTerms, owner: Address, now: number): void {
  validateTermsShape(t);
  uint(now, 32, 'creation time');
  const start = Math.max(t.startAt, now);
  if (owner.workChain !== 0 || t.startAt > now + 2_592_000 ||
      start + (t.slices - 1) * t.interval >= t.expiresAt || t.expiresAt > now + 7_776_000) {
    throw Error('Invalid order creation terms');
  }
}

/** The factory validates OCRT terms, then clamps startAt before emitting OINI. */
export function canonicalOrderTerms(cell: Cell, owner: Address, now: number): Cell {
  const terms = parseOrderTerms(cell);
  validateOrderTerms(terms, owner, now);
  return orderTermsToCell({ ...terms, startAt: Math.max(terms.startAt, now) });
}

/** Terms do not participate in the child address; factory OINI evidence must bind them. */
export function orderInitialData(factory: Address, owner: Address, nonce: bigint): Cell {
  if (owner.workChain !== 0 || typeof nonce !== 'bigint' || nonce < 0n || nonce >= 1n << 64n) {
    throw Error('Invalid order identity');
  }
  return beginCell().storeAddress(factory).storeAddress(owner).storeUint(nonce, 64).storeMaybeRef(null).endCell();
}

/** Reads storage only. Callers must authenticate its code, child address, factory and immutable terms. */
export function decodeOrderState(data: Cell): OrderState {
  const s = ordinary(data, 'storage');
  const factory = s.loadAddress(), owner = s.loadAddress(), nonce = s.loadUintBig(64), body = s.loadMaybeRef();
  s.endParse();
  if (owner.workChain !== 0) throw Error('Invalid order owner');
  const identity = { factory, owner, nonce, dataHash: data.hash().toString('hex') };
  if (body === null) return { ...identity, state: 0, closeReason: 0, executedSlices: 0, execId: 0,
    lastExecutedAt: 0, attemptAt: 0, cancelRequested: false, refundSeen: false, refundKind: 0,
    refusal: 0, inputWallet: null, keeper: null, prevKeeper: null, terms: null, termsCell: null,
    termsHash: null, soldIn: 0n, inFlight: 0n, unexecutedIn: 0n };
  const b = ordinary(body, 'body');
  const state = b.loadUint(2), closeReason = b.loadUint(2), executedSlices = b.loadUint(8);
  const execId = b.loadUint(32), lastExecutedAt = b.loadUint(32), attemptAt = b.loadUint(32);
  const cancelRequested = b.loadBoolean(), refundSeen = b.loadBoolean();
  const refundKind = b.loadUint(2), refusal = b.loadUint(2), p = ordinary(b.loadRef(), 'peers');
  const termsCell = b.loadRef();
  b.endParse();
  const inputWallet = p.loadMaybeAddress(), keeper = p.loadMaybeAddress(), prevKeeper = p.loadMaybeAddress();
  p.endParse();
  const terms = parseOrderTerms(termsCell);
  if (state === 0 || refundKind > 2 || refusal > 2 || refundSeen !== (refundKind !== 0) ||
      (state === 3 ? closeReason === 0 : closeReason !== 0) || executedSlices > terms.slices ||
      executedSlices > execId || ((executedSlices === terms.slices) !== (state === 3 && closeReason === 1))) {
    throw Error('Invalid order execution state');
  }
  if (execId === 0 ? (executedSlices !== 0 || lastExecutedAt !== 0 || attemptAt !== 0 ||
      cancelRequested || refundSeen || refusal !== 0 || keeper !== null || prevKeeper !== null || state === 2) :
      (inputWallet === null || keeper === null || (execId === 1 ? prevKeeper !== null : prevKeeper === null))) {
    throw Error('Invalid order execution identity');
  }
  if (inputWallet && [factory, owner, terms.inputMaster, terms.pool, terms.recipient].some(a => inputWallet.equals(a))) {
    throw Error('Invalid order input wallet');
  }
  const slice = executedSlices === terms.slices - 1
    ? terms.amountIn - BigInt(terms.slices - 1) * (terms.amountIn / BigInt(terms.slices))
    : terms.amountIn / BigInt(terms.slices);
  const soldIn = executedSlices === terms.slices ? terms.amountIn
    : BigInt(executedSlices) * (terms.amountIn / BigInt(terms.slices));
  // Closed storage discards the prior EXECUTING state. Its zero inFlight getter
  // cannot establish that a timed-out slice returned, or that a close refund paid.
  const inFlight = state === 2 && !refundSeen ? slice : 0n;
  return { ...identity, state: state as 1 | 2 | 3, closeReason: closeReason as 0 | 1 | 2 | 3,
    executedSlices, execId, lastExecutedAt, attemptAt, cancelRequested, refundSeen,
    refundKind: refundKind as 0 | 1 | 2, refusal: refusal as 0 | 1 | 2,
    inputWallet, keeper, prevKeeper, terms, termsCell, termsHash: termsCell.hash().toString('hex'),
    soldIn, inFlight, unexecutedIn: terms.amountIn - soldIn };
}
