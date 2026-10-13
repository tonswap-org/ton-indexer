import { Address, Cell, TupleItem, beginCell } from '@ton/core';
import { writeCurrentJettonWalletStorage } from '../ledger/jettonWalletState';

export type RunGetMethodResult = {
  exitCode: number;
  stack: TupleItem[];
} | null;

export type CanonicalJettonRootData = {
  totalSupply: bigint;
  mintable: bigint;
  admin: Address | null;
  content: Cell;
  walletCode: Cell;
};

export type CanonicalJettonWalletData = {
  balance: bigint;
  owner: Address;
  root: Address;
  walletCode: Cell;
};

const unwrapTransportTuple = (stack: TupleItem[]): TupleItem[] => {
  if (stack.length === 1 && stack[0].type === 'tuple') {
    return stack[0].items;
  }
  return stack;
};

const tupleCell = (item: TupleItem | undefined): Cell | null => {
  if (!item || item.type !== 'cell') return null;
  return item.cell;
};

const tupleAddress = (item: TupleItem | undefined): Address | null | undefined => {
  if (!item) return undefined;
  if (item.type === 'null') return null;
  if (item.type !== 'cell' && item.type !== 'slice' && item.type !== 'builder') {
    return undefined;
  }
  try {
    const slice = item.cell.beginParse();
    const address = slice.loadMaybeAddress();
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return undefined;
    return address;
  } catch {
    return undefined;
  }
};

const sameCell = (left: Cell, right: Cell) => left.hash().equals(right.hash());

const sameAddress = (left: Address, right: Address) => left.equals(right);

/**
 * Builds the exact initial persistent-data cell used by TONSWAP JettonWallet.
 *
 * TEP-74 does not standardize wallet storage, so this helper must only be used
 * for TONSWAP roots whose own wallet code matches the release template; release
 * qualification independently checks the getter address against this StateInit.
 * JTW1 stores bounded identity, accounting and journal
 * groups and the protected Pool/application policies in four references; those references
 * are part of the wallet address.
 */
export const buildTonswapJettonWalletInitialData = (
  owner: Address,
  root: Address
): Cell => {
  const burnJournal = beginCell()
    .storeUint(0, 8)
    .storeUint(0n, 64)
    .storeCoins(0n)
    .storeUint(0n, 256)
    .storeAddress(null)
    .endCell();
  const mintJournal = beginCell()
    .storeUint(0, 8)
    .storeUint(0n, 64)
    .storeUint(0n, 64)
    .storeCoins(0n)
    .storeUint(0n, 256)
    .endCell();

  return writeCurrentJettonWalletStorage({
    protectedT3Epoch: 0,
    protectedRiskVaultEpoch: 0,
    protectedPoolEpoch: 0,
    protectedPoolRouter: null,
    protectedPoolQuarantine: 0n,
    protectedApplicationKind: 0,
    protectedApplicationEpoch: 0,
    protectedApplicationQuarantine: 0n,
    owner,
    root,
    feeDelegate: null,
    balance: 0n,
    lockedFees: 0n,
    borrowedFees: 0n,
    lastBounceOpcode: 0,
    lastBounceQueryId: 0n,
    lastBounceAmount: 0n,
    burnJournal,
    mintJournal,
    mintReceipts: null,
    referralNotifications: null,
  });
};

export const isSuccessfulGetterResult = (
  result: RunGetMethodResult
): result is Exclude<RunGetMethodResult, null> =>
  result !== null && (result.exitCode === 0 || result.exitCode === 1);

export const parseCanonicalJettonRootData = (
  input: TupleItem[]
): CanonicalJettonRootData | null => {
  const stack = unwrapTransportTuple(input);
  if (stack.length !== 5) return null;
  if (
    stack[0].type !== 'int' ||
    stack[0].value < 0n ||
    stack[1].type !== 'int' ||
    (stack[1].value !== 0n && stack[1].value !== -1n)
  ) {
    return null;
  }
  const admin = tupleAddress(stack[2]);
  const content = tupleCell(stack[3]);
  const walletCode = tupleCell(stack[4]);
  if (admin === undefined || !content || !walletCode) return null;
  return {
    totalSupply: stack[0].value,
    mintable: stack[1].value,
    admin,
    content,
    walletCode
  };
};

export const parseCanonicalJettonWalletAddress = (
  input: TupleItem[]
): Address | null => {
  const stack = unwrapTransportTuple(input);
  if (stack.length !== 1) return null;
  const address = tupleAddress(stack[0]);
  return address ?? null;
};

export const parseCanonicalJettonWalletData = (
  input: TupleItem[],
  expected: { owner: Address; root: Address; walletCode: Cell }
): CanonicalJettonWalletData | null => {
  const stack = unwrapTransportTuple(input);
  if (stack.length !== 4 || stack[0].type !== 'int' || stack[0].value < 0n) {
    return null;
  }
  const owner = tupleAddress(stack[1]);
  const root = tupleAddress(stack[2]);
  const walletCode = tupleCell(stack[3]);
  if (
    !owner ||
    !root ||
    !walletCode ||
    !sameAddress(owner, expected.owner) ||
    !sameAddress(root, expected.root) ||
    !sameCell(walletCode, expected.walletCode)
  ) {
    return null;
  }
  return {
    balance: stack[0].value,
    owner,
    root,
    walletCode
  };
};

export const cellFromAccountCodeBoc = (codeBoc: string | null | undefined): Cell | null => {
  if (!codeBoc || !codeBoc.trim()) return null;
  try {
    const cells = Cell.fromBoc(Buffer.from(codeBoc.trim(), 'base64'));
    return cells.length === 1 ? cells[0] : null;
  } catch {
    return null;
  }
};
