import assert from 'node:assert/strict';
import { decodeCurrentDlmmOrders } from '../ledger/currentDlmmOrderProof';
import { verifyCurrentT3Transaction } from '../ledger/currentDlmmPhysical';
import { currentOrderRecoveryBinding, currentOrderRecoveryOriginals } from './support/currentDlmmOrderRecoveryFixture';
import { projectOwnerLedger } from '../ledger/project';
import { currentDlmmProjectionFixture } from './support/currentDlmmProjectionFixture';

async function main() {
  let checks = 0;
  const cases=currentOrderRecoveryOriginals(process.argv[2]);assert.equal(cases.length,12);assert.equal(new Set(cases.map(c=>c.file)).size,12);
  for (const c of cases) {
    const binding = currentOrderRecoveryBinding(c), original = c.completeTransactions, txs = original.map(verifyCurrentT3Transaction);
    const select = (rows = original, b = binding) => decodeCurrentDlmmOrders(c.original.wallet, b, rows).find(o => o.economics.order?.address === c.original.order)?.economics;
    const selected = select(); assert(selected, c.file); assert.equal(selected.outcome, c.mode.startsWith('never-funded') ? 'accepted' : 'refunded', c.file);
    for (const [key, expected] of [['fundedInRaw','funded'],['consumedInRaw','consumed'],['receivedOutRaw','received'],['refundedInRaw','refunded']] as const)
      assert.equal(selected.order![key], c.expected[expected], `${c.file} ${key}`);
    assert.equal(selected.order!.executedSlices, c.expected.slices); assert.equal(selected.paidInRaw, c.expected.funded);
    assert.equal(selected.pendingOutT3Raw, '0'); assert.equal(selected.pendingOutXRaw, '0'); checks++;
    const omit = (hash: string) => original.filter((_: any, i: number) => txs[i].hash !== hash);
    const creator = c.actions.find((a: any) => a.kind === 'create'); assert.equal(select(omit(creator.ownerDispatch.hash)), undefined); checks++;
    if (c.mode.startsWith('never-funded')) {
      assert.equal(selected.cash.length, 0); assert.equal(selected.paidOutT3Raw, '0'); assert.equal(selected.paidOutXRaw, '0');
      assert.equal(select(original, { ...binding, orderWalletAbsences: [] })!.outcome, 'unresolved');
      const absent = binding.orderWalletAbsences![0];
      for (const state of [{ ...absent.state, shardAccountBoc: undefined }, { ...absent.state, sourceMasterchain: undefined },
        { ...absent.state, lastTxLt: '0' }, { ...absent.state, balance: '1' }])
        assert.equal(select(original, { ...binding, orderWalletAbsences: [{ ...absent, state }] })!.outcome, 'unresolved');
      const bounced = txs.find((t: any) => t.account === c.original.order && t.tx.inMessage?.info.type === 'internal' && t.tx.inMessage.info.bounced)!; assert(bounced);
      assert.equal(select(omit(bounced.hash))!.outcome, 'unresolved');
      const failed = txs.find((t: any) => t.account === c.binding.wallets.orderPay.address)!; assert(failed && !failed.succeeded);
      assert.equal(select(omit(failed.hash))!.outcome, 'unresolved');
      const close = c.actions.find((a: any) => a.kind === 'cancel' || a.kind === 'expire'); assert(close);
      assert.equal(select(omit(close.ownerDispatch.hash))!.outcome, 'unresolved'); checks += 9;
    } else {
      assert.equal(selected.cash.filter(l => l.direction === 'out').length, 1, 'custody funding is debited once');
      assert.equal(selected.cash.filter(l => l.direction === 'in').reduce((n, l) => n + BigInt(l.amountRaw), 0n), BigInt(c.expected.refunded));
      const mark = txs.find((t: any) => t.account === c.binding.wallets.orderPay.address && t.succeeded && t.tx.inMessage?.body.bits.length >= 32 && t.tx.inMessage.body.beginParse().preloadUint(32) === 0x5433574b)!;
      const retry = txs.find((t: any) => t.account === c.binding.wallets.orderPay.address && t.succeeded && t.tx.inMessage?.body.bits.length >= 32 && t.tx.inMessage.body.beginParse().preloadUint(32) === 0x54335759)!;
      assert(mark && retry); const recovered = selected.cash.find(l => l.direction === 'in' && BigInt(txs.find((t: any) => t.hash === l.creditTransaction)!.tx.lt) > retry.tx.lt)!; assert(recovered);
      assert.notEqual(recovered.debitTransaction, retry.hash, 'retry is never a second debit'); assert.equal(recovered.debitTransaction, recovered.originTransaction);
      const failedHash=c.recovery.failedTransaction.hash;
      const bounced=txs.find((t:any)=>t.account===c.binding.wallets.orderPay.address&&t.tx.inMessage?.info.type==='internal'&&t.tx.inMessage.info.bounced&&t.tx.inMessage.info.src.toRawString()===c.recovery.failedRecipient);assert(bounced);
      for (const hash of [mark.hash, retry.hash, recovered.debitTransaction, recovered.creditTransaction, failedHash, bounced.hash]) assert.equal(select(omit(hash))!.outcome, 'unresolved', `missing ${hash}`);
      const recovery = c.actions.find((a: any) => a.kind === 'recover'); assert(recovery); assert.equal(select(omit(recovery.ownerDispatch.hash))!.outcome, 'unresolved');
      for (const stage of c.stages.filter((s: any) => s.stage !== 'delivered')) assert.equal(select(original.slice(0, stage.transactionCount))!.outcome, 'unresolved', stage.stage);
      assert.throws(() => select([...original, original.find((_: any, i: number) => txs[i].hash === retry.hash)]), /duplicate originals/); checks += 13;
    }
    const input = currentDlmmProjectionFixture({ binding, request: { owner: c.original.wallet }, transactions: original });
    const projected = await projectOwnerLedger(input), event = projected.events.find(e => e.settlement?.currentDlmm?.order?.address === c.original.order);
    assert.equal(event?.settlement?.status, 'confirmed', `${c.file} ${JSON.stringify(event?.issues)}`);
    const economic = event!.settlement!.currentDlmm!;
    for (const root of [binding.pools[0].t3.root, binding.pools[0].x.root]) for (const direction of ['in','out'] as const) {
      const total: bigint = event!.movements.filter(m => m.asset.master === root && m.direction === direction && ['jetton_transfer','jetton_internal_transfer'].includes(m.evidence.kind)).reduce((n,m) => n + BigInt(m.amountRaw), 0n);
      assert.equal(total, economic.cash.filter(l => l.root === root && l.direction === direction).reduce((n,l) => n + BigInt(l.amountRaw), 0n), 'ordinary projection never creates duplicate cash');
    }
    const noState = await projectOwnerLedger({ ...input, stateAt: async () => null });
    assert(!noState.events.some(e => e.settlement?.currentDlmm?.order?.address === c.original.order && e.settlement?.status === 'confirmed')); checks += 6;
    console.log(c.file, 'original recovery/zero-custody proof and ordinary cash projection passed');
  }
  console.log('Current Order original recovery checks passed:', checks);
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
