import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Address, beginCell, Cell, loadTransaction, storeTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import type { RawTransaction } from '../data/dataSource';
import { selectActivePoolCutoffHistory, type PoolCutoffHistoryRequest } from '../ledger/activePoolCutoffHistory';

// These are retained original local VM executions. Their original cells
// prove the account chain under test; they are not masterchain archive proofs.
const fixturePath = `${__dirname}/fixtures/dlmm-referral-market-current/dlmm-market-precision.json`;
const fixtureBytes = readFileSync(fixturePath);
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '3645f842f1aa5607d6d841b0cdfb85f4e089115e6615b072ed46e331a30740bb');
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const pool: string = fixture.accounts.pool;
const history: RawTransaction[] = fixture.transactions.filter((row: { account: string }) => row.account === pool)
  .map((row: { transactionBoc: string }) => decodeOriginalTransaction(Cell.fromBase64(row.transactionBoc), Address.parse(pool)))
  .sort((a: RawTransaction, b: RawTransaction) => BigInt(a.lt) < BigInt(b.lt) ? 1 : -1);
const head = history[0];
const iso = (utime: number) => new Date(utime * 1000).toISOString();
const requestAt = (cutoffUtime: number): PoolCutoffHistoryRequest => ({ pool,
  observedAt: iso(cutoffUtime + 86400), cutoffAt: iso(cutoffUtime), head: { lt: head.lt, hash: head.hash } });
let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const available = (request: PoolCutoffHistoryRequest, rows = history) => {
  const result = selectActivePoolCutoffHistory(request, rows);
  assert.equal(result.status, 'available', JSON.stringify(result));
  if (result.status !== 'available') throw Error('Expected a linked cutoff history');
  return result.evidence;
};
const unavailable = (request: PoolCutoffHistoryRequest, rows: RawTransaction[], issue: string) => {
  const result = selectActivePoolCutoffHistory(request, rows);
  assert.equal(result.status, 'unavailable');
  if (result.status !== 'unavailable') throw Error('Expected unavailable cutoff history');
  assert.equal(result.issue, issue);
};

check('an exact-cutoff transaction is included, including the last transaction within that chain second', () => {
  const evidence = available(requestAt(1789080020));
  assert.equal(evidence.applicable.lt, '82000000');
  assert.equal(evidence.applicable.utime, 1789080020);
  assert.equal(evidence.successor?.lt, '86000000');
  assert.equal(evidence.successor?.utime, 1789080030);
  assert.equal(evidence.applicableAt, '2026-09-10T22:40:20.000Z');
});
check('a boundary one second before the next transaction retains the earlier actual state', () => {
  const evidence = available(requestAt(1789080019));
  assert.equal(evidence.applicable.lt, '71000000');
  assert.equal(evidence.successor?.lt, '75000000');
});
check('a failed pool transaction remains a state boundary rather than being removed as non-trading activity', () => {
  const evidence = available(requestAt(1789080060));
  assert.equal(evidence.applicable.lt, '111000000');
  assert.equal(evidence.applicable.success, false);
  assert.equal(evidence.successor?.lt, '114000000');
});
check('an unchanged current account pointer establishes the selected chain state through the cutoff', () => {
  const evidence = available(requestAt(head.utime + 1), [head]);
  assert.equal(evidence.applicable.lt, head.lt);
  assert.equal(evidence.successor, null);
  assert.equal(evidence.intervening.length, 0);
  assert.equal(evidence.observedHead.lt, head.lt);
});
check('only the linked suffix needed to reach the cutoff is required', () => {
  const request = requestAt(1789080020);
  const index = history.findIndex(row => row.lt === '82000000');
  assert.deepEqual(available(request, history.slice(0, index + 1)), available(request));
});
check('source order never changes the canonical retained chain evidence', () => {
  assert.deepEqual(available(requestAt(1789080019), [...history].reverse()), available(requestAt(1789080019)));
});
check('mutable transaction summaries cannot move original cell timestamps across the cutoff', () => {
  const rows = structuredClone(history);
  rows.find(row => row.lt === '86000000')!.utime = 1789080019;
  const evidence = available(requestAt(1789080020), rows);
  assert.equal(evidence.applicable.lt, '82000000');
  assert.equal(evidence.successor?.utime, 1789080030);
});
check('a missing intervening transaction fails coverage rather than choosing an older snapshot', () => {
  unavailable(requestAt(1789080020), history.filter(row => row.lt !== '111000000'), 'pool_cutoff_history_gap');
});
check('a missing immediately following transaction fails cutoff applicability', () => {
  unavailable(requestAt(1789080020), history.filter(row => row.lt !== '86000000'), 'pool_cutoff_history_gap');
});
check('history stopping after the cutoff has no applicable state', () => {
  unavailable(requestAt(1789080019), history.filter(row => row.utime > 1789080019), 'pool_cutoff_state_uncovered');
});
check('a current pointer from another account generation fails closed', () => {
  unavailable({ ...requestAt(1789080020), head: { ...requestAt(1789080020).head, hash: '00'.repeat(32) } }, history, 'pool_cutoff_head_mismatch');
});
check('duplicate originals do not silently deduplicate coverage', () => {
  unavailable(requestAt(1789080020), [...history, history[3]], 'pool_cutoff_duplicate_transaction');
});
check('original cells from another account cannot establish pool coverage', () => {
  const foreign = fixture.transactions.find((row: { account: string }) => row.account !== pool);
  const raw = decodeOriginalTransaction(Cell.fromBase64(foreign.transactionBoc), Address.parse(foreign.account));
  unavailable(requestAt(1789080020), [raw, ...history], 'pool_cutoff_original_unavailable');
});
check('missing or changed original BOCs cannot be replaced by decoded transaction summaries', () => {
  const missing = structuredClone(history); delete missing[3].rawBoc;
  unavailable(requestAt(1789080020), missing, 'pool_cutoff_original_unavailable');
  const changed = structuredClone(history); changed[3].rawBoc = history[4].rawBoc;
  unavailable(requestAt(1789080020), changed, 'pool_cutoff_original_unavailable');
});
check('a future chain transaction cannot certify the current observation', () => {
  unavailable({ ...requestAt(1789080020), observedAt: iso(head.utime - 1), cutoffAt: iso(head.utime - 1 - 86400) }, history, 'pool_cutoff_future_transaction');
});
check('nonmonotonic original chain timestamps cannot be interpolated across the cutoff', () => {
  // Deliberately altered negative cells test structural refusal only. They are
  // never represented as authenticated native or network execution evidence.
  const older = loadTransaction(Cell.fromBase64(history[1].rawBoc!).beginParse());
  const newer = loadTransaction(Cell.fromBase64(history[0].rawBoc!).beginParse());
  older.now = newer.now + 1;
  const olderCell = beginCell().store(storeTransaction(older)).endCell();
  newer.prevTransactionHash = BigInt(`0x${olderCell.hash().toString('hex')}`);
  const newerCell = beginCell().store(storeTransaction(newer)).endCell();
  const rows = [newerCell, olderCell].map(cell => decodeOriginalTransaction(cell, Address.parse(pool)));
  const request = requestAt(head.utime - 1);
  request.head = { lt: rows[0].lt, hash: rows[0].hash };
  unavailable(request, rows, 'pool_cutoff_time_order_invalid');
});
check('the caller cannot move the exact 24-hour cutoff or supply a noncanonical time', () => {
  for (const change of [{ cutoffAt: iso(1789080021) }, { observedAt: '2026-09-12' },
    { cutoffAt: '2026-09-10T22:40:20Z' }, { observedAt: '2026-09-11T22:40:20.001Z' }]) {
    unavailable({ ...requestAt(1789080020), ...change }, history, 'pool_cutoff_request_invalid');
  }
});
check('empty history and absent canonical pointer never imply an unchanged state', () => {
  unavailable(requestAt(1789080020), [], 'pool_cutoff_state_uncovered');
  unavailable({ ...requestAt(1789080020), head: { lt: '0', hash: '00'.repeat(32) } }, history, 'pool_cutoff_request_invalid');
});
check('evidence preserves original cells, stable identity, exact cutoff and frozen nested values', () => {
  const request = requestAt(1789080020), before = JSON.stringify(history), evidence = available(request);
  assert.equal(JSON.stringify(history), before);
  assert.equal(evidence.schema, 'active-pool-cutoff-history-v1');
  assert.equal(evidence.proof, 'linked-original-account-transactions');
  assert.match(evidence.id, /^[a-f0-9]{64}$/);
  assert.equal(evidence.id, available(request).id);
  for (const value of [evidence, evidence.applicable, evidence.observedHead, evidence.successor, evidence.intervening, ...evidence.intervening]) assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(evidence.applicable.inMessage));
  assert.ok(Object.isFrozen(evidence.applicable.outMessages));
  for (const original of evidence.intervening) {
    assert.ok(Object.isFrozen(original.inMessage));
    assert.ok(Object.isFrozen(original.outMessages));
    for (const message of original.outMessages) assert.ok(Object.isFrozen(message));
  }
  assert.equal(Object.isFrozen(history), false);
  assert.equal(Object.isFrozen(history[0]), false);
  assert.equal(Object.isFrozen(history[0].outMessages), false);
  assert.notEqual(evidence.applicable, history.find(row => row.lt === evidence.applicable.lt));
  assert.ok(evidence.applicable.rawBoc);
  assert.notEqual(evidence.applicable.lt, evidence.observedHead.lt);
});
console.log(`Active pool cutoff history checks passed: ${checks}`);
