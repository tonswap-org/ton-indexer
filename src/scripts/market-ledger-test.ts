import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectDlmmMarket } from '../ledger/marketProjection';
import { readDlmmMarketState } from '../ledger/dlmmState';
import type { DlmmMarketBinding, MarketNode, MarketDependency } from '../ledger/marketTypes';

function fixtureInput(name: string) {
const fixture = JSON.parse(readFileSync(`${__dirname}/fixtures/${name}`, 'utf8'));
const binding: DlmmMarketBinding = { network: 'localnet', pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX, tokenTCodeHash:fixture.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash, tokenXCodeHash:fixture.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash,
  poolCodeHash: fixture.compiler.find((entry: any) => entry.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
  walletCodeHash: fixture.compiler.find((entry: any) => entry.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash };
const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
  const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
  return { account: entry.account, raw: entry.raw, before: { seqno: 0, state: { ...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState } }, after: { seqno: 0, state: boundary.after } };
});
return { fixture, binding, nodes };
}
const { binding, nodes } = fixtureInput('dlmm-market-settlements.json');
const project = (input: MarketNode[] = nodes) => projectDlmmMarket(binding, input, []);
const result = project();
assert.equal(result.candidates.length, 6);
assert.equal(result.observations.length, 5);
assert.deepEqual(result.observations.map(value => [value.paidInputRaw, value.returnedInputRaw, value.consumedInputRaw, value.outputRaw]), [
  ['10000', '0', '10000', '9997'], ['15000', '0', '15000', '14995'], ['10000', '0', '10000', '9997'],
  ['12000', '0', '12000', '11996'], ['2000000', '1016699', '983301', '983006'],
]);
assert.equal(result.candidates.filter(value => value.status === 'refunded').length, 1);
assert.equal(result.historyComplete, false);
assert.equal(new Set(result.observations.map(value => value.id)).size, 5);
assert.notEqual(result.observations[0].payer, result.observations[0].recipient);
assert.deepEqual(result.observations.at(-1)!.ratio, { numerator: '983006', denominator: '983301', unit: 'output_atomic_per_input_atomic', includesTradingFees: true });
assert.deepEqual(project([...nodes].reverse()), result);
const duplicate = project([...nodes, nodes[60]]);
assert.equal(duplicate.observations.length, 0);
assert.ok(duplicate.issues.includes('market_duplicate_or_conflicting_transaction'));
const priorToRecovery = project(nodes.filter(node => BigInt(node.raw.lt) < 110000000n));
assert.equal(priorToRecovery.observations.length, 3);
assert.equal(priorToRecovery.candidates.at(-1)!.status, 'unresolved');
const noArchives = project(nodes.map(node => ({ ...node, before: null, after: null })));
assert.equal(noArchives.observations.length, 0);
assert.ok(noArchives.candidates.every(value => value.issues.includes('market_archive_missing')));
const pool = nodes.find(node => node.account === binding.pool && node.raw.lt === '60000000')!;
assert.equal(readDlmmMarketState(pool.after!.state.dataBoc!).settlements.size, 1);
const heads = new Map<string, MarketNode>();
for (const node of nodes) if (!heads.has(node.account) || BigInt(heads.get(node.account)!.raw.lt) < BigInt(node.raw.lt)) heads.set(node.account, node);
const dependencies: MarketDependency[] = [...heads].map(([account, head]) => ({ account, generation: '00000000-0000-4000-8000-000000000001',
  historyComplete: true, headLt: head.raw.lt, headHash: head.raw.hash, checkedThrough: new Date((head.raw.utime + 60) * 1000).toISOString() }));
assert.equal(projectDlmmMarket(binding, nodes, dependencies).historyComplete, true);
const missingNotice = structuredClone(nodes); delete missingNotice.find(node => node.account === binding.pool && node.raw.lt === '60000000')!.raw.inMessage!.body;
const damaged = projectDlmmMarket(binding, missingNotice, dependencies);
assert.equal(damaged.historyComplete, false); assert.equal(damaged.observations.length, 4); assert.ok(damaged.issues.includes('market_pool_notification_undecodable'));
delete missingNotice.find(node => node.account === binding.pool && node.raw.lt === '60000000')!.raw.inMessage!.op;
const missingEnvelope = projectDlmmMarket(binding, missingNotice, dependencies);
assert.equal(missingEnvelope.historyComplete, false); assert.equal(missingEnvelope.observations.length, 4); assert.ok(missingEnvelope.issues.includes('market_pool_input_undecodable'));
const staleCoverage = dependencies.map(dependency => ({ ...dependency, checkedThrough: '2020-01-01T00:00:00.000Z' }));
assert.equal(projectDlmmMarket(binding, nodes, staleCoverage).historyComplete, false);
for (const label of ['missing input original', 'missing recipient credit', 'missing finalization', 'wrong historical code', 'wrong created LT', 'wrong boundary identity']) {
  let input = structuredClone(nodes);
  const execution = result.observations[1], settlement = execution.settlements[0];
  const matches = (node: MarketNode, target: { account: string; lt: string }) => node.account === target.account && node.raw.lt === target.lt;
  if (label === 'missing input original') input = input.filter(node => !matches(node, execution.input.request));
  if (label === 'missing recipient credit') input = input.filter(node => !matches(node, settlement.credit));
  if (label === 'missing finalization') input = input.filter(node => !matches(node, settlement.poolFinalized));
  if (label === 'wrong historical code') input.find(node => matches(node, settlement.credit))!.after!.state.codeBoc = input.find(node => node.account === binding.pool && node.after?.state.codeBoc)!.after!.state.codeBoc;
  if (label === 'wrong created LT') input.find(node => matches(node, settlement.credit))!.raw.inMessage!.createdLt = '1';
  if (label === 'wrong boundary identity') input.find(node => matches(node, settlement.credit))!.after!.state.lastTxHash = '0'.repeat(64);
  const altered = project(input); assert.ok(!altered.observations.some(value => value.id === execution.id), label);
  assert.ok(altered.observations.length >= 3, `${label} keeps independent valid observations`);
}
const queued = fixtureInput('dlmm-market-queued-settlements.json'), queueResult = projectDlmmMarket(queued.binding, queued.nodes, []);
assert.equal(queueResult.observations.length, 3, JSON.stringify(queueResult.candidates));
assert.deepEqual(queueResult.observations.map(value => value.outputRaw), ['9997', '19994', '9997']);
assert.ok(queueResult.observations[1].settlements[0].request.lt !== queueResult.observations[1].acceptance.lt, 'queued output dispatch follows its original acceptance');
assert.equal(queueResult.observations[1].settlements[0].request.lt, queueResult.observations[0].settlements[0].poolFinalized.lt, 'prior JSFK dispatches next head');
assert.equal(BigInt(queueResult.observations[2].settlements[0].settlementId), BigInt(queueResult.observations[2].businessQueryId) + 1n, 'allocator skips the business query ID');
assert.ok(queueResult.observations[0].settlements[0].boundaries.some(value => value.beforeAccountState === 'uninitialized' && value.beforeDataHash === null), 'prefunded uninitialized beneficiary receives its first jetton credit');
assert.deepEqual(projectDlmmMarket(queued.binding, [...queued.nodes].reverse(), []), queueResult);
console.log('DLMM market ledger authentic execution tests passed');
