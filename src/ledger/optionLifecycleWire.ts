import { Address, beginCell, type Slice } from "@ton/core";
import type { RawMessage } from "../data/dataSource";
import { bodyCell } from "./wire";
export const OPTION_EXERCISE = 0x46455843,
  OPTION_SHOUT_EXERCISE = 0x45585243,
  OPTION_SPREAD_EXERCISE = 0x45585350,
  OPTION_SHOUT_PAYOUT = 0x53595054,
  OPTION_VAULT_PAYOUT = 0x53505954,
  OPTION_RELEASE_COLLATERAL = 0x52434c4b,
  OPTION_CLAIM_RECEIPT = 0x4f435243,
  OPTION_CLAIM_RETRY = 0x4f435259,
  OPTION_NATIVE_REFUND = 0x4f524644;
const end = (s: Slice) => {
  if (s.remainingBits || s.remainingRefs)
    throw Error("Trailing option lifecycle fields");
};
export function optionExercise(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== OPTION_EXERCISE) return null;
    const seriesId = s.loadUintBig(64).toString(),
      positionId = s.loadUintBig(64).toString(),
      recipient = s.loadAddress().toRawString(),
      payoutRaw = s.loadCoins().toString(),
      premiumBurnRaw = s.loadCoins().toString();
    end(s);
    return {
      seriesId,
      positionId,
      recipient,
      payoutRaw,
      premiumBurnRaw,
      bodyHash: c.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
export function optionProductExercise(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse(),
      opcode = s.loadUint(32);
    if (
      ![
        OPTION_SHOUT_EXERCISE,
        OPTION_SPREAD_EXERCISE,
        OPTION_SHOUT_PAYOUT,
      ].includes(opcode)
    )
      return null;
    const positionId = s.loadUintBig(64).toString();
    let recipient: string | undefined,
      payoutRaw: string,
      premiumBurnRaw: string | undefined,
      refundTo: string | undefined;
    if (opcode === OPTION_SHOUT_PAYOUT) {
      recipient = s.loadAddress().toRawString();
      payoutRaw = s.loadCoins().toString();
    } else {
      payoutRaw = s.loadCoins().toString();
      if (opcode === OPTION_SHOUT_EXERCISE)
        recipient = s.loadAddress().toRawString();
    }
    if (opcode !== OPTION_SPREAD_EXERCISE) {
      premiumBurnRaw = s.loadCoins().toString();
      refundTo = s.loadAddress().toRawString();
    }
    end(s);
    return {
      opcode,
      positionId,
      payoutRaw,
      recipient,
      premiumBurnRaw,
      refundTo,
      bodyHash: c.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
export function optionVaultPayout(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== OPTION_VAULT_PAYOUT) return null;
    const positionId = s.loadUintBig(64).toString(),
      seriesId = s.loadUintBig(64).toString(),
      recipient = s.loadAddress().toRawString(),
      payoutRaw = s.loadCoins().toString(),
      premiumBurnRaw = s.loadCoins().toString(),
      refundTo = s.loadAddress().toRawString();
    end(s);
    return {
      seriesId,
      positionId,
      recipient,
      payoutRaw,
      premiumBurnRaw,
      refundTo,
      bodyHash: c.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
export function optionClaimReceipt(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== OPTION_CLAIM_RECEIPT) return null;
    const claimId = s.loadUintBig(64).toString(),
      kind = s.loadUint(8),
      wireId = s.loadUintBig(64).toString(),
      amountRaw = s.loadCoins().toString(),
      identityHash = s.loadUintBig(256).toString(16).padStart(64, "0");
    end(s);
    return {
      claimId,
      kind,
      wireId,
      amountRaw,
      identityHash,
      bodyHash: c.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
export const optionSettlementKey = (
  kind: number,
  seriesId: string,
  positionId: string,
) =>
  beginCell()
    .storeUint(kind, 8)
    .storeUint(BigInt(seriesId), 64)
    .storeUint(BigInt(positionId), 64)
    .endCell()
    .hash()
    .toString("hex");
export const optionPositionClaimIdentity = (
  kind: number,
  seriesId: string,
  positionId: string,
  owner: string,
  recipient: string,
  amountRaw: string,
) =>
  beginCell()
    .storeUint(OPTION_CLAIM_RECEIPT, 32)
    .storeUint(kind, 8)
    .storeUint(BigInt(seriesId), 64)
    .storeUint(BigInt(positionId), 64)
    .storeAddress(Address.parse(owner))
    .storeAddress(Address.parse(recipient))
    .storeCoins(BigInt(amountRaw))
    .endCell()
    .hash()
    .toString("hex");
export const optionIngressClaimIdentity = (
  owner: string,
  queryId: string,
  amountRaw: string,
  payloadHash: string,
) =>
  beginCell()
    .storeUint(OPTION_CLAIM_RECEIPT, 32)
    .storeUint(1, 8)
    .storeAddress(Address.parse(owner))
    .storeUint(BigInt(queryId), 64)
    .storeCoins(BigInt(amountRaw))
    .storeUint(BigInt("0x" + payloadHash), 256)
    .endCell()
    .hash()
    .toString("hex");
