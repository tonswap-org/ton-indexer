import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginCell } from '@ton/core';
import { projectDlmmMarket } from '../ledger/marketProjection';
import { readDlmmMarketState } from '../ledger/dlmmState';
import type { DlmmMarketBinding, MarketNode, MarketDependency } from '../ledger/marketTypes';

function fixtureInput(name: string) {
const fixture = JSON.parse(readFileSync(`${__dirname}/fixtures/dlmm-referral-market-current/${name}`, 'utf8'));
const binding: DlmmMarketBinding = { router: null, routerCodeHash: null, network: 'localnet', pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX, tokenTCodeHash:fixture.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash, tokenXCodeHash:fixture.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash,
  poolCodeHash: fixture.compiler.find((entry: any) => entry.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
  walletCodeHash: fixture.compiler.find((entry: any) => entry.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash };
const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
  const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
  return { account: entry.account, raw: entry.raw, before: { seqno: 0, state: { ...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState } }, after: { seqno: 0, state: boundary.after } };
});
return { fixture, binding, nodes };
}
const { fixture, binding, nodes } = fixtureInput('dlmm-market-settlements.json');
const project = (input: MarketNode[] = nodes) => projectDlmmMarket(binding, input, []);
const result = project();
assert.equal(result.candidates.length, 6);
assert.equal(result.observations.length, 5);
assert.deepEqual(result.observations.map(value => [value.paidInputRaw, value.returnedInputRaw, value.consumedInputRaw, value.outputRaw]), [
  ['10000', '0', '10000', '10000'], ['15000', '0', '15000', '15000'], ['10000', '0', '10000', '10000'],
  ['12000', '0', '12000', '12000'], ['2000000', '1017000', '983000', '983000'],
]);
assert.equal(result.candidates.filter(value => value.status === 'refunded').length, 1);
assert.equal(result.historyComplete, false);
assert.equal(new Set(result.observations.map(value => value.id)).size, 5);
assert.notEqual(result.observations[0].payer, result.observations[0].recipient);
assert.deepEqual(result.observations.at(-1)!.ratio, { numerator: '1', denominator: '1', unit: 'output_atomic_per_input_atomic', includesTradingFees: true });
assert.deepEqual(project([...nodes].reverse()), result);
const duplicate = project([...nodes, nodes[60]]);
assert.equal(duplicate.observations.length, 0);
assert.ok(duplicate.issues.includes('market_duplicate_or_conflicting_transaction'));
const recoveryStart = fixture.transactions.find((row:any) => row.phase === 'retry-output-recovery').raw.lt;
const priorToRecovery = project(nodes.filter(node => BigInt(node.raw.lt) < BigInt(recoveryStart)));
assert.equal(priorToRecovery.observations.length, 3);
assert.equal(priorToRecovery.candidates.at(-1)!.status, 'unresolved');
const noArchives = project(nodes.map(node => ({ ...node, before: null, after: null })));
assert.equal(noArchives.observations.length, 0);
assert.ok(noArchives.candidates.every(value => value.issues.includes('market_archive_missing')));
const firstAcceptanceLt = fixture.transactions.find((row:any) => row.phase === 'full-t-to-x' && row.account === binding.pool && row.raw.inMessage?.op === 0x7362d09c).raw.lt;
const pool = nodes.find(node => node.account === binding.pool && node.raw.lt === firstAcceptanceLt)!;
assert.equal(readDlmmMarketState(pool.after!.state.dataBoc!).settlements.size, 1);
const heads = new Map<string, MarketNode>();
for (const node of nodes) if (!heads.has(node.account) || BigInt(heads.get(node.account)!.raw.lt) < BigInt(node.raw.lt)) heads.set(node.account, node);
const dependencies: MarketDependency[] = [...heads].map(([account, head]) => ({ account, generation: '00000000-0000-4000-8000-000000000001',
  historyComplete: true, headLt: head.raw.lt, headHash: head.raw.hash, checkedThrough: new Date((head.raw.utime + 60) * 1000).toISOString() }));
assert.equal(projectDlmmMarket(binding, nodes, dependencies).historyComplete, true);
const missingNotice = structuredClone(nodes); delete missingNotice.find(node => node.account === binding.pool && node.raw.lt === firstAcceptanceLt)!.raw.inMessage!.body;
const damaged = projectDlmmMarket(binding, missingNotice, dependencies);
assert.equal(damaged.historyComplete, false); assert.equal(damaged.observations.length, 4); assert.ok(damaged.issues.includes('market_pool_notification_undecodable'));
delete missingNotice.find(node => node.account === binding.pool && node.raw.lt === firstAcceptanceLt)!.raw.inMessage!.op;
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
assert.deepEqual(queueResult.observations.map(value => value.outputRaw), ['10000', '20000', '10000']);
assert.ok(queueResult.observations[1].settlements[0].request.lt !== queueResult.observations[1].acceptance.lt, 'queued output dispatch follows its original acceptance');
assert.equal(queueResult.observations[1].settlements[0].request.lt, queueResult.observations[0].settlements[0].poolFinalized.lt, 'prior JSFK dispatches next head');
assert.equal(BigInt(queueResult.observations[2].settlements[0].settlementId), BigInt(queueResult.observations[2].businessQueryId) + 1n, 'allocator skips the business query ID');
assert.ok(queueResult.observations[0].settlements[0].boundaries.some(value => value.beforeAccountState === 'uninitialized' && value.beforeDataHash === null), 'prefunded uninitialized beneficiary receives its first jetton credit');
assert.deepEqual(projectDlmmMarket(queued.binding, [...queued.nodes].reverse(), []), queueResult);
for (const [source, baseline, index, trigger] of [[{binding, nodes}, result, 3, 'retry'], [queued, queueResult, 1, 'finalizer']] as const) {
  const execution = baseline.observations[index], payout = execution.settlements[0];
  const isDispatch = (node: MarketNode) => node.account === payout.request.account && node.raw.lt === payout.request.lt;
  const dispatch = source.nodes.find(isDispatch)!;
  const before = readDlmmMarketState(dispatch.before!.state.dataBoc!), after = readDlmmMarketState(dispatch.after!.state.dataBoc!);
  const fresh = after.settlements.get(payout.settlementId)!, prior = before.settlements.get(fresh.settlementId)!;
  assert.equal(prior.status, 1, `${trigger}: the original liability had not entered the wallet`);
  assert.equal(fresh.settlementId, prior.settlementId, `${trigger}: a liability that never entered its wallet retains the original wire identity`);
  assert.equal(fresh.status, 2);
  assert.equal(fresh.predecessorId, '0');
  assert.equal(after.nextSettlementId, before.nextSettlementId);
  assert.equal(after.settlements.size, before.settlements.size - (trigger === 'finalizer' ? 1 : 0));
  assert.equal(fresh.fundedRaw, '220000000');
  assert.equal(fresh.amountRaw, prior.amountRaw);
  assert.equal(fresh.destinationWallet, prior.destinationWallet);
  assert.ok(payout.boundaries.some(boundary => boundary.transaction.lt === dispatch.raw.lt));
  for (const damage of ['missing dispatch', 'missing prior state', 'wrong pool code', 'wrong prior boundary identity',
    ...(trigger === 'retry' ? ['wrong retry nonce', 'underfunded retry'] : ['missing predecessor finalizer'])]) {
    let changed = structuredClone(source.nodes);
    const target = changed.find(isDispatch)!;
    if (damage === 'missing dispatch') changed = changed.filter(node => !isDispatch(node));
    if (damage === 'missing prior state') target.before = null;
    if (damage === 'wrong pool code') target.before!.state.codeBoc = beginCell().storeUint(1, 1).endCell().toBoc().toString('base64');
    if (damage === 'wrong prior boundary identity') target.before!.state.lastTxHash = '0'.repeat(64);
    if (damage === 'wrong retry nonce') target.raw.inMessage!.body = beginCell().storeUint(0x44535259, 32).storeUint(BigInt(prior.settlementId) + 1n, 64).endCell().toBoc().toString('base64');
    if (damage === 'underfunded retry') target.raw.inMessage!.value = '1';
    if (damage === 'missing predecessor finalizer') changed = changed.filter(node => node.account !== baseline.observations[0].settlements[0].walletFinalized.account || node.raw.lt !== baseline.observations[0].settlements[0].walletFinalized.lt);
    const damaged = projectDlmmMarket(source.binding, changed, []);
    assert.ok(!damaged.observations.some(value => value.id === execution.id), `${trigger}: ${damage} cannot qualify the same amount as the original liability`);
    assert.ok(damaged.observations.length > 0, `${trigger}: ${damage} retains independent actual trades`);
  }
}
console.log('DLMM market ledger authentic execution tests passed');
