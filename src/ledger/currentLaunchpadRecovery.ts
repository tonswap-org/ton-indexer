import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { readHolderReceipt, readHolderRecoveryState } from '../runtime/launchpadHolderRecoveryEvidence';
import { t3PathRoot } from './currentT3Wire';
import { decodeLaunchLp, type decodeLaunchChild } from './currentLaunchpadState';
import { need, raw, tokenTransfer, type CurrentLaunchpadTransaction } from './currentLaunchpadProof';
type Child = ReturnType<typeof decodeLaunchChild>;
const hash = (cell: Cell) => BigInt('0x' + cell.hash().toString('hex'));
const pair = (a: bigint, b: bigint) => hash(beginCell().storeUint(3, 8).storeUint(a, 256).storeUint(b, 256).endCell());
function books(child: Child) {
  return Dictionary.loadDirect(Dictionary.Keys.Uint(8), { serialize() { throw Error('Read only'); }, parse(s) {
    const total = s.loadCoins(), count = s.loadUint(16), entries = s.loadDict(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)), archive = s.loadMaybeRef(); s.endParse();
    need(count === entries.size && count <= 1024);
    return { total, count, entries, archive };
  } }, child.owed);
}
function archived(cell: Cell | null | undefined) {
  need(cell && !cell.isExotic); const s = cell.beginParse(), count = s.loadUintBig(65), root = s.loadUintBig(256), total = s.loadCoins();
  const frontier = s.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256)); s.endParse(); need(count > 0n && count <= 1n << 64n && [...frontier.keys()].every(level => level < 64)); return { count, root, total, frontier };
}

const sameEntries = (a: Dictionary<Address, bigint>, b: Dictionary<Address, bigint>) => a.size === b.size && [...a].every(([owner, amount]) => b.get(owner) === amount);
const sameFrontier = (a: Dictionary<number, bigint>, b: Map<number, bigint>) => a.size === b.size && [...a].every(([level, value]) => b.get(level) === value);
const sameCell = (a: Cell | null | undefined, b: Cell | null | undefined) => a && b ? a.equals(b) : !a && !b;
/** Exact Sale JRCM owedCredit(..., 1) branch in the pinned current native code.
 * Even an existing owner is archived once one direct entry already exists. */
export function verifyLaunchpadRecoveredOwed(holder: string, slot: number, beneficiary: string, amount: bigint, before: Child, after: Child) {
  need(slot <= 1 && amount > 0n && before.identity.role === 0 && after.identity.role === 0);
  const empty = { total: 0n, count: 0, entries: Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)), archive: null };
  const left = books(before).get(slot) ?? empty, right = books(after).get(slot); need(right && right.total === left.total + amount);
  const owner = Address.parse(beneficiary);
  if (left.count === 0) {
    need(right.count === 1 && right.entries.get(owner) === amount && sameCell(left.archive, right.archive));
    return;
  }
  need(right.count === left.count && sameEntries(left.entries, right.entries));
  const a = left.archive ? archived(left.archive) : { count: 0n, root: 0n, total: 0n, frontier: new Map<number, bigint>() }, z = archived(right.archive);
  need(a.count < 1n << 64n && z.count === a.count + 1n && z.total === a.total + amount);
  const frontier = new Map(a.frontier); let zero = hash(beginCell().storeUint(0, 8).endCell()), stored = false;
  let node = hash(beginCell().storeUint(1, 8).storeAddress(Address.parse(holder)).storeUint(slot, 8).storeUint(a.count, 64).storeAddress(owner).storeUint(amount, 120).endCell());
  for (let level = 0; level < 64; level++) {
    if ((a.count >> BigInt(level)) & 1n) { const sibling = frontier.get(level); need(sibling !== undefined); node = pair(sibling, node); }
    else { if (!stored) { frontier.set(level, node); stored = true; } node = pair(node, zero); }
    zero = pair(zero, zero);
  }
  need(node === z.root && sameFrontier(z.frontier, frontier));
}

/** A successful original CLMA consumes one exact committed owed leaf. Receipt
 * retirement is separate from the emitted token transfer's eventual delivery. */
export function verifyLaunchpadArchiveClaim(body: Cell, holder: string, before: Child, after: Child) {
  need(before.identity.role === 0 && after.identity.role === 0 && !body.isExotic);
  const s = body.beginParse(); need(s.loadUint(32) === 0x434c4d41); s.loadUintBig(64);
  const slot = s.loadUint(8), id = s.loadUintBig(64), owner = s.loadAddress(), amount = s.loadCoins(); let proof: Cell | null = s.loadRef(); s.endParse();
  need(slot <= 1 && amount > 0n);
  const left = books(before).get(slot), right = books(after).get(slot); need(left && right);
  const a = archived(left.archive), z = archived(right.archive); need(id < a.count && z.count === a.count && z.total === a.total - amount && right.total === left.total - amount && left.count === right.count && sameEntries(left.entries, right.entries));
  let old = hash(beginCell().storeUint(1, 8).storeAddress(Address.parse(holder)).storeUint(slot, 8).storeUint(id, 64).storeAddress(owner).storeUint(amount, 120).endCell());
  let next = hash(beginCell().storeUint(2, 8).storeAddress(Address.parse(holder)).storeUint(slot, 8).storeUint(id, 64).endCell());
  let difference = id ^ a.count, frontierLevel = -1; while (difference) { frontierLevel++; difference >>= 1n; }
  const frontier = new Map(a.frontier);
  for (let level = 0; level < 64; level++) {
    if (level === frontierLevel) frontier.set(level, next);
    need(proof && !proof.isExotic); const p = proof.beginParse(), sibling = p.loadUintBig(256); proof = p.loadMaybeRef(); p.endParse(); need((proof === null) === (level === 63));
    if ((id >> BigInt(level)) & 1n) { old = pair(sibling, old); next = pair(sibling, next); } else { old = pair(old, sibling); next = pair(next, sibling); }
  }
  need(old === a.root && next === z.root && sameFrontier(z.frontier, frontier));
  return { beneficiary: raw(owner)!, amountRaw: String(amount), slot };
}
/** JRCM restores an already proven holder receipt to native accounting. It
 * neither creates a wallet credit nor reclassifies its original income source. */
export function verifyLaunchpadHolderClaim(tx: CurrentLaunchpadTransaction, before: Child, after: Child) {
  need(tx.succeeded && tx.tx.inMessage?.info.type === 'internal' && !tx.tx.inMessage.info.bounced);
  const s = tx.tx.inMessage.body.beginParse(); need(s.loadUint(32) === 0x4a52434d);
  const receipt = s.loadRef(), proof = s.loadRef(); s.endParse(); const r = readHolderReceipt(receipt); need(!r.claimed && before.identity.role < 2);
  const left = tx.before.account?.storage.state, right = tx.after.account?.storage.state;
  need(left?.type === 'active' && right?.type === 'active' && left.state.data && right.state.data);
  const a = readHolderRecoveryState(left.state.data), z = readHolderRecoveryState(right.state.data); need(a && z && a.initialized && z.initialized && a.lastKey === z.lastKey && a.pending - z.pending === r.amount);
  const claimed = beginCell().storeUint(r.key, 64).storeRef(beginCell().storeBit(r.incoming).storeUint(r.slot, 8).storeCoins(r.amount).storeBit(true).storeRef(r.body)).endCell();
  need(t3PathRoot(r.key, receipt, proof) === a.root && t3PathRoot(r.key, claimed, proof) === z.root);
  let beneficiary: string, queryId: bigint;
  if (r.incoming) {
    const p = r.body.beginParse(); need(p.loadUint(32) === 0x7362d09c); queryId = p.loadUintBig(64); need(p.loadCoins() === r.amount); beneficiary = raw(p.loadAddress())!;
    // A wrapped swap refund may change its beneficial owner. Such a receipt
    // remains unresolved until the original swap origin is authenticated.
    const payload = p.loadBit() ? p.loadRef() : beginCell().storeSlice(p).endCell();
    if (payload.bits.length >= 32) need(payload.beginParse().preloadUint(32) !== 0x53575233);
  } else { const request = tokenTransfer(r.body); need(request.amount === r.amount); beneficiary = request.owner; queryId = request.queryId; }
  if (before.identity.role === 0) {
    verifyLaunchpadRecoveredOwed(tx.account, r.slot, beneficiary, r.amount, before, after);
  } else {
    const l = decodeLaunchLp(before), q = decodeLaunchLp(after), counts = l.unlockAt === 0 || tx.tx.now < l.unlockAt;
    const restore = r.incoming || beneficiary === raw(l.pool);
    need(q.t3Bal - l.t3Bal === (counts && restore ? r.amount : 0n));
    beneficiary = tx.account;
  }
  return { beneficiary, queryId: String(queryId), amountRaw: String(r.amount), slot: r.slot };
}
