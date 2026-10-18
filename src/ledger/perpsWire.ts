import { canonicalLedgerAddress } from "./normalize";
import { Address, Cell, beginCell, contractAddress, type Slice } from "@ton/core";
import type { RawMessage, RawTransaction } from "../data/dataSource";
import { bodyCell, businessBodyCell, tokenWire, TRANSFER } from "./wire";
import { buildTonswapJettonWalletInitialData } from "../data/jettonAbi";
// Exact first-release budget split persisted by the current engine. These
// values bind a paid notification to its continuation; they are not gas quotes.
export const PERPS_ORACLE_REFRESH_VALUE = 300_000_000n;
export const PERPS_CLOSE_ORACLE_VALUE = 400_000_000n;
export const PERPS_CLOSE_PROCESSING_VALUE = 400_000_000n;
export const PERPS_RISK_ADMISSION_VALUE = 980_000_000n;
export const PERPS_NOTIFICATION_ENVELOPE_VALUE = 20_000_000n;
export const PERPS_OPEN = 0x4f50454e,
  PERPS_MODIFY = 0x4d444946,
  PERPS_CLOSE = 0x434c4f53,
  PERPS_ADD_MARGIN = 0x41444d47,
  PERPS_REMOVE_MARGIN = 0x524d5647,
  PERPS_CLAIM = 0x43464e47,
  PERPS_LIQUIDATE = 0x514c4951,
  PERPS_ADL = 0x41444c54;
export const PERPS_ORACLE_PULL = 0x50525051,
  PERPS_ORACLE_RESULT = 0x50525043,
  PERPS_ORACLE_FAILED = 0x50524641,
  PERPS_EXPIRE_ORDER = 0x50524558;
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
        v.referrer = s.loadMaybeAddress()?.toRawString() ?? null;
      }
      if (opcode === PERPS_CLOSE) {
        v.operation = "close";
        v.sizeRaw = s.loadIntBig(128).toString();
        v.limitPriceRaw = s.loadCoins().toString();
        v.referrer = s.loadMaybeAddress()?.toRawString() ?? null;
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
/** The current paid-order receipt stores the exact canonical NOTIFY envelope. */
export function perpsOpenNotification(cell: Cell) {
  try {
    const s = cell.beginParse();
    if (s.loadUint(32) !== 0x7362d09c) return null;
    const fundingQueryId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString();
    const owner = s.loadAddress().toRawString(), senderWallet = s.loadAddress().toRawString();
    const forwardTonRaw = s.loadCoins().toString(), request = perpsRequest(s.loadRef());
    if (s.remainingBits || s.remainingRefs || !request || !['open', 'modify'].includes(request.operation)) return null;
    return { fundingQueryId, amountRaw, owner, senderWallet, forwardTonRaw, request };
  } catch { return null; }
}
export function perpsOracleMessage(message?: RawMessage) {
  try {
    const body = bodyCell(message);
    if (!body) return null;
    const s = body.beginParse(), opcode = s.loadUint(32);
    if (![PERPS_ORACLE_PULL, PERPS_ORACLE_RESULT, PERPS_ORACLE_FAILED, PERPS_EXPIRE_ORDER].includes(opcode)) return null;
    const wireQueryId = s.loadUintBig(64).toString(), marketId = s.loadUint(32);
    let owner: string | undefined, requestHash: string | undefined, status: number | undefined;
    let funding: Cell | undefined;
    if (opcode === PERPS_ORACLE_PULL || opcode === PERPS_ORACLE_RESULT) {
      owner = s.loadAddress().toRawString();
      requestHash = s.loadUintBig(256).toString(16).padStart(64, '0');
    }
    if (opcode === PERPS_ORACLE_RESULT) {
      status = s.loadUint(8);
      if (status === 2) funding = s.loadRef();
      else if (status !== 3) return null;
    }
    if (wireQueryId === '0' || s.remainingBits || s.remainingRefs) return null;
    return { opcode, wireQueryId, marketId, owner, requestHash, status, funding, body };
  } catch { return null; }
}
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
  const data = buildTonswapJettonWalletInitialData(Address.parse(owner), Address.parse(root));
  return contractAddress(0, { code, data }).toRawString();
}
export function perpsControl(m: RawMessage | undefined, op: number) {
  try {
    const c = businessBodyCell(m);
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

export const PERPS_PROTOCOL_PEER_LIMIT = 32;
/** Discovery is limited to complete current requests emitted by the qualified
 * engine. It grants no settlement authority: the projector still checks each
 * original edge against its exact historical engine state and receipt. */
export function discoverPerpsPeers(transactions: RawTransaction[], engine: string, engineWallet: string) {
  const peers = new Set<string>(), custodyOwners = new Set<string>();
  const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw Error('Trailing request'); };
  const add = (destination: string, custody: boolean) => {
    peers.add(destination); if (custody) custodyOwners.add(destination);
  };
  for (const tx of transactions) {
    if (!tx.success || tx.status && tx.status !== 'success') continue;
    for (const message of tx.outMessages) {
      try {
        if (message.bounced || !message.source || !message.destination || canonicalLedgerAddress(message.source) !== engine) continue;
        const destination = canonicalLedgerAddress(message.destination), body = businessBodyCell(message);
        if (!body) continue;
        const s = body.beginParse(), op = s.loadUint(32);
        if (op === 0x52564c54) { // RVLT: actual reservation request
          if (!s.loadUintBig(64)) continue;
          s.loadUint(16); s.loadUintBig(256); s.loadCoins(); s.loadCoins(); s.loadCoins(); end(s);
          add(destination, true);
        } else if (op === 0x52565053) { // RVPS: atomic reservation replacement and payout
          if (!s.loadUintBig(64)) continue;
          s.loadUint(16); s.loadUintBig(256); s.loadUintBig(64); s.loadUintBig(256); s.loadCoins();
          const target = s.loadRef().beginParse(); end(s);
          target.loadCoins(); target.loadCoins(); target.loadCoins(); target.loadAddress(); target.loadRef(); end(target);
          add(destination, true);
        } else if (op === 0x52505251) { // RPRQ: policy request and exact callback
          if (!s.loadUint(32) || !s.loadUintBig(64)) continue; end(s); add(destination, false);
        } else if (op === 0x43524544) { // CRED: registry credit and acknowledgement
          if (!s.loadUintBig(64) || !s.loadUint(32)) continue;
          s.loadAddress(); s.loadCoins(); s.loadMaybeAddress(); end(s); add(destination, false);
        } else if (op === TRANSFER && destination === engineWallet) {
          const transfer = tokenWire(message);
          if (!transfer?.owner || transfer.op !== TRANSFER) continue;
          const f = transfer.forward.beginParse(), tag = f.loadUint(32);
          if (tag === 0x5246464c) { // RFFL: physical protocol fee custody
            if (!f.loadUintBig(64) || !f.loadUintBig(256)) continue;
            if (f.loadCoins() > BigInt(transfer.amountRaw)) continue; end(f);
          } else if (tag === 0x52564450) { // RVDP: physical collected trader-loss deposit
            f.loadUint(16); if (f.loadCoins().toString() !== transfer.amountRaw) continue; f.loadRef(); end(f);
          } else continue;
          add(canonicalLedgerAddress(transfer.owner), true);
        }
      } catch { /* Malformed output cannot widen the captured graph. */ }
    }
    if (peers.size > PERPS_PROTOCOL_PEER_LIMIT) throw Error('perps_range_protocol_account_limit');
  }
  return { peers, custodyOwners };
}
