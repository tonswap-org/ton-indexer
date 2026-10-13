import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import type { RawMessage } from '../data/dataSource';
import { NATIVE_FUNDING } from '../ledger/nativeFunding';
import { bodyCell, businessBodyCell, businessOpcode, dlmmLiquidityNotificationCommitment, messageKey, NOTIFY, opcode, tokenWire } from '../ledger/wire';
import { WireBodySummaryCache } from '../ledger/wireBodySummary';

const source = `0:${'1'.repeat(64)}`, destination = `0:${'2'.repeat(64)}`;
const cell = (value: number) => beginCell().storeUint(value, 32).storeUint(314, 32).endCell();
const encoded = (value: Cell) => value.toBoc().toString('base64');
const message = (value: Cell): RawMessage => ({ source, destination, createdLt: '127', body: encoded(value) });
function countParses(run: (count: () => number) => void) {
  const original = Cell.fromBoc;
  let parses = 0;
  Cell.fromBoc = bytes => { parses++; return original(bytes); };
  try { run(() => parses); } finally { Cell.fromBoc = original; }
}
function check(name: string, run: () => void) { run(); console.log('PASS', name); }

check('repeated identity, opcode and non-token checks decode exact content once', () => {
  const value = cell(0x12345678), raw = message(value);
  countParses(count => {
    for (let index = 0; index < 12; index++) {
      assert.equal(opcode(raw), 0x12345678);
      assert.equal(businessOpcode(raw), 0x12345678);
      assert.equal(messageKey(raw), `${source}:${destination}:127:${value.hash().toString('hex')}`);
      assert.equal(tokenWire(raw), null);
    }
    assert.equal(count(), 1);
    assert.equal(opcode({ ...raw, op: 0x11111111 }), null);
    assert.equal(businessOpcode({ ...raw, op: 0x11111111 }), null);
    assert.equal(messageKey({ ...raw, op: 0x11111111 }), null);
    assert.equal(messageKey({ ...raw, createdLt: '0127' }), null);
    assert.equal(messageKey({ ...raw, source: 'invalid' }), null);
    assert.notEqual(messageKey({ ...raw, source: destination }), messageKey(raw));
    assert.notEqual(messageKey({ ...raw, destination: source }), messageKey(raw));
    assert.notEqual(messageKey({ ...raw, createdLt: '128' }), messageKey(raw));
    assert.equal(count(), 1, 'Current message metadata is checked without reparsing its immutable body');
    assert.notEqual(messageKey(message(cell(0x12345679))), messageKey(raw));
    assert.equal(count(), 2, 'Changed original bytes must be decoded independently');
    assert.equal(opcode({ ...raw, body: raw.body + '\n' }), 0x12345678);
    assert.equal(count(), 3, 'Alternate encodings are separate exact-text keys');
  });
});

check('returned Cell hash and bit buffers cannot poison cached identities or future decoding', () => {
  const value = cell(0x23456789), raw = message(value), key = messageKey(raw);
  for (const read of [bodyCell, businessBodyCell]) {
    const first = read(raw)!;
    assert.notEqual(first, read(raw), 'Mutable graphs are never reused');
    first.hash().fill(0);
    first.bits.subbuffer(0, 32)!.fill(0);
    assert.equal(messageKey(raw), key);
    assert.equal(opcode(raw), 0x23456789);
    assert.equal(businessOpcode(raw), 0x23456789);
    assert.equal(read(raw)!.hash().toString('hex'), value.hash().toString('hex'));
    assert.equal(read(raw)!.beginParse().preloadUint(32), 0x23456789);
  }
});

check('LRU eviction bounds entry count and exact encoded source bytes', () => {
  const bodies = [101, 102, 103].map(value => encoded(cell(value)));
  countParses(count => {
    const cache = new WireBodySummaryCache(2, 100_000);
    cache.get(bodies[0]); cache.get(bodies[1]); cache.get(bodies[0]); cache.get(bodies[2]);
    assert.equal(count(), 3);
    cache.get(bodies[0]); assert.equal(count(), 3, 'Hit refreshes LRU order');
    cache.get(bodies[1]); assert.equal(count(), 4, 'Least recent entry was evicted');
    const byteBound = new WireBodySummaryCache(10, bodies[0].length * 2);
    byteBound.get(bodies[0]); byteBound.get(bodies[1]); byteBound.get(bodies[0]);
    assert.equal(count(), 7, 'Byte bound evicts even below entry limit');
    const oversized = new WireBodySummaryCache(10, bodies[0].length * 2 - 1);
    assert.equal(oversized.get(bodies[0])?.opcode, 101);
    assert.equal(oversized.get(bodies[0])?.opcode, 101);
    assert.equal(count(), 9, 'Oversized bodies still decode but are never retained');
    const immutable = cache.get(bodies[0])!;
    assert(Object.isFrozen(immutable));
    assert.equal(Reflect.set(immutable, 'opcode', 999), false);
    assert.equal(Reflect.set(immutable, 'hash', '0'.repeat(64)), false);
    assert.equal(cache.get(bodies[0])!.opcode, 101);
    assert.equal(cache.get(bodies[0])!.hash, cell(101).hash().toString('hex'));
    const unusual = bodies[0] + '\ud800';
    const before = count();
    assert.equal(cache.get(unusual)!.opcode, 101);
    assert.equal(cache.get(unusual)!.opcode, 101);
    assert.equal(count(), before + 1, 'Owned UTF-16 keys preserve even tolerant, noncanonical input exactly');
  });
});

check('valid token payloads remain independent fresh Cell graphs', () => {
  const payload = cell(0x34567890);
  const value = beginCell().storeUint(NOTIFY, 32).storeUint(1, 64).storeCoins(5)
    .storeAddress(Address.parse(source)).storeAddress(Address.parse(destination)).storeCoins(0).storeRef(payload).endCell();
  const raw = message(value), key = messageKey(raw), first = tokenWire(raw)!;
  assert.equal(first.amountRaw, '5');
  first.amountRaw = '999';
  first.forward.hash().fill(0);
  first.forward.bits.subbuffer(0, 32)!.fill(0);
  const next = tokenWire(raw)!;
  assert.equal(next.amountRaw, '5');
  assert.equal(next.forward.beginParse().preloadUint(32), 0x34567890);
  assert.equal(next.forward.hash().toString('hex'), payload.hash().toString('hex'));
  assert.equal(messageKey(raw), key);
});

check('funding envelope identity remains physical and malformed business envelopes stay rejected', () => {
  const business = cell(NOTIFY);
  const wrap = (correlation: number) => beginCell().storeUint(NATIVE_FUNDING, 32).storeUint(correlation, 64)
    .storeUint(0, 8).storeUint(0, 32).storeAddress(Address.parse(source)).storeRef(business).endCell();
  const a = message(wrap(1)), b = message(wrap(2));
  assert.equal(opcode(a), NATIVE_FUNDING);
  assert.equal(businessOpcode(a), NOTIFY);
  assert.equal(businessOpcode(b), NOTIFY);
  assert.notEqual(messageKey(a), messageKey(b));
  assert.equal(businessOpcode({ ...a, op: NOTIFY }), null);
  const trailing = beginCell().storeSlice(wrap(1).beginParse()).storeBit(true).endCell();
  const bad = message(trailing);
  assert.equal(opcode(bad), NATIVE_FUNDING, 'Outer evidence still exists');
  assert.equal(businessOpcode(bad), null);
  assert.equal(tokenWire(bad), null);
  assert.equal(businessOpcode(message(cell(NATIVE_FUNDING))), null);
  const notification = message(business);
  const expected = beginCell().storeUint(0x444c5246, 32).storeAddress(Address.parse(destination))
    .storeAddress(Address.parse(source)).storeUint(127, 64).storeBuffer(business.hash()).endCell().hash().toString('hex');
  countParses(count => {
    assert.equal(dlmmLiquidityNotificationCommitment(notification), expected);
    assert.equal(dlmmLiquidityNotificationCommitment(notification), expected);
    assert.equal(count(), 1, 'Commitment does not reparse the same original body for each check');
  });
  assert.equal(dlmmLiquidityNotificationCommitment({ ...notification, bounced: true }), null);
});

check('malformed, multi-root, short and exotic bodies retain their original boundaries', () => {
  const multi = Buffer.from('b5ee9c7201010202000c0001000800000001000800000002', 'hex');
  assert.equal(Cell.fromBoc(multi).length, 2);
  for (const body of ['invalid', multi.toString('base64')]) {
    const raw = { source, destination, createdLt: '127', body };
    assert.equal(bodyCell(raw), null); assert.equal(opcode(raw), null);
    assert.equal(businessOpcode(raw), null); assert.equal(messageKey(raw), null); assert.equal(tokenWire(raw), null);
  }
  const short = { ...message(beginCell().storeUint(7, 3).endCell()), op: 123 };
  assert(bodyCell(short)); assert(messageKey(short)); assert.equal(opcode(short), null);
  const exotic = beginCell().storeUint(2, 8).storeBuffer(Buffer.alloc(32, 7)).endCell({ exotic: true });
  const raw = message(exotic);
  assert(bodyCell(raw)); assert(messageKey(raw));
  assert.throws(() => opcode(raw), /Exotic/);
  assert.equal(businessOpcode(raw), null); assert.equal(tokenWire(raw), null);
  assert.equal(messageKey({ ...raw, op: 2 }), null);
  assert.equal(opcode({ ...raw, op: 2 }), null);
});
console.log('6 bounded wire summary checks passed');
