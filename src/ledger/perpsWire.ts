import { Address, Cell, beginCell, contractAddress } from "@ton/core";
import type { RawMessage } from "../data/dataSource";
import { bodyCell } from "./wire";
export const PERPS_OPEN = 0x4f50454e,
  PERPS_MODIFY = 0x4d444946,
  PERPS_CLOSE = 0x434c4f53,
  PERPS_ADD_MARGIN = 0x41444d47,
  PERPS_REMOVE_MARGIN = 0x524d5647,
  PERPS_CLAIM = 0x43464e47,
  PERPS_LIQUIDATE = 0x514c4951,
  PERPS_ADL = 0x41444c54;
export const PERPS_USER_OPS = new Set([
  PERPS_OPEN,
  PERPS_MODIFY,
  PERPS_CLOSE,
  PERPS_ADD_MARGIN,
  PERPS_REMOVE_MARGIN,
  PERPS_CLAIM,
  PERPS_LIQUIDATE,
  PERPS_ADL,
]);
export type PerpsRequest = {
  opcode: number;
  operation:
    | "open"
    | "modify"
    | "close"
    | "add_margin"
    | "remove_margin"
    | "claim"
    | "liquidation"
    | "adl";
  queryId: string;
  marketId: number;
  owner?: string;
  sizeRaw?: string;
  marginRaw?: string;
  limitPriceRaw?: string;
  leverageBps?: number;
  flags?: number;
  referrer?: string | null;
};
export function perpsRequest(cell: Cell): PerpsRequest | null {
  try {
    const s = cell.beginParse(),
      opcode = s.loadUint(32);
    if (!PERPS_USER_OPS.has(opcode)) return null;
    let v: PerpsRequest;
    if (opcode === PERPS_ADL) {
      const marketId = s.loadUint(32),
        owner = s.loadAddress().toRawString(),
        sizeRaw = s.loadIntBig(128).toString(),
        queryId = s.loadUintBig(64).toString();
      v = { opcode, operation: "adl", marketId, owner, sizeRaw, queryId };
    } else {
      const queryId = s.loadUintBig(64).toString(),
        marketId = s.loadUint(32);
      v = { opcode, queryId, marketId, operation: "claim" };
      if (opcode === PERPS_OPEN) {
        v.operation = "open";
        v.sizeRaw = s.loadIntBig(128).toString();
        v.marginRaw = s.loadCoins().toString();
        v.limitPriceRaw = s.loadCoins().toString();
        v.leverageBps = s.loadUint(32);
        v.referrer = s.loadMaybeAddress()?.toRawString() ?? null;
      }
      if (opcode === PERPS_MODIFY) {
        v.operation = "modify";
        v.sizeRaw = s.loadIntBig(128).toString();
        v.marginRaw = s.loadIntBig(128).toString();
        v.limitPriceRaw = s.loadCoins().toString();
        v.flags = s.loadUint(32);
      }
      if (opcode === PERPS_CLOSE) {
        v.operation = "close";
        v.sizeRaw = s.loadIntBig(128).toString();
        v.limitPriceRaw = s.loadCoins().toString();
      }
      if (opcode === PERPS_ADD_MARGIN || opcode === PERPS_REMOVE_MARGIN) {
        v.operation =
          opcode === PERPS_ADD_MARGIN ? "add_margin" : "remove_margin";
        v.marginRaw = s.loadCoins().toString();
      }
      if (opcode === PERPS_LIQUIDATE) {
        v.operation = "liquidation";
        v.owner = s.loadAddress().toRawString();
        v.sizeRaw = s.loadCoins().toString();
      }
    }
    if (s.remainingBits || s.remainingRefs) return null;
    return v;
  } catch {
    return null;
  }
}
export const perpsMessage = (m?: RawMessage) => {
  const c = bodyCell(m);
  return c ? perpsRequest(c) : null;
};
export const perpsPositionKey = (owner: string, marketId: number) =>
  beginCell()
    .storeAddress(Address.parse(owner))
    .storeUint(marketId, 32)
    .endCell()
    .hash()
    .toString("hex");
export const perpsTransferKey = (wallet: string) =>
  beginCell()
    .storeUint(0x54524e46, 32)
    .storeAddress(Address.parse(wallet))
    .endCell()
    .hash()
    .toString("hex");
export function perpsWalletAddress(code: Cell, root: string, owner: string) {
  const data = beginCell()
    .storeCoins(0)
    .storeAddress(Address.parse(owner))
    .storeAddress(Address.parse(root))
    .storeCoins(0)
    .storeCoins(0)
    .storeAddress(null)
    .storeUint(0, 32)
    .storeUint(0, 64)
    .storeCoins(0)
    .storeRef(
      beginCell()
        .storeUint(0, 8)
        .storeUint(0, 64)
        .storeCoins(0)
        .storeUint(0, 256)
        .storeAddress(null)
        .endCell(),
    )
    .storeRef(
      beginCell()
        .storeUint(0, 8)
        .storeUint(0, 64)
        .storeUint(0, 64)
        .storeCoins(0)
        .storeUint(0, 256)
        .endCell(),
    )
    .endCell();
  return contractAddress(0, { code, data }).toRawString();
}
export function perpsControl(m: RawMessage | undefined, op: number) {
  try {
    const c = bodyCell(m);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== op) return null;
    const queryId = s.loadUintBig(64).toString(),
      amountRaw = s.loadCoins().toString(),
      destination = s.loadAddress().toRawString();
    if (s.remainingBits || s.remainingRefs) return null;
    return { queryId, amountRaw, destination };
  } catch {
    return null;
  }
}
