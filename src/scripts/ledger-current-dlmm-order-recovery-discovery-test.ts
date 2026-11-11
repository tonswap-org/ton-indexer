import assert from 'node:assert/strict';
import { currentOrderRecoveryOriginals } from './support/currentDlmmOrderRecoveryFixture';
import { currentDlmmMarketGraphFixture } from './support/currentDlmmMarketGraphFixture';
import { currentDlmmProjectionFixture } from './support/currentDlmmProjectionFixture';
import { currentDlmmBindingFromManifest } from '../ledger/currentDlmmPhysical';
import { decodeCurrentDlmmOrders } from '../ledger/currentDlmmOrderProof';
import { LedgerGraphBuilder } from '../ledger/graph';
import { createJettonWalletReader } from '../data/jettonWallet';
import type { WalletIdentityStore } from '../ledger/identities';
import type { PostgresLedgerStore } from '../ledger/store';
async function main() {
  const cases=currentOrderRecoveryOriginals(process.argv[2]).filter(c => c.file.startsWith('order-0-never-funded-cancelled-'));assert.equal(cases.length,2);
  for (const c of cases) {
    const head = c.readSnapshots.at(-1).response.head;
    // Adapt actual RPC/account pairs at one original native head. The block
    // transport is synthetic; no empty envelope or getter is invented.
    const calls: any[] = [], results: any[] = [];
    for (const a of c.currentAccounts) {
      const r = a.response; assert.equal(r.block_id.seqno, head.seqno); assert.equal(r.sync_utime, head.utime);
      assert.equal(Buffer.from(r.block_id.root_hash, 'base64').toString('hex'), head.rootHashHex);
      calls.push({ kind: 'account', address: a.address }); results.push({ kind: 'account', state: r.state === 'uninitialized' ? 'uninit' : r.state,
        balance: r.balance, codeBoc: r.code || null, dataBoc: r.data || null, originalShardAccountBoc: a.originalShardAccountBoc,
        lastTx: { lt: r.last_transaction_id.lt, hash: Buffer.from(r.last_transaction_id.hash, 'base64').toString('hex') } });
    }
    const f = currentDlmmMarketGraphFixture({ ...c, readSnapshots: [...c.readSnapshots, { calls, response: { head, results } }] });
    const read = f.source.getAccountState.bind(f.source), current = { missingEmpty: false, staleEmpty: false };
    f.source.getAccountState = async (address, options) => {
      const state = await read(address, options), bound = { ...state, sourceMasterchain: f.adapter.head };
      if (address !== c.binding.wallets.orderPay.address) return bound;
      if (current.missingEmpty) return { ...bound, shardAccountBoc: undefined };
      if (current.staleEmpty) return { ...bound, sourceMasterchain: { ...f.adapter.head, rootHashHex: '0'.repeat(64) } };
      return bound;
    };
    const binding = { release: f.binding.release, pools: [{ pool: f.binding.pool, market: f.binding.market, t3: f.binding.t3, x: f.binding.x, wallets: f.wallets }] };
    const input = currentDlmmProjectionFixture({ binding, request: { owner: c.original.wallet }, transactions: f.evidence });
    const identities = { resolve: async (a: string) => input.wallets.get(a) ?? null, known: async () => null,
      reader: createJettonWalletReader({ source: f.source, tokens: f.binding.release.tokens.map(t => ({ master: t.root, masterCodeHash: t.masterCodeHash, walletCodeHash: t.walletCodeHash })) }) } as unknown as WalletIdentityStore;
    const graph = new LedgerGraphBuilder('localnet', f.source, f.ledger.store as PostgresLedgerStore, [], undefined, identities, f.ledger.refreshDependency.bind(f.ledger), 256,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], [], undefined, undefined, currentDlmmBindingFromManifest(f.binding.release));
    const run = () => graph.build(c.original.wallet, f.dependencies.find(d => d.account === c.original.wallet)!.generation, { boundary: f.adapter.head });
    const found = await run(); assert.equal(found.bindings[`current-dlmm-orders:${f.binding.release.contracts.SpotOrderFactory!.address}`], true, JSON.stringify(found.issues));
    assert.equal(found.currentDlmmBinding?.orderWalletAbsences?.length, 1);
    assert.equal(decodeCurrentDlmmOrders(c.original.wallet, found.currentDlmmBinding!, f.evidence).find(o => o.economics.order?.address === c.original.order)?.economics.outcome, 'accepted');
    assert.equal(found.chains.get(c.binding.wallets.orderPay.address)?.transactions.length, 1, 'original failed withdrawal stays in history');
    for (const flag of ['missingEmpty','staleEmpty'] as const) {
      current[flag] = true; const missing = await run();
      assert(!missing.currentDlmmBinding?.orderWalletAbsences?.length);
      assert.notEqual(decodeCurrentDlmmOrders(c.original.wallet, missing.currentDlmmBinding!, f.evidence).find(o => o.economics.order?.address === c.original.order)?.economics.outcome, 'accepted'); current[flag] = false;
    }
    console.log(c.file, 'ordinary graph retains exact empty-account cursor; missing/stale physical evidence cannot close custody');
  }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
