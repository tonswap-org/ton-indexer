import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Cell, loadTransaction, beginCell} from '@ton/core';
import {projectDlmmMarket} from '../ledger/marketProjection';
import {createDlmmProofGraph} from '../ledger/dlmmProof';
import {verifyDlmmSwapExecution} from '../ledger/dlmmSwapProof';
import {tokenWire} from '../ledger/wire';
import {readDlmmMarketState} from '../ledger/dlmmState';
import type {MarketNode} from '../ledger/marketTypes';
const directory = resolve(__dirname, 'fixtures/dlmm-referral-market-current');
const bytes = readFileSync(resolve(directory, 'dlmm-negative-ready-rotation.json'));
const provenance = JSON.parse(readFileSync(resolve(directory, 'dlmm-negative-ready-rotation.provenance.json'), 'utf8'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256);
const fixture = JSON.parse(bytes.toString());
const binding = {router: null, routerCodeHash: null, network: 'localnet' as const, pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX,
  tokenTCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash,
  tokenXCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash,
  poolCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
  walletCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash};
assert.equal(binding.poolCodeHash, provenance.poolCodeHash);
const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
  const transaction = loadTransaction(Cell.fromBase64(entry.transactionBoc).beginParse());
  assert.equal(transaction.hash().toString('hex'), entry.raw.hash);
  const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
  assert.equal(transaction.stateUpdate.oldHash.toString('hex'), Cell.fromBase64(boundary.before.shardAccountBoc).refs[0].hash().toString('hex'));
  assert.equal(transaction.stateUpdate.newHash.toString('hex'), Cell.fromBase64(boundary.after.shardAccountBoc).refs[0].hash().toString('hex'));
  return {account: entry.account, raw: entry.raw, before: {seqno: 0, state: {...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState}}, after: {seqno: 0, state: boundary.after}};
});
const graph = createDlmmProofGraph(binding, nodes);
for (const node of nodes.filter(n => n.account === binding.pool && tokenWire(n.raw.inMessage)?.forward.beginParse().preloadUint(32) === 0x53574150)) {
  verifyDlmmSwapExecution(binding, graph, node);
}
const projection = projectDlmmMarket(binding, nodes, []);
assert.equal(projection.observations.length, 2, JSON.stringify(projection.candidates.map(value => ({status: value.status, issues: value.issues}))));
assert.deepEqual(projection.observations.map(value => value.outputRaw), ['10000', '11000']);
const recovered = projection.observations[0], payout = recovered.settlements[0];
const head = nodes.filter(node => node.account === binding.pool).at(-1)!;
const receipt = [...readDlmmMarketState(head.after!.state.dataBoc!).directSwaps.receipts.values()].find(value => value.businessQueryId === recovered.businessQueryId)!;
assert.deepEqual([...receipt.output.wires.values()].map(wire => wire.disposition), [2, 1, 3]);
assert.equal(receipt.output.currentId, payout.settlementId);
assert.equal(receipt.output.done, true);
assert.equal(new Set(projection.observations.map(value => value.id)).size, 2);
assert.deepEqual(projectDlmmMarket(binding, [...nodes].reverse(), []), projection);
const failure = nodes.find(node => node.raw.hash === fixture.failureInjection.transactionHash)!;
const restored = nodes.find(node => node.account === failure.raw.inMessage!.source && node.raw.inMessage?.bounced && node.raw.inMessage.source === failure.account)!;
const negativeAck = nodes.find(node => node.account === binding.pool && node.raw.inMessage?.op === 0x4a544246)!;
const negativeFinalizer = nodes.find(node => node.account === restored.account && node.raw.inMessage?.op === 0x4a53464e)!;
const replacement = nodes.find(node => node.account === binding.pool && node.raw.inMessage?.op === 0x4a53464b && BigInt(node.raw.lt) > BigInt(negativeFinalizer.raw.lt))!;
for (const [name, target] of [['failed recipient', failure], ['balance restoration', restored], ['negative acknowledgement', negativeAck],
  ['negative wallet finalizer', negativeFinalizer], ['replacement allocation', replacement]] as const) {
  for (const damage of ['missing transaction', 'missing before boundary', 'wrong after code'] as const) {
    let changed = structuredClone(nodes), node = changed.find(value => value.account === target.account && value.raw.lt === target.raw.lt)!;
    if (damage === 'missing transaction') changed = changed.filter(value => value !== node);
    if (damage === 'missing before boundary') node.before = null;
    if (damage === 'wrong after code') node.after!.state.codeBoc = beginCell().storeBit(1).endCell().toBoc().toString('base64');
    const result = projectDlmmMarket(binding, changed, []);
    assert.ok(!result.observations.some(value => value.id === recovered.id), `${name}: ${damage} must leave the recovered original unresolved`);
    assert.ok(result.observations.some(value => value.id === projection.observations[1].id), `${name}: ${damage} retains the independent delivered swap`);
  }
}
for (const damage of ['failure changed to success', 'forged bounce prefix']) {
  const changed = structuredClone(nodes);
  if (damage === 'failure changed to success') changed.find(node => node.raw.hash === failure.raw.hash)!.raw.success = true;
  else changed.find(node => node.raw.hash === restored.raw.hash)!.raw.inMessage!.body = beginCell().storeUint(0xffffffff, 32).storeUint(0, 256).endCell().toBoc().toString('base64');
  assert.ok(!projectDlmmMarket(binding, changed, []).observations.some(value => value.id === recovered.id), damage);
}
console.log('PASS actual negative finality -> READY rotation -> exact token delivery, with 17 missing/forged-evidence regressions');
