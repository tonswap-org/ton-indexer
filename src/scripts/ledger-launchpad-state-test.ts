import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadMessage, loadTransaction, type Builder } from '@ton/core';
import type { RawMessage, RawTransaction } from '../data/dataSource';
import { readFixedSaleState, readFixedSaleSettlementRecord, type FixedSaleSettlement } from '../ledger/launchpadState';
import * as w from '../ledger/launchpadWire';
import { tokenWire } from '../ledger/wire';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';

type Snapshot = { balance: string; lastTxLt: string; lastTxHash: string; accountState: string; codeBoc: string | null; dataBoc: string | null };
type Boundary = { phase: string; account: string; transactionLt: string; transactionHash: string; before: Snapshot; after: Snapshot };
// Original immutable fixture metadata used the SDK's old slot name. Production
// decoding reads its original BOC and exposes this TVM12+ slot as extraFlagsRaw.
type SavedMessage = RawMessage & { messageBoc: string; messageHash: string; ihrFeeRaw?: string };
type SavedTransaction = { phase: string; account: string; raw: RawTransaction & { inMessage?: SavedMessage; outMessages: SavedMessage[] }; transactionBoc: string };
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/launchpad-fixed-refund.json'), 'utf8')) as {
  schema: string; environment: string; originalTest: string; facts: Record<string,string>; accounts: Record<string, string>;
  transactions: SavedTransaction[]; boundaries: Boundary[];
  compiler: { entrypointFileName: string; codeHash: string }[];
  observations: { label: string; saleState: Record<string, string | boolean>; journal: Record<string, string>; settlement3: Record<string, unknown>; settlement4: Record<string, unknown> }[];
};
const a = fixture.accounts, A = (value: string) => Address.parse(value);
const saleBoundaries = fixture.boundaries.filter(b => b.account === a.sale && b.phase !== 'setup');
const getBoundary = (lt: string) => fixture.boundaries.find(b => b.transactionLt === lt)!;
const getTransaction = (lt: string) => fixture.transactions.find(t => t.raw.lt === lt)!;
const parse = (snapshot: Snapshot) => readFixedSaleState(snapshot.dataBoc!);
const refundWire = fixture.facts.refundWireId, escrowWire = fixture.facts.creatorEscrowWireId;
const findLt = (account: string, opcode: number, query?: string) => {
  const row = fixture.transactions.find(t => t.account === account && t.raw.inMessage?.op === opcode &&
    (query === undefined || Cell.fromBase64(t.raw.inMessage.body!).beginParse().skip(32).loadUintBig(64).toString() === query));
  assert(row); return row.raw.lt;
};
const claimLt = findLt(a.sale, w.LAUNCHPAD_CLAIM, '9'), deliveryLt = findLt(a.sale, w.LAUNCHPAD_SUCCEEDED, refundWire);
const finalLt = findLt(a.sale, w.LAUNCHPAD_FINALIZED, refundWire), debitLt = findLt(a.paymentSaleWallet, w.LAUNCHPAD_TRANSFER, refundWire);
const creditLt = findLt(a.ownerPaymentWallet, w.LAUNCHPAD_INTERNAL, refundWire), walletFinalLt = findLt(a.paymentSaleWallet, w.LAUNCHPAD_WALLET_FINALIZE, refundWire);
const claim = getBoundary(claimLt), delivered = getBoundary(deliveryLt), finalized = getBoundary(finalLt);
const initialRecord = parse(claim.after).journal.entries.get(refundWire)!;
const boc = (cell: Cell) => cell.toBoc().toString('base64');
const message = (cell: Cell): RawMessage => ({ body: boc(cell), op: cell.bits.length >= 32 ? cell.beginParse().loadUint(32) : undefined });
let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`ok ${passed} - ${name}`); }
function recordCell(change: Partial<Omit<FixedSaleSettlement, 'status' | 'route' | 'kind' | 'deployRequired'>> & { status?: number; route?: number; kind?: number; deployRequired?: number } = {}, extra?: (builder: Builder) => void) {
  const r = { ...initialRecord, ...change };
  const b = beginCell().storeUint(BigInt(r.referralOperationId), 64).storeUint(r.accountingAck,8).storeUint(BigInt(r.successorId),64).storeUint(BigInt(r.settlementId), 64).storeUint(BigInt(`0x${r.requestHash}`), 256)
    .storeCoins(BigInt(r.amountRaw)).storeCoins(BigInt(r.forwardTonAmountRaw)).storeUint(r.route, 8).storeUint(r.kind, 8)
    .storeUint(r.status, 8).storeUint(r.deployRequired, 8).storeCoins(BigInt(r.deliveryReservedRaw)).storeCoins(BigInt(r.finalizeReservedRaw))
    .storeUint(BigInt(r.predecessorId), 64).storeInt(BigInt(r.recordedAt), 64)
    .storeRef(beginCell().storeAddress(A(r.tokenRoot)).storeAddress(A(r.sourceWallet)).endCell())
    .storeRef(beginCell().storeAddress(A(r.destinationWallet)).storeAddress(A(r.recipientOwner)).endCell()).storeRef(Cell.fromBase64(r.forwardPayloadBoc));
  extra?.(b); return b.endCell();
}
function replaceRef(cell: Cell, index: number, replacement: Cell) {
  const builder = beginCell().storeBits(cell.bits);
  cell.refs.forEach((ref, i) => builder.storeRef(i === index ? replacement : ref));
  return builder.endCell();
}
function withJournal(change: (cell: Cell) => Cell) {
  const root = Cell.fromBase64(claim.after.dataBoc!), state = root.refs[3];
  return boc(replaceRef(root, 3, replaceRef(state, 3, change(state.refs[3]))));
}
function withRecord(record: Cell, key = BigInt(refundWire)) {
  return withJournal(cell => {
    const s = cell.beginParse(), dictionary = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
    dictionary.set(key, record);
    return beginCell().storeDict(dictionary).storeSlice(s).endCell();
  });
}
function wallet(snapshot: Snapshot) {
  const s = readCurrentJettonWalletStorage(Cell.fromBase64(snapshot.dataBoc!));
  const balance = s.balance, owner = s.owner.toRawString(), root = s.root.toRawString();
  const lastOpcode = s.lastBounceOpcode, queryId = s.lastBounceQueryId.toString(), amount = s.lastBounceAmount;
  return { balance, owner, root, lastOpcode, queryId, amount };
}

test('authentic untransformed fixed-sale refund has exact physical transaction and message identities', () => {
  assert.equal(fixture.schema, 'launchpad-fixed-sandbox-v1'); assert.equal(fixture.environment, 'sandbox-production-code');
  assert.equal(fixture.originalTest, 'tests/launchpad/LaunchpadFixedSale.spec.ts:1000-1091');
  assert(fixture.transactions.length > 50); assert.equal(fixture.boundaries.length, fixture.transactions.length);
  for (const saved of fixture.transactions) {
    const cell = Cell.fromBase64(saved.transactionBoc), raw = saved.raw, tx = loadTransaction(cell.beginParse());
    assert.equal(cell.hash().toString('hex'), raw.hash); assert.equal(tx.lt.toString(), raw.lt);
    assert.equal(tx.totalFees.coins.toString(), raw.totalFeesRaw); assert(BigInt(raw.totalFeesRaw!) > 0n);
    assert.equal(tx.prevTransactionLt.toString(), raw.prevTransactionLt);
    assert.equal(tx.prevTransactionHash.toString(16).padStart(64, '0'), raw.prevTransactionHash);
    const boundary = getBoundary(raw.lt); assert.equal(boundary.transactionHash, raw.hash); assert.equal(boundary.account, saved.account);
    assert.equal(boundary.before.lastTxLt, raw.prevTransactionLt); assert.equal(boundary.before.lastTxHash, raw.prevTransactionHash);
    assert.equal(boundary.after.lastTxLt, raw.lt); assert.equal(boundary.after.lastTxHash, raw.hash);
    for (const savedMessage of [raw.inMessage, ...raw.outMessages].filter(Boolean) as SavedMessage[]) {
      const full = Cell.fromBase64(savedMessage.messageBoc), msg = loadMessage(full.beginParse());
      assert.equal(full.hash().toString('hex'), savedMessage.messageHash);
      assert.equal(boc(msg.body), savedMessage.body);
      if (msg.info.type === 'internal') {
        assert.equal(msg.info.src.toRawString(), savedMessage.source); assert.equal(msg.info.dest.toRawString(), savedMessage.destination);
        assert.equal(msg.info.value.coins.toString(), savedMessage.value);
        assert.equal(msg.info.forwardFee.toString(), savedMessage.forwardFeeRaw);
        assert.equal(msg.info.ihrFee.toString(), savedMessage.ihrFeeRaw);
      }
    }
  }
});
test('strict current storage parses all 24 configured before/after boundaries with qualified code and routing', () => {
  assert(saleBoundaries.length > 8);
  for (const boundary of saleBoundaries) for (const snapshot of [boundary.before, boundary.after]) {
    const state = parse(snapshot);
    assert.equal(state.layout, 'fixed-v1'); assert.equal(state.registry.owner, a.creator); assert.equal(state.registry.factory, a.creator);
    assert.equal(state.registry.governance, a.creator); assert.equal(state.registry.enabled, 1);
    assert.equal(state.paymentRouting.tokenRoot, a.paymentRoot); assert.equal(state.paymentRouting.wallet, a.paymentSaleWallet);
    assert.equal(state.saleRouting.tokenRoot, a.saleRoot); assert.equal(state.saleRouting.wallet, a.saleWallet);
    assert.equal(Cell.fromBase64(snapshot.codeBoc!).hash().toString('hex'), fixture.compiler[0].codeHash);
    assert.equal(state.paymentRouting.walletCodeHash, fixture.compiler[2].codeHash);
    assert.equal(state.t3Root, a.paymentRoot); assert.equal(state.t3WalletCodeHash, state.paymentRouting.walletCodeHash);
    assert.equal(state.config.priceRaw, '1000000000000000000000000000'); assert.equal(state.config.softCapRaw, '10000000000');
    assert.equal(state.config.insuranceTargetRaw, '1000000000');
  }
});
test('parsed journal and metrics equal authentic wrapper getter observations after each phase', () => {
  for (const [phase, label] of [['contribution', 'after-contribution'], ['sale-finalize', 'after-sale-finalize'], ['refund-claim', 'after-refund-claim'], ['creator-escrow-retry', 'after-creator-escrow-retry']]) {
    const saved = saleBoundaries.filter(b => b.phase === phase).at(-1)!;
    const state = parse(saved.after), observed = fixture.observations.find(o => o.label === label)!;
    for (const key of ['totalRaised', 'totalSold', 'totalRefunded', 'totalFees', 'saleSupply', 'escrowBalance'])
      assert.equal(state.metrics[`${key}Raw` as keyof typeof state.metrics], observed.saleState[key]);
    for (const key of ['nextSettlementId', 'currentPaymentId', 'currentSaleId', 'tailPaymentId', 'tailSaleId'] as const)
      assert.equal(state.journal[key], observed.journal[key]);
    assert.equal(state.journal.reservedPaymentRaw, observed.journal.reservedPayment);
    assert.equal(state.journal.reservedSaleRaw, observed.journal.reservedSale);

  }
});
test('one admitted contribution reserves four project units without fabricating a token receipt', () => {
  const b = getBoundary(fixture.transactions.find(t => t.account === a.sale && t.phase === 'contribution' && t.raw.inMessage?.op === 0x7362d09c)!.raw.lt), before = parse(b.before), after = parse(b.after);
  assert.equal(before.contributions.size, 0);
  assert.deepEqual(after.contributions.get(a.owner), { paymentAmountRaw: '4000000000', tokenAmountRaw: '4', claimed: false, rewardWallet: a.owner, refundWallet: a.owner, feePaidRaw: '40000000', referrer: w.launchpadCommand(message(tokenWire(getTransaction(b.transactionLt).raw.inMessage)!.forward))?.referrer ?? null });
  assert.equal(after.metrics.totalRaisedRaw, '4000000000'); assert.equal(after.metrics.outstandingRaisedRaw, '4000000000');
  assert.equal(after.metrics.saleSupplyRaw, '20'); assert.equal(after.metrics.totalSoldRaw, '4');
  const ownerCredit = fixture.transactions.filter(t => t.phase === 'contribution' && t.account === a.ownerPaymentWallet && t.raw.inMessage?.op === w.LAUNCHPAD_TRANSFER);
  assert.equal(ownerCredit.length, 1); assert.equal(wallet(getBoundary(ownerCredit[0].raw.lt).after).balance, BigInt(fixture.facts.originalOwnerPaymentRaw) - 4000000000n);
});
test('failed claim changes exact entitlement and reserves refund separately from creator escrow', () => {
  const before = parse(claim.before), after = parse(claim.after);
  assert.equal(before.metrics.finalized, true); assert.equal(before.metrics.successful, false);
  assert.equal(before.contributions.get(a.owner)!.claimed, false); assert.equal(after.contributions.get(a.owner)!.claimed, true);
  assert.equal(after.contributions.get(a.owner)!.paymentAmountRaw, '0'); assert.equal(after.contributions.get(a.owner)!.tokenAmountRaw, '0');
  assert.equal(before.metrics.outstandingRaisedRaw, '4000000000'); assert.equal(after.metrics.outstandingRaisedRaw, '0');
  assert.equal(after.metrics.totalRefundedRaw, '4000000000'); assert.equal(after.journal.reservedPaymentRaw, '5000000000');
  assert.equal(initialRecord.kind, 3); assert.equal(initialRecord.state, 'in-flight'); assert.equal(initialRecord.amountRaw, '4000000000');
  assert.equal(initialRecord.recipientOwner, a.owner); assert.equal(initialRecord.destinationWallet, a.ownerPaymentWallet);
  const escrow = after.journal.entries.get(escrowWire)!;
  assert.equal(escrow.kind, 6); assert.equal(escrow.state, 'ready'); assert.equal(escrow.amountRaw, fixture.facts.creatorEscrowRaw);
  assert.equal(escrow.recipientOwner, a.creator); assert.equal(escrow.predecessorId, refundWire);
});
test('actual refund requires DELIVERED to FINAL with exact reserve decrease and physical accepted cash', () => {
  const deliveredBefore = parse(delivered.before), deliveredAfter = parse(delivered.after), before = parse(finalized.before), after = parse(finalized.after);
  assert.equal(deliveredBefore.journal.entries.get(refundWire)!.status, 2); assert.equal(deliveredAfter.journal.entries.get(refundWire)!.status, 3);
  assert.equal(deliveredBefore.journal.entries.get(refundWire)!.finalizeReservedRaw, '40000000');
  assert.equal(deliveredAfter.journal.entries.get(refundWire)!.finalizeReservedRaw, '0');
  assert.equal(before.journal.entries.get(refundWire)!.state, 'delivered'); assert.equal(after.journal.entries.get(refundWire)!.state, 'final');
  assert.equal(BigInt(before.journal.reservedPaymentRaw) - BigInt(after.journal.reservedPaymentRaw), 4000000000n);
  assert.equal(after.journal.reservedPaymentRaw, fixture.facts.creatorEscrowRaw); assert.equal(after.journal.currentPaymentId, escrowWire);
  const debit = getBoundary(debitLt), credit = getBoundary(creditLt), physicalFinal = getBoundary(walletFinalLt);
  assert.equal(wallet(debit.before).balance - wallet(debit.after).balance, 4000000000n);
  assert.equal(wallet(credit.after).balance - wallet(credit.before).balance, 4000000000n);
  assert.equal(wallet(credit.after).owner, a.owner); assert.equal(wallet(credit.after).root, a.paymentRoot);
  assert.equal(wallet(physicalFinal.before).lastOpcode, w.LAUNCHPAD_SUCCEEDED);
  assert.equal(wallet(physicalFinal.before).queryId, refundWire); assert.equal(wallet(physicalFinal.before).amount, 4000000000n);
  assert.equal(wallet(physicalFinal.after).lastOpcode, 0); assert.equal(wallet(physicalFinal.after).queryId, refundWire);
});
test('authentic transfer and all settlement callbacks retain exact query, amount and destination', () => {
  assert.equal(w.fixedSaleSettlementRequestHash(a.sale, initialRecord), initialRecord.requestHash);
  const transfer = w.launchpadSettlementTransfer(getTransaction(debitLt).raw.inMessage)!;
  assert.equal(transfer.bodyHash, initialRecord.requestHash); assert.equal(transfer.queryId, refundWire);
  assert.equal(transfer.amountRaw, '4000000000'); assert.equal(transfer.recipientOwner, a.owner); assert.equal(transfer.responseOwner, a.sale);
  const internal = w.launchpadInternalSettlementTransfer(getTransaction(creditLt).raw.inMessage)!;
  assert.equal(internal.fromOwner, a.sale); assert.equal(internal.responseWallet, a.paymentSaleWallet); assert.equal(internal.queryId, refundWire);
  assert.equal(internal.amountRaw, '4000000000'); assert.equal(internal.forwardPayloadHash, initialRecord.forwardPayloadHash);
  for (const [lt, kind] of [[findLt(a.paymentSaleWallet, w.LAUNCHPAD_ACCEPTED, refundWire), 'accepted'], [deliveryLt, 'succeeded'], [walletFinalLt, 'finalize'], [finalLt, 'finalized']]) {
    const tuple = w.launchpadSettlementTuple(getTransaction(lt).raw.inMessage)!;
    assert.equal(tuple.kind, kind); assert.equal(tuple.queryId, refundWire); assert.equal(tuple.amountRaw, '4000000000'); assert.equal(tuple.destination, a.ownerPaymentWallet);
  }
});
test('canonical contribution, finalize, claim and retry commands parse exact fields', () => {
  assert.deepEqual(w.launchpadCommand(message(beginCell().storeUint(w.LAUNCHPAD_CONTRIBUTE, 32).storeUint(7, 64).storeAddress(A(a.owner)).storeAddress(A(a.owner)).storeRef(beginCell().storeAddress(null).endCell()).endCell()))?.kind, 'contribute');
  const claim = w.launchpadCommand(getTransaction(claimLt).raw.inMessage)!;
  assert.equal(claim.kind, 'claim'); assert.equal(claim.queryId, '9'); assert('beneficiary' in claim && claim.beneficiary === null);
  assert.equal(w.launchpadCommand(getTransaction(findLt(a.sale, w.LAUNCHPAD_FINALIZE)).raw.inMessage)!.kind, 'finalize-sale');
  const retry = w.launchpadCommand(getTransaction(findLt(a.sale, w.LAUNCHPAD_RETRY, escrowWire)).raw.inMessage)!;
  assert.equal(retry.kind, 'retry'); assert('settlementId' in retry && retry.settlementId === escrowWire);
});
test('creator escrow and protocol fee settle once without increasing the participant refund', () => {
  const closing = parse(saleBoundaries.at(-1)!.after);
  assert.equal(closing.journal.reservedPaymentRaw, '0'); assert.equal(closing.metrics.totalRefundedRaw, '4000000000');
  assert.equal(closing.metrics.totalFeesRaw, '0'); assert.equal(closing.metrics.saleSupplyRaw, '0');
  const latest = (account: string) => fixture.boundaries.filter(b => b.account === account).at(-1)!.after;
  assert.equal(wallet(latest(a.ownerPaymentWallet)).balance, BigInt(fixture.facts.originalOwnerPaymentRaw));
  assert.equal(fixture.transactions.filter(t => t.account === a.protocolPaymentWallet && t.raw.inMessage?.op === w.LAUNCHPAD_INTERNAL).length, 0);
  const before = fixture.boundaries.find(b => b.account === a.creatorPaymentWallet && b.phase === 'refund-claim')!.before; assert.equal(wallet(latest(a.creatorPaymentWallet)).balance - wallet(before).balance, BigInt(fixture.facts.creatorEscrowRaw));
});
test('settlement cell roundtrip preserves every raw field and does not label FINAL as paid', () => {
  assert.deepEqual(readFixedSaleSettlementRecord(recordCell()), initialRecord);
  for (const status of [1, 2, 3, 4, 5, 6, 7]) {
    const parsed = readFixedSaleSettlementRecord(recordCell({ status })); assert.equal(parsed.status, status);
    assert.equal('paid' in parsed, false); assert.equal('confirmed' in parsed, false);
  }
  // This is a deliberately mutated negative vector, not a fabricated successful transaction.
  const negative = readFixedSaleSettlementRecord(recordCell({ status: 6 })), retired = readFixedSaleSettlementRecord(recordCell({ status: 5 }));
  assert.equal(negative.state, 'negative-finalized'); assert.equal(retired.state, 'final'); assert.equal(retired.amountRaw, negative.amountRaw);
});
test('unknown states routes kinds and deployment flags are rejected', () => {
  for (const status of [0, 8, 255]) assert.throws(() => readFixedSaleSettlementRecord(recordCell({ status })));
  for (const route of [0, 3, 255]) assert.throws(() => readFixedSaleSettlementRecord(recordCell({ route })));
  for (const kind of [0, 11, 255]) assert.throws(() => readFixedSaleSettlementRecord(recordCell({ kind })));
  for (const deployRequired of [2, 255]) assert.throws(() => readFixedSaleSettlementRecord(recordCell({ deployRequired })));
});
test('zero identities amounts and invalid predecessor ordering are rejected', () => {
  for (const change of [{ settlementId: '0' }, { amountRaw: '0' }, { predecessorId: refundWire }, { successorId: refundWire }])
    assert.throws(() => readFixedSaleSettlementRecord(recordCell(change)));
});
test('trailing record bits and references and shared journal layout are rejected', () => {
  assert.throws(() => readFixedSaleSettlementRecord(recordCell({}, b => b.storeBit(1))), /Trailing/);
  assert.throws(() => readFixedSaleSettlementRecord(recordCell({}, b => b.storeRef(Cell.EMPTY))), /reference/);
  const shared = replaceRef(recordCell(), 1, beginCell().storeAddress(A(a.ownerPaymentWallet)).storeAddress(A(a.owner)).storeBit(1).endCell());
  assert.throws(() => readFixedSaleSettlementRecord(shared), /Trailing/);
});
test('journal rejects mismatched keys next IDs and dangling route lanes', () => {
  assert.throws(() => readFixedSaleState(withRecord(recordCell({ settlementId: '999' }))), /key mismatch/);
  assert.throws(() => readFixedSaleState(withRecord(recordCell({ settlementId: '5' }), 5n)), /key mismatch/);
  assert.throws(() => readFixedSaleState(withJournal(cell => {
    const s = cell.beginParse(), d = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()); s.skip(64);
    return beginCell().storeDict(d).storeUint(0, 64).storeSlice(s).endCell();
  })), /next settlement/);
  assert.throws(() => readFixedSaleState(withJournal(cell => {
    const s = cell.beginParse(), d = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()), next = s.loadUintBig(64); s.skip(64);
    return beginCell().storeDict(d).storeUint(next, 64).storeUint(999, 64).storeSlice(s).endCell();
  })), /lane record mismatch/);
});
test('strict storage rejects root trailing data malformed BOC and missing current routing code', () => {
  const cell = Cell.fromBase64(claim.after.dataBoc!);
  assert.throws(() => readFixedSaleState(boc(beginCell().storeSlice(cell.beginParse()).storeBit(1).endCell())), /Trailing/);
  for (const invalid of ['', 'not-a-boc', boc(Cell.EMPTY)]) assert.throws(() => readFixedSaleState(invalid));
  const routing = cell.refs[1], payment = routing.refs[0];
  assert.throws(() => readFixedSaleState(boc(replaceRef(cell, 1, replaceRef(routing, 0, replaceRef(payment, 0, Cell.EMPTY))))), /code unavailable/);
});
test('strict wires reject missing mismatched and malformed bodies', () => {
  for (const parser of [w.launchpadCommand, w.launchpadSettlementTransfer, w.launchpadInternalSettlementTransfer, w.launchpadSettlementTuple]) {
    for (const invalid of [undefined, { body: 'not-a-boc' }, message(Cell.EMPTY), message(beginCell().storeUint(0x12345678, 32).endCell())]) assert.equal(parser(invalid), null);
  }
  for (const [parser, lt] of [[w.launchpadCommand, claimLt], [w.launchpadSettlementTransfer, debitLt], [w.launchpadInternalSettlementTransfer, creditLt], [w.launchpadSettlementTuple, deliveryLt]] as const) {
    const saved = getTransaction(lt).raw.inMessage!;
    assert.equal(parser({ ...saved, op: 1 }), null);
    const cell = Cell.fromBase64(saved.body!);
    assert.equal(parser(message(beginCell().storeSlice(cell.beginParse()).storeBit(1).endCell())), null);
    assert.equal(parser(message(beginCell().storeSlice(cell.beginParse()).storeRef(Cell.EMPTY).endCell())), null);
  }
});
test('transfer rejects noncanonical custom marker and tuples expose negative/replay without payment claims', () => {
  const transfer = Cell.fromBase64(getTransaction(debitLt).raw.inMessage!.body!);
  for (const marker of [Cell.EMPTY, beginCell().storeUint(w.LAUNCHPAD_SETTLEMENT_MARKER, 32).storeBit(0).endCell(), beginCell().storeUint(0x12345678, 32).endCell()])
    assert.equal(w.launchpadSettlementTransfer(message(replaceRef(transfer, 0, marker))), null);
  for (const [opcode, kind] of [[w.LAUNCHPAD_BOUNCED, 'bounced'], [w.LAUNCHPAD_REPLAY, 'replay']] as const) {
    const tuple = w.launchpadSettlementTuple(message(beginCell().storeUint(opcode, 32).storeUint(3, 64).storeCoins(4000000000n).storeAddress(A(a.ownerPaymentWallet)).endCell()))!;
    assert.equal(tuple.kind, kind); assert.equal('paid' in tuple, false);
  }
});
console.log(`${passed} Launchpad state/wire tests passed; authentic sandbox source, no live-chain claim.`);
