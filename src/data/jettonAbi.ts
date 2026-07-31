import { Address, Cell, TupleItem, beginCell } from '@ton/core';

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

export type CanonicalJettonBalance = {
  wallet: string;
  balance: string;
};

type CanonicalJettonBalanceReader = {
  owner: string;
  master: string;
  runGetMethod: (
    address: string,
    method: 'get_jetton_data' | 'get_wallet_address' | 'get_wallet_data',
    args?: TupleItem[]
  ) => Promise<RunGetMethodResult>;
  readAccountCode: (address: string) => Promise<Cell | null>;
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
 * for TONSWAP roots whose getter address is independently checked against the
 * resulting StateInit. The empty burn and mint journals are refs and therefore
 * remain part of the wallet address even before either settlement flow runs.
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

  return beginCell()
    .storeCoins(0n)
    .storeAddress(owner)
    .storeAddress(root)
    .storeCoins(0n)
    .storeCoins(0n)
    .storeAddress(null)
    .storeUint(0, 32)
    .storeUint(0n, 64)
    .storeCoins(0n)
    .storeRef(burnJournal)
    .storeRef(mintJournal)
    .endCell();
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

export const readCanonicalJettonBalance = async (
  reader: CanonicalJettonBalanceReader
): Promise<CanonicalJettonBalance | null> => {
  try {
    const owner = Address.parse(reader.owner);
    const master = Address.parse(reader.master);
    const masterRaw = master.toRawString();

    const rootResult = await reader.runGetMethod(masterRaw, 'get_jetton_data', []);
    if (!isSuccessfulGetterResult(rootResult)) return null;
    const rootData = parseCanonicalJettonRootData(rootResult.stack);
    if (!rootData) return null;

    const ownerArgument: TupleItem = {
      type: 'slice',
      cell: beginCell().storeAddress(owner).endCell()
    };
    const addressResult = await reader.runGetMethod(
      masterRaw,
      'get_wallet_address',
      [ownerArgument]
    );
    if (!isSuccessfulGetterResult(addressResult)) return null;
    const wallet = parseCanonicalJettonWalletAddress(addressResult.stack);
    if (!wallet) return null;

    const walletRaw = wallet.toRawString();
    const walletResult = await reader.runGetMethod(walletRaw, 'get_wallet_data', []);
    if (!isSuccessfulGetterResult(walletResult)) return null;
    const walletData = parseCanonicalJettonWalletData(walletResult.stack, {
      owner,
      root: master,
      walletCode: rootData.walletCode
    });
    if (!walletData) return null;

    // TEP-74 does not standardize a wallet's persistent-data layout, so an indexer
    // cannot independently derive every third-party wallet address from code alone.
    // It can still fail closed on all identities the getter ABI exposes. Requiring
    // the active account code additionally prevents trusting a wallet getter that
    // merely claims the root's expected code. A source that cannot expose account
    // code returns no balance instead of weakening this check.
    const accountCode = await reader.readAccountCode(walletRaw);
    if (!accountCode || !sameCell(accountCode, rootData.walletCode)) return null;

    return {
      wallet: wallet.toString({ urlSafe: true, bounceable: true }),
      balance: walletData.balance.toString(10)
    };
  } catch {
    return null;
  }
};
