import { Address, beginCell } from "@ton/core";
import type { RawMessage } from "../data/dataSource";
import { bodyCell } from "./wire";
export const OPTION_OWNER_ABORT = 0x4f424152,
  OPTION_VAULT_ABORT = 0x4f424142,
  OPTION_VAULT_COMMIT = 0x4f42434d,
  OPTION_VAULT_ABORT_ACK = 0x4f424141,
  OPTION_CANCEL = 0x4f42434c,
  OPTION_CANCEL_ACK = 0x4f424341;
export const BUY = {
  RESERVED: 1n,
  CUSTODY_IN_FLIGHT: 2n,
  CUSTODY_PROVEN: 4n,
  VAULT_COMMITTED: 8n,
  ABORTING: 16n,
  CANCELLED: 32n,
  REFUND_IN_FLIGHT: 64n,
  REFUNDED: 128n,
  ACTIVATING: 256n,
  ACTIVE: 512n,
  VAULT_ABORTED: 1024n,
  CUSTODY_FINALIZING: 2048n,
  CUSTODY_BOUNCED: 4096n,
  REFUND_FINALIZING: 8192n,
  REFUND_BOUNCED: 16384n,
} as const;
export function optionOwnerAbort(message?: RawMessage) {
  try {
    const cell = bodyCell(message);
    if (!cell) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== OPTION_OWNER_ABORT) return null;
    const seriesId = s.loadUintBig(64).toString(),
      positionId = s.loadUintBig(64).toString();
    if (s.remainingBits || s.remainingRefs) return null;
    return { seriesId, positionId, bodyHash: cell.hash().toString("hex") };
  } catch {
    return null;
  }
}
/** Standard VM bounce: marker plus exactly the first 256 bits of the long
 * initial series-buy body. Identity beyond opcode/wire comes from state. */
export function optionInitialBuyBounce(message?: RawMessage) {
  try {
    if (!message?.bounced) return null;
    const cell = bodyCell(message);
    if (!cell || cell.bits.length !== 288 || cell.refs.length !== 0) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== 0xffffffff) return null;
    const opcode = s.loadUint(32), wireId = s.loadUintBig(64).toString();
    if (![0x424f5952, 0x42425559].includes(opcode) || wireId === "0") return null;
    return { opcode, wireId, bodyHash: cell.hash().toString("hex"), bodyBoc: cell.toBoc().toString("base64") };
  } catch { return null; }
}
export function optionVaultAbort(message?: RawMessage) {
  try {
    const cell = bodyCell(message);
    if (!cell) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== OPTION_VAULT_ABORT) return null;
    const seriesId = s.loadUintBig(64).toString(),
      positionId = s.loadUintBig(64).toString(),
      custodyWireId = s.loadUintBig(64).toString(),
      collateralRaw = s.loadCoins().toString(),
      premiumRaw = s.loadCoins().toString(),
      recipient = s.loadAddress().toRawString(),
      vaultWallet = s.loadAddress().toRawString();
    if (s.remainingBits || s.remainingRefs) return null;
    return {
      seriesId,
      positionId,
      custodyWireId,
      collateralRaw,
      premiumRaw,
      recipient,
      vaultWallet,
      bodyHash: cell.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
export function optionBuyResponse(
  message: RawMessage | undefined,
  expected: number,
) {
  try {
    const cell = bodyCell(message);
    if (!cell) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== expected) return null;
    const seriesId = s.loadUintBig(64).toString(),
      positionId = s.loadUintBig(64).toString(),
      leg = s.loadUint(8),
      wireId = s.loadUintBig(64).toString();
    if (s.remainingBits || s.remainingRefs) return null;
    return {
      seriesId,
      positionId,
      leg,
      wireId,
      bodyHash: cell.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
export const optionDepositReceiptHash = (
  seriesId: string,
  positionId: string,
  wireId: string,
  collateralRaw: string,
  premiumRaw: string,
  vaultWallet: string,
) =>
  beginCell()
    .storeUint(BigInt(seriesId), 64)
    .storeUint(BigInt(positionId), 64)
    .storeUint(BigInt(wireId), 64)
    .storeCoins(BigInt(collateralRaw))
    .storeCoins(BigInt(premiumRaw))
    .storeAddress(Address.parse(vaultWallet))
    .endCell()
    .hash()
    .toString("hex");
export const optionAbortReceiptHash = (receiptHash: string) =>
  beginCell()
    .storeUint(OPTION_VAULT_ABORT, 32)
    .storeUint(BigInt("0x" + receiptHash), 256)
    .endCell()
    .hash()
    .toString("hex");
export const optionAbortRefundHash = (
  seriesId: string,
  positionId: string,
  wireId: string,
  amountRaw: string,
  recipient: string,
  receiptHash: string,
) =>
  beginCell()
    .storeUint(OPTION_VAULT_ABORT, 32)
    .storeUint(BigInt(seriesId), 64)
    .storeUint(BigInt(positionId), 64)
    .storeUint(BigInt(wireId), 64)
    .storeCoins(BigInt(amountRaw))
    .storeAddress(Address.parse(recipient))
    .storeUint(BigInt("0x" + receiptHash), 256)
    .endCell()
    .hash()
    .toString("hex");

export function optionVaultCommit(message?: RawMessage) {
  try {
    const cell = bodyCell(message);
    if (!cell) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== OPTION_VAULT_COMMIT) return null;
    const seriesId = s.loadUintBig(64).toString(),
      positionId = s.loadUintBig(64).toString(),
      custodyWireId = s.loadUintBig(64).toString(),
      collateralRaw = s.loadCoins().toString(),
      premiumRaw = s.loadCoins().toString(),
      vaultWallet = s.loadAddress().toRawString();
    if (s.remainingBits || s.remainingRefs) return null;
    return {
      seriesId,
      positionId,
      custodyWireId,
      collateralRaw,
      premiumRaw,
      vaultWallet,
      bodyHash: cell.hash().toString("hex"),
    };
  } catch {
    return null;
  }
}
