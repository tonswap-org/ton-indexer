import { Address, Cell, Slice } from '@ton/core';

export const ORDER_QUEUE_CAPACITY = 16_384;
export const ORDER_SEQUENCE_MAX = 0xffff_ffff;

function requireQueue(ok: unknown): asserts ok {
  if (!ok) throw Error('Invalid order creation queue transition');
}

export function readOrderFactory(data: Cell) {
  requireQueue(!data.isExotic);
  const s = data.beginParse(), code = s.loadRef(), salt = s.loadUintBig(64);
  const activity = s.remainingBits > 0;
  const queueCount = activity ? s.loadUint(16) : 0;
  const sequence = activity ? s.loadUint(32) : 0;
  const root = activity ? s.loadMaybeRef() : null;
  const relay = activity && s.remainingBits ? s.loadAddress() : null;
  s.endParse();
  requireQueue((!relay || relay.workChain === 0) && !code.isExotic && queueCount <= ORDER_QUEUE_CAPACITY && queueCount <= sequence
    && (queueCount === 0) === (root === null) && !root?.isExotic);
  return { code, salt, activity, queueCount, sequence, root, relay };
}

// A TON dictionary edge stores a compressed label followed by a value or two branches.
function edge(cell: Cell, width: number) {
  requireQueue(!cell.isExotic);
  const s = cell.beginParse(), lengthBits = Math.ceil(Math.log2(width + 1));
  let length = 0, prefix = 0n;
  if (!s.loadBit()) {
    while (s.loadBit()) { length++; requireQueue(length <= width); }
    prefix = s.loadUintBig(length);
  } else if (!s.loadBit()) {
    length = s.loadUint(lengthBits);
    requireQueue(length <= width);
    prefix = s.loadUintBig(length);
  } else {
    const bit = s.loadBit();
    length = s.loadUint(lengthBits);
    requireQueue(length <= width);
    if (bit) prefix = (1n << BigInt(length)) - 1n;
  }
  requireQueue(length === width ? s.remainingBits === 256 && s.remainingRefs === 0 : s.remainingBits === 0 && s.remainingRefs === 2);
  return { length, prefix, payload: s };
}

const lowBits = (value: bigint, count: number) => value & ((1n << BigInt(count)) - 1n);
function verifyLeaf(cell: Cell, width: number, key: bigint, value: bigint) {
  const e = edge(cell, width);
  requireQueue(e.length === width && e.prefix === lowBits(key, width) && e.payload.loadUintBig(256) === value);
}

// Only the path to the inserted row changes. Comparing untouched subtree hashes keeps
// verification bounded by the 64-bit key even when a supplied BOC shares subtrees.
function verifyInsert(before: Cell, after: Cell, width: number, key: bigint, value: bigint) {
  const a = edge(before, width), b = edge(after, width);
  requireQueue(b.length <= a.length && b.length < width);
  requireQueue(b.prefix === (a.prefix >> BigInt(a.length - b.length))
    && b.prefix === (lowBits(key, width) >> BigInt(width - b.length)));
  const left = b.payload.loadRef(), right = b.payload.loadRef();
  const rest = width - b.length - 1, side = Number((key >> BigInt(rest)) & 1n);
  const next = side ? right : left, sibling = side ? left : right;
  if (b.length === a.length) {
    const oldLeft = a.payload.loadRef(), oldRight = a.payload.loadRef();
    requireQueue(sibling.equals(side ? oldLeft : oldRight));
    verifyInsert(side ? oldRight : oldLeft, next, rest, key, value);
    return;
  }
  const tail = a.length - b.length - 1, oldSide = Number((a.prefix >> BigInt(tail)) & 1n);
  const unchanged = edge(sibling, rest);
  requireQueue(oldSide !== side && unchanged.length === tail && unchanged.prefix === lowBits(a.prefix, tail)
    && unchanged.payload.asCell().equals(a.payload.asCell()));
  verifyLeaf(next, rest, key, value);
}

export function orderCreationKey(before: Cell, after: Cell, automated: boolean, startAt: number, order: Address) {
  const a = readOrderFactory(before);
  if (!a.activity || !automated || a.queueCount === ORDER_QUEUE_CAPACITY || a.sequence === ORDER_SEQUENCE_MAX) {
    requireQueue(before.equals(after));
    return a.activity ? 0n : null;
  }
  const b = readOrderFactory(after);
  requireQueue(b.activity && b.code.equals(a.code) && b.salt === a.salt && b.relay?.toRawString() === a.relay?.toRawString() && b.queueCount === a.queueCount + 1
    && b.sequence === a.sequence + 1 && b.root && order.workChain === 0 && Number.isSafeInteger(startAt)
    && startAt >= 0 && startAt <= 0xffff_ffff);
  const key = (BigInt(startAt) << 32n) | BigInt(b.sequence);
  const value = BigInt('0x' + order.hash.toString('hex'));
  if (a.root) verifyInsert(a.root, b.root, 64, key, value);
  else verifyLeaf(b.root, 64, key, value);
  return key;
}

export function readOrderInit(body: Slice, query: bigint, key: bigint | null, terms: Cell) {
  requireQueue(body.loadUint(32) === 0x4f494e49 && body.loadUintBig(64) === query);
  if (key !== null) requireQueue(body.loadUintBig(64) === key);
  requireQueue(body.loadRef().equals(terms));
  body.endParse();
}
