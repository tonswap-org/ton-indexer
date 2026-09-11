import { Address, Cell, Dictionary, beginCell } from "@ton/core";
import { burnIntentHash } from "./t3Wire";
const end = (s: ReturnType<Cell["beginParse"]>) => {
  if (s.remainingBits || s.remainingRefs)
    throw Error("Trailing T3 recovery storage");
};
const hex = (n: bigint | undefined) =>
  n === undefined ? null : n.toString(16).padStart(64, "0");
export const t3ReceiptKey = (
  domain: number,
  root: string,
  party: string,
  id: string,
) =>
  beginCell()
    .storeUint(domain, 32)
    .storeAddress(Address.parse(root))
    .storeAddress(Address.parse(party))
    .storeUint(BigInt(id), 64)
    .endCell()
    .hash();
export function readT3RecoveryRoot(
  boc: string,
  root: string,
  wallet: string,
  hub: string,
  queryId: string,
  wireId: string,
) {
  const cell = Cell.fromBase64(boc),
    s = cell.beginParse();
  if (s.loadUint(32) !== 0x4a545253 || s.remainingBits || s.remainingRefs !== 4)
    throw Error("T3 root storage");
  const registry = s.loadRef().beginParse(),
    data = s.loadRef().beginParse();
  registry.loadMaybeAddress();
  const enabled = registry.loadUint(8),
    withdrawalsOnly = registry.loadUint(8);
  registry.loadRef();
  end(registry);
  if (enabled > 1 || withdrawalsOnly > 1) throw Error("T3 root flags");
  const totalSupplyRaw = data.loadCoins().toString();
  data.loadMaybeAddress();
  const walletCode = data.loadRef();
  data.loadRef();
  const emitter = data.loadMaybeAddress()?.toRawString() ?? null;
  end(data);
  const r = s.loadRef().beginParse(),
    receipts = r.loadDict(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.BigUint(256),
    );
  end(r);
  s.loadRef();
  end(s);
  const get = (domain: number, party: string, id: string) =>
    receipts.get(
      BigInt("0x" + t3ReceiptKey(domain, root, party, id).toString("hex")),
    );
  return {
    walletCode,
    summary: {
      enabled,
      withdrawalsOnly,
      totalSupplyRaw,
      emitter,
      walletCodeHash: walletCode.hash().toString("hex"),
      receiptHash: hex(get(0x4a425354, wallet, queryId)),
      pendingHash: hex(get(0x54334250, wallet, queryId)),
      negativeHash: hex(get(0x5433424e, wallet, queryId)),
      acceptedHash: hex(get(0x54334241, wallet, queryId)),
      wireWalletHash: hex(get(0x54334257, hub, wireId)),
      wireQueryId: get(0x54334251, hub, wireId)?.toString() ?? null,
      wireIntentHash: hex(get(0x54334249, hub, wireId)),
      wireAmountRaw: get(0x5433424d, hub, wireId)?.toString() ?? null,
      dataHash: cell.hash().toString("hex"),
    },
  };
}
export function readT3RecoveryWallet(boc: string) {
  const cell = Cell.fromBase64(boc),
    s = cell.beginParse(),
    balanceRaw = s.loadCoins().toString(),
    owner = s.loadAddress().toRawString(),
    root = s.loadAddress().toRawString();
  const lockedFeesRaw = s.loadCoins().toString(),
    borrowedFeesRaw = s.loadCoins().toString(),
    destination = s.loadMaybeAddress()?.toRawString() ?? null,
    opcode = s.loadUint(32),
    transferQueryId = s.loadUintBig(64).toString(),
    transferAmountRaw = s.loadCoins().toString();
  // Current jetton_wallet.tolk settlement_status: the root-cell tuple is
  // separate from the burn journal below. NONE may retain a finalized tuple.
  const transferStatus: 0 | 1 | 2 | 3 = destination === null
    ? 0
    : opcode === 0x4a534954
      ? 1
      : opcode === 0x4a535543
        ? 2
        : opcode === 0x4a544246
          ? 3
          : 0;
  const j = s.loadRef().beginParse();
  s.loadRef();
  end(s);
  const status = j.loadUint(8),
    queryId = j.loadUintBig(64).toString(),
    amountRaw = j.loadCoins().toString(),
    requestHash = hex(j.loadUintBig(256))!,
    response = j.loadMaybeAddress()?.toRawString() ?? null;
  end(j);
  if (status > 5) throw Error("T3 wallet status");
  return {
    balanceRaw,
    owner,
    root,
    lockedFeesRaw,
    borrowedFeesRaw,
    transfer: {
      status: transferStatus,
      queryId: transferQueryId,
      amountRaw: transferAmountRaw,
      destination,
      opcode,
    },
    journal: { status, queryId, amountRaw, requestHash, response },
    dataHash: cell.hash().toString("hex"),
  };
}
export function readT3RecoveryHub(boc: string, owner: string, queryId: string) {
  const cell = Cell.fromBase64(boc),
    s = cell.beginParse();
  if (s.loadUint(32) !== 0x54335354 || s.remainingBits || s.remainingRefs !== 1)
    throw Error("T3 hub storage");
  const data = s.loadRef().beginParse();
  data.skip(40);
  for (let i = 0; i < 4; i++) data.loadCoins();
  data.loadRef();
  data.loadRef();
  data.skip(208);
  data.loadRef();
  data.loadMaybeAddress();
  const root = data.loadAddress().toRawString(),
    enabled = data.loadUint(8),
    b = data.loadRef().beginParse();
  end(data);
  if (enabled > 1) throw Error("T3 hub enabled");
  b.loadMaybeAddress();
  b.skip(64);
  b.loadCoins();
  b.skip(64);
  b.loadMaybeAddress();
  b.skip(32);
  b.loadCoins();
  b.skip(64);
  b.loadRef();
  const p = b.loadRef().beginParse();
  end(b);
  p.loadUintBig(64);
  const entries = p.loadDict(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    ),
    identities = p.loadDict(
      Dictionary.Keys.BigUint(64),
      Dictionary.Values.BigUint(256),
    );
  end(p);
  const key = BigInt("0x" + burnIntentHash(owner, queryId)),
    entry = entries.get(key);
  if (!entry)
    return {
      root,
      enabled,
      proof: null,
      dataHash: cell.hash().toString("hex"),
    };
  const v = entry.beginParse(),
    proof = {
      queryId: v.loadUintBig(64).toString(),
      wireId: v.loadUintBig(64).toString(),
      owner: v.loadAddress().toRawString(),
      recipient: v.loadAddress().toRawString(),
      amountRaw: v.loadCoins().toString(),
      slippage: v.loadUint(16),
      mode: v.loadUint(8),
      outputToken: v.loadUint(8),
      payoutId: v.loadUintBig(64).toString(),
      consumed: v.loadUint(8),
    };
  end(v);
  if (
    proof.consumed > 1 ||
    proof.payoutId === "0" ||
    proof.wireId === "0" ||
    identities.get(BigInt(proof.payoutId)) !== key
  )
    throw Error("T3 proof identity");
  return { root, enabled, proof, dataHash: cell.hash().toString("hex") };
}
