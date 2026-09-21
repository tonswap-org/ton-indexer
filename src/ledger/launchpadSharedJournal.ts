import { Cell, Dictionary, type Slice } from '@ton/core';
import { address, end, flag, hash, hex, maybeAddress, raw } from './launchpadStateCommon';

const states = ['none', 'ready', 'in-flight', 'delivered', 'bounced', 'final', 'negative-finalized', 'accounting-pending'] as const;
export type LaunchpadSettlementStatus = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type LaunchpadSharedSettlement = {
  referralOperationId: string; accountingAck: 0 | 1; successorId: string;
  settlementId: string; requestHash: string; amountRaw: string; forwardTonAmountRaw: string;
  route: 1 | 2; kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  status: LaunchpadSettlementStatus; state: typeof states[LaunchpadSettlementStatus]; deployRequired: 0 | 1;
  deliveryReservedRaw: string; finalizeReservedRaw: string; predecessorId: string; recordedAt: string;
  tokenRoot: string; sourceWallet: string; destinationWallet: string; recipientOwner: string;
  forwardPayloadBoc: string; forwardPayloadHash: string; recordHash: string;
};
/** All first-release sale models use this exact record. FINAL may also retire a
 * negative wire; accounting-pending proves no completed fee allocation. */
export function readLaunchpadSharedSettlement(cell: Cell): LaunchpadSharedSettlement {
  const s = cell.beginParse(), referralOperationId = s.loadUintBig(64).toString(), accountingAck = flag(s), successorId = s.loadUintBig(64).toString();
  const settlementId = s.loadUintBig(64).toString(), requestHash = hex(s.loadUintBig(256));
  const amountRaw = raw(s), forwardTonAmountRaw = raw(s), route = s.loadUint(8), kind = s.loadUint(8), status = s.loadUint(8);
  if (!BigInt(settlementId) || !BigInt(amountRaw) || ![1, 2].includes(route) || kind < 1 || kind > 10 || status < 1 || status > 7)
    throw Error('Invalid shared Launchpad settlement identity, route, kind or state');
  const deployRequired = flag(s), deliveryReservedRaw = raw(s), finalizeReservedRaw = raw(s);
  const predecessorId = s.loadUintBig(64).toString(), recordedAt = s.loadIntBig(64).toString();
  if (predecessorId === settlementId || successorId === settlementId) throw Error('Invalid shared Launchpad lane link');
  if (s.remainingRefs !== 3) throw Error('Shared Launchpad settlement reference layout');
  const source = s.loadRef().beginParse(), tokenRoot = address(source), sourceWallet = address(source); end(source);
  const destination = s.loadRef().beginParse(), destinationWallet = address(destination), recipientOwner = address(destination); end(destination);
  const payload = s.loadRef(); end(s);
  return { referralOperationId, accountingAck, successorId, settlementId, requestHash, amountRaw, forwardTonAmountRaw, route: route as 1 | 2,
    kind: kind as LaunchpadSharedSettlement['kind'], status: status as LaunchpadSettlementStatus, state: states[status as LaunchpadSettlementStatus], deployRequired,
    deliveryReservedRaw, finalizeReservedRaw, predecessorId, recordedAt, tokenRoot, sourceWallet, destinationWallet, recipientOwner,
    forwardPayloadBoc: payload.toBoc().toString('base64'), forwardPayloadHash: hash(payload), recordHash: hash(cell) };
}
function readReferralContext(cell: Cell) {
  const s = cell.beginParse(), prerequisiteId = s.loadUintBig(64).toString(), amountRaw = raw(s), nativeBudgetRaw = raw(s), settlementId = s.loadUintBig(64).toString();
  const route = s.loadRef().beginParse(); end(s);
  const tokenRoot = address(route), sourceWallet = address(route), feeRouter = address(route), walletCode = route.loadRef(); end(route);
  if (!BigInt(prerequisiteId) || !BigInt(amountRaw) || !walletCode.bits.length && !walletCode.refs.length) throw Error('Invalid Launchpad referral context');
  return { prerequisiteId, amountRaw, nativeBudgetRaw, settlementId, tokenRoot, sourceWallet, feeRouter, walletCodeHash: hash(walletCode) };
}
function readReferralCredit(s: Slice) {
  const status = s.loadUint(8), attempts = s.loadUint(8), registry = address(s), requestHash = hex(s.loadUintBig(256));
  const totalRewardedRaw = raw(s), actualReferrer = maybeAddress(s), body = s.loadRef(), context = readReferralContext(s.loadRef()); end(s);
  const b = body.beginParse(); if (b.loadUint(32) !== 0x43524544) throw Error('Invalid Launchpad referral credit opcode');
  const operationId = b.loadUintBig(64).toString(), key = b.loadUint(32), user = address(b), amountRaw = raw(b), referrer = maybeAddress(b); end(b);
  if (status > 4 || !BigInt(operationId) || !key || amountRaw !== context.amountRaw || BigInt(totalRewardedRaw) > BigInt(amountRaw) || hash(body) !== requestHash)
    throw Error('Invalid Launchpad referral credit identity or amount');
  return { status, attempts, registry, requestHash, totalRewardedRaw, actualReferrer, operationId, key, user, amountRaw, referrer, context, bodyBoc: body.toBoc().toString('base64') };
}
export function readLaunchpadReferralCredits(cell: Cell) {
  const s = cell.beginParse(), nonce = s.loadUintBig(64).toString(), cursor = s.loadUintBig(64).toString();
  const entries = s.loadDict(Dictionary.Keys.BigUint(64), { serialize: (): never => { throw Error('Read-only Launchpad credit decoder'); }, parse: readReferralCredit });
  const ready = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Uint(8)); end(s);
  if (BigInt(cursor) > BigInt(nonce)) throw Error('Invalid Launchpad referral cursor');
  for (const [id, entry] of entries) if (entry.operationId !== id.toString() || id > BigInt(nonce) || (entry.status === 2) !== ready.has(id))
    throw Error('Launchpad referral outbox key or ready mismatch');
  for (const [id, value] of ready) if (value !== 1 || entries.get(id)?.status !== 2) throw Error('Launchpad referral ready entry mismatch');
  return { nonce, cursor, entries: new Map([...entries].map(([id, entry]) => [id.toString(), entry])), dataHash: hash(cell) };
}
export function readLaunchpadSharedJournal(cell: Cell) {
  const s = cell.beginParse(), records = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  const nextSettlementId = s.loadUintBig(64).toString(), currentPaymentId = s.loadUintBig(64).toString(), currentSaleId = s.loadUintBig(64).toString();
  const tailPaymentId = s.loadUintBig(64).toString(), tailSaleId = s.loadUintBig(64).toString();
  const reservedPaymentRaw = raw(s), reservedSaleRaw = raw(s), reservedNativeRaw = raw(s), referralCredits = readLaunchpadReferralCredits(s.loadRef()); end(s);
  if (!BigInt(nextSettlementId)) throw Error('Invalid shared Launchpad next settlement ID');
  const entries = new Map<string, LaunchpadSharedSettlement>();
  for (const [id, cell] of records) {
    const record = readLaunchpadSharedSettlement(cell);
    if (record.settlementId !== id.toString() || id >= BigInt(nextSettlementId)) throw Error('Shared Launchpad journal key mismatch');
    entries.set(id.toString(), record);
  }
  for (const [id, route] of [[currentPaymentId, 1], [tailPaymentId, 1], [currentSaleId, 2], [tailSaleId, 2]] as const)
    if (id !== '0' && entries.get(id)?.route !== route) throw Error('Shared Launchpad lane record mismatch');
  for (const record of entries.values()) for (const id of [record.predecessorId, record.successorId])
    if (id !== '0' && entries.get(id)?.route !== record.route) throw Error('Shared Launchpad lane link mismatch');
  return { nextSettlementId, currentPaymentId, currentSaleId, tailPaymentId, tailSaleId, reservedPaymentRaw, reservedSaleRaw, reservedNativeRaw, referralCredits, entries };
}
export type LaunchpadSharedJournal = ReturnType<typeof readLaunchpadSharedJournal>;
