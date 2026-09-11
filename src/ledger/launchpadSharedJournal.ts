import { Cell, Dictionary } from '@ton/core';
import type { FixedSaleSettlement } from './launchpadState';
import { address, end, flag, hash, hex, raw } from './launchpadStateCommon';

export type LaunchpadSharedSettlement = Omit<FixedSaleSettlement, 'kind'> & { tokenRoot: string; kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 };
const states = ['none', 'ready', 'in-flight', 'delivered', 'bounced', 'final', 'negative-finalized'] as const;
/** Current shared bonding/auction record. Token root and destination references
 * differ from fixed-sale storage; a FINAL state is not a delivery assertion. */
export function readLaunchpadSharedSettlement(cell: Cell): LaunchpadSharedSettlement {
  const s = cell.beginParse(), settlementId = s.loadUintBig(64).toString(), requestHash = hex(s.loadUintBig(256));
  const amountRaw = raw(s), forwardTonAmountRaw = raw(s), route = s.loadUint(8), kind = s.loadUint(8), status = s.loadUint(8);
  if (!BigInt(settlementId) || !BigInt(amountRaw) || ![1, 2].includes(route) || kind < 1 || kind > 10 || status < 1 || status > 6)
    throw Error('Invalid shared Launchpad settlement identity, route, kind or state');
  const deployRequired = flag(s), deliveryReservedRaw = raw(s), finalizeReservedRaw = raw(s);
  const predecessorId = s.loadUintBig(64).toString(), recordedAt = s.loadIntBig(64).toString();
  if (BigInt(predecessorId) >= BigInt(settlementId)) throw Error('Invalid shared Launchpad predecessor');
  if (s.remainingRefs !== 3) throw Error('Shared Launchpad settlement reference layout');
  const source = s.loadRef().beginParse(), tokenRoot = address(source), sourceWallet = address(source); end(source);
  const destination = s.loadRef().beginParse(), destinationWallet = address(destination), recipientOwner = address(destination); end(destination);
  const payload = s.loadRef(); end(s);
  return { settlementId, requestHash, amountRaw, forwardTonAmountRaw, route: route as 1 | 2, kind: kind as LaunchpadSharedSettlement['kind'],
    status: status as LaunchpadSharedSettlement['status'], state: states[status as LaunchpadSharedSettlement['status']], deployRequired,
    deliveryReservedRaw, finalizeReservedRaw, predecessorId, recordedAt, tokenRoot, sourceWallet, destinationWallet, recipientOwner,
    forwardPayloadBoc: payload.toBoc().toString('base64'), forwardPayloadHash: hash(payload), recordHash: hash(cell) };
}
export function readLaunchpadSharedJournal(cell: Cell) {
  const s = cell.beginParse(), records = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  const nextSettlementId = s.loadUintBig(64).toString(), currentPaymentId = s.loadUintBig(64).toString(), currentSaleId = s.loadUintBig(64).toString();
  const tailPaymentId = s.loadUintBig(64).toString(), tailSaleId = s.loadUintBig(64).toString();
  const reservedPaymentRaw = raw(s), reservedSaleRaw = raw(s); end(s);
  if (!BigInt(nextSettlementId)) throw Error('Invalid shared Launchpad next settlement ID');
  const entries = new Map<string, LaunchpadSharedSettlement>();
  for (const [id, cell] of records) {
    const record = readLaunchpadSharedSettlement(cell);
    if (record.settlementId !== id.toString() || id >= BigInt(nextSettlementId)) throw Error('Shared Launchpad journal key mismatch');
    entries.set(id.toString(), record);
  }
  for (const [id, route] of [[currentPaymentId, 1], [tailPaymentId, 1], [currentSaleId, 2], [tailSaleId, 2]] as const)
    if (id !== '0' && entries.get(id)?.route !== route) throw Error('Shared Launchpad lane record mismatch');
  return { nextSettlementId, currentPaymentId, currentSaleId, tailPaymentId, tailSaleId, reservedPaymentRaw, reservedSaleRaw, entries };
}
export type LaunchpadSharedJournal = ReturnType<typeof readLaunchpadSharedJournal>;
