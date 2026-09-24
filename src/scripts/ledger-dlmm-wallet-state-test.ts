import { writeCurrentJettonWalletStorage } from "../ledger/jettonWalletState";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, beginCell } from '@ton/core';
import { readT3RecoveryWallet } from '../ledger/t3RecoveryState';
import { perpsWalletAddress } from '../ledger/perpsWire';

type Message = { op?: number; source?: string; destination?: string; body: string };
type Transaction = { phase: string; account: string; raw: { lt: string; hash: string; success: boolean; inMessage?: Message; outMessages: Message[] } };
type State = { codeBoc: string | null; dataBoc: string | null };
type Boundary = { phase: string; account: string; transactionLt: string; transactionHash: string; before: State; after: State };
type Fixture = {
  accounts: { pool: string; lp: string; payer: string; otherPayer: string; recipient: string; tokenT: string; tokenX: string; wallets: Record<string, string[]> };
  compiler: { entrypointFileName: string; codeHash: string }[];
  transactions: Transaction[]; boundaries: Boundary[];
  intents: {phase:string;firstSettlementId:string;quote:{amountOut:string}}[];
};
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/dlmm-referral-market-current/dlmm-market-settlements.json'), 'utf8')) as Fixture;
const { accounts: a } = fixture;
const read = (s: State) => { assert(s.dataBoc); return readT3RecoveryWallet(s.dataBoc); };
const boundary = (t: Transaction) => {
  const b = fixture.boundaries.find(b => b.account === t.account && b.transactionLt === t.raw.lt && b.transactionHash === t.raw.hash);
  assert(b); return b;
};
const poolWallets = new Set(a.wallets.pool);
const sourceEvents = (opcode: number) => fixture.transactions.filter(t => poolWallets.has(t.account) && t.raw.inMessage?.op === opcode);
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);
const bodyTuple = (message: Message) => {
  const s = Cell.fromBase64(message.body).beginParse(); s.loadUint(32);
  return { queryId: s.loadUintBig(64).toString(), amountRaw: s.loadCoins().toString() };
};

test('all ten real wallet addresses derive from current unchanged code, root and owner', () => {
  const walletHash = fixture.compiler.find(c => c.entrypointFileName.endsWith('/jetton_wallet.tolk'))!.codeHash;
  const active = fixture.boundaries.find(b => b.account === a.wallets.pool[0] && b.after.codeBoc)!;
  const code = Cell.fromBase64(active.after.codeBoc!); assert.equal(code.hash().toString('hex'), walletHash);
  const owners: Record<string, string> = { pool: a.pool, lp: a.lp, payer: a.payer, other: a.otherPayer, recipient: a.recipient };
  let addresses = 0, states = 0;
  for (const [name, wallets] of Object.entries(a.wallets)) for (let side = 0; side < 2; side++) {
    const wallet = wallets[side], root = side === 0 ? a.tokenT : a.tokenX;
    assert.equal(perpsWalletAddress(code, root, owners[name]), wallet); addresses++;
    for (const b of fixture.boundaries.filter(b => b.account === wallet)) for (const snapshot of [b.before, b.after]) if (snapshot.dataBoc) {
      const state = read(snapshot); assert.equal(state.owner, owners[name]); assert.equal(state.root, root);
      assert.equal(Cell.fromBase64(snapshot.codeBoc!).hash().toString('hex'), walletHash);
      assert.equal(state.lockedFeesRaw, '0'); assert.equal(state.borrowedFeesRaw, '0'); states++;
    }
  }
  assert.equal(addresses, 10); assert.equal(states, 91);
});

test('seven authentic JSTT starts debit exact token amounts and replace only the permitted source tuple', () => {
  const starts = sourceEvents(0x0f8a7ea5); assert.equal(starts.length, 7);
  for (const t of starts) {
    assert(t.raw.success); const b = boundary(t), before = read(b.before), after = read(b.after), m = t.raw.inMessage!;
    const s = Cell.fromBase64(m.body).beginParse(); s.loadUint(32);
    const queryId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString(), destinationOwner = s.loadAddress().toRawString();
    assert.equal(s.loadAddress().toRawString(), a.pool); const marker = s.loadRef().beginParse(); assert.equal(marker.loadUint(32), 0x4a535454);
    assert.equal(marker.remainingBits, 0); assert.equal(marker.remainingRefs, 0);
    assert.equal(before.transfer.status, 0); assert.equal(after.transfer.status, 1); assert.equal(after.transfer.opcode, 0x4a534954);
    assert.equal(after.transfer.queryId, queryId); assert.equal(after.transfer.amountRaw, amountRaw);
    assert.equal(after.transfer.destination, perpsWalletAddress(Cell.fromBase64(b.after.codeBoc!), after.root, destinationOwner));
    assert.equal(BigInt(before.balanceRaw) - BigInt(after.balanceRaw), BigInt(amountRaw));
    assert.deepEqual(after.journal, before.journal, 'burn journal is independent of a token transfer');
    assert.equal(after.journal.status, 0);
  }
});

test('seven actual recipient JSAC receipts advance Sent to Accepted without a second debit', () => {
  const acks = sourceEvents(0x4a534143); assert.equal(acks.length, 7);
  for (const t of acks) {
    const b = boundary(t), before = read(b.before), after = read(b.after), tuple = bodyTuple(t.raw.inMessage!);
    assert.equal(t.raw.inMessage!.source, before.transfer.destination); assert(t.raw.success);
    assert.equal(before.transfer.status, 1); assert.equal(after.transfer.status, 2); assert.equal(after.transfer.opcode, 0x4a535543);
    assert.equal(after.transfer.queryId, tuple.queryId); assert.equal(after.transfer.amountRaw, tuple.amountRaw);
    assert.equal(after.balanceRaw, before.balanceRaw); assert.equal(after.transfer.destination, before.transfer.destination);
    assert.deepEqual(after.journal, before.journal);
    assert(t.raw.outMessages.some(m => m.op === 0x4a535543 && m.destination === a.pool));
  }
});

test('seven source finalizers retain None tombstones and never convert journal cleanup into another cash movement', () => {
  const finalizers = sourceEvents(0x4a53464e); assert.equal(finalizers.length, 7);
  for (const t of finalizers) {
    const b = boundary(t), before = read(b.before), after = read(b.after), tuple = bodyTuple(t.raw.inMessage!);
    assert.equal(t.raw.inMessage!.source, a.pool); assert.equal(before.transfer.status, 2); assert.equal(after.transfer.status, 0);
    assert.equal(after.transfer.opcode, 0); assert.equal(after.transfer.queryId, tuple.queryId); assert.equal(after.transfer.amountRaw, tuple.amountRaw);
    assert(after.transfer.destination); assert.equal(after.transfer.destination, before.transfer.destination);
    assert.equal(after.balanceRaw, before.balanceRaw); assert.deepEqual(after.journal, before.journal);
    assert(t.raw.outMessages.some(m => m.op === 0x4a53464b && m.destination === a.pool));
  }
});

test('seven real destination credits add their exact amounts while preserving unrelated transfer and burn state', () => {
  const credits = fixture.transactions.filter(t => t.raw.inMessage?.op === 0x4a534954); assert.equal(credits.length, 7);
  for (const t of credits) {
    assert(t.raw.success); const b = boundary(t), before = b.before.dataBoc ? read(b.before) : null, after = read(b.after), tuple = bodyTuple(t.raw.inMessage!);
    assert.equal(BigInt(after.balanceRaw) - BigInt(before?.balanceRaw ?? '0'), BigInt(tuple.amountRaw));
    if (before) { assert.deepEqual(after.transfer, before.transfer); assert.deepEqual(after.journal, before.journal); }
    else assert.deepEqual(after.transfer, { status: 0, queryId: '0', amountRaw: '0', destination: null, opcode: 0 });
    assert(t.raw.outMessages.some(m => m.op === 0x4a534143 && m.destination === t.raw.inMessage!.source));
  }
});

test('READY and a failed retry produce no transfer start; funded recovery consumes the existing wire once', () => {
  for (const phase of ['underfunded-output', 'retry-underfunded-failed']) {
    assert.equal(sourceEvents(0x0f8a7ea5).filter(t => t.phase === phase).length, 0);
    assert.equal(fixture.transactions.filter(t => t.phase === phase && t.raw.inMessage?.op === 0x4a534954).length, 0);
  }
  const recoveries = sourceEvents(0x0f8a7ea5).filter(t => t.phase === 'retry-output-recovery'); assert.equal(recoveries.length, 1);
  const state = read(boundary(recoveries[0]).after), intent = fixture.intents.find(row=>row.phase==='underfunded-output')!;
  assert.equal(state.transfer.queryId, intent.firstSettlementId, 'funded retry uses the original never-admitted wire'); assert.equal(state.transfer.amountRaw, '12000'); assert.equal(state.transfer.status, 1);
});

test('repeating a business request uses distinct source wires, including finalized tuple replacement', () => {
  const first = sourceEvents(0x0f8a7ea5).find(t => t.phase === 'full-t-to-x' && t.account === a.wallets.pool[1])!;
  const repeated = sourceEvents(0x0f8a7ea5).find(t => t.phase === 'repeat-business-query' && t.account === a.wallets.pool[1])!;
  const firstAfter = read(boundary(first).after), repeatedBefore = read(boundary(repeated).before), repeatedAfter = read(boundary(repeated).after);
  assert.equal(repeatedBefore.transfer.status, 0); assert.equal(repeatedBefore.transfer.queryId, firstAfter.transfer.queryId);
  assert.notEqual(repeatedAfter.transfer.queryId, firstAfter.transfer.queryId); assert.equal(repeatedAfter.transfer.status, 1);
});

/** Synthetic parser vectors only: they do not claim any on-chain receipt. */
const vector = (opcode: number, destination: string | null, burnStatus = 0) => writeCurrentJettonWalletStorage({
  owner: Address.parse(a.pool), root: Address.parse(a.tokenT), feeDelegate: destination ? Address.parse(destination) : null,
  balance: 123n, lockedFees: 4n, borrowedFees: 5n, lastBounceOpcode: opcode, lastBounceQueryId: 77n, lastBounceAmount: 88n,
  burnJournal: beginCell().storeUint(burnStatus, 8).storeUint(9, 64).storeCoins(10).storeUint(11, 256).storeAddress(Address.parse(a.payer)).endCell(),
  mintJournal: beginCell().storeUint(0, 8).storeUint(0, 64).storeUint(0, 64).storeCoins(0).storeUint(0, 256).endCell(),
  mintReceipts: null, referralNotifications: null,
});
for (const [name, opcode, destination, status] of [
  ['empty destination dominates opcode', 0x4a534954, null, 0],
  ['sent', 0x4a534954, a.wallets.recipient[1], 1],
  ['accepted', 0x4a535543, a.wallets.recipient[1], 2],
  ['bounced', 0x4a544246, a.wallets.recipient[1], 3],
  ['finalized tombstone', 0, a.wallets.recipient[1], 0],
  ['unrelated ordinary bounce opcode', 0x178d4519, a.wallets.recipient[1], 0],
] as const) test(`current getter mapping: ${name}`, () => {
  const state = readT3RecoveryWallet(vector(opcode, destination, 2).toBoc().toString('base64'));
  assert.deepEqual(state.transfer, { status, opcode, destination, queryId: '77', amountRaw: '88' });
  assert.equal(state.lockedFeesRaw, '4'); assert.equal(state.borrowedFeesRaw, '5');
  assert.deepEqual(state.journal, { status: 2, queryId: '9', amountRaw: '10', requestHash: 'b'.padStart(64, '0'), response: a.payer });
});

test('missing, truncated or trailing current tuple fields reject instead of fabricating None state', () => {
  const valid = vector(0x4a534954, a.wallets.recipient[1]);
  assert.throws(() => readT3RecoveryWallet(beginCell().storeCoins(123).storeAddress(Address.parse(a.pool)).storeAddress(Address.parse(a.tokenT)).endCell().toBoc().toString('base64')));
  assert.throws(() => readT3RecoveryWallet(beginCell().storeSlice(valid.beginParse()).storeBit(0).endCell().toBoc().toString('base64')));
  assert.throws(() => readT3RecoveryWallet(beginCell().storeBits(valid.bits).storeRef(valid.refs[0]).endCell().toBoc().toString('base64')));
});

for (const [name, run] of tests) { run(); console.log(`PASS ${name}`); }
console.log(`Passed ${tests.length} DLMM wallet-state tests`);
