import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadShardAccount, loadTransaction } from '@ton/core';
import { readPerpsOracleRefreshes, readPerpsState } from '../ledger/perpsState';
import { PERPS_CLOSE, PERPS_OPEN } from '../ledger/perpsWire';

const owner = Address.parse(`0:${'a'.repeat(64)}`);
const hash = 'b'.repeat(64);
const empty = beginCell().endCell();
const receipt = (overrides: Partial<{ queryId: bigint; wireQueryId: bigint; status: number; requestedAt: bigint; completedAt: bigint; mark: bigint; markTs: bigint }> = {}) => {
  const value = { queryId: 7n, wireQueryId: 3n, status: 2, requestedAt: 100n, completedAt: 102n, mark: 1_000_000_000n, markTs: 101n, ...overrides };
  return beginCell().storeUint(value.queryId, 64).storeUint(value.wireQueryId, 64).storeUint(BigInt(`0x${hash}`), 256).storeUint(value.status, 8)
    .storeInt(value.requestedAt, 64).storeInt(value.completedAt, 64).storeCoins(value.mark).storeInt(value.markTs, 64).storeRef(empty).endCell();
};
const raw = {
  serialize: (cell: Cell, builder: any) => builder.storeSlice(cell.beginParse()),
  parse: (slice: any) => { const cell = slice.asCell(); slice.skip(slice.remainingBits); while (slice.remainingRefs) slice.loadRef(); return cell; },
};
const eligibilityKey = (cell: Cell): bigint | null => {
  const s = cell.beginParse(); s.loadUintBig(64); const wire = s.loadUintBig(64); s.loadUintBig(256);
  const status = s.loadUint(8), requested = s.loadIntBig(64); const order = s.loadRef();
  if (order.bits.length || order.refs.length) { const o = order.beginParse(); o.loadRef(); o.loadRef(); o.loadCoins(); if (o.loadUint(8) === 1) return null; }
  return ((status === 1 ? requested + 300n : 0n) << 64n) | wire;
};
const records = (value: Cell, options: { count?: number; nextWireQueryId?: bigint; key?: bigint; entryOwner?: Address; extraOwner?: Address; omitEntry?: boolean; omitIndex?: boolean } = {}) => {
  const index = Dictionary.empty(Dictionary.Keys.BigUint(128), Dictionary.Values.Address());
  let key: bigint | null;
  try { key = eligibilityKey(value); } catch { key = 3n; }
  if (key !== null && !options.omitIndex) index.set(options.key ?? key, owner);
  if (options.extraOwner) index.set(2n, options.extraOwner);
  const entries = Dictionary.empty(Dictionary.Keys.Address(), raw);
  if (!options.omitEntry) entries.set(options.entryOwner ?? owner, value);
  const wires = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Address());
  if (!options.omitEntry) {
    const wire = value.beginParse(); wire.skip(64);
    wires.set(wire.loadUintBig(64), options.entryOwner ?? owner);
  }
  return beginCell().storeUint(options.count ?? 1, 16).storeUint(options.nextWireQueryId ?? 4n, 64).storeDict(index).storeDict(entries).storeDict(wires).endCell();
};
assert.equal(readPerpsOracleRefreshes(empty).size, 0);
assert.deepEqual(readPerpsOracleRefreshes(records(receipt())).get(owner.toRawString()), {
  queryId: '7', wireQueryId: '3', requestHash: hash, status: 2, requestedAt: '100', completedAt: '102', oracleMarkRaw: '1000000000', oracleMarkTs: '101', order: null,
});
assert.equal(readPerpsOracleRefreshes(records(receipt({ status: 1, completedAt: 0n, mark: 0n, markTs: 0n }))).size, 1);
for (const status of [3, 4]) assert.equal(readPerpsOracleRefreshes(records(receipt({ status, mark: 0n, markTs: 0n }))).size, 1);
for (const invalid of [
  receipt({ queryId: 0n }), receipt({ wireQueryId: 0n }), receipt({ wireQueryId: 4n }), receipt({ status: 0 }), receipt({ status: 5 }), receipt({ requestedAt: -1n }),
  receipt({ status: 1 }), receipt({ completedAt: 99n }), receipt({ mark: 0n }), receipt({ markTs: 0n }),
  beginCell().storeBits(receipt().bits).endCell(), // Missing mandatory current order reference.
  beginCell().storeSlice(receipt().beginParse()).storeBit(0).endCell(),
  beginCell().storeSlice(receipt().beginParse()).storeRef(empty).endCell(), empty,
]) assert.throws(() => readPerpsOracleRefreshes(records(invalid)));
assert.throws(() => readPerpsOracleRefreshes(beginCell().storeSlice(records(receipt()).beginParse()).storeBit(0).endCell()));
assert.throws(() => readPerpsOracleRefreshes(beginCell().storeSlice(records(receipt()).beginParse()).storeRef(empty).endCell()));
for (const options of [
  { count: 129 }, { nextWireQueryId: 0n }, { nextWireQueryId: 3n }, { key: 128n }, { extraOwner: owner }, { omitEntry: true }, { omitIndex: true }, { count: 0 },
  { entryOwner: Address.parse(`0:${'d'.repeat(64)}`) }, { extraOwner: Address.parse(`0:${'d'.repeat(64)}`) },
]) assert.throws(() => readPerpsOracleRefreshes(records(receipt(), options)));
const fullOwners = Dictionary.empty(Dictionary.Keys.BigUint(128), Dictionary.Values.Address());
const fullEntries = Dictionary.empty(Dictionary.Keys.Address(), raw);
const fullWires = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Address());
for (let index = 0; index < 128; index += 1) {
  const member = Address.parse(`0:${(index + 1).toString(16).padStart(64, '0')}`);
  fullOwners.set(BigInt(index + 1), member);
  fullWires.set(BigInt(index + 1), member);
  fullEntries.set(member, receipt({ wireQueryId: BigInt(index + 1) }));
}
assert.equal(readPerpsOracleRefreshes(beginCell().storeUint(128, 16).storeUint(129n, 64).storeDict(fullOwners).storeDict(fullEntries).storeDict(fullWires).endCell()).size, 128);
const duplicateNonce = Address.parse(`0:${(128).toString(16).padStart(64, '0')}`);
fullEntries.set(duplicateNonce, receipt({ wireQueryId: 1n }));
assert.throws(() => readPerpsOracleRefreshes(beginCell().storeUint(128, 16).storeUint(129n, 64).storeDict(fullOwners).storeDict(fullEntries).storeDict(fullWires).endCell()), 'Distinct owners cannot share an internal wire nonce');
fullEntries.set(duplicateNonce, receipt({ wireQueryId: 128n }));
fullOwners.set(129n, owner);
fullEntries.set(owner, receipt());
assert.throws(() => readPerpsOracleRefreshes(beginCell().storeUint(128, 16).storeUint(129n, 64).storeDict(fullOwners).storeDict(fullEntries).storeDict(fullWires).endCell()));

// Paid orders preserve the exact approved trade and its original funding
// envelope. A valid eligibility index cannot replace those bindings.
const requestedPool = Address.parse(`0:${'c'.repeat(64)}`);
const closeRequest = beginCell().storeUint(PERPS_CLOSE, 32).storeUint(7, 64).storeUint(1, 32).storeInt(0, 128).storeCoins(12).storeAddress(null).endCell();
const partialCloseRequest = beginCell().storeUint(PERPS_CLOSE, 32).storeUint(7, 64).storeUint(1, 32).storeInt(9, 128).storeCoins(12).storeAddress(null).endCell();
const openRequest = beginCell().storeUint(PERPS_OPEN, 32).storeUint(7, 64).storeUint(1, 32).storeInt(9, 128).storeCoins(15)
  .storeCoins(12).storeUint(20000, 32).storeAddress(null).endCell();
const notification = (request = openRequest, fundingOwner = owner, forwardTon = 1280000000n) => beginCell()
  .storeUint(0x7362d09c, 32).storeUint(99, 64).storeCoins(16).storeAddress(fundingOwner).storeAddress(requestedPool)
  .storeCoins(forwardTon).storeRef(request).endCell();
const tradeOrder = (request = closeRequest, funding = empty, outcome = 2, reason = 0, pool: Address | null = requestedPool) => beginCell()
  .storeRef(request).storeRef(funding).storeCoins(800000000n).storeUint(outcome, 8).storeUint(reason, 8).storeUint(request.equals(openRequest) && outcome === 2 ? 2 : 0, 8).storeAddress(pool).storeRef(empty).endCell();
const tradeReceipt = (order = tradeOrder(), requestHash = closeRequest.hash(), status = 2) => {
  const source = receipt({ status, ...(status === 1 ? { completedAt: 0n, mark: 0n, markTs: 0n } : {}) }).beginParse();
  const prefix = source.loadBits(128); source.skip(256);
  return beginCell().storeBits(prefix).storeBuffer(requestHash).storeBits(source.loadBits(source.remainingBits)).storeRef(order).endCell();
};
const paid = readPerpsOracleRefreshes(records(tradeReceipt())).get(owner.toRawString())!;
assert.equal(paid.order?.pool, requestedPool.toRawString());
assert.equal(paid.order?.request.limitPriceRaw, '12');
const funded = readPerpsOracleRefreshes(records(tradeReceipt(tradeOrder(openRequest, notification()), notification().hash()))).get(owner.toRawString())!;
assert.equal(funded.order?.funding?.fundingQueryId, '99');
assert.equal(funded.order?.funding?.amountRaw, '16');
assert.equal(funded.order?.request.leverageBps, 20000);
assert.equal(readPerpsOracleRefreshes(records(tradeReceipt(tradeOrder(closeRequest, empty, 3, 7), closeRequest.hash(), 3)))
  .get(owner.toRawString())?.order?.reason, 7);
for (const invalid of [
  tradeReceipt(tradeOrder(partialCloseRequest), partialCloseRequest.hash()), // CLOS is the full-exit opcode; partial changes use MDIF.
  tradeReceipt(beginCell().storeBits(tradeOrder().bits).storeRef(closeRequest).endCell()), // Missing notification reference.
  tradeReceipt(beginCell().storeCoins(800000000n).storeUint(2, 8).storeUint(0, 8).storeRef(closeRequest).storeRef(empty).endCell()), // Missing saved pool.
  tradeReceipt(tradeOrder(closeRequest, empty, 2, 0, null)),
  tradeReceipt(tradeOrder(closeRequest, notification())),
  tradeReceipt(tradeOrder(openRequest, empty), openRequest.hash()),
  tradeReceipt(tradeOrder(openRequest, notification(closeRequest)), notification(closeRequest).hash()),
  tradeReceipt(tradeOrder(openRequest, notification(openRequest, requestedPool)), notification(openRequest, requestedPool).hash()),
  tradeReceipt(tradeOrder(openRequest, notification(openRequest, owner, 1n)), notification(openRequest, owner, 1n).hash()),
  tradeReceipt(tradeOrder(openRequest, notification()), openRequest.hash()), // Payload hash cannot replace full NOTIFY hash.
  tradeReceipt(tradeOrder(closeRequest, empty, 1, 0)),
  tradeReceipt(tradeOrder(closeRequest, empty, 3, 4)),
  tradeReceipt(tradeOrder(closeRequest, empty, 3, 7)), // Rebind is not oracle acceptance.
  tradeReceipt(tradeOrder(closeRequest, empty, 2, 1)),
]) assert.throws(() => readPerpsOracleRefreshes(records(invalid)));

const archive = loadShardAccount(Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/predecessor.boc')))[0].beginParse());
assert.equal(archive.account?.storage.state.type, 'active');
const state = archive.account!.storage.state;
if (state.type !== 'active') throw Error('Fixture is inactive');
const historicalCode = state.state.code!.hash().toString('hex');
const data = state.state.data!;
assert.throws(() => readPerpsState(data.toBoc().toString('base64'), historicalCode), 'An archived code hash does not enable an obsolete layout');
assert.throws(() => readPerpsState(data.toBoc().toString('base64'), 'c'.repeat(64)), 'Current code must carry the current receipt reference');

const withRefs = (cell: Cell, refs: readonly Cell[]) => {
  const builder = beginCell().storeBits(cell.bits);
  for (const ref of refs) builder.storeRef(ref);
  return builder.endCell();
};
const currentFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/perps-risk-admission-current/open-accepted.json'), 'utf8'));
const currentCodeHash = Cell.fromBase64(currentFixture.engineCode).hash().toString('hex');
const engineAccount = BigInt('0x' + Address.parse(currentFixture.engine).hash.toString('hex'));
const currentStorage = currentFixture.transactions.filter((saved: any) =>
  loadTransaction(Cell.fromBase64(saved.transaction).beginParse()).address === engineAccount).at(-1).newStorage;
const currentData = Cell.fromBase64(currentStorage);
const currentWithAccrual = (accrual?: Cell) => {
  const marketDict = currentData.refs[1].refs[0].beginParse().loadDict(Dictionary.Keys.Uint(32), raw);
  for (const [id, market] of marketDict) {
    const stats = market.refs[1], currentFundingAndRisk = stats.refs[3];
    const fundingAndRisk = beginCell();
    if (accrual) fundingAndRisk.storeRef(accrual);
    fundingAndRisk.storeRef(currentFundingAndRisk.refs[1]);
    const statsRefs = [stats.refs[0], stats.refs[1], records(receipt()), fundingAndRisk.endCell()];
    marketDict.set(id, withRefs(market, [market.refs[0], withRefs(market.refs[1], statsRefs)]));
  }
  const maps = withRefs(currentData.refs[1], [beginCell().storeDict(marketDict).endCell(), ...currentData.refs[1].refs.slice(1)]);
  return withRefs(currentData, [currentData.refs[0], maps, ...currentData.refs.slice(2)]).toBoc().toString('base64');
};
const fundingCheckpoint = (remainder = 0, healthy = true, rate = 0n, validUntil = 0n) => beginCell()
  .storeInt(remainder, 64).storeBit(healthy).storeInt(rate, 128).storeInt(validUntil, 64).endCell();
const current = currentWithAccrual(fundingCheckpoint(3599, true, -7n, 1234n));
assert.equal(readPerpsState(current, 'c'.repeat(64)).oracleRefreshes.values().next().value?.get(owner.toRawString())?.queryId, '7');
assert.equal(readPerpsState(current, 'c'.repeat(64)).markets.values().next().value?.fundingRemainderRaw, '3599');
assert.equal(readPerpsState(current, 'c'.repeat(64)).markets.values().next().value?.oraclePriceHealthy, true);
assert.equal(readPerpsState(current, 'c'.repeat(64)).markets.values().next().value?.fundingRateBpsRaw, '-7');
assert.equal(readPerpsState(current, 'c'.repeat(64)).markets.values().next().value?.fundingValidUntil, '1234');
assert.equal(readPerpsState(currentWithAccrual(fundingCheckpoint(0, false)), 'c'.repeat(64))
  .markets.values().next().value?.oraclePriceHealthy, false);
for (const invalid of [undefined, empty, fundingCheckpoint(-1), fundingCheckpoint(3600), fundingCheckpoint(0, true, 0n, -1n),
  beginCell().storeInt(0, 64).endCell(), beginCell().storeInt(0, 64).storeBit(true).endCell(),
  beginCell().storeSlice(fundingCheckpoint().beginParse()).storeBit(false).endCell(),
  beginCell().storeSlice(fundingCheckpoint().beginParse()).storeRef(empty).endCell()])
  assert.throws(() => readPerpsState(currentWithAccrual(invalid), 'c'.repeat(64)), 'Current funding checkpoint is mandatory, bounded and exact');
// Runtime code qualification is enforced by the caller before this sole ABI parser.
assert.equal(readPerpsState(current, historicalCode).oracleRefreshes.size, readPerpsState(current, 'c'.repeat(64)).markets.size);
// Read the unmodified current engine archive; authentic old archives remain
// unsupported even when they contain one newer-looking field.
const actual = readPerpsState(currentStorage, currentCodeHash);
assert(actual.positions.size > 0);
assert([...actual.positions.values()].every(position => BigInt(position.counterparty.reservedRaw) > 0n));
for (const path of ['perps-oracle-execution/funding-remainder.json',
  'perps-order-plans-current/funding-remainder-current.json',
  'perps-order-plans-current/engine-exhausted-current.json']) {
  const archived = JSON.parse(readFileSync(join(__dirname, 'fixtures', path), 'utf8'));
  assert.throws(() => readPerpsState(archived.dataBoc, archived.codeHash), 'Archived layouts never enable compatibility decoding');
}
// A protected paid record has no expiry entry; a malicious deadline must fail.
const pendingPaid = tradeReceipt(tradeOrder(closeRequest, empty, 1, 0), closeRequest.hash(), 1);
assert.equal(readPerpsOracleRefreshes(records(pendingPaid)).size, 1);
assert.throws(() => readPerpsOracleRefreshes(records(pendingPaid, { extraOwner: owner })), /eligibility/);
const obsoleteOwners = Dictionary.empty(Dictionary.Keys.Uint(16), Dictionary.Values.Address()).set(0, owner);
const obsoleteEntries = Dictionary.empty(Dictionary.Keys.Address(), raw).set(owner, receipt());
assert.throws(() => readPerpsOracleRefreshes(beginCell().storeUint(1, 16).storeUint(4n, 64).storeDict(obsoleteOwners).storeDict(obsoleteEntries).endCell()));
console.log('Perps oracle receipts: exact eligibility index, protected paid orders and rejection of obsolete layouts passed');
