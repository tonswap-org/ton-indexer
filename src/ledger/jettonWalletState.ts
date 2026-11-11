import { Address, beginCell, Cell } from "@ton/core";

export const CURRENT_JETTON_WALLET_STORAGE_MAGIC = 0x4a545731; // JTW1

export type CurrentJettonWalletStorage = {
  protectedT3Epoch?: number;
  protectedRiskVaultEpoch?: number;
  protectedPoolEpoch?: number;
  protectedPoolRouter?: Address | null;
  protectedPoolQuarantine?: bigint;
  protectedApplicationKind?: number;
  protectedApplicationEpoch?: number;
  protectedApplicationQuarantine?: bigint;
  owner: Address;
  root: Address;
  feeDelegate: Address | null;
  balance: bigint;
  lockedFees: bigint;
  borrowedFees: bigint;
  lastBounceOpcode: number;
  lastBounceQueryId: bigint;
  lastBounceAmount: bigint;
  burnJournal: Cell;
  mintJournal: Cell;
  mintReceipts: Cell | null;
  referralNotifications: Cell | null;
};

const end = (slice: ReturnType<Cell["beginParse"]>, label: string) => {
  if (slice.remainingBits || slice.remainingRefs) throw Error(`Trailing ${label}`);
};

const addressFromFixedParts = (workchain: number, hash: bigint) =>
  new Address(workchain, Buffer.from(hash.toString(16).padStart(64, "0"), "hex"));

const storeFixedAddress = (builder: ReturnType<typeof beginCell>, address: Address) =>
  builder.storeInt(address.workChain, 8).storeBuffer(address.hash);

const loadCanonicalCoins = (slice: ReturnType<Cell["beginParse"]>, label: string) => {
  const byteLength = slice.loadUint(4);
  if (!byteLength) return 0n;
  const amount = slice.loadUintBig(byteLength * 8);
  if (amount < (1n << BigInt((byteLength - 1) * 8))) throw Error(`Noncanonical ${label}`);
  return amount;
};

const requireApplicationPolicy = (kind: number, epoch: number, quarantine: bigint, balance: bigint,
  t3Epoch: number, riskEpoch: number, poolEpoch: number) => {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff ||
      ![0, 1, 2].includes(kind) || (epoch === 0) !== (kind === 0) ||
      (epoch === 0 && quarantine !== 0n) || quarantine < 0n || quarantine > balance ||
      (epoch !== 0 && (t3Epoch !== 0 || riskEpoch !== 0 || poolEpoch !== 0))) {
    throw Error('Invalid or mixed JTW1 protected application policy');
  }
};

export function readCurrentJettonWalletStorage(data: Cell): CurrentJettonWalletStorage {
  const outer = data.beginParse();
  if (outer.remainingBits !== 96 || outer.remainingRefs !== 4 ||
      outer.loadUint(32) !== CURRENT_JETTON_WALLET_STORAGE_MAGIC) {
    throw Error("Current JTW1 wallet storage required");
  }
  const protectedT3Epoch = outer.loadUint(32);
  const protectedRiskVaultEpoch = outer.loadUint(32);
  const identity = outer.loadRef().beginParse();
  const accounting = outer.loadRef().beginParse();
  const journals = outer.loadRef().beginParse();
  const poolPolicy = outer.loadRef().beginParse();
  end(outer, "JTW1 root");
  const owner = addressFromFixedParts(identity.loadInt(8), identity.loadUintBig(256));
  const root = addressFromFixedParts(identity.loadInt(8), identity.loadUintBig(256));
  const hasFeeDelegate = identity.loadBoolean();
  const feeDelegateWorkchain = identity.loadInt(8), feeDelegateHash = identity.loadUintBig(256);
  if (!hasFeeDelegate && (feeDelegateWorkchain !== 0 || feeDelegateHash !== 0n)) {
    throw Error("Absent JTW1 fee delegate must use zero fixed fields");
  }
  const feeDelegate = hasFeeDelegate ? addressFromFixedParts(feeDelegateWorkchain, feeDelegateHash) : null;
  end(identity, "JTW1 identity");
  const balance = loadCanonicalCoins(accounting, "JTW1 balance"),
    lockedFees = loadCanonicalCoins(accounting, "JTW1 locked fees"),
    borrowedFees = loadCanonicalCoins(accounting, "JTW1 borrowed fees");
  const lastBounceOpcode = accounting.loadUint(32), lastBounceQueryId = accounting.loadUintBig(64),
    lastBounceAmount = loadCanonicalCoins(accounting, "JTW1 bounce amount");
  end(accounting, "JTW1 accounting");
  const burnJournal = journals.loadRef(), mintJournal = journals.loadRef();
  const mintReceipts = journals.loadMaybeRef(), referralNotifications = journals.loadMaybeRef();
  end(journals, "JTW1 journals");
  const protectedPoolEpoch = poolPolicy.loadUint(32),
    protectedPoolRouter = poolPolicy.loadMaybeAddress(),
    protectedPoolQuarantine = loadCanonicalCoins(poolPolicy, 'protected Pool quarantine');
  const protectedApplicationKind = poolPolicy.loadUint(8),
    protectedApplicationEpoch = poolPolicy.loadUint(32),
    protectedApplicationQuarantine = loadCanonicalCoins(poolPolicy, 'protected application quarantine');
  end(poolPolicy, 'JTW1 protected wallet policy');
  if ((protectedPoolEpoch === 0 && (protectedPoolRouter !== null || protectedPoolQuarantine !== 0n)) ||
      protectedPoolQuarantine > balance) throw Error('Invalid protected Pool wallet quarantine');
  requireApplicationPolicy(protectedApplicationKind, protectedApplicationEpoch, protectedApplicationQuarantine,
    balance, protectedT3Epoch, protectedRiskVaultEpoch, protectedPoolEpoch);
  return { protectedT3Epoch, protectedRiskVaultEpoch, protectedPoolEpoch, protectedPoolRouter,
    protectedPoolQuarantine, protectedApplicationKind, protectedApplicationEpoch, protectedApplicationQuarantine,
    owner, root, feeDelegate, balance, lockedFees, borrowedFees, lastBounceOpcode,
    lastBounceQueryId, lastBounceAmount, burnJournal, mintJournal, mintReceipts, referralNotifications };
}

export function writeCurrentJettonWalletStorage(storage: CurrentJettonWalletStorage): Cell {
  const protectedT3Epoch = storage.protectedT3Epoch ?? 0;
  const protectedRiskVaultEpoch = storage.protectedRiskVaultEpoch ?? 0;
  const protectedPoolEpoch = storage.protectedPoolEpoch ?? 0;
  const protectedPoolRouter = storage.protectedPoolRouter ?? null;
  const protectedPoolQuarantine = storage.protectedPoolQuarantine ?? 0n;
  const protectedApplicationKind = storage.protectedApplicationKind ?? 0;
  const protectedApplicationEpoch = storage.protectedApplicationEpoch ?? 0;
  const protectedApplicationQuarantine = storage.protectedApplicationQuarantine ?? 0n;
  requireApplicationPolicy(protectedApplicationKind, protectedApplicationEpoch, protectedApplicationQuarantine,
    storage.balance, protectedT3Epoch, protectedRiskVaultEpoch, protectedPoolEpoch);
  if (!Number.isInteger(protectedT3Epoch) || protectedT3Epoch < 0 || protectedT3Epoch > 0xffffffff) {
    throw Error("JTW1 protected T3 epoch must fit uint32");
  }
  if (!Number.isInteger(protectedRiskVaultEpoch) || protectedRiskVaultEpoch < 0 || protectedRiskVaultEpoch > 0xffffffff) {
    throw Error("JTW1 protected RiskVault epoch must fit uint32");
  }
  if (!Number.isInteger(protectedPoolEpoch) || protectedPoolEpoch < 0 || protectedPoolEpoch > 0xffffffff ||
      (protectedPoolEpoch === 0 && (protectedPoolRouter !== null || protectedPoolQuarantine !== 0n)) ||
      protectedPoolQuarantine < 0n || protectedPoolQuarantine > storage.balance) {
    throw Error('JTW1 protected Pool policy or quarantine is invalid');
  }
  const identity = storeFixedAddress(storeFixedAddress(beginCell(), storage.owner), storage.root)
    .storeBit(storage.feeDelegate !== null);
  if (storage.feeDelegate) storeFixedAddress(identity, storage.feeDelegate);
  else identity.storeInt(0, 8).storeUint(0, 256);
  return beginCell().storeUint(CURRENT_JETTON_WALLET_STORAGE_MAGIC, 32).storeUint(protectedT3Epoch, 32)
    .storeUint(protectedRiskVaultEpoch, 32)
    .storeRef(identity.endCell())
    .storeRef(beginCell().storeCoins(storage.balance).storeCoins(storage.lockedFees)
      .storeCoins(storage.borrowedFees).storeUint(storage.lastBounceOpcode, 32)
      .storeUint(storage.lastBounceQueryId, 64).storeCoins(storage.lastBounceAmount).endCell())
    .storeRef(beginCell().storeRef(storage.burnJournal).storeRef(storage.mintJournal)
      .storeMaybeRef(storage.mintReceipts).storeMaybeRef(storage.referralNotifications).endCell())
    .storeRef(beginCell().storeUint(protectedPoolEpoch, 32).storeAddress(protectedPoolRouter)
      .storeCoins(protectedPoolQuarantine).storeUint(protectedApplicationKind, 8)
      .storeUint(protectedApplicationEpoch, 32).storeCoins(protectedApplicationQuarantine).endCell())
    .endCell();
}
