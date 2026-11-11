import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Cell, Dictionary, beginCell} from '@ton/core';
import {readDlmmMarketState} from '../ledger/dlmmState';
import {readDlmmDirectSwaps} from '../ledger/dlmmDirectSwapState';
import {createDlmmProofGraph} from '../ledger/dlmmProof';
import type {MarketNode} from '../ledger/marketTypes';

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/dlmm-referral-market-current/dlmm-negative-ready-rotation.json'), 'utf8'));
const binding = {router: null, routerCodeHash: null, network: 'localnet' as const, pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX,
  poolCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
  walletCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash};
const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
  const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
  return {account: entry.account, raw: entry.raw, before: {seqno: 0, state: {...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState}}, after: {seqno: 0, state: boundary.after}};
});
const replaceRef = (parent: Cell, index: number, child: Cell) => {
  const b = beginCell().storeBits(parent.bits); parent.refs.forEach((ref, i) => b.storeRef(i === index ? child : ref)); return b.endCell();
};
const products = (boc: string) => Cell.fromBase64(boc).refs[3].refs[1].refs[3].refs[3];
const replaceProducts = (boc: string, product: Cell) => {
  const root = Cell.fromBase64(boc), meta = root.refs[3], position = meta.refs[1], journal = position.refs[3];
  return replaceRef(root, 3, replaceRef(meta, 1, replaceRef(position, 3, replaceRef(journal, 3, product)))).toBoc().toString('base64');
};
function editStore(cell: Cell, edit: (receipts: Dictionary<bigint, Cell>, index: Dictionary<bigint, bigint>) => void) {
  const s = cell.beginParse(), receipts = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), index = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.BigUint(256));
  edit(receipts, index); return beginCell().storeDict(receipts).storeDict(index).endCell();
}
let activeChecked = false, completedChecked = false, rotatedChecked = false, poolKeyChecked = false;
for (const node of nodes.filter(node => node.account === binding.pool && node.after?.state.dataBoc)) {
  const boc = node.after!.state.dataBoc!, state = readDlmmMarketState(boc);
  if (state.storageForm !== 'persisted') continue;
  const product = products(boc), store = product.refs[2];
  const parse = (changed: Cell) => readDlmmDirectSwaps(changed, BigInt(state.nextSettlementId), state.settlements);
  assert.equal(product.bits.length, 16); assert.equal(product.refs.length, 3);
  for (const receipt of state.directSwaps.receipts.values()) {
    const notice = nodes.find(candidate => candidate.account === binding.pool && candidate.raw.inMessage?.createdLt === receipt.notificationCreatedLt &&
      candidate.raw.inMessage.source === receipt.notificationSender && candidate.raw.inMessage.body && Cell.fromBase64(candidate.raw.inMessage.body).hash().toString('hex') === receipt.notificationBodyHash);
    assert.ok(notice, 'permanent receipt retains the exact original physical notification');
    for (const leg of [receipt.refund, receipt.output]) {
      if (leg.amountRaw === '0') continue;
      if (!leg.done && !activeChecked) {
        activeChecked = true;
        assert.throws(() => parse(editStore(store, (_receipts, index) => {index.delete(BigInt(leg.currentId));})), /index_invalid/);
        assert.throws(() => parse(editStore(store, (_receipts, index) => {index.set(BigInt(leg.currentId), 1n);})), /index_invalid/);
      }
      if (leg.done && !completedChecked) {
        completedChecked = true;
        assert.equal(state.settlements.has(leg.currentId), false, 'positive finality prunes active record but preserves immutable receipt');
        const legIndex = leg === receipt.refund ? 1 : 2;
        assert.throws(() => parse(editStore(store, (receipts) => {
          const key = BigInt('0x' + receipt.key), old = receipts.get(key)!, oldLeg = old.refs[legIndex];
          receipts.set(key, replaceRef(old, legIndex, replaceRef(oldLeg, 0, beginCell().storeDict(null).endCell())));
        })), /initial_wire_missing/);
      }
      if ([...leg.wires.values()].some(wire => wire.disposition === 1) && !rotatedChecked) {
        rotatedChecked = true;
        const first = [...leg.wires.values()].find(wire => wire.disposition === 1)!; assert.equal(first.disposition, 1);
        assert.ok(BigInt(leg.currentId) > BigInt(leg.initialId));
        const legIndex = leg === receipt.refund ? 1 : 2;
        for (const disposition of [0, 3, 4]) assert.throws(() => parse(editStore(store, (receipts) => {
          const key = BigInt('0x' + receipt.key), old = receipts.get(key)!, oldLeg = old.refs[legIndex];
          const wires = Dictionary.load(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell(), oldLeg.refs[0]);
          wires.set(BigInt(first.id), beginCell().storeUint(BigInt(first.predecessorId), 64).storeUint(BigInt(first.successorId), 64).storeUint(disposition, 8).storeRef(first.body).endCell());
          receipts.set(key, replaceRef(old, legIndex, replaceRef(oldLeg, 0, beginCell().storeDict(wires).endCell())));
        })), /replacement_invalid|wire_fields_invalid/);
      }
    }
  }
  if (!poolKeyChecked && state.directSwaps.receipts.size) {
    poolKeyChecked = true;
    const graph = createDlmmProofGraph(binding, nodes); graph.poolAt(node);
    const changed = structuredClone(node), receipt = state.directSwaps.receipts.values().next().value!;
    const altered = editStore(store, (receipts, index) => {
      const old = BigInt('0x' + receipt.key), value = receipts.get(old)!; receipts.delete(old); receipts.set(1n, value);
      for (const [id, key] of index) if (key === old) index.set(id, 1n);
    });
    changed.after!.state.dataBoc = replaceProducts(boc, replaceRef(product, 2, altered));
    assert.throws(() => createDlmmProofGraph(binding, nodes.map(value => value === node ? changed : value)).poolAt(changed), /receipt_identity_invalid/);
    const oldProducts = beginCell().storeBits(product.bits).storeRef(product.refs[0]).storeRef(product.refs[1]).endCell();
    assert.throws(() => readDlmmMarketState(replaceProducts(boc, oldProducts)), /products_layout_invalid/);
  }
}
assert.ok(activeChecked && completedChecked && rotatedChecked && poolKeyChecked, 'actual fixtures cover active, completed and never-admitted replacement receipts');
console.log('PASS exact direct-swap receipts, current products, live index, permanent finality and adversarial wire lineage');
