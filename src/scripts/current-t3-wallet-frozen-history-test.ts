import assert from 'node:assert/strict';
import { beginCell, Cell, storeShardAccount, storeTransaction, type StateInit } from '@ton/core';
import { reconstructCurrentT3WalletClaims } from '../ledger/currentT3Receipts';
import { canonicalLedgerHash } from '../ledger/normalize';
import { orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState, boundaryTransaction } from '../runtime/physicalEvidence';
import { currentOwedFixture } from './support/currentOwedFixture';

/** Genuine source-bound native freeze/refusal/thaw history. Mutated cells below
 * are negative vectors only; no rewritten original qualifies a positive. */
async function main() {
  const fixture = currentOwedFixture();
  const original = [...fixture.cases()].find(c => c.file === 'protected-failed-default.json'); assert(original);
  const c = original.capture, wallet = c.plan.from.address, stage = c.stages.after;
  const rows: OrderTransactionEvidence[] = c.completeTransactions.slice(0, stage.transactionCount)
    .filter((r: OrderTransactionEvidence) => r.account === wallet);
  const checked = rows.map(verifyOrderTransaction);
  const frozenIndex = checked.findIndex(r => r.before.account?.storage.state.type === 'frozen' && r.after.account?.storage.state.type === 'frozen');
  const thawIndex = checked.findIndex(r => r.before.account?.storage.state.type === 'frozen' && r.after.account?.storage.state.type === 'active');
  assert(frozenIndex > 0 && thawIndex > frozenIndex); assert(checked.filter(r => r.after.account?.storage.state.type === 'frozen').length > 256);
  const key = (lt: string, hash: string) => `${lt}:${canonicalLedgerHash(hash)}`;
  const run = (history: OrderTransactionEvidence[], change?: (snapshot: ReturnType<typeof boundaryState>) => ReturnType<typeof boundaryState>,
    currentState = boundaryState(wallet, history.at(-1)!.afterShardAccountBoc, stage.head.seqno)) => {
    const states = new Map<string, ReturnType<typeof boundaryState>>();
    for (const row of history) for (const boc of [row.beforeShardAccountBoc, row.afterShardAccountBoc]) {
      const value = boundaryState(wallet, boc, stage.head.seqno); states.set(key(value.state.lastTxLt!, value.state.lastTxHash!), value);
    }
    return reconstructCurrentT3WalletClaims({ binding: { hub: c.manifest.contracts.T3Hub.address,
      walletCodeHash: c.manifest.templates.T3Wallet, proofCodeHash: c.manifest.templates.T3RecoveryProof }, wallet, owner: c.holder,
      transactions: history.map(evidence => boundaryTransaction({ evidence, seqno: stage.head.seqno })),
      currentState,
      stateAt: async (_, lt, hash) => { const value = states.get(key(lt, hash)); return value ? change?.(value) ?? value : null; },
    });
  };
  const positive = await run(rows); assert.equal(positive.status, 'ok', JSON.stringify(positive));
  if (positive.status === 'ok') { assert.equal(positive.records.length, 3); assert.equal(positive.failures.length, 1); }
  console.log('Original 522-row wallet history retains every frozen row and reconstructs both current trees.');
  const firstFrozen = checked.findIndex(r => r.after.account?.storage.state.type === 'frozen'); assert(firstFrozen > 0);
  const priorActive = boundaryState(wallet, rows[firstFrozen - 1].afterShardAccountBoc, stage.head.seqno);
  const frozenCurrent = boundaryState(wallet, rows[frozenIndex].afterShardAccountBoc, stage.head.seqno);
  const fakeActive = { ...frozenCurrent, state: { ...frozenCurrent.state, accountState: 'active' as const,
    codeBoc: priorActive.state.codeBoc, dataBoc: priorActive.state.dataBoc } };
  assert.deepEqual(await run(rows.slice(0, frozenIndex + 1), undefined, fakeActive),
    { status: 'unavailable', reason: 'current_wallet_state_mismatch' }, 'Active metadata cannot replace the final frozen original');
  const actualCurrent = boundaryState(wallet, rows.at(-1)!.afterShardAccountBoc, stage.head.seqno);
  assert.deepEqual(await run(rows, undefined, { ...actualCurrent, state: { ...actualCurrent.state,
    shardAccountBoc: rows[frozenIndex].afterShardAccountBoc } }),
    { status: 'unavailable', reason: 'current_wallet_state_mismatch' }, 'Current active metadata must match its exact last original account cell');
  assert.equal((await run(rows.filter((_, i) => i !== frozenIndex))).status, 'unavailable', 'An interior frozen original cannot be omitted');
  const frozenLt = String(checked[frozenIndex].tx.lt);
  const changedCommitment = await run(rows, snapshot => {
    if (snapshot.state.lastTxLt !== frozenLt) return snapshot;
    const shard = orderShard(snapshot.state.shardAccountBoc!, wallet).shard;
    assert.equal(shard.account?.storage.state.type, 'frozen');
    if (shard.account?.storage.state.type === 'frozen') shard.account.storage.state.stateHash ^= 1n;
    return { ...snapshot, state: { ...snapshot.state, shardAccountBoc: beginCell().store(storeShardAccount(shard)).endCell().toBoc().toString('base64') } };
  });
  assert.equal(changedCommitment.status, 'unavailable', 'Changed frozen commitment is not original evidence');
  const prefix = rows.slice(0, thawIndex + 1), thaw = checked[thawIndex]; assert(thaw.tx.inMessage?.init);
  assert.equal((await run(prefix)).status, 'ok', 'Exact original restoration is itself a valid active boundary');
  for (const init of [null, { ...thaw.tx.inMessage.init, data: beginCell().endCell() } satisfies StateInit]) {
    const transaction = beginCell().store(storeTransaction({ ...thaw.tx, inMessage: { ...thaw.tx.inMessage, init } })).endCell();
    const after = orderShard(rows[thawIndex].afterShardAccountBoc, wallet).shard; after.lastTransactionHash = BigInt('0x' + transaction.hash().toString('hex'));
    const altered = { ...rows[thawIndex], transactionBoc: transaction.toBoc().toString('base64'),
      afterShardAccountBoc: beginCell().store(storeShardAccount(after)).endCell().toBoc().toString('base64') };
    assert(verifyOrderTransaction(altered).succeeded, 'Negative cell keeps valid structural original-boundary commitments');
    const result = await run([...prefix.slice(0, -1), altered]);
    assert.deepEqual(result, { status: 'unavailable', reason: 'frozen_wallet_thaw_mismatch' });
  }
  console.log('Missing frozen original, altered commitment, and missing/altered thaw StateInit all refuse.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
