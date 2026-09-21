import { Address, beginCell, Cell } from "@ton/core";

export const CURRENT_JETTON_WALLET_STORAGE_MAGIC = 0x4a545731; // JTW1

export type CurrentJettonWalletStorage = {
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

export function readCurrentJettonWalletStorage(data: Cell): CurrentJettonWalletStorage {
  const outer = data.beginParse();
  if (outer.remainingBits !== 32 || outer.remainingRefs !== 3 ||
      outer.loadUint(32) !== CURRENT_JETTON_WALLET_STORAGE_MAGIC) {
    throw Error("Current JTW1 wallet storage required");
  }
  const identity = outer.loadRef().beginParse();
  const accounting = outer.loadRef().beginParse();
  const journals = outer.loadRef().beginParse();
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
  return { owner, root, feeDelegate, balance, lockedFees, borrowedFees, lastBounceOpcode,
    lastBounceQueryId, lastBounceAmount, burnJournal, mintJournal, mintReceipts, referralNotifications };
}

export function writeCurrentJettonWalletStorage(storage: CurrentJettonWalletStorage): Cell {
  const identity = storeFixedAddress(storeFixedAddress(beginCell(), storage.owner), storage.root)
    .storeBit(storage.feeDelegate !== null);
  if (storage.feeDelegate) storeFixedAddress(identity, storage.feeDelegate);
  else identity.storeInt(0, 8).storeUint(0, 256);
  return beginCell().storeUint(CURRENT_JETTON_WALLET_STORAGE_MAGIC, 32)
    .storeRef(identity.endCell())
    .storeRef(beginCell().storeCoins(storage.balance).storeCoins(storage.lockedFees)
      .storeCoins(storage.borrowedFees).storeUint(storage.lastBounceOpcode, 32)
      .storeUint(storage.lastBounceQueryId, 64).storeCoins(storage.lastBounceAmount).endCell())
    .storeRef(beginCell().storeRef(storage.burnJournal).storeRef(storage.mintJournal)
      .storeMaybeRef(storage.mintReceipts).storeMaybeRef(storage.referralNotifications).endCell())
    .endCell();
}
