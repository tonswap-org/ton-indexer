import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadMessage } from '@ton/core';
import { readDlmmMarketState, readDlmmRouterOperation } from '../ledger/dlmmState';
import { verifyDlmmDeposit } from '../ledger/dlmmLiquidity';
import { ref, type DlmmProofBinding } from '../ledger/dlmmProof';
import type { MarketNode } from '../ledger/marketTypes';
import type { AccountStateResponse, RawTransaction } from '../data/dataSource';
import { DLMM_FEE_GROWTH_SCALE, deriveDlmmLiquidityAmounts, dlmmPositionState, dlmmLiquidityInversePrice, dlmmPendingLiquidityKey, readDlmmPendingLiquidityAdd, readDlmmLiquidityState, readDlmmLiquidityWithdrawal, verifyDlmmLiquidityTransition,
  type DlmmLiquidityState, type DlmmLiquidityRequest } from '../ledger/dlmmLiquidityState';

const fixturePath = process.env.DLMM_LIQUIDITY_FIXTURE || resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-settlements.json');
const fixtureBytes = readFileSync(fixturePath), fixture = JSON.parse(fixtureBytes.toString()) as {
  accounts: { pool: string; lp: string; other: string; recipient: string };
  intents: any[];
  transactions: { account: string; raw: RawTransaction }[];
  boundaries: { account: string; transactionLt: string; transactionHash: string; before: { dataBoc: string | null }; after: { dataBoc: string | null } }[];
};
const poolBoundaries = fixture.boundaries.filter(b => b.account === fixture.accounts.pool);
const tested: string[] = [], calculated: unknown[] = [];
const test = (name: string, fn: () => void) => { fn(); tested.push(name); console.log(`ok - ${name}`); };
const read = (boc: string | null) => { assert(boc); return readDlmmLiquidityState(boc); };
function request(intent: any): DlmmLiquidityRequest {
  if (intent.kind === 'add') return { kind: 'add', owner: intent.owner, binId: intent.binId, amountTRaw: intent.amountT, amountXRaw: intent.amountX, minSharesRaw: '0' };
  if (intent.kind === 'withdrawal') return { kind: 'withdrawal', owner: intent.owner, recipient: intent.recipient, binId: intent.binId, sharesRaw: intent.shares, queryId: intent.businessQueryId };
  return { kind: 'collect-fees', owner: intent.owner, recipient: intent.recipient, binId: intent.binId, sharesRaw: intent.shares };
}
function original(intent: any) {
  const candidates = fixture.transactions.slice(intent.transactionStart, intent.transactionEnd).filter(t => t.account === fixture.accounts.pool && t.raw.success).map(t => {
    const boundary = poolBoundaries.find(b => b.transactionLt === t.raw.lt && b.transactionHash === t.raw.hash); assert(boundary); return boundary;
  });
  if (intent.kind !== 'add') { assert(candidates.length); return candidates[0]; }
  const changed = candidates.filter(b => b.before.dataBoc && b.after.dataBoc && read(b.before.dataBoc).positions.get(dlmmPositionState(read(b.before.dataBoc), intent.owner, intent.binId).positionKey) !== read(b.after.dataBoc).positions.get(dlmmPositionState(read(b.after.dataBoc), intent.owner, intent.binId).positionKey));
  assert.equal(changed.length, 1); return changed[0];
}
const clone = (s: DlmmLiquidityState): DlmmLiquidityState => ({ ...s, market: { ...s.market }, bins: new Map([...s.bins].map(([k, v]) => [k, { ...v }])),
  positions: new Map(s.positions), checkpointsT: new Map(s.checkpointsT), checkpointsX: new Map(s.checkpointsX), creditsT: new Map(s.creditsT), creditsX: new Map(s.creditsX), lockedShares: new Map(s.lockedShares), withdrawals: new Map(s.withdrawals), pending: new Map(s.pending) });
const replaceRef = (cell: Cell, index: number, replacement: Cell) => { const b = beginCell().storeBits(cell.bits); cell.refs.forEach((ref, i) => b.storeRef(i === index ? replacement : ref)); return b.endCell(); };
const toBoc = (cell: Cell) => cell.toBoc().toString('base64');
const withdrawal = fixture.intents.find(i => i.kind === 'withdrawal'); assert(withdrawal);
const wb = original(withdrawal), wbefore = read(wb.before.dataBoc), wafter = read(wb.after.dataBoc), wrequest = request(withdrawal);
const graphFixture = JSON.parse(fixtureBytes.toString()) as {accounts: Record<string, string>; compiler: {entrypointFileName: string; codeHash: string}[];
  transactions: MarketNode[]; boundaries: {account: string; transactionHash: string; before: AccountStateResponse; after: AccountStateResponse}[]};
const proofBinding: DlmmProofBinding = {network: 'localnet', pool: graphFixture.accounts.pool, tokenT: graphFixture.accounts.tokenT, tokenX: graphFixture.accounts.tokenX,
  poolCodeHash: graphFixture.compiler.find(row => row.entrypointFileName.endsWith('/dlmm/pool.tolk'))!.codeHash,
  walletCodeHash: graphFixture.compiler.find(row => row.entrypointFileName.endsWith('/jetton_wallet.tolk'))!.codeHash};
function proofNodes(): MarketNode[] {
  return structuredClone(graphFixture.transactions).map(node => {
    const boundary = graphFixture.boundaries.find(row => row.account === node.account && row.transactionHash === node.raw.hash); assert(boundary);
    const state = (original: AccountStateResponse) => ({...structuredClone(original), accountState: String(original.accountState) === 'uninit' ? 'uninitialized' : original.accountState}) as AccountStateResponse;
    // Sandbox transaction boundaries are exact; the positive seqno is a fixture
    // archive bracket only, not a claim that Sandbox executes masterchain blocks.
    return {...node, before: {seqno: 50, state: state(boundary.before)}, after: {seqno: 50, state: state(boundary.after)}};
  });
}
function depositRefs(nodes: MarketNode[], intent: any) {
  return nodes.slice(intent.transactionStart, intent.transactionEnd).filter(node => node.account === fixture.accounts.pool && node.raw.inMessage?.op === 0x7362d09c).map(ref);
}

test('every captured pool boundary reads only an exact current constructor or persisted state', () => {
  let count = 0, constructors = 0;
  for (const b of poolBoundaries) for (const side of [b.before, b.after]) if (side.dataBoc) {
    const value = read(side.dataBoc); count++; if (value.market.storageForm === 'constructor') constructors++;
    assert.equal(value.market.dataHash, Cell.fromBase64(side.dataBoc).hash().toString('hex'));
    for (const bin of value.bins.values()) { assert(BigInt(bin.feeReserveTRaw) <= BigInt(bin.reserveTRaw)); assert(BigInt(bin.feeReserveXRaw) <= BigInt(bin.reserveXRaw)); }
  }
  assert(count > 20); assert(constructors > 0); console.log(JSON.stringify({ boundaryStates: count, constructorStates: constructors }));
});

test('current pool metadata rejects obsolete guards, omitted cumulative observations and unknown pool kinds', () => {
  const data = Cell.fromBase64(wb.before.dataBoc!);
  const guard = data.refs[2];
  const oldGuard = beginCell().storeBits(guard.bits.substring(0,416)).endCell();
  assert.throws(() => readDlmmMarketState(toBoc(replaceRef(data,2,oldGuard))), /structures_invalid/);
  const tailedGuard = beginCell().storeBits(guard.bits).storeBit(0).endCell();
  assert.throws(() => readDlmmMarketState(toBoc(replaceRef(data,2,tailedGuard))), /structures_invalid/);
  const observations = data.refs[1], ring = observations.refs[0];
  const oldRing = beginCell(); ring.refs.slice(0,3).forEach(ref => oldRing.storeRef(ref));
  assert.throws(() => readDlmmMarketState(toBoc(replaceRef(data,1,replaceRef(observations,0,oldRing.endCell())))), /observation_ring_invalid/);
  const root = beginCell().storeBits(data.bits.substring(0,833)).storeUint(3,8).storeBits(data.bits.substring(841,data.bits.length-841));
  data.refs.forEach(ref=>root.storeRef(ref));
  assert.throws(()=>readDlmmMarketState(toBoc(root.endCell())),/pool_layout_invalid/);
});
test('current router operation records reject omitted receipts, tails, hash substitution and invalid terminal status', () => {
  const boundary = poolBoundaries.find(b => b.after.dataBoc && readDlmmMarketState(b.after.dataBoc).routerOperations.size > 0)!;
  const data = Cell.fromBase64(boundary.after.dataBoc!), products=data.refs[3].refs[1].refs[3].refs[3];
  const entries=products.refs[1].beginParse().loadDict(Dictionary.Keys.BigUint(64),Dictionary.Values.Cell());
  const cell=[...entries.values()][0]; readDlmmRouterOperation(cell);
  const tail=beginCell().storeBits(cell.bits).storeBit(0);cell.refs.forEach(ref=>tail.storeRef(ref));
  assert.throws(()=>readDlmmRouterOperation(tail.endCell()),/trailing_data/);
  assert.throws(()=>readDlmmRouterOperation(beginCell().storeBits(cell.bits).storeRef(cell.refs[0]).endCell()),/layout_invalid/);
  assert.throws(()=>readDlmmRouterOperation(replaceRef(cell,0,Cell.EMPTY)),/fields_invalid/);
  const status=beginCell().storeBits(cell.bits.substring(0,320)).storeUint(3,8).storeBits(cell.bits.substring(328,cell.bits.length-328));
  cell.refs.forEach(ref=>status.storeRef(ref));
  assert.throws(()=>readDlmmRouterOperation(status.endCell()),/fields_invalid/);
});

for (const intent of fixture.intents.filter(i => i.kind !== 'swap')) test(`actual ${intent.label} conserves separate principal and earned fees`, () => {
  const b = original(intent), before = read(b.before.dataBoc), after = read(b.after.dataBoc), prior = JSON.stringify({ before: [...before.bins], after: [...after.bins], original: intent });
  const result = verifyDlmmLiquidityTransition(before, after, request(intent));
  if (intent.kind === 'add') { assert.equal(result.mintedSharesRaw, intent.mintedShares); assert.equal(result.principalTRaw, intent.amountT); assert.equal(result.principalXRaw, intent.amountX); }
  else for (const key of ['principalT', 'principalX', 'feeT', 'feeX', 'totalT', 'totalX']) assert.equal(result[`${key}Raw` as keyof typeof result], intent.expected[key]);
  if (intent.kind.startsWith('collect')) { assert.equal(result.burnedSharesRaw, '0'); assert.equal(result.beforePosition.sharesRaw, result.afterPosition.sharesRaw); assert.equal(result.beforeBin.sharesRaw, result.afterBin.sharesRaw); }
  assert.equal(JSON.stringify({ before: [...before.bins], after: [...after.bins], original: intent }), prior);
  calculated.push({ label: intent.label, request: request(intent), source: { transactionLt: b.transactionLt, transactionHash: b.transactionHash, beforeHash: before.market.dataHash, afterHash: after.market.dataHash }, result });
});

test('withdrawal journal totals include fees and do not relabel all receipts as principal', () => {
  const result = verifyDlmmLiquidityTransition(wbefore, wafter, wrequest), row = wafter.withdrawals.get(withdrawal.businessQueryId)!;
  assert.equal(row.totalTRaw, '320912'); assert.equal(row.totalXRaw, '345909'); assert.equal(result.principalTRaw, '320757'); assert.equal(result.feeTRaw, '155');
  assert.equal(BigInt(result.principalTRaw) + BigInt(result.feeTRaw), BigInt(row.totalTRaw));
  assert.equal(row.owner, withdrawal.owner); assert.equal(row.recipient, withdrawal.recipient);
});

test('actual fees from both swap directions accrue only in T3 after the 83 percent LP split', () => {
  const swaps = fixture.intents.filter(i => i.kind === 'swap');
  assert.deepEqual(swaps.map(i => i.quote.feePaid), ['300', '450']);
  assert.deepEqual(swaps.map(i => i.after.feeReserves.X), ['0', '0']);
  assert.deepEqual(swaps.map(i => BigInt(i.after.feeReserves.T) - BigInt(i.before.feeReserves.T)), [249n, 373n]);
  assert.equal(withdrawal.expected.feeX, '0');
  assert.equal(withdrawal.expected.totalX, withdrawal.expected.principalX);
});

test('fee collection debits the owner checkpoint and preserves a distinct payout recipient', () => {
  const intent = fixture.intents.find(i => i.kind === 'collect-fees-to')!, b = original(intent), before = read(b.before.dataBoc), after = read(b.after.dataBoc);
  assert.notEqual(intent.owner, intent.recipient); verifyDlmmLiquidityTransition(before, after, request(intent));
  assert.deepEqual(dlmmPositionState(before, intent.recipient, 0), dlmmPositionState(after, intent.recipient, 0));
  assert.notEqual(dlmmPositionState(before, intent.owner, 0).creditedTRaw, dlmmPositionState(after, intent.owner, 0).creditedTRaw);
});

for (const mutation of ['other-bin', 'other-owner', 'growth', 'fee-claim', 'credit', 'shares', 'fee-reserve', 'journal-total', 'guard', 'farm', 'active-query', 'initial-delivered', 'completion-funding'] as const) test(`rejects an altered ${mutation} despite otherwise matching payouts`, () => {
  const bad = clone(wafter), target = dlmmPositionState(bad, withdrawal.owner, 0).positionKey;
  if (mutation === 'other-bin') bad.bins.set(1, { ...bad.bins.get(0)! });
  if (mutation === 'other-owner') bad.positions.set(dlmmPositionState(bad, fixture.accounts.recipient, 0).positionKey, '1');
  if (mutation === 'growth') bad.feeGrowthGlobalTRaw = (BigInt(bad.feeGrowthGlobalTRaw) + 1n).toString();
  if (mutation === 'fee-claim') bad.market.feeClaimedT = (BigInt(bad.market.feeClaimedT) + 1n).toString();
  if (mutation === 'credit') bad.creditsT.set(target, (BigInt(bad.creditsT.get(target)!) + 1n).toString());
  if (mutation === 'shares') bad.positions.set(target, (BigInt(bad.positions.get(target)!) + 1n).toString());
  if (mutation === 'fee-reserve') bad.bins.get(0)!.feeReserveTRaw = '0';
  if (mutation === 'journal-total') bad.withdrawals.set(withdrawal.businessQueryId, { ...bad.withdrawals.get(withdrawal.businessQueryId)!, totalTRaw: '320757' });
  if (mutation === 'guard') bad.market.guardConfigurationHash = '0'.repeat(64);
  if (mutation === 'farm') bad.market.farmingHash = '0'.repeat(64);
  if (mutation === 'active-query') bad.activeWithdrawalQueryId = '0';
  if (mutation === 'initial-delivered') bad.withdrawals.set(withdrawal.businessQueryId, { ...bad.withdrawals.get(withdrawal.businessQueryId)!, legT: 1 });
  if (mutation === 'completion-funding') bad.withdrawals.set(withdrawal.businessQueryId, { ...bad.withdrawals.get(withdrawal.businessQueryId)!, completionFundedRaw: '0' });
  assert.throws(() => verifyDlmmLiquidityTransition(wbefore, bad, wrequest));
});

test('locks restrict removal but do not burn or prohibit fee collection', () => {
  const state = clone(wbefore), key = dlmmPositionState(state, withdrawal.owner, 0).positionKey;
  state.lockedShares.set(key, state.positions.get(key)!);
  assert.throws(() => deriveDlmmLiquidityAmounts(state, wrequest), /share_request/);
  const fees = deriveDlmmLiquidityAmounts(state, { kind: 'collect-fees', owner: withdrawal.owner, recipient: withdrawal.owner, binId: 0, sharesRaw: withdrawal.shares });
  assert.equal(fees.burnedSharesRaw, '0'); assert.equal(fees.afterPosition.lockedSharesRaw, state.positions.get(key));
});

test('growth accrual and requested-share fee division floor separately with retained dust', () => {
  const state = clone(wbefore), key = dlmmPositionState(state, withdrawal.owner, 0).positionKey, bin = state.bins.get(0)!;
  bin.sharesRaw = '7'; bin.reserveTRaw = '100'; bin.reserveXRaw = '100'; bin.feeReserveTRaw = '20'; bin.feeReserveXRaw = '20';
  bin.feeGrowthTRaw = (DLMM_FEE_GROWTH_SCALE / 2n).toString(); bin.feeGrowthXRaw = '0';
  state.positions.set(key, '3'); state.checkpointsT.set(key, '0'); state.checkpointsX.set(key, '0'); state.creditsT.set(key, '2'); state.creditsX.set(key, '0');
  const result = deriveDlmmLiquidityAmounts(state, { ...wrequest, sharesRaw: '1' } as DlmmLiquidityRequest);
  assert.equal(result.accruedTRaw, '1'); assert.equal(result.feeTRaw, '1'); assert.equal(result.principalTRaw, '11'); assert.equal(result.afterPosition.creditedTRaw, '2');
  calculated.push({ label: 'constructed-two-stage-floor', request: { ...wrequest, sharesRaw: '1' }, result });
});

for (const intent of fixture.intents.filter(i => i.kind === 'add')) test(`actual ${intent.label} retains the first contribution until the exact final mint`, () => {
  const final = original(intent), before = read(final.before.dataBoc), after = read(final.after.dataBoc);
  const key = dlmmPendingLiquidityKey(intent.owner, intent.binId, intent.businessQueryId), pending = before.pending.get(key); assert(pending);
  assert.equal(after.pending.has(key), false);
  assert.equal(pending.amountTRaw, intent.amountT); assert.equal(pending.amountXRaw, '0'); assert(pending.vaultT); assert.equal(pending.vaultX, null);
  const first = poolBoundaries.filter(b => fixture.transactions.slice(intent.transactionStart, intent.transactionEnd).some(t => t.account === fixture.accounts.pool && t.raw.lt === b.transactionLt))
    .find(b => b.before.dataBoc && b.after.dataBoc && !read(b.before.dataBoc).pending.has(key) && read(b.after.dataBoc).pending.has(key)); assert(first);
  assert.deepEqual(read(first.after.dataBoc).pending.get(key), pending);
  const firstRaw = fixture.transactions.find(t => t.account === fixture.accounts.pool && t.raw.lt === first.transactionLt)!.raw;
  const message = loadMessage(Cell.fromBase64((firstRaw.inMessage as {messageBoc: string}).messageBoc).beginParse());
  assert.equal(message.info.type, 'internal');
  if (message.info.type !== 'internal') throw Error('expected actual notification');
  const commitment = beginCell().storeUint(0x444c5246, 32).storeAddress(message.info.dest).storeAddress(message.info.src)
    .storeUint(message.info.createdLt, 64).storeUint(BigInt('0x' + message.body.hash().toString('hex')), 256).endCell().hash().toString('hex');
  assert.equal(pending.notificationHashT, commitment); assert.equal(pending.notificationHashX, '0'.repeat(64));
  assert.notEqual(dlmmPendingLiquidityKey(intent.owner, intent.binId, (BigInt(intent.businessQueryId) + 1n).toString()), key);
  assert.notEqual(dlmmPendingLiquidityKey(fixture.accounts.recipient, intent.binId, intent.businessQueryId), key);
});

test('pending records reject tails, inconsistent vaults and already completed two-sided entries', () => {
  const record = (t: bigint, x: bigint, vaultT: Address | null, vaultX: Address | null) => beginCell().storeCoins(t).storeCoins(x).storeCoins(10).storeCoins(0).storeUint(0, 256)
    .storeRef(beginCell().storeAddress(vaultT).storeAddress(vaultX).endCell())
    .storeRef(beginCell().storeUint(t ? 1 : 0, 256).storeUint(x ? 1 : 0, 256).endCell()).endCell();
  const valid = record(7n, 0n, Address.parse(withdrawal.owner), null);
  assert.equal(readDlmmPendingLiquidityAdd(valid).amountTRaw, '7');
  assert.throws(() => readDlmmPendingLiquidityAdd(beginCell().storeSlice(valid.beginParse()).storeBit(1).endCell()), /trailing/);
  assert.throws(() => readDlmmPendingLiquidityAdd(record(7n, 0n, null, null)), /pending_fields/);
  assert.throws(() => readDlmmPendingLiquidityAdd(record(7n, 9n, Address.parse(withdrawal.owner), Address.parse(withdrawal.owner))), /pending_fields/);
});

test('adding after fee accrual excludes fee reserves from the minted-share denominator', () => {
  const state = clone(wbefore), key = dlmmPositionState(state, withdrawal.owner, 0).positionKey, bin = state.bins.get(0)!;
  Object.assign(bin, { reserveTRaw: '120', reserveXRaw: '250', feeReserveTRaw: '20', feeReserveXRaw: '50', sharesRaw: '1000', feeGrowthTRaw: '0', feeGrowthXRaw: '0' });
  state.positions.set(key, '400'); state.checkpointsT.set(key, '0'); state.checkpointsX.set(key, '0'); state.creditsT.set(key, '3'); state.creditsX.set(key, '5');
  const req: DlmmLiquidityRequest = { kind: 'add', owner: withdrawal.owner, binId: 0, amountTRaw: '30', amountXRaw: '50', minSharesRaw: '250' };
  const result = deriveDlmmLiquidityAmounts(state, req);
  assert.equal(result.mintedSharesRaw, '250'); assert.equal(result.afterBin.reserveTRaw, '150'); assert.equal(result.afterBin.reserveXRaw, '300');
  assert.equal(result.afterBin.feeReserveTRaw, '20'); assert.equal(result.afterPosition.creditedTRaw, '3'); assert.equal(result.afterPosition.creditedXRaw, '5');
  assert.throws(() => deriveDlmmLiquidityAmounts(state, { ...req, minSharesRaw: '251' }), /mint/);
  state.binLiquidityCapRaw = '299'; assert.throws(() => deriveDlmmLiquidityAmounts(state, req), /bin_cap/);
  calculated.push({ label: 'constructed-add-excludes-fee-reserves', request: req, result });
});

test('large raw reserves and shares retain exact partial principal and fee arithmetic', () => {
  const state = clone(wbefore), key = dlmmPositionState(state, withdrawal.owner, 0).positionKey, bin = state.bins.get(0)!;
  Object.assign(bin, { reserveTRaw: '900719925474099300007', reserveXRaw: '900719925474099300019', feeReserveTRaw: '100000001', feeReserveXRaw: '100000003', sharesRaw: '90071992547409931', feeGrowthTRaw: (DLMM_FEE_GROWTH_SCALE / 1000000000n).toString(), feeGrowthXRaw: '0' });
  state.positions.set(key, '9007199254740993'); state.checkpointsT.set(key, '0'); state.checkpointsX.set(key, '0'); state.creditsT.set(key, '123'); state.creditsX.set(key, '100000001');
  const req = { ...wrequest, sharesRaw: '3002399751580331' } as DlmmLiquidityRequest, result = deriveDlmmLiquidityAmounts(state, req);
  assert(BigInt(result.principalTRaw) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(BigInt(result.afterBin.reserveTRaw) + BigInt(result.totalTRaw), BigInt(bin.reserveTRaw));
  calculated.push({ label: 'constructed-beyond-safe-integer', request: req, result });
});

test('current inverse cache is derived exactly and changed cache values reject a mint', () => {
  assert.equal(dlmmLiquidityInversePrice(0, 1), '18446744073709551616');
  assert.equal(dlmmLiquidityInversePrice(1, 1), '18446725626983924632');
  assert.equal(dlmmLiquidityInversePrice(-1, 1), '18446762520453625325');
  const intent = fixture.intents.find(i => i.kind === 'add')!, b = original(intent), before = read(b.before.dataBoc), bad = clone(read(b.after.dataBoc));
  bad.bins.get(0)!.priceInvQ64Raw = '1'; assert.throws(() => verifyDlmmLiquidityTransition(before, bad, request(intent)), /bin_delta/);
});

for (const bad of ['unknown-kind', 'zero-shares', 'excess-shares', 'noncanonical-shares', 'checkpoint-ahead', 'unfunded-fee', 'owner-over-supply', 'replayed-query'] as const) test(`rejects ${bad} before deriving economic values`, () => {
  const state = clone(wbefore), req = { ...wrequest } as any, key = dlmmPositionState(state, withdrawal.owner, 0).positionKey;
  if (bad === 'unknown-kind') req.kind = 'remove';
  if (bad === 'zero-shares') req.sharesRaw = '0';
  if (bad === 'excess-shares') req.sharesRaw = (BigInt(state.positions.get(key)!) + 1n).toString();
  if (bad === 'noncanonical-shares') req.sharesRaw = '01';
  if (bad === 'checkpoint-ahead') state.checkpointsT.set(key, (BigInt(state.bins.get(0)!.feeGrowthTRaw) + 1n).toString());
  if (bad === 'unfunded-fee') state.creditsT.set(key, '100000000000000000000000000000');
  if (bad === 'owner-over-supply') state.positions.set(key, (BigInt(state.bins.get(0)!.sharesRaw) + 1n).toString());
  if (bad === 'replayed-query') state.withdrawals.set(req.queryId, wafter.withdrawals.get(req.queryId)!);
  assert.throws(() => deriveDlmmLiquidityAmounts(state, req));
});

test('strict current extra rejects the former fee-only size instead of adding zero reserves', () => {
  const originalCell = Cell.fromBase64(wb.before.dataBoc!), binRoot = originalCell.refs[0];
  const codec = { serialize: (c: Cell, builder: ReturnType<typeof beginCell>) => { builder.storeSlice(c.beginParse()); }, parse: (s: import('@ton/core').Slice) => s.asCell() };
  const values = Dictionary.load(Dictionary.Keys.Int(32), codec, binRoot.refs[0]);
  const bin = values.get(0)!; values.set(0, replaceRef(bin, 0, beginCell().storeUint(0, 256).storeUint(0, 256).endCell()));
  const altered = replaceRef(originalCell, 0, replaceRef(binRoot, 0, beginCell().storeDict(values).endCell()));
  assert.throws(() => readDlmmLiquidityState(toBoc(altered)), /extra_layout/);
});

test('a populated bin cannot use the current empty-bin extra or a tailed position leaf', () => {
  const root = Cell.fromBase64(wb.before.dataBoc!), binRoot = root.refs[0];
  const codec = { serialize: (c: Cell, b: ReturnType<typeof beginCell>) => { b.storeSlice(c.beginParse()); }, parse: (s: import('@ton/core').Slice) => s.asCell() };
  const bins = Dictionary.load(Dictionary.Keys.Int(32), codec, binRoot.refs[0]);
  bins.set(0, replaceRef(bins.get(0)!, 0, beginCell().endCell()));
  assert.throws(() => readDlmmLiquidityState(toBoc(replaceRef(root, 0, replaceRef(binRoot, 0, beginCell().storeDict(bins).endCell())))), /populated_empty_extra/);
  const meta = root.refs[3], pos = meta.refs[1], positions = Dictionary.load(Dictionary.Keys.BigUint(256), codec, pos.refs[0]);
  const key = BigInt('0x' + dlmmPositionState(wbefore, withdrawal.owner, 0).positionKey);
  positions.set(key, beginCell().storeSlice(positions.get(key)!.beginParse()).storeBit(1).endCell());
  assert.throws(() => readDlmmLiquidityState(toBoc(replaceRef(root, 3, replaceRef(meta, 1, replaceRef(pos, 0, beginCell().storeDict(positions).endCell()))))), /trailing/);
});

test('constructor selection rejects mixed populated cells instead of accepting a missing journal', () => {
  const originalCell = Cell.fromBase64(wb.before.dataBoc!), meta = originalCell.refs[3], pos = meta.refs[1];
  const altered = replaceRef(originalCell, 3, replaceRef(meta, 1, replaceRef(pos, 3, beginCell().endCell())));
  assert.throws(() => readDlmmMarketState(toBoc(altered)), /constructor_state/);
});

test('current withdrawal records reject tailed or wrong-tag evidence', () => {
  const root = Cell.fromBase64(wb.after.dataBoc!), ws = root.refs[3].refs[1].refs[2].beginParse(); ws.loadUintBig(64);
  const rows = ws.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()), record = rows.get(BigInt(withdrawal.businessQueryId))!;
  assert.equal(readDlmmLiquidityWithdrawal(record).queryId, withdrawal.businessQueryId);
  const tailed = beginCell().storeSlice(record.beginParse()).storeBit(1).endCell();
  assert.throws(() => readDlmmLiquidityWithdrawal(tailed), /layout/);
  const invalid = beginCell().storeUint(0, 32).storeSlice(record.beginParse().skip(32)).endCell(); assert.throws(() => readDlmmLiquidityWithdrawal(invalid), /layout/);
});

for (const intent of fixture.intents.filter(i => i.kind === 'add')) test(`actual graph ${intent.label} proves both physical payments and exact minted shares`, () => {
  const nodes = proofNodes(), originalBytes = JSON.stringify(nodes), result = verifyDlmmDeposit(proofBinding, nodes, intent.owner, depositRefs(nodes, intent));
  assert.equal(result.amounts.mintedSharesRaw, intent.mintedShares); assert.equal(result.amounts.principalTRaw, intent.amountT); assert.equal(result.amounts.principalXRaw, intent.amountX);
  assert.equal(result.evidence.length, 8); assert.equal(JSON.stringify(nodes), originalBytes);
});

for (const mutation of ['pending-amount', 'minted-shares', 'first-fee-claim', 'first-global-growth', 'final-native-reserve'] as const) test(`deposit graph rejects ${mutation} without changing the physical source records`, () => {
  const intent = fixture.intents.find(i => i.kind === 'add')!, nodes = proofNodes(), acceptances = depositRefs(nodes, intent);
  assert.equal(acceptances.length, 2);
  const target = nodes.find(node => node.raw.lt === acceptances[mutation.startsWith('first-') ? 0 : 1].lt && node.account === fixture.accounts.pool)!;
  const side = mutation === 'pending-amount' ? target.before! : target.after!, cell = Cell.fromBase64(side.state.dataBoc!), meta = cell.refs[3], pos = meta.refs[1];
  let changed = cell;
  if (mutation === 'first-fee-claim') {
    const s = meta.beginParse(), governance = s.loadMaybeAddress(), seq = s.loadUintBig(64), updated = s.loadUintBig(64), claimedT = s.loadUintBig(128), claimedX = s.loadUintBig(128);
    const b = beginCell().storeAddress(governance).storeUint(seq, 64).storeUint(updated, 64).storeUint(claimedT + 1n, 128).storeUint(claimedX, 128); meta.refs.forEach(child => b.storeRef(child)); changed = replaceRef(cell, 3, b.endCell());
  } else if (mutation === 'first-global-growth') {
    const s = cell.refs[0].beginParse(); changed = replaceRef(cell, 0, beginCell().storeUint(s.loadUintBig(256) + 1n, 256).storeUint(s.loadUintBig(256), 256).storeRef(s.loadRef()).endCell());
  } else if (mutation === 'final-native-reserve') {
    const journal = pos.refs[3], s = journal.beginParse(), b = beginCell().storeUint(s.loadUint(32), 32).storeUint(s.loadUintBig(64), 64).storeCoins(s.loadCoins()).storeCoins(s.loadCoins()).storeCoins(s.loadCoins() + 1n);
    journal.refs.forEach(child => b.storeRef(child)); changed = replaceRef(cell, 3, replaceRef(meta, 1, replaceRef(pos, 3, b.endCell())));
  } else if (mutation === 'pending-amount') {
    const rows = Dictionary.load(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell(), pos.refs[1]), key = BigInt('0x' + dlmmPendingLiquidityKey(intent.owner, intent.binId, intent.businessQueryId));
    const old = rows.get(key)!, s = old.beginParse(), b = beginCell().storeCoins(s.loadCoins() + 1n).storeCoins(s.loadCoins()).storeCoins(s.loadCoins()).storeCoins(s.loadCoins()).storeUint(s.loadUintBig(256), 256).storeRef(s.loadRef()).storeRef(s.loadRef()); rows.set(key, b.endCell());
    changed = replaceRef(cell, 3, replaceRef(meta, 1, replaceRef(pos, 1, beginCell().storeDict(rows).endCell())));
  } else {
    const rows = Dictionary.load(Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(256), pos.refs[0]), key = BigInt('0x' + dlmmPositionState(read(side.state.dataBoc!), intent.owner, intent.binId).positionKey);
    rows.set(key, rows.get(key)! + 1n); changed = replaceRef(cell, 3, replaceRef(meta, 1, replaceRef(pos, 0, beginCell().storeDict(rows).endCell())));
  }
  side.state.dataBoc = toBoc(changed);
  assert.throws(() => verifyDlmmDeposit(proofBinding, nodes, intent.owner, acceptances));
});

test('deposit rejects a consistently substituted pending commitment despite unchanged payment bodies and amounts', () => {
  const intent = fixture.intents.find(i => i.kind === 'add')!, nodes = proofNodes(), acceptances = depositRefs(nodes, intent);
  const accepted = acceptances.map(a => nodes.find(n => n.account === fixture.accounts.pool && n.raw.lt === a.lt)!);
  for (const state of [accepted[0].after!, accepted[1].before!]) {
    const cell = Cell.fromBase64(state.state.dataBoc!), meta = cell.refs[3], pos = meta.refs[1];
    const rows = Dictionary.load(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell(), pos.refs[1]);
    const key = BigInt('0x' + dlmmPendingLiquidityKey(intent.owner, intent.binId, intent.businessQueryId)), pending = rows.get(key)!;
    rows.set(key, replaceRef(pending, 1, beginCell().storeUint(1, 256).storeUint(0, 256).endCell()));
    state.state.dataBoc = toBoc(replaceRef(cell, 3, replaceRef(meta, 1, replaceRef(pos, 1, beginCell().storeDict(rows).endCell()))));
  }
  assert.throws(() => verifyDlmmDeposit(proofBinding, nodes, intent.owner, acceptances), /pending_contribution_invalid/);
});

if (process.env.DLMM_LIQUIDITY_TEST_EVIDENCE_DIR) {
  const directory = resolve(process.env.DLMM_LIQUIDITY_TEST_EVIDENCE_DIR); mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'state-test-results.json'), JSON.stringify({ fixture: fixturePath, fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), passed: tested.length, failed: 0, tests: tested, calculated }, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: tested.length, failed: 0, actualOperations: fixture.intents.filter(i => i.kind !== 'swap').length }));
