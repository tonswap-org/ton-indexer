import { Cell, Dictionary, type Slice } from '@ton/core';
import type { DlmmSettlementRecord } from './dlmmState';

const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw new Error('dlmm_direct_swap_trailing_data'); };
const hash = (value: bigint) => value.toString(16).padStart(64, '0');
const start = 0x4453000000000001n;

export interface DlmmDirectSwapWire {
  id: string; predecessorId: string; successorId: string; disposition: number;
  body: Cell; requestHash: string; amountRaw: string; owner: string; response: string;
  forwardTonRaw: string; forward: Cell;
}
export interface DlmmDirectSwapLeg {
  initialId: string; currentId: string; amountRaw: string; done: boolean;
  wires: Map<string, DlmmDirectSwapWire>;
}
export interface DlmmDirectSwapReceipt {
  key: string; notificationCreatedLt: string; notificationSender: string;
  notificationBody: Cell; notificationBodyHash: string; businessQueryId: string;
  notificationQueryId: string;
  inputRaw: string; payer: string; refund: DlmmDirectSwapLeg; output: DlmmDirectSwapLeg;
}

function readWire(id: bigint, cell: Cell): DlmmDirectSwapWire {
  const s = cell.beginParse();
  if (s.remainingBits !== 136 || s.remainingRefs !== 1 || id < start) throw new Error('dlmm_direct_swap_wire_layout_invalid');
  const predecessorId = s.loadUintBig(64).toString(), successorId = s.loadUintBig(64).toString(), disposition = s.loadUint(8), body = s.loadRef(); end(s);
  const request = body.beginParse();
  if (request.loadUint(32) !== 0x0f8a7ea5 || request.loadUintBig(64) !== id) throw new Error('dlmm_direct_swap_wire_identity_invalid');
  const amountRaw = request.loadCoins().toString(), owner = request.loadAddress().toRawString(), response = request.loadAddress().toRawString();
  const custom = request.loadRef().beginParse(), forwardTonRaw = request.loadCoins().toString(), forward = request.loadRef(); end(request);
  if (custom.remainingBits !== 32 || custom.remainingRefs || custom.loadUint(32) !== 0x4a535454 || amountRaw === '0' || disposition > 3)
    throw new Error('dlmm_direct_swap_wire_fields_invalid');
  return {id: id.toString(), predecessorId, successorId, disposition, body, requestHash: body.hash().toString('hex'), amountRaw, owner, response, forwardTonRaw, forward};
}

function readLeg(cell: Cell, nextId: bigint): DlmmDirectSwapLeg {
  const s = cell.beginParse(), initialId = s.loadUintBig(64).toString(), currentId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString(), done = s.loadUint(8);
  if (done > 1 || s.remainingBits || s.remainingRefs !== 1) throw new Error('dlmm_direct_swap_leg_layout_invalid');
  const map = s.loadRef().beginParse(), entries = map.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()); end(map); end(s);
  const wires = new Map<string, DlmmDirectSwapWire>();
  for (const [id, value] of entries) { if (id >= nextId) throw new Error('dlmm_direct_swap_wire_sequence_invalid'); wires.set(id.toString(), readWire(id, value)); }
  if (amountRaw === '0') {
    if (initialId !== '0' || currentId !== '0' || done !== 1 || wires.size) throw new Error('dlmm_direct_swap_absent_leg_invalid');
    return {initialId, currentId, amountRaw, done: true, wires};
  }
  const first = wires.get(initialId), visited = new Set<string>(); let id = initialId, predecessor = '0';
  if (!first) throw new Error('dlmm_direct_swap_initial_wire_missing');
  while (id !== '0') {
    const wire = wires.get(id);
    if (!wire || visited.has(id) || wire.predecessorId !== predecessor || wire.amountRaw !== amountRaw ||
      wire.owner !== first.owner || wire.response !== first.response || wire.forwardTonRaw !== first.forwardTonRaw || !wire.forward.hash().equals(first.forward.hash()))
      throw new Error('dlmm_direct_swap_lineage_invalid');
    visited.add(id);
    if (id === currentId) {
      if (wire.successorId !== '0' || wire.disposition !== (done === 1 ? 3 : 0)) throw new Error('dlmm_direct_swap_current_wire_invalid');
    } else if (wire.disposition !== 1 && wire.disposition !== 2 || BigInt(wire.successorId) <= BigInt(id)) throw new Error('dlmm_direct_swap_replacement_invalid');
    predecessor = id; id = wire.successorId;
  }
  if (predecessor !== currentId || visited.size !== wires.size) throw new Error('dlmm_direct_swap_lineage_coverage_invalid');
  return {initialId, currentId, amountRaw, done: done === 1, wires};
}

/** Current direct-swap receipt storage. Receipts preserve exact request bodies
 * after settlement pruning; they do not replace independent physical delivery
 * evidence. No prior products layout is accepted by the pool reader. */
export function readDlmmDirectSwaps(cell: Cell, nextId: bigint, settlements: ReadonlyMap<string, DlmmSettlementRecord>) {
  const s = cell.beginParse(), entries = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), index = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.BigUint(256)); end(s);
  const receipts = new Map<string, DlmmDirectSwapReceipt>(), live = new Map<string, string>(), allWires = new Set<string>();
  for (const [key, value] of entries) {
    const receipt = value.beginParse(), notificationCreatedLt = receipt.loadUintBig(64).toString(), notificationSender = receipt.loadAddress().toRawString();
    if (receipt.remainingBits || receipt.remainingRefs !== 3 || notificationCreatedLt === '0') throw new Error('dlmm_direct_swap_receipt_layout_invalid');
    const notificationBody = receipt.loadRef(), refund = readLeg(receipt.loadRef(), nextId), output = readLeg(receipt.loadRef(), nextId); end(receipt);
    const notice = notificationBody.beginParse();
    if (notice.loadUint(32) !== 0x7362d09c) throw new Error('dlmm_direct_swap_notice_invalid');
    const notificationQueryId = notice.loadUintBig(64).toString(), inputRaw = notice.loadCoins().toString(), payer = notice.loadAddress().toRawString();
    notice.loadAddress(); notice.loadCoins(); const payload = notice.loadRef(); end(notice);
    const forward = payload.beginParse();
    if (inputRaw === '0' || payload.bits.length < 96 || forward.loadUint(32) !== 0x53574150 ||
      refund.amountRaw === '0' && output.amountRaw === '0' || BigInt(refund.amountRaw) > BigInt(inputRaw)) throw new Error('dlmm_direct_swap_notice_fields_invalid');
    const businessQueryId = forward.loadUintBig(64).toString();
    for (const [leg, kind] of [[refund, 2], [output, 1]] as const) {
      for (const wire of leg.wires.values()) {
        if (allWires.has(wire.id)) throw new Error('dlmm_direct_swap_wire_reused'); allWires.add(wire.id);
        if (wire.id !== leg.currentId && settlements.has(wire.id)) throw new Error('dlmm_direct_swap_retired_wire_active');
      }
      if (leg.amountRaw === '0') continue;
      const current = leg.wires.get(leg.currentId)!, record = settlements.get(leg.currentId);
      if (leg.done) {
        if (record) throw new Error('dlmm_direct_swap_final_wire_active');
      } else {
        if (!record || record.kind !== kind || ![businessQueryId, notificationQueryId].includes(record.businessQueryId) || record.amountRaw !== leg.amountRaw ||
          record.requestHash !== current.requestHash || record.predecessorId !== current.predecessorId || record.destinationOwner !== current.owner ||
          record.forwardTonAmountRaw !== current.forwardTonRaw || !record.forwardPayload.hash().equals(current.forward.hash())) throw new Error('dlmm_direct_swap_active_wire_invalid');
        live.set(leg.currentId, hash(key));
      }
    }
    if (refund.amountRaw !== '0' && refund.wires.get(refund.initialId)!.owner !== payer) throw new Error('dlmm_direct_swap_refund_owner_invalid');
    receipts.set(hash(key), {key: hash(key), notificationCreatedLt, notificationSender, notificationBody, notificationBodyHash: notificationBody.hash().toString('hex'), businessQueryId, notificationQueryId, inputRaw, payer, refund, output});
  }
  if (index.size !== live.size || [...index].some(([id, key]) => live.get(id.toString()) !== hash(key))) throw new Error('dlmm_direct_swap_index_invalid');
  return {receipts, wires: live, dataHash: cell.hash().toString('hex')};
}
