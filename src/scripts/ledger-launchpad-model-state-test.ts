import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadMessage, loadTransaction } from '@ton/core';
import type { RawMessage, RawTransaction } from '../data/dataSource';
import { readBondingSaleState } from '../ledger/launchpadBondingState';
import { readAuctionSaleState } from '../ledger/launchpadAuctionState';
import { readLaunchpadEnvelope, readLaunchpadFills, readLaunchpadRegistry, readLaunchpadRouting } from '../ledger/launchpadStateCommon';
import { readLaunchpadSharedJournal, readLaunchpadSharedSettlement, type LaunchpadSharedSettlement } from '../ledger/launchpadSharedJournal';
import { readFixedSaleSettlementRecord } from '../ledger/launchpadState';
import { fixedSaleSettlementRequestHash, launchpadCommand, LAUNCHPAD_BID, LAUNCHPAD_TRANSFER } from '../ledger/launchpadWire';
import { tokenWire, NOTIFY } from '../ledger/wire';

type Snapshot = { balance: string; lastTxLt: string; lastTxHash: string; codeBoc: string | null; dataBoc: string | null };
type Boundary = { phase: string; account: string; transactionLt: string; transactionHash: string; before: Snapshot; after: Snapshot };
type SavedMessage = RawMessage & { messageBoc: string; messageHash: string };
type Fixture = {
  model: 'bonding' | 'auction'; accounts: Record<string, string>; boundaries: Boundary[];
  transactions: { phase: string; account: string; transactionBoc: string; raw: RawTransaction & { inMessage?: SavedMessage; outMessages: SavedMessage[] } }[];
  compiler: { entrypointFileName: string; codeHash: string }[];
  intents: { phase: string; requester: string; queryId: string; outerQueryId: string; amountRaw: string; expectedAcceptance: boolean }[];
  observations: { label: string; saleState: Record<string, unknown>; ownerEntry: Record<string, unknown>; otherEntry: Record<string, unknown>; journal: Record<string, unknown>; records: Record<string, unknown>[] }[];
};
const load = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `fixtures/${name}.json`), 'utf8')) as Fixture;
const bonding = load('launchpad-bonding-contributions'), auction = load('launchpad-auction-bids');
const fixtures = [bonding, auction];
const read = (f: Fixture, data: string) => f.model === 'bonding' ? readBondingSaleState(data) : readAuctionSaleState(data);
const boundaries = (f: Fixture, phase: string) => f.boundaries.filter(b => b.account === f.accounts.sale && b.phase === phase);
const acceptance = (f: Fixture, phase: string) => {
  const tx = f.transactions.filter(t => t.account === f.accounts.sale && t.phase === phase && t.raw.inMessage?.op === NOTIFY);
  assert.equal(tx.length, 1); return f.boundaries.find(b => b.transactionHash === tx[0].raw.hash)!;
};
const boc = (c: Cell) => c.toBoc().toString('base64'), A = (value: string) => Address.parse(value);
const message = (cell: Cell): RawMessage => ({ body: boc(cell), op: cell.bits.length >= 32 ? cell.beginParse().loadUint(32) : undefined });
function replaceRef(cell: Cell, index: number, value: Cell) { const b = beginCell().storeBits(cell.bits); cell.refs.forEach((ref, i) => b.storeRef(i === index ? value : ref)); return b.endCell(); }
let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`ok ${passed} - ${name}`); }

for (const f of fixtures) {
  test(`${f.model}: all original transaction/message cells and archive boundaries retain exact identities and fees`, () => {
    assert.equal(f.transactions.length, f.model === 'bonding' ? 161 : 131); assert.equal(f.boundaries.length, f.transactions.length);
    for (const saved of f.transactions) {
      const cell = Cell.fromBase64(saved.transactionBoc), tx = loadTransaction(cell.beginParse()), b = f.boundaries.find(b => b.transactionHash === saved.raw.hash)!;
      assert.equal(cell.hash().toString('hex'), saved.raw.hash); assert.equal(tx.lt.toString(), saved.raw.lt);
      assert.equal(tx.totalFees.coins.toString(), saved.raw.totalFeesRaw); assert.equal(b.account, saved.account);
      assert.equal(b.before.lastTxLt, saved.raw.prevTransactionLt); assert.equal(b.before.lastTxHash, saved.raw.prevTransactionHash);
      assert.equal(b.after.lastTxLt, saved.raw.lt); assert.equal(b.after.lastTxHash, saved.raw.hash);
      for (const m of [saved.raw.inMessage, ...saved.raw.outMessages].filter(Boolean) as SavedMessage[]) {
        const raw = Cell.fromBase64(m.messageBoc), decoded = loadMessage(raw.beginParse());
        assert.equal(raw.hash().toString('hex'), m.messageHash); assert.equal(boc(decoded.body), m.body);
        if (decoded.info.type === 'internal') { assert.equal(decoded.info.src.toRawString(), m.source); assert.equal(decoded.info.dest.toRawString(), m.destination); assert.equal(decoded.info.value.coins.toString(), m.value); }
      }
    }
  });
  test(`${f.model}: current serialized states agree with actual getters without old-layout defaults`, () => {
    const sale = f.boundaries.filter(b => b.account === f.accounts.sale && b.phase !== 'setup');
    assert.equal(sale.length * 2, f.model === 'bonding' ? 56 : 42);
    for (const b of sale) for (const snapshot of [b.before, b.after]) {
      const s = read(f, snapshot.dataBoc!);
      assert.equal(s.registry.owner, f.accounts.creator); assert.equal(s.registry.factory, f.accounts.creator);
      assert.equal(s.paymentRouting.wallet, f.accounts.paymentSaleWallet); assert.equal(s.paymentRouting.tokenRoot, f.accounts.paymentRoot);
      assert.equal(s.paymentRouting.walletCodeHash, f.compiler.find(c => c.entrypointFileName.endsWith('jetton_wallet.tolk'))!.codeHash);
      assert.equal(Cell.fromBase64(snapshot.codeBoc!).hash().toString('hex'), f.compiler.find(c => c.entrypointFileName.endsWith(`sale_${f.model}.tolk`))!.codeHash);
      for (const record of s.journal.entries.values()) assert.equal(fixedSaleSettlementRequestHash(f.accounts.sale, record), record.requestHash);
    }
    for (const observation of f.observations.filter(o => o.label.startsWith('after-owner-') || o.label === 'after-other-interleaved' || o.label === 'after-sale-finalize')) {
      const phase = observation.label.slice(6), boundary = boundaries(f, phase).at(-1); if (!boundary) continue;
      const s = read(f, boundary.after.dataBoc!);
      for (const [key, value] of Object.entries(s.metrics)) {
        const getterKey = key.endsWith('Raw') ? key.slice(0, -3) : key;
        if (Object.hasOwn(observation.saleState, getterKey)) assert.equal(String(value), String(observation.saleState[getterKey]), `${f.model} ${phase} ${key}`);
      }
      for (const [id, r] of s.journal.entries) {
        const getter = observation.records.find(r => r.settlementId === id)!;
        assert.equal(r.amountRaw, getter.amount); assert.equal(r.status, getter.status); assert.equal(r.tokenRoot, getter.tokenRoot);
        assert.equal(BigInt(`0x${r.requestHash}`).toString(), getter.requestHash);
      }
    }
  });
  test(`${f.model}: unequal outer and inner query IDs are preserved as separate request fields`, () => {
    const b = acceptance(f, 'other-interleaved'), tx = f.transactions.find(t => t.raw.hash === b.transactionHash)!;
    const notification = tokenWire(tx.raw.inMessage)!;
    assert.equal(notification.queryId, '1201'); assert.equal(launchpadCommand(message(notification.forward))!.queryId, '201');
    const intent = f.intents.find(i => i.phase === 'other-interleaved')!;
    assert.equal(intent.outerQueryId, '1201'); assert.equal(intent.queryId, '201');
  });
  test(`${f.model}: two distinct funded transactions with identical complete request bodies remain distinguishable`, () => {
    const phases = f.model === 'bonding' ? ['owner-second-same-query', 'owner-third-identical-body'] : ['owner-first', 'owner-second-same-query'];
    const txs = phases.map(phase => f.transactions.find(t => t.phase === phase && t.account === f.accounts.ownerPaymentWallet && t.raw.inMessage?.op === LAUNCHPAD_TRANSFER)!);
    assert.equal(txs[0].raw.inMessage!.body, txs[1].raw.inMessage!.body);
    assert.notEqual(txs[0].raw.hash, txs[1].raw.hash); assert.notEqual(txs[0].raw.inMessage!.messageHash, txs[1].raw.inMessage!.messageHash);
    assert.notEqual(txs[0].raw.lt, txs[1].raw.lt);
  });
  test(`${f.model}: a genuine processed rejected payment books a refund without increasing participant acceptance`, () => {
    const b = acceptance(f, 'owner-rejected'), before = read(f, b.before.dataBoc!), after = read(f, b.after.dataBoc!);
    const bp = 'contributions' in before ? before.contributions : before.bids, ap = 'contributions' in after ? after.contributions : after.bids;
    assert.deepEqual([...ap], [...bp]); assert.deepEqual(after.metrics, before.metrics);
    const added = [...after.journal.entries.values()].filter(r => !before.journal.entries.has(r.settlementId));
    assert.equal(added.length, 1); assert.equal(added[0].kind, 3); assert.equal(added[0].amountRaw, f.model === 'bonding' ? '1000000000' : '3000000000');
    assert.equal(added[0].recipientOwner, f.accounts.owner);
    assert.equal(f.transactions.find(t => t.raw.hash === b.transactionHash)!.raw.success, true);
  });
  test(`${f.model}: claim flags retain historical positions and independently deliver actual allocated tokens`, () => {
    const b = boundaries(f, 'owner-claim')[0], before = read(f, b.before.dataBoc!), after = read(f, b.after.dataBoc!);
    const bp = ('contributions' in before ? before.contributions : before.bids).get(f.accounts.owner)!;
    const ap = ('contributions' in after ? after.contributions : after.bids).get(f.accounts.owner)!;
    assert.equal(bp.claimed, false); assert.equal(ap.claimed, true);
    assert.deepEqual({ ...ap, claimed: false }, bp);
    const transfers = f.transactions.filter(t => t.phase === 'owner-claim').map(t => ({ t, wire: tokenWire(t.raw.inMessage) })).filter(({ wire }) => wire?.op === 0x4a534954 && wire.amountRaw === '2');
    assert.equal(transfers.length, 1); const credit = f.boundaries.find(b => b.transactionHash === transfers[0].t.raw.hash)!;
    const balance = (s: Snapshot) => s.dataBoc ? Cell.fromBase64(s.dataBoc).beginParse().loadCoins() : 0n;
    assert.equal(balance(credit.after) - balance(credit.before), 2n);
  });
}
test('bonding: each participant-local acceptance pushes exact fill and uses the before-state price across interleaving', () => {
  for (const intent of bonding.intents.filter(i => i.expectedAcceptance)) {
    const b = acceptance(bonding, intent.phase), before = readBondingSaleState(b.before.dataBoc!), after = readBondingSaleState(b.after.dataBoc!);
    const old = before.contributions.get(intent.requester), added = after.contributions.get(intent.requester)!;
    const amount = BigInt(intent.amountRaw), tokens = amount / BigInt(before.metrics.currentPriceRaw);
    assert.equal(tokens * BigInt(before.metrics.currentPriceRaw), amount);
    assert.equal(BigInt(added.paymentAmountRaw) - BigInt(old?.paymentAmountRaw ?? '0'), amount);
    assert.equal(BigInt(added.tokenAmountRaw) - BigInt(old?.tokenAmountRaw ?? '0'), tokens);
    assert.equal(added.fills[0].paymentAmountRaw, intent.amountRaw); assert.equal(added.fills[0].tokenAmountRaw, tokens.toString());
    assert.equal(added.fills[0].previousHash, old?.fills.length ? old.fillsHash : null);
    assert.deepEqual(added.fills.slice(1), old?.fills ?? []);
    assert.equal(after.metrics.lastPriceRaw, before.metrics.currentPriceRaw);
    assert.equal(BigInt(after.metrics.currentPriceRaw), BigInt(after.config.basePriceRaw) + BigInt(after.config.slopeNumeratorRaw) * BigInt(after.metrics.totalSoldRaw) / BigInt(after.config.slopeDenominatorRaw));
    for (const [owner, entry] of before.contributions) if (owner !== intent.requester) assert.deepEqual(after.contributions.get(owner), entry);
  }
  const b = acceptance(bonding, 'owner-second-same-query');
  assert.equal(readBondingSaleState(b.before.dataBoc!).metrics.currentPriceRaw, '3000000000');
});
test('bonding: real partial refund pops latest fill while later identical request creates new provenance', () => {
  const b = boundaries(bonding, 'owner-partial-refund')[0], before = readBondingSaleState(b.before.dataBoc!), after = readBondingSaleState(b.after.dataBoc!);
  const old = before.contributions.get(bonding.accounts.owner)!, next = after.contributions.get(bonding.accounts.owner)!;
  assert.deepEqual(old.fills.map(f => f.paymentAmountRaw), ['3000000000', '1000000000']);
  assert.deepEqual(next.fills, old.fills.slice(1)); assert.equal(next.paymentAmountRaw, '1000000000');
  assert.equal(next.fillsHash, old.fills[0].previousHash);
  const followup = acceptance(bonding, 'owner-third-identical-body');
  assert.equal(readBondingSaleState(followup.before.dataBoc!).contributions.get(bonding.accounts.owner)!.paymentAmountRaw, '1000000000');
});
test('auction: repeated bids retain a single limit price and add exact commitment/quantity/fill', () => {
  for (const intent of auction.intents.filter(i => i.expectedAcceptance)) {
    const b = acceptance(auction, intent.phase), before = readAuctionSaleState(b.before.dataBoc!), after = readAuctionSaleState(b.after.dataBoc!);
    const old = before.bids.get(intent.requester), added = after.bids.get(intent.requester)!;
    assert.equal(BigInt(added.commitmentRaw) - BigInt(old?.commitmentRaw ?? '0'), BigInt(intent.amountRaw));
    assert.equal(BigInt(added.quantityRaw) - BigInt(old?.quantityRaw ?? '0'), 1n);
    assert.equal(added.fills[0].paymentAmountRaw, intent.amountRaw); assert.equal(added.fills[0].tokenAmountRaw, '1');
    assert.equal(added.fills[0].previousHash, old?.fills.length ? old.fillsHash : null); assert.deepEqual(added.fills.slice(1), old?.fills ?? []);
    if (old) assert.equal(added.maxPriceRaw, old.maxPriceRaw);
    assert.equal(after.metrics.distributedQuantityRaw, '0'); assert.equal(after.metrics.clearingQuantityRaw, '0');
    for (const [owner, entry] of before.bids) if (owner !== intent.requester) assert.deepEqual(after.bids.get(owner), entry);
  }
  const b = boundaries(auction, 'owner-claim')[0], before = readAuctionSaleState(b.before.dataBoc!), after = readAuctionSaleState(b.after.dataBoc!);
  assert.equal(before.bids.get(auction.accounts.owner)!.commitmentRaw, '4000000000'); assert.equal(before.metrics.clearingPriceRaw, '1000000000');
  assert.equal(after.metrics.distributedQuantityRaw, '2'); assert.equal(BigInt(after.metrics.totalRefundedRaw) - BigInt(before.metrics.totalRefundedRaw), 2000000000n);
});

const specimen = readBondingSaleState(acceptance(bonding, 'owner-first').after.dataBoc!).journal.entries.values().next().value!;
function sharedRecord(changes: Partial<Omit<LaunchpadSharedSettlement, 'status' | 'kind'>> & { status?: number; kind?: number } = {}) {
  const r = { ...specimen, ...changes };
  return beginCell().storeUint(BigInt(r.settlementId), 64).storeUint(BigInt(`0x${r.requestHash}`), 256).storeCoins(BigInt(r.amountRaw)).storeCoins(BigInt(r.forwardTonAmountRaw))
    .storeUint(r.route, 8).storeUint(r.kind, 8).storeUint(r.status, 8).storeUint(r.deployRequired, 8).storeCoins(BigInt(r.deliveryReservedRaw)).storeCoins(BigInt(r.finalizeReservedRaw))
    .storeUint(BigInt(r.predecessorId), 64).storeInt(BigInt(r.recordedAt), 64).storeRef(beginCell().storeAddress(A(r.tokenRoot)).storeAddress(A(r.sourceWallet)).endCell())
    .storeRef(beginCell().storeAddress(A(r.destinationWallet)).storeAddress(A(r.recipientOwner)).endCell()).storeRef(Cell.fromBase64(r.forwardPayloadBoc)).endCell();
}
test('shared settlement parser preserves complete records and raw FINAL/negative states without claiming payment', () => {
  assert.deepEqual(readLaunchpadSharedSettlement(sharedRecord()), specimen);
  for (const status of [1, 2, 3, 4, 5, 6]) { const r = readLaunchpadSharedSettlement(sharedRecord({ status })); assert.equal(r.status, status); assert.equal('paid' in r, false); }
  for (const status of [0, 7, 255]) assert.throws(() => readLaunchpadSharedSettlement(sharedRecord({ status })));
  for (const kind of [0, 11, 255]) assert.throws(() => readLaunchpadSharedSettlement(sharedRecord({ kind })));
  assert.throws(() => readFixedSaleSettlementRecord(sharedRecord()));
  assert.throws(() => readLaunchpadSharedSettlement(sharedRecord({ predecessorId: specimen.settlementId })));
});
test('shared journal rejects key conflicts and trailing state', () => {
  const env = readLaunchpadEnvelope(acceptance(bonding, 'owner-first').after.dataBoc!), journal = env.stateCell.refs[3];
  assert(readLaunchpadSharedJournal(journal).entries.size > 0);
  const s = journal.beginParse(), d = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  d.set(1n, sharedRecord({ settlementId: '2' }));
  assert.throws(() => readLaunchpadSharedJournal(beginCell().storeDict(d).storeSlice(s).endCell()), /key mismatch/);
  assert.throws(() => readLaunchpadSharedJournal(beginCell().storeSlice(journal.beginParse()).storeBit(1).endCell()), /Trailing/);
});
test('current fill parser rejects zero malformed trailing and noncanonical empty-predecessor lists', () => {
  const good = beginCell().storeCoins(1).storeCoins(3).endCell(); assert.equal(readLaunchpadFills(good).fills[0].paymentAmountRaw, '3');
  for (const bad of [beginCell().storeCoins(0).storeCoins(3).endCell(), beginCell().storeCoins(1).storeCoins(0).endCell(),
    beginCell().storeSlice(good.beginParse()).storeBit(1).endCell(), beginCell().storeSlice(good.beginParse()).storeRef(Cell.EMPTY).endCell(),
    beginCell().storeSlice(good.beginParse()).storeRef(good).storeRef(good).endCell()]) assert.throws(() => readLaunchpadFills(bad));
});
test('all current model roots reject trailing or older routing shape and unknown model kinds', () => {
  for (const f of fixtures) {
    const root = Cell.fromBase64(acceptance(f, 'owner-first').after.dataBoc!);
    assert.throws(() => read(f, boc(beginCell().storeSlice(root.beginParse()).storeBit(1).endCell())));
    assert.throws(() => read(f, boc(replaceRef(root, 1, beginCell().storeSlice(root.refs[1].beginParse()).storeRef(Cell.EMPTY).endCell()))));
    const cfg = root.refs[2], s = cfg.beginParse(); s.skip(8);
    assert.throws(() => read(f, boc(replaceRef(root, 2, beginCell().storeUint(255, 8).storeSlice(s).endCell()))), /Unsupported/);
    assert.throws(() => read(f, 'not-a-boc'));
    assert.throws(() => read(f, boc(Cell.EMPTY)));
  }
});
test('common registry/routing preserve exact identities and reject malformed flags or omitted wallet code', () => {
  const root = Cell.fromBase64(acceptance(bonding, 'owner-first').after.dataBoc!);
  assert.equal(readLaunchpadRegistry(root.refs[0]).owner, bonding.accounts.creator);
  const routing = root.refs[1].refs[0]; assert.equal(readLaunchpadRouting(routing).wallet, bonding.accounts.paymentSaleWallet);
  assert.throws(() => readLaunchpadRouting(replaceRef(routing, 0, Cell.EMPTY)), /code unavailable/);
  assert.throws(() => readLaunchpadRegistry(beginCell().storeAddress(A(bonding.accounts.creator)).storeUint(2, 8).storeUint(0, 8).storeRef(Cell.EMPTY).endCell()), /flag/);
});
test('PBID canonical wire parses exact price/quantity and rejects truncation trailing fields and opcode conflicts', () => {
  const tx = auction.transactions.find(t => t.account === auction.accounts.ownerPaymentWallet && t.phase === 'owner-first' && t.raw.inMessage?.op === LAUNCHPAD_TRANSFER)!;
  const forward = tokenWire(tx.raw.inMessage)!.forward, parsed = launchpadCommand(message(forward))!;
  assert.equal(parsed.kind, 'bid'); assert('maxPriceRaw' in parsed && parsed.maxPriceRaw === '2000000000'); assert('quantityRaw' in parsed && parsed.quantityRaw === '1');
  assert.equal(parsed.queryId, '101');
  assert.equal(launchpadCommand(message(beginCell().storeUint(LAUNCHPAD_BID, 32).storeUint(101, 64).endCell())), null);
  assert.equal(launchpadCommand(message(beginCell().storeSlice(forward.beginParse()).storeBit(1).endCell())), null);
  assert.equal(launchpadCommand({ ...message(forward), op: 1 }), null);
});
console.log(`${passed} Launchpad model state/wire tests passed with 292 authentic transactions; no live-chain claim.`);
