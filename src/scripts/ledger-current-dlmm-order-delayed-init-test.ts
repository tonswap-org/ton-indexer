import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCurrentDlmmOrders, readCurrentDlmmOrderCreations } from '../ledger/currentDlmmOrderProof';
import { verifyCurrentT3Transaction } from '../ledger/currentDlmmPhysical';
import { currentDlmmFixtureBinding } from './support/currentDlmmFixture';
import { currentOrderDelayedInitFixture } from './support/currentOrderDelayedInitFixture';

const folder = process.argv[2];
const cases = folder ? readdirSync(folder).filter(file => file.endsWith('.json')).map(file => ({ file, ...JSON.parse(readFileSync(join(folder, file), 'utf8')) }))
  : [...currentOrderDelayedInitFixture().cases()].map(row => ({ file: row.file, ...row.capture }));
assert.equal(cases.length, 8);
for (const c of cases) {
  const binding = currentDlmmFixtureBinding(c), originals = c.completeTransactions;
  const select = (rows: typeof originals) => decodeCurrentDlmmOrders(c.original.wallet, binding, rows).find(order => order.economics.order?.address === c.original.order);
  const selected = select(originals); assert(selected, c.file);
  const e = selected.economics;
  assert.equal(e.outcome, c.mode === 'filled' ? 'delivered' : 'refunded', c.file);
  assert.equal(e.order!.fundedInRaw, c.expected.funded); assert.equal(e.order!.consumedInRaw, c.expected.consumed);
  assert.equal(e.order!.receivedOutRaw, c.expected.received); assert.equal(e.order!.refundedInRaw, c.expected.refunded);
  assert.equal(e.order!.executedSlices, c.expected.slices); assert.equal(e.grossFeeT3Raw, c.expected.grossFeeT3);
  assert.equal(e.protocolFeeT3Raw, c.expected.protocolFeeT3); assert.equal(e.paidInRaw, c.expected.funded);
  assert.equal(e.pendingOutT3Raw, '0'); assert.equal(e.pendingOutXRaw, '0');
  assert.equal(e.cash.filter(leg => leg.direction === 'out').length, 1);
  assert.equal(e.cash.filter(leg => leg.direction === 'in').length, c.expected.slices + (c.mode === 'filled' ? 0 : 1));
  const parsed = originals.map(verifyCurrentT3Transaction);
  const credit = parsed.find((tx: any) => tx.hash === c.creditBeforeInit.creditHash), child = parsed.find((tx: any) => tx.hash === c.creditBeforeInit.childHash);
  assert(credit && child); assert(credit.tx.lt < child.tx.lt, 'Original physical credit precedes original order initialization');
  const creation = readCurrentDlmmOrderCreations(c.original.wallet, binding, originals).find(row => row.order === c.original.order);
  assert(creation); assert.equal(creation.childHash, child.hash);
  const create = c.actions.find((action: any) => action.kind === 'create'), fund = c.actions.find((action: any) => action.kind === 'fund');
  assert(create && fund); assert.equal(create.ownerDispatch.hash, fund.ownerDispatch.hash, 'One original owner wallet transaction emitted both messages');
  const without = (hash: string) => originals.filter((row: any) => verifyCurrentT3Transaction(row).hash !== hash);
  assert.equal(select(without(create.ownerDispatch.hash)), undefined, 'Both authorities need the original owner transaction');
  assert.equal(select(without(child.hash)), undefined, 'Canonical child initialization remains mandatory');
  assert.equal(select(without(credit.hash))?.economics.outcome, 'unresolved', 'Missing actual funding credit remains unresolved');
  const incoming = e.cash.find(leg => leg.direction === 'in'); assert(incoming);
  assert.equal(select(without(incoming.creditTransaction))?.economics.outcome, 'unresolved', 'No cash from output dispatch alone');
  console.log(c.file, e.outcome, 'original credit-before-init verified');
}
console.log('Current Order: all 8 source-bound native credit-before-init cases and original-authority/cash omissions passed.');
