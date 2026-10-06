import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Address, Cell, Dictionary, beginCell, loadShardAccount, loadTransaction } from '@ton/core';
import { perpsOracleTradeTransition, readPerpsOracleRefreshes, readPerpsState } from '../ledger/perpsState';
import { PERPS_CLAIM, PERPS_CLOSE, PERPS_OPEN } from '../ledger/perpsWire';
import { perpsRiskFixtureFolder, readPerpsRiskFixtureProvenance } from './perps-risk-fixture';

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
const notification = (request = openRequest, fundingOwner = owner, forwardTon = 2080000000n) => beginCell()
  .storeUint(0x7362d09c, 32).storeUint(99, 64).storeCoins(16).storeAddress(fundingOwner).storeAddress(requestedPool)
  .storeCoins(forwardTon).storeRef(request).endCell();
const tradeOrder = (request = closeRequest, funding = empty, outcome = 2, reason = 0, pool: Address | null = requestedPool, previous = empty) => beginCell()
  .storeRef(request).storeRef(funding).storeCoins(800000000n).storeUint(outcome, 8).storeUint(reason, 8).storeUint(request.equals(openRequest) && outcome === 2 ? 2 : 0, 8).storeAddress(pool).storeRef(previous).endCell();
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

// Managed exits store a position commitment and original native sponsor;
// these are neither a MODIFY's whole position nor an ordinary CLOSE's empty cell.
const nativeSponsor = (refundKind = 0, moduleId = 0, refundTo: Address | null = requestedPool) => beginCell()
  .storeUint(99, 64).storeUint(refundKind, 8).storeUint(moduleId, 32).storeAddress(refundTo).endCell();
const positionContext = (sponsor = nativeSponsor()) => beginCell().storeUint(123, 256).storeRef(sponsor).endCell();
const claimRequest = beginCell().storeUint(PERPS_CLAIM, 32).storeUint(7, 64).storeUint(1, 32).endCell();
for (const [request, kind] of [[closeRequest, 1], [claimRequest, 2]] as const) {
  for (const [outcome, reason, status] of [[1, kind, 1], [2, 0, 2], [3, 2, 2], [3, 3, 4]] as const) {
    const managed = readPerpsOracleRefreshes(records(tradeReceipt(
      tradeOrder(request, empty, outcome, reason, requestedPool, positionContext()), request.hash(), status))).get(owner.toRawString())!;
    assert.equal(managed.order?.positionOracleContext?.positionHash, '7b'.padStart(64, '0'));
    assert.equal(managed.order?.positionOracleContext?.sponsor.refundTo, requestedPool.toRawString());
    assert.equal(managed.order?.positionOracleContext?.sponsor.correlationId, '99');
  }
  for (const wrongKind of [0, kind === 1 ? 2 : 1, 3]) assert.throws(() => readPerpsOracleRefreshes(records(tradeReceipt(
    tradeOrder(request, empty, 1, wrongKind, requestedPool, positionContext()), request.hash(), 1))));
}
assert.throws(() => readPerpsOracleRefreshes(records(tradeReceipt(tradeOrder(claimRequest), claimRequest.hash()))));
for (const context of [
  beginCell().storeUint(123, 255).storeRef(nativeSponsor()).endCell(),
  beginCell().storeUint(123, 257).storeRef(nativeSponsor()).endCell(),
  beginCell().storeUint(123, 256).endCell(),
  beginCell().storeUint(123, 256).storeRef(nativeSponsor()).storeRef(empty).endCell(),
  positionContext(nativeSponsor(2)), positionContext(nativeSponsor(0, 405)),
  positionContext(nativeSponsor(1, 0)), positionContext(nativeSponsor(0, 0, null)),
  positionContext(beginCell().storeSlice(nativeSponsor().beginParse()).storeBit(false).endCell()),
  positionContext(beginCell().storeSlice(nativeSponsor().beginParse()).storeRef(empty).endCell()),
]) assert.throws(() => readPerpsOracleRefreshes(records(tradeReceipt(
  tradeOrder(closeRequest, empty, 1, 1, requestedPool, context), closeRequest.hash(), 1))));
assert.throws(() => readPerpsOracleRefreshes(records(tradeReceipt(
  tradeOrder(openRequest, notification(), 2, 0, requestedPool, positionContext()), notification().hash()))));

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
readPerpsRiskFixtureProvenance();
const maintenanceFixture = JSON.parse(readFileSync(join(perpsRiskFixtureFolder, 'maintenance-close.json'), 'utf8'));
const maintenanceEngine = BigInt('0x' + Address.parse(maintenanceFixture.engine).hash.toString('hex'));
const maintenanceCodeHash = Cell.fromBase64(maintenanceFixture.engineCode).hash().toString('hex');
let managedBoundaries = 0, acceptedMaintenance: any = null;
for (const row of maintenanceFixture.transactions) {
  const tx = loadTransaction(Cell.fromBase64(row.transaction).beginParse());
  if (tx.address !== maintenanceEngine || !row.oldStorage || !row.newStorage) continue;
  const before = readPerpsState(row.oldStorage, maintenanceCodeHash), after = readPerpsState(row.newStorage, maintenanceCodeHash);
  for (const [marketId, owners] of after.oracleRefreshes) {
    const next = owners.get(maintenanceFixture.owner);
    if (!next?.order?.positionOracleContext) continue;
    managedBoundaries++;
    const prior = before.oracleRefreshes.get(marketId)?.get(maintenanceFixture.owner);
    if (prior?.order?.outcome === 1 && next.order.outcome === 2) {
      assert(tx.description.type === 'generic' && !tx.description.aborted);
      const transition = perpsOracleTradeTransition(before, after, maintenanceFixture.owner, next.order.request);
      assert(transition, 'Actual funded maintenance must retain its exact position and sponsor across execution');
      assert.equal(prior.order.reason, 1);
      assert.equal(next.order.reason, 0);
      assert.equal(next.order.positionOracleContext.sponsor.refundKind, 1);
      assert.equal(next.order.positionOracleContext.sponsor.moduleId, 405);
      acceptedMaintenance = { row, before, after, next, prior, marketId };
    }
  }
}
assert(managedBoundaries >= 2 && acceptedMaintenance, 'Current producer must contain the real managed close transition');
const managed = acceptedMaintenance;
const replaceContext = (boc: string, transform: (context: Cell) => Cell): string => {
  const data = Cell.fromBase64(boc), maps = data.refs[1];
  const markets = maps.refs[0].beginParse().loadDict(Dictionary.Keys.Uint(32), raw);
  const market = markets.get(managed.marketId)!, stats = market.refs[1], journal = stats.refs[2], s = journal.beginParse();
  const count = s.loadUint(16), nextWire = s.loadUintBig(64);
  const eligibility = s.loadDict(Dictionary.Keys.BigUint(128), raw), entries = s.loadDict(Dictionary.Keys.Address(), raw);
  const wires = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Address()); s.endParse();
  const trader = Address.parse(maintenanceFixture.owner), receipt = entries.get(trader)!, order = receipt.refs[0];
  entries.set(trader, withRefs(receipt, [withRefs(order, [order.refs[0], order.refs[1], transform(order.refs[2])])]));
  const changedJournal = beginCell().storeUint(count, 16).storeUint(nextWire, 64).storeDict(eligibility).storeDict(entries).storeDict(wires).endCell();
  markets.set(managed.marketId, withRefs(market, [market.refs[0], withRefs(stats, [stats.refs[0], stats.refs[1], changedJournal, stats.refs[3]])]));
  return withRefs(data, [data.refs[0], withRefs(maps, [beginCell().storeDict(markets).endCell(), ...maps.refs.slice(1)]), ...data.refs.slice(2)]).toBoc().toString('base64');
};
for (const sponsor of [nativeSponsor(1, 404), nativeSponsor(1, 405, owner)]) {
  const wrongSponsor = replaceContext(managed.row.newStorage, context => beginCell().storeBits(context.bits).storeRef(sponsor).endCell());
  assert.throws(() => readPerpsState(wrongSponsor, maintenanceCodeHash), /position oracle sponsor/);
}
const changedHash = (context: Cell) => beginCell().storeUint(123, 256).storeRef(context.refs[0]).endCell();
const changedSponsor = (context: Cell) => beginCell().storeBits(context.bits).storeRef(nativeSponsor()).endCell();
for (const transform of [changedHash, changedSponsor]) {
  const alteredAfter = readPerpsState(replaceContext(managed.row.newStorage, transform), maintenanceCodeHash);
  assert.equal(perpsOracleTradeTransition(managed.before, alteredAfter, maintenanceFixture.owner, managed.next.order.request), null,
    'The terminal continuation cannot replace either the position commitment or original sponsor');
}
const wrongBefore = readPerpsState(replaceContext(managed.row.oldStorage, changedHash), maintenanceCodeHash);
const wrongAfter = readPerpsState(replaceContext(managed.row.newStorage, changedHash), maintenanceCodeHash);
assert.equal(perpsOracleTradeTransition(wrongBefore, wrongAfter, maintenanceFixture.owner, managed.next.order.request), null,
  'Even an unchanged arbitrary commitment cannot prove an accepted close of another position');
const currentFixture = JSON.parse(readFileSync(join(perpsRiskFixtureFolder, 'open-accepted.json'), 'utf8'));
const currentCodeHash = Cell.fromBase64(currentFixture.engineCode).hash().toString('hex');
const engineAccount = BigInt('0x' + Address.parse(currentFixture.engine).hash.toString('hex'));
const currentStorage = currentFixture.transactions.filter((saved: any) =>
  loadTransaction(Cell.fromBase64(saved.transaction).beginParse()).address === engineAccount).at(-1).newStorage;
const currentData = Cell.fromBase64(currentStorage);
// The final Engine carries distinct funding/control collectors. Reject an
// otherwise authentic state if either identity is duplicated or reuses the
// GasVault itself: both defects would misattribute returned native funds.
const currentRegistry = currentData.refs[0];
const currentConfig = currentRegistry.refs[1];
const currentRouter = currentConfig.refs[0];
const routerSlice = currentRouter.beginParse();
routerSlice.loadMaybeAddress();
const currentGasVault = routerSlice.loadMaybeAddress();
routerSlice.loadMaybeAddress();
const currentExtras = routerSlice.loadRef();
assert(currentGasVault && (currentExtras.beginParse().loadUint(8) & 64));
const collectorSlice = currentExtras.refs[0].beginParse();
const fundingCollector = collectorSlice.loadAddress();
const controlCollector = collectorSlice.loadAddress();
assert(!fundingCollector.equals(controlCollector));
const originalCurrent = readPerpsState(currentStorage, currentCodeHash);
const governance = currentRegistry.refs[0].beginParse().loadMaybeAddress();
const policyController = new Address(0, Buffer.alloc(32, 0xee));
assert(!governance?.equals(policyController));
const pendingPolicy = (marketId: number, overrides: Partial<{
  controller: Address | null; policyId: number; scope: number; registrationVersion: number; leaseSecs: number;
  epoch: bigint; sourceVersion: number; configVersion: number; validUntil: bigint; grossBudget: bigint;
  consumedGross: bigint; posture: number; flags: number;
}> = {}) => {
  const p = { controller: policyController as Address | null, policyId: marketId, scope: marketId,
    registrationVersion: 1, leaseSecs: 120, epoch: 0n, sourceVersion: 0, configVersion: 0,
    validUntil: 0n, grossBudget: 0n, consumedGross: 0n, posture: 4, flags: 1, ...overrides };
  return beginCell().storeAddress(p.controller).storeUint(p.policyId, 32).storeUint(p.scope, 32)
    .storeUint(p.registrationVersion, 32).storeUint(p.leaseSecs, 32).storeUint(p.epoch, 64)
    .storeUint(p.sourceVersion, 32).storeUint(p.configVersion, 32).storeInt(p.validUntil, 64)
    .storeUint(p.grossBudget, 64).storeUint(p.consumedGross, 64).storeUint(p.posture, 8).storeUint(p.flags, 8).endCell();
};
const policyMap = (entries: [number, Cell][]) => {
  const bindings = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
  for (const [id, value] of entries) bindings.set(id, value);
  return beginCell().storeDict(bindings).endCell();
};
const withPendingPolicyMap = (map: Cell, options: { swapRefs?: boolean; omitRef?: boolean; mask?: boolean; trailer?: boolean } = {}) => {
  const bits = currentExtras.beginParse(), mask = bits.loadUint(8);
  assert.equal(mask & 32, 0, 'The original current-source archive has no pending future market bindings');
  const extras = beginCell().storeUint(options.mask === false ? mask : mask | 32, 8).storeSlice(bits);
  if (!options.omitRef) extras.storeRef(map);
  if (options.trailer) extras.storeBit(0);
  let changedExtras = extras.endCell();
  if (options.swapRefs) {
    const refs = [...changedExtras.refs];
    [refs[refs.length - 1], refs[refs.length - 2]] = [refs[refs.length - 2], refs[refs.length - 1]];
    changedExtras = withRefs(changedExtras, refs);
  }
  const router = withRefs(currentRouter, [changedExtras, ...currentRouter.refs.slice(1)]);
  const config = withRefs(currentConfig, [router, ...currentConfig.refs.slice(1)]);
  const registry = withRefs(currentRegistry, [currentRegistry.refs[0], config, ...currentRegistry.refs.slice(2)]);
  return withRefs(currentData, [registry, ...currentData.refs.slice(1)]).toBoc().toString('base64');
};
// Preserve the actual current OPEN graph while adding the same native
// RiskPolicyBindingMapPersisted shape used for absent future market slots.
assert.equal(originalCurrent.pendingRiskPolicies.size, 0);
const futureBindings = readPerpsState(withPendingPolicyMap(policyMap([
  [2, pendingPolicy(2)], [3, pendingPolicy(3)], [4, pendingPolicy(4)],
])), currentCodeHash);
assert.deepEqual([...futureBindings.pendingRiskPolicies.keys()], [2, 3, 4]);
for (const [marketId, policy] of futureBindings.pendingRiskPolicies) assert.deepEqual(policy, {
  controller: policyController.toRawString(), policyId: marketId, scope: marketId,
  registrationVersion: 1, leaseSecs: 120, epoch: '0', sourceVersion: 0, configVersion: 0,
  validUntil: '0', grossBudget: '0', consumedGross: '0', posture: 4, flags: 1,
});
assert.deepEqual(futureBindings.markets, originalCurrent.markets);
assert.deepEqual(futureBindings.positions, originalCurrent.positions);
assert.deepEqual(futureBindings.accounts, originalCurrent.accounts);
const semanticStateValue = (value: unknown): unknown => {
  // Adding an unrelated reference changes the decoded BOC backing buffer.
  // Preserve every oracle field and authenticate Cells by their own graph.
  if (value instanceof Cell) return { cellHash: value.hash().toString('hex'), cellBoc: value.toBoc().toString('base64') };
  if (value instanceof Map) return [...value].map(([key, entry]) => [semanticStateValue(key), semanticStateValue(entry)]);
  if (Array.isArray(value)) return value.map(semanticStateValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, semanticStateValue(entry)]));
  return value;
};
assert.deepEqual(semanticStateValue(futureBindings.oracleRefreshes), semanticStateValue(originalCurrent.oracleRefreshes));
assert.notEqual(futureBindings.configHash, originalCurrent.configHash, 'Pending commitments remain bound into the exact configuration hash');
assert.notEqual(futureBindings.dataHash, originalCurrent.dataHash);
for (const overrides of [
  { controller: null }, { policyId: 0 }, { policyId: 3 }, { scope: 3 }, { registrationVersion: 0 },
  { leaseSecs: 0 }, { leaseSecs: 121 }, { epoch: 1n }, { sourceVersion: 1 }, { configVersion: 1 },
  { validUntil: -1n }, { validUntil: 1n }, { grossBudget: 1n }, { consumedGross: 1n },
  { posture: 0 }, { posture: 5 }, { flags: 0 }, { flags: 3 }, { flags: 8 },
  ...(governance ? [{ controller: governance }] : []),
]) assert.throws(() => readPerpsState(withPendingPolicyMap(policyMap([[2, pendingPolicy(2, overrides)]])), currentCodeHash),
  'A future binding is the exact unissued, blocked risk_policy_empty commitment');
for (const id of [0, 1, 5, 0xffffffff])
  assert.throws(() => readPerpsState(withPendingPolicyMap(policyMap([[id, pendingPolicy(id)]])), currentCodeHash));
const validPolicy = pendingPolicy(2), validMap = policyMap([[2, validPolicy]]);
const pruned = beginCell().storeUint(1, 8).storeUint(1, 8).storeUint(0n, 256).storeUint(0, 16).endCell({ exotic: true });
for (const malformed of [
  empty, policyMap([]), beginCell().storeRef(validPolicy).endCell(),
  beginCell().storeSlice(validMap.beginParse()).storeBit(0).endCell(),
  beginCell().storeSlice(validMap.beginParse()).storeRef(empty).endCell(),
  policyMap([[2, empty]]), policyMap([[2, pruned]]),
  policyMap([[2, beginCell().storeBits(validPolicy.bits).storeRef(empty).endCell()]]),
  policyMap([[2, beginCell().storeSlice(validPolicy.beginParse()).storeBit(0).endCell()]]),
  beginCell().storeDict(Dictionary.empty(Dictionary.Keys.Uint(32), raw).set(2, validPolicy)).endCell(),
  beginCell().storeBit(1).storeRef(pruned).endCell(),
]) assert.throws(() => readPerpsState(withPendingPolicyMap(malformed), currentCodeHash),
  'Missing, inline, pruned or trailing dictionary/value data never becomes a future binding');
for (const options of [{ swapRefs: true }, { omitRef: true }, { mask: false }, { trailer: true }])
  assert.throws(() => readPerpsState(withPendingPolicyMap(validMap, options), currentCodeHash), 'Extras references are exact and ordered');
const forkMap = policyMap([[2, pendingPolicy(2)], [3, pendingPolicy(3)]]);
assert.equal(forkMap.refs[0].refs.length, 2);
for (const fork of [beginCell().storeSlice(forkMap.refs[0].beginParse()).storeBit(0).endCell(),
  withRefs(forkMap.refs[0], [pruned, forkMap.refs[0].refs[1]]),
  withRefs(forkMap.refs[0], [forkMap.refs[0].refs[0]])])
  assert.throws(() => readPerpsState(withPendingPolicyMap(beginCell().storeBit(1).storeRef(fork).endCell()), currentCodeHash),
    'Complete dictionary fork evidence is mandatory');
const existingMarket = originalCurrent.markets.keys().next().value!;
const mapsWithFutureRegistered = currentData.refs[1];
const registered = mapsWithFutureRegistered.refs[0].beginParse().loadDict(Dictionary.Keys.Uint(32), raw);
const overlapId = 2;
assert(!registered.has(overlapId));
const originalMarket = registered.get(existingMarket)!, originalStats = originalMarket.refs[1];
const overlapFundingAndRisk = beginCell().storeRef(originalStats.refs[3].refs[0]).storeRef(empty).endCell();
const overlapStats = withRefs(originalStats, [originalStats.refs[0], originalStats.refs[1], empty, overlapFundingAndRisk]);
registered.set(overlapId, withRefs(originalMarket, [originalMarket.refs[0], overlapStats]));
const overlapMaps = withRefs(mapsWithFutureRegistered, [beginCell().storeDict(registered).endCell(), ...mapsWithFutureRegistered.refs.slice(1)]);
assert(readPerpsState(withRefs(currentData, [currentData.refs[0], overlapMaps, ...currentData.refs.slice(2)])
  .toBoc().toString('base64'), currentCodeHash).markets.has(overlapId));
const overlapData = Cell.fromBase64(withPendingPolicyMap(validMap));
assert.throws(() => readPerpsState(withRefs(overlapData, [overlapData.refs[0], overlapMaps, ...overlapData.refs.slice(2)])
  .toBoc().toString('base64'), currentCodeHash), /pending risk policy overlaps/, 'A pending future binding cannot also belong to a registered market');
const withCollectors = (first: Address, second: Address) => {
  const collectors = beginCell().storeAddress(first).storeAddress(second).endCell();
  const extras = withRefs(currentExtras, [collectors, ...currentExtras.refs.slice(1)]);
  const router = withRefs(currentRouter, [extras, ...currentRouter.refs.slice(1)]);
  const config = withRefs(currentConfig, [router, ...currentConfig.refs.slice(1)]);
  const registry = withRefs(currentRegistry, [currentRegistry.refs[0], config, ...currentRegistry.refs.slice(2)]);
  return withRefs(currentData, [registry, ...currentData.refs.slice(1)]).toBoc().toString('base64');
};
for (const malformed of [withCollectors(fundingCollector, fundingCollector),
  withCollectors(currentGasVault, controlCollector)]) {
  assert.throws(() => readPerpsState(malformed, currentCodeHash), /Perps return collector identities/);
}
for (const queueRefs of [currentData.refs[2].refs.slice(0, 2), [...currentData.refs[2].refs, Cell.EMPTY]]) {
  const obsoleteQueue = withRefs(currentData.refs[2], queueRefs);
  const obsoleteState = withRefs(currentData, [currentData.refs[0], currentData.refs[1], obsoleteQueue, currentData.refs[3]]);
  assert.throws(() => readPerpsState(obsoleteState.toBoc().toString('base64'), currentCodeHash),
    /Perps canonical queue bundle/, 'The exact three-reference queue bundle is mandatory');
}
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
// Original live state that exposed the pending-policy decoder failure. This
// observation is a schema regression, not historical transaction/replay proof.
const liveBytes = gunzipSync(readFileSync(join(__dirname, 'fixtures/perps-pending-risk-policies-live.01.json.gz')));
assert.equal(liveBytes.length, 397204);
assert.equal(createHash('sha256').update(liveBytes).digest('hex'), '2b38e4937788d7da9a30d2dfcb3037da46bedb22a211ceaa1ec6f09284d91340');
const live = JSON.parse(liveBytes.toString('utf8'));
assert.equal(live.schema, 'tonswap-live-perps-state-observation-v1');
assert.equal(live.network, 'testnet');
assert.deepEqual(live.head, { seqno: 89411541, timestamp: 1791266143 });
assert.equal(live.state.accountState, 'active');
assert.equal(Cell.fromBase64(live.state.codeBoc).hash().toString('hex'), live.codeHash);
const liveState = readPerpsState(live.state.dataBoc, live.codeHash);
assert.equal(liveState.dataHash, '418ef81e3b2020b127fa27e2fd15e2ce28bf611ff257c5468b41d57a7ffe4d5d');
assert.deepEqual([...liveState.pendingRiskPolicies.keys()], [2, 3, 4]);
assert.deepEqual([...liveState.markets.keys()], [1]);
assert(liveState.positions.size > 0, 'The live first trade and pending future policies coexist');
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
console.log('Perps oracle receipts: exact eligibility, managed position/sponsor commitments, native maintenance continuation and obsolete-layout rejection passed');
