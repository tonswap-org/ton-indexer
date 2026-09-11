import { Address, Cell, Slice } from '@ton/core';
import type { RawMessage } from '../data/dataSource';
export const TRANSFER = 0x0f8a7ea5,
  INTERNAL = 0x178d4519,
  SETTLEMENT_INTERNAL = 0x4a534954,
  NOTIFY = 0x7362d09c,
  BURN = 0x595f07bc,
  BURN_NOTIFY = 0x7bdd97de;
export const SWAP = 0x53574150,
  ADD = 0x444c4144,
  REMOVE = 0x44524d56,
  WITHDRAW_COMPLETE = 0x4457434d;
export const TOKEN_CONTROL_OPS = new Set([
  TRANSFER,
  INTERNAL,
  SETTLEMENT_INTERNAL,
  NOTIFY,
  BURN,
  BURN_NOTIFY,
  0xd53276db,
  0x4a534143,
  0x4a535543,
  0x4a53464e,
  0x4a53464b,
  0x4a535250,
  0x4a544246,
]);
export const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
export function bodyCell(message?: RawMessage): Cell | null {
  try {
    if (!message?.body) return null;
    const cells = Cell.fromBoc(Buffer.from(message.body, 'base64'));
    if (cells.length !== 1) return null;
    const cell = cells[0];
    if (
      message.op !== undefined &&
      cell.bits.length >= 32 &&
      cell.beginParse().preloadUint(32) !== message.op
    )
      return null;
    return cell;
  } catch {
    return null;
  }
}
export function opcode(message?: RawMessage) {
  const cell = bodyCell(message);
  return cell && cell.bits.length >= 32
    ? cell.beginParse().preloadUint(32)
    : null;
}
const end = (s: Slice) => {
  if (s.remainingBits || s.remainingRefs) throw new Error('trailing wire data');
};
const forward = (s: Slice) => {
  if (s.loadBit()) {
    const cell = s.loadRef();
    end(s);
    return cell;
  }
  return s.asCell();
};
export type TokenWire = {
  op: number;
  queryId: string;
  amountRaw: string;
  owner: string | null;
  response: string | null;
  forwardTonRaw: string;
  forward: Cell;
  custom?: Cell | null;
  senderWallet?: string | null;
};
/** Current TONSWAP cell-ref ABI and standard TEP-74 are distinct wire formats.
 * Accept a format only when it consumes the complete envelope; ambiguous parses fail closed. */
export function tokenWire(message?: RawMessage): TokenWire | null {
  const cell = bodyCell(message);
  if (!cell) return null;
  const parse = (canonical: boolean): TokenWire | null => {
    try {
      const s = cell.beginParse(),
        op = s.loadUint(32);
      if (
        ![
          TRANSFER,
          INTERNAL,
          SETTLEMENT_INTERNAL,
          NOTIFY,
          BURN_NOTIFY,
        ].includes(op) ||
        (!canonical && op === SETTLEMENT_INTERNAL)
      )
        return null;
      const queryId = s.loadUintBig(64).toString(),
        amountRaw = s.loadCoins().toString(),
        owner = s.loadMaybeAddress()?.toRawString() ?? null;
      if (op === NOTIFY) {
        if (!canonical)
          return {
            op,
            queryId,
            amountRaw,
            owner,
            response: null,
            forwardTonRaw: '0',
            forward: forward(s),
          };
        const senderWallet = s.loadMaybeAddress()?.toRawString() ?? null,
          forwardTonRaw = s.loadCoins().toString(),
          payload = s.loadRef();
        end(s);
        return {
          op,
          queryId,
          amountRaw,
          owner,
          response: null,
          senderWallet,
          forwardTonRaw,
          forward: payload,
        };
      }
      const response = s.loadMaybeAddress()?.toRawString() ?? null;
      if (op === BURN_NOTIFY) {
        const custom = canonical ? s.loadRef() : undefined;
        end(s);
        return {
          op,
          queryId,
          amountRaw,
          owner,
          response,
          forwardTonRaw: '0',
          forward: Cell.EMPTY,
          custom,
        };
      }
      const custom =
        op === TRANSFER
          ? canonical
            ? s.loadRef()
            : s.loadMaybeRef()
          : undefined;
      const forwardTonRaw = s.loadCoins().toString(),
        payload = canonical ? s.loadRef() : forward(s);
      if (canonical) end(s);
      return {
        op,
        queryId,
        amountRaw,
        owner,
        response,
        forwardTonRaw,
        forward: payload,
        custom,
      };
    } catch {
      return null;
    }
  };
  const a = parse(true),
    b = parse(false);
  if (a && b) {
    const key = (wire: TokenWire) =>
      JSON.stringify({
        ...wire,
        forward: wire.forward.hash().toString('hex'),
        custom: wire.custom?.hash().toString('hex') ?? null,
      });
    return key(a) === key(b) ? a : null;
  }
  return a ?? b;
}
export type ProtocolForward = {
  operation: 'swap' | 'lp_deposit';
  queryId: string;
  owner: string | null;
  binId?: number;
  minOutRaw?: string;
};
/** Known perps funding envelopes are product intents, not proof of position acceptance.
 * Decode only the family boundary here; engine rejection/refund remains unresolved. */
export function unresolvedPerpsForward(cell: Cell): boolean {
  return (
    cell.bits.length >= 32 &&
    [0x4f50454e, 0x41444d47, 0x4d444946].includes(
      cell.beginParse().preloadUint(32),
    )
  );
}
/** A Launchpad payload identifies product intent, never completed sale accounting. */
export function unresolvedLaunchpadForward(cell: Cell): boolean {
  return cell.bits.length >= 32 &&
    [0x434e5452, 0x50424944, 0x56434c4d].includes(
      cell.beginParse().preloadUint(32),
    );
}
export function protocolForward(cell: Cell): ProtocolForward | null {
  try {
    const s = cell.beginParse();
    const op = s.loadUint(32);
    if (op !== SWAP && op !== ADD) return null;
    const queryId = s.loadUintBig(64).toString(),
      owner = s.loadMaybeAddress()?.toRawString() ?? null;
    if (op === ADD) {
      const binId = s.loadInt(32);
      s.loadUintBig(256);
      end(s);
      return { operation: 'lp_deposit', queryId, owner, binId };
    }
    const minOutRaw = s.loadCoins().toString(),
      direction = s.loadUint(8);
    if (direction !== 0 && direction !== 1) return null;
    // The full swap envelope is checked again by the existing durable settlement resolver.
    return { operation: 'swap', queryId, owner, minOutRaw };
  } catch {
    return null;
  }
}
export function withdrawalRequest(message?: RawMessage) {
  try {
    const cell = bodyCell(message);
    if (!cell) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== REMOVE) return null;
    const queryId = s.loadUintBig(64).toString(),
      binId = s.loadInt(32),
      shares = s.loadUintBig(256).toString(),
      recipient = s.loadAddress().toRawString();
    end(s);
    if (queryId === '0' || shares === '0') return null;
    return { queryId, binId, shares, recipient };
  } catch {
    return null;
  }
}
export function withdrawalReceipt(message?: RawMessage) {
  try {
    const cell = bodyCell(message);
    if (!cell) return null;
    const s = cell.beginParse();
    if (s.loadUint(32) !== WITHDRAW_COMPLETE) return null;
    const queryId = s.loadUintBig(64).toString(),
      binId = s.loadInt(32),
      shares = s.loadUintBig(256).toString();
    const actors = s.loadRef().beginParse(),
      amounts = s.loadRef().beginParse();
    const owner = actors.loadAddress().toRawString(),
      recipient = actors.loadAddress().toRawString(),
      amountT = amounts.loadCoins().toString(),
      amountX = amounts.loadCoins().toString();
    end(s);
    end(actors);
    end(amounts);
    return { queryId, binId, shares, owner, recipient, amountT, amountX };
  } catch {
    return null;
  }
}
/** Account-owned created_lt plus exact body and endpoint identity disambiguate replayed requests. */
export function messageKey(message?: RawMessage): string | null {
  const cell = bodyCell(message);
  if (
    !cell ||
    !message?.source ||
    !message.destination ||
    !uint(message.createdLt)
  )
    return null;
  try {
    return `${Address.parse(message.source).toRawString()}:${Address.parse(message.destination).toRawString()}:${message.createdLt}:${cell.hash().toString('hex')}`;
  } catch {
    return null;
  }
}
