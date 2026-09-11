import { Address, Cell, beginCell, type Slice } from '@ton/core';
import type { RawMessage } from '../data/dataSource';
import type { FixedSaleSettlement } from './launchpadState';
import { bodyCell } from './wire';

export const LAUNCHPAD_CONTRIBUTE = 0x434e5452, LAUNCHPAD_BID = 0x50424944, LAUNCHPAD_FINALIZE = 0x46494e4c,
  LAUNCHPAD_CLAIM = 0x434c414d, LAUNCHPAD_RETRY = 0x53545259;
export const LAUNCHPAD_TRANSFER = 0x0f8a7ea5, LAUNCHPAD_SETTLEMENT_MARKER = 0x4a535454,
  LAUNCHPAD_INTERNAL = 0x4a534954, LAUNCHPAD_ACCEPTED = 0x4a534143,
  LAUNCHPAD_SUCCEEDED = 0x4a535543, LAUNCHPAD_BOUNCED = 0x4a544246,
  LAUNCHPAD_WALLET_FINALIZE = 0x4a53464e, LAUNCHPAD_FINALIZED = 0x4a53464b,
  LAUNCHPAD_REPLAY = 0x4a535250;
const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw Error('Trailing Launchpad wire fields'); };
const maybeAddress = (s: Slice) => s.loadMaybeAddress()?.toRawString() ?? null;
const tupleKinds = new Map<number, 'accepted' | 'succeeded' | 'bounced' | 'finalize' | 'finalized' | 'replay'>([
  [LAUNCHPAD_ACCEPTED, 'accepted'], [LAUNCHPAD_SUCCEEDED, 'succeeded'], [LAUNCHPAD_BOUNCED, 'bounced'],
  [LAUNCHPAD_WALLET_FINALIZE, 'finalize'], [LAUNCHPAD_FINALIZED, 'finalized'], [LAUNCHPAD_REPLAY, 'replay'],
] as const);
export function launchpadSettlementTuple(message?: RawMessage) {
  try {
    const cell = bodyCell(message); if (!cell) return null;
    const s = cell.beginParse(), opcode = s.loadUint(32), kind = tupleKinds.get(opcode); if (!kind) return null;
    const queryId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString(), destination = s.loadAddress().toRawString(); end(s);
    return { opcode, kind, queryId, amountRaw, destination, bodyHash: cell.hash().toString('hex') };
  } catch { return null; }
}
export function launchpadCommand(message?: RawMessage) {
  try {
    const cell = bodyCell(message); if (!cell) return null;
    const s = cell.beginParse(), opcode = s.loadUint(32), queryId = s.loadUintBig(64).toString(), bodyHash = cell.hash().toString('hex');
    if (opcode === LAUNCHPAD_CONTRIBUTE) {
      const rewardWallet = maybeAddress(s), refundWallet = maybeAddress(s); end(s);
      return { opcode, kind: 'contribute' as const, queryId, rewardWallet, refundWallet, bodyHash };
    }
    if (opcode === LAUNCHPAD_BID) {
      const maxPriceRaw = s.loadCoins().toString(), quantityRaw = s.loadCoins().toString();
      const rewardWallet = maybeAddress(s), refundWallet = maybeAddress(s); end(s);
      return { opcode, kind: 'bid' as const, queryId, maxPriceRaw, quantityRaw, rewardWallet, refundWallet, bodyHash };
    }
    if (opcode === LAUNCHPAD_CLAIM) { const beneficiary = maybeAddress(s); end(s); return { opcode, kind: 'claim' as const, queryId, beneficiary, bodyHash }; }
    if (opcode === LAUNCHPAD_FINALIZE) { end(s); return { opcode, kind: 'finalize-sale' as const, queryId, bodyHash }; }
    if (opcode === LAUNCHPAD_RETRY) { end(s); return { opcode, kind: 'retry' as const, queryId, settlementId: queryId, bodyHash }; }
    return null;
  } catch { return null; }
}
/** Canonical TONSwap typed transfer only, not a generic TEP-74 or untyped debit. */
export function launchpadSettlementTransfer(message?: RawMessage) {
  try {
    const cell = bodyCell(message); if (!cell) return null;
    const s = cell.beginParse(); if (s.loadUint(32) !== LAUNCHPAD_TRANSFER) return null;
    const queryId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString();
    const recipientOwner = s.loadAddress().toRawString(), responseOwner = s.loadAddress().toRawString(), custom = s.loadRef().beginParse();
    if (custom.loadUint(32) !== LAUNCHPAD_SETTLEMENT_MARKER) return null; end(custom);
    const forwardTonAmountRaw = s.loadCoins().toString(), forwardPayload = s.loadRef(); end(s);
    return { queryId, amountRaw, recipientOwner, responseOwner, forwardTonAmountRaw,
      forwardPayloadBoc: forwardPayload.toBoc().toString('base64'), forwardPayloadHash: forwardPayload.hash().toString('hex'), bodyHash: cell.hash().toString('hex') };
  } catch { return null; }
}
export function launchpadInternalSettlementTransfer(message?: RawMessage) {
  try {
    const cell = bodyCell(message); if (!cell) return null;
    const s = cell.beginParse(); if (s.loadUint(32) !== LAUNCHPAD_INTERNAL) return null;
    const queryId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString(), fromOwner = s.loadAddress().toRawString(), responseWallet = s.loadAddress().toRawString();
    const forwardTonAmountRaw = s.loadCoins().toString(), forwardPayload = s.loadRef(); end(s);
    return { queryId, amountRaw, fromOwner, responseWallet, forwardTonAmountRaw,
      forwardPayloadBoc: forwardPayload.toBoc().toString('base64'), forwardPayloadHash: forwardPayload.hash().toString('hex'), bodyHash: cell.hash().toString('hex') };
  } catch { return null; }
}
export function fixedSaleSettlementRequestHash(sale: string, record: Pick<FixedSaleSettlement, 'settlementId' | 'amountRaw' | 'recipientOwner' | 'forwardTonAmountRaw' | 'forwardPayloadBoc'>) {
  return beginCell().storeUint(LAUNCHPAD_TRANSFER, 32).storeUint(BigInt(record.settlementId), 64).storeCoins(BigInt(record.amountRaw))
    .storeAddress(Address.parse(record.recipientOwner)).storeAddress(Address.parse(sale))
    .storeRef(beginCell().storeUint(LAUNCHPAD_SETTLEMENT_MARKER, 32).endCell())
    .storeCoins(BigInt(record.forwardTonAmountRaw)).storeRef(Cell.fromBase64(record.forwardPayloadBoc)).endCell().hash().toString('hex');
}
