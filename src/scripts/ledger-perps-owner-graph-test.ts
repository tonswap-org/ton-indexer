import assert from 'node:assert/strict';
import { Cell } from '@ton/core';
import { fixture } from './ledger-perps-oracle-execution-test';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import { LedgerGraphBuilder } from '../ledger/graph';
import { PostgresLedgerStore } from '../ledger/store';
import type { WalletIdentityStore } from '../ledger/identities';
import { projectOwnerLedger } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { loadOpcodes } from '../utils/opcodes';

async function build(stale = false, failHistory = false) {
  const captured = fixture('open-accepted'), { f, input, states, rows } = captured;
  const boundary = fixtureHead(100000), cycle = { boundary, signal: new AbortController().signal };
  const refreshed: string[] = [], read: string[] = [];
  // A trusted store adapter isolates graph discovery from physical backfill,
  // which has its own linked-history tests. Original captured BOCs stay intact.
  const histories = new Map([...input.chains].map(([account, chain]) => [account, stale && account === f.riskController ? [] : chain.transactions]));
  const store = {
    rawHistory: async (account: string) => {
      if (failHistory && account === f.riskController) throw Error('durable_history_unavailable');
      return (histories.get(account) ?? []).map(raw => ({ account, raw }));
    },
    pool: { query: async (sql: string, values: string[]) => {
      if (sql.startsWith('SELECT source_complete')) {
        const last = histories.get(values[0])?.at(-1);
        return { rows: [{ source_complete: true, complete: true, head_lt: last?.lt ?? null, head_hash: last?.hash ?? null, head_observed_at: '2026-10-13T00:00:00.000Z' }] };
      }
      if (sql.startsWith('SELECT snapshot')) {
        const snapshot = states.get(`${values[1]}:${values[2]}:${canonicalLedgerHash(values[3])}`);
        return { rows: snapshot ? [{ snapshot }] : [] };
      }
      throw Error(`Unexpected store call ${sql}`);
    } },
  } as unknown as PostgresLedgerStore;
  const source = fakeChainSource({ getAccountState: async (account, options) => {
    assert.deepEqual(options?.at, boundary); assert.equal(options?.signal, cycle.signal); read.push(account);
    const row = rows.filter((row: any) => row.account === account).at(-1);
    if (!row) return { accountState: 'uninitialized', balance: '0' };
    const codeBoc = account === f.engine ? f.engineCode : f.walletCode;
    return { accountState: 'active', balance: '0', codeBoc, dataBoc: row.newStorage, lastTxLt: row.raw.lt, lastTxHash: row.raw.hash };
  } });
  const identities = { resolve: async (account: string) => input.wallets.get(account) ?? null, known: async () => null,
    reader: { wallet: async (root: string, owner: string, options: any) => {
      assert.deepEqual(options.at, boundary); assert.equal(options.signal, cycle.signal);
      const asset = [...input.wallets.values()].find(asset => asset.master === root && asset.owner === owner);
      return asset?.wallet ? { status: 'ok', root, wallet: asset.wallet, balanceRaw: '0', lastTxLt: '1', lastTxHash: '0'.repeat(64) }
        : { status: 'unavailable', root, wallet: null, reason: 'upstream' };
    } },
  } as unknown as WalletIdentityStore;
  const graph = await new LedgerGraphBuilder('localnet', source, store, [], undefined, identities, async account => {
    refreshed.push(account); const last = histories.get(account)?.at(-1);
    return { account, generation: account, head: last ? { lt: last.lt, hash: last.hash } : null, complete: true,
      atBoundary: !(stale && account === f.riskController), errorCode: stale && account === f.riskController ? 'source_unavailable' : null };
  }, 256, undefined, undefined, f.root, f.engine, Cell.fromBase64(f.engineCode).hash().toString('hex')).build(f.owner, f.owner, cycle);
  const projection = await projectOwnerLedger({ network: 'localnet', owner: f.owner, opcodes: loadOpcodes(), ...graph });
  return { f, graph, projection, refreshed, read };
}
async function main() {
  const complete = await build(), event = complete.projection.events.find(event => event.kind === 'perps_operation')!;
  assert(event, 'funded OPEN is represented through the owner graph');
  assert.equal(event.settlement?.status, 'confirmed', JSON.stringify(event));
  assert(event.settlement?.perps?.oracleExecution?.admission, 'owner graph includes independent risk admission evidence');
  for (const account of [complete.f.pool, complete.f.riskVault, complete.f.riskController, complete.f.rvWallet])
    assert(complete.refreshed.includes(account), `protocol peer/custody ${account} is loaded`);
  const stale = await build(true), pending = stale.projection.events.find(event => event.kind === 'perps_operation')!;
  assert(pending); assert.equal(pending.settlement?.status, 'incomplete');
  assert(stale.graph.issues.includes('related_account_refresh_pending'));
  assert(stale.graph.pendingAccounts.includes(stale.f.riskController));
  await assert.rejects(build(false, true), /durable_history_unavailable/, 'product discovery cannot swallow storage failure into an empty complete chain');
  console.log('funded native OPEN through owner graph confirms oracle admission; stale required peer retains a pending operation and refresh reason');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
