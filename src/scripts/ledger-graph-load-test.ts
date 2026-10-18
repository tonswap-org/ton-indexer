import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { LedgerGraphBuilder } from '../ledger/graph';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import type { WalletIdentityStore } from '../ledger/identities';
import { findTransactionState } from '../ledger/archive';
import { normalizeLedgerEvent } from '../ledger/normalize';
import type { RawTransaction } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import { loadOpcodes } from '../utils/opcodes';
import { currentT3Fixture } from './support/currentT3Fixture';

const addr = (n: number) => `0:${n.toString(16).padStart(64, '0')}`, hash = Buffer.alloc(32, 1).toString('base64');
async function main() {
  const db = new PGlite();
  const pool: LedgerSqlPool = { query: async (sql, params) => !params && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params),
    connect: async () => pool, end: () => db.close() };
  const store = new PostgresLedgerStore(pool), owner = addr(1), engine = addr(2), hub = addr(3), roots = Array.from({ length: 8 }, (_, i) => addr(i + 10)), wallets = roots.map((_, i) => addr(i + 30));
  const cycle = { boundary: fixtureHead(100), signal: new AbortController().signal };
  const generations = new Map<string, string>();
  const raw: RawTransaction = { lt: '1', hash, prevTransactionLt: '0', prevTransactionHash: Buffer.alloc(32).toString('base64'),
    utime: 1700000000, success: true, status: 'success', totalFeesRaw: '0', outMessages: [] };
  try {
    await store.initialize();
    for (const account of [owner, ...wallets]) {
      const generation = randomUUID(); generations.set(account, generation);
      await store.begin('testnet', account, generation, { lt: '1', hash });
      await store.append(generation, [await normalizeLedgerEvent('testnet', account, raw, loadOpcodes())], [raw]);
      await store.complete('testnet', account, generation);
    }
    const assets = new Map(wallets.map((wallet, i) => [wallet, { kind: 'jetton' as const, id: `testnet:jetton:${roots[i]}`, owner, master: roots[i], wallet }]));
    const identities = { resolve: async (wallet: string) => assets.get(wallet) ?? null,
      known: async (_owner: string, root: string) => root === roots[2] ? assets.get(wallets[2]) : null,
      reader: { wallet: async (root: string, _owner: string, options: any) => {
        assert.deepEqual(options.at, cycle.boundary); assert.equal(options.signal, cycle.signal);
        const i = roots.indexOf(root);
        return i === 1 ? { status: 'not_deployed', root, wallet: wallets[i], balanceRaw: '0' }
          : i === 2 ? { status: 'unavailable', root, wallet: null, reason: 'upstream' }
          : { status: 'ok', root, wallet: wallets[i], balanceRaw: '1', lastTxLt: '1', lastTxHash: hash };
      } },
    } as unknown as WalletIdentityStore;
    let active = 0, peak = 0;
    const refresh = async (account: string) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { account, generation: generations.get(account)!, head: { lt: '1', hash }, complete: true,
        atBoundary: account !== wallets[0], errorCode: account === wallets[0] ? 'source_unavailable' : null };
    };
    const source = fakeChainSource();
    const graph = await new LedgerGraphBuilder('testnet', source, store, roots, undefined, identities, refresh,
      256, undefined, undefined, undefined, engine, 'a'.repeat(64)).build(owner, generations.get(owner)!, cycle);
    const retained = graph.chains.get(wallets[0])!;
    assert.deepEqual(retained.transactions, [raw]); assert.equal(retained.generation, generations.get(wallets[0]));
    assert.equal(retained.historyComplete, true); assert.equal(retained.atBoundary, false);
    assert.equal(retained.headLt, '1'); assert.equal(retained.headHash, hash);
    assert(graph.issues.includes('related_account_refresh_pending'));
    assert(!graph.issues.includes('related_account_history_incomplete'), 'read failure does not erase a complete stored chain');
    assert(!graph.chains.has(engine), 'an owner with no perps activity never loads the engine');
    assert(graph.chains.has(wallets[1]), 'qualified not_deployed wallet still gets physical history coverage');
    assert(graph.issues.includes('configured_wallet_discovery_unresolved'));
    assert(graph.wallets.has(wallets[2]) && graph.chains.has(wallets[2]), 'known identity remains after unreadable configured wallet discovery');
    assert.equal(peak, 4, 'dependency loads use parallelism'); assert(peak <= 4, 'dependency loads are bounded at four');
    assert.deepEqual([...graph.chains.keys()], [...graph.chains.keys()].sort(), 'parallel discovery has stable final order');
    assert.deepEqual(graph.boundary, cycle.boundary);

    // A configured current T3 identity remains explicitly unresolved when its
    // release binding or pinned account read is unavailable.
    const relevant = randomUUID(), request = { ...raw, outMessages: [{ source: owner, destination: hub, op: 0, value: '0' }] };
    await store.begin('testnet', owner, relevant, { lt: '1', hash });
    // Immutable raw rows deliberately cannot be overwritten. This graph-only
    // adapter supplies its distinct owner evidence without altering stored rows.
    const ownerStore = { pool: store.pool, rawHistory: async (generation: string) => generation === relevant
      ? [{ account: owner, raw: request }] : store.rawHistory(generation) } as unknown as PostgresLedgerStore;
    await store.pool.query('UPDATE ledger_runs SET source_complete=true WHERE generation=$1', [relevant]);
    let reads = 0;
    const current = currentT3Fixture();
    const unavailable = fakeChainSource({ getAccountState: async (account, options) => {
      assert.equal(account, current.hub);
      assert.deepEqual(options?.at, cycle.boundary); assert.equal(options?.signal, cycle.signal); reads++; throw Error('offline');
    } });
    const failed = await new LedgerGraphBuilder('testnet', unavailable, ownerStore, [], undefined, identities, refresh,
      256, undefined, hub, roots[0]).build(owner, relevant, cycle);
    assert.equal(reads, 0, 'Missing release binding never invokes an obsolete discovery getter');
    assert.equal(failed.bindings[`t3:${hub}`], false);
    assert(failed.issues.includes('t3_hub_identity_or_reserve_unresolved'));
    // The network label only scopes this synthetic source/store harness; no
    // native execution or deployment qualification is asserted by this failure.
    const binding = { ...current.binding, network: 'testnet' as const };
    const unreadable = await new LedgerGraphBuilder('testnet', unavailable, ownerStore, [], undefined, identities, refresh,
      256, undefined, current.hub, current.hub, undefined, undefined, undefined, undefined, binding).build(owner, relevant, cycle);
    assert.equal(reads, 1, 'Current identity discovery reads the original account at the cycle boundary');
    assert.equal(unreadable.bindings[`t3:${current.hub}`], false);
    assert(unreadable.issues.includes('t3_hub_identity_or_reserve_unresolved'));
    console.log('graph loads retain stored chains on refresh failure; empty/unreadable wallet distinction, product relevance, pinned getters and bounded deterministic parallelism passed');
  } finally { await db.close(); }
  await archiveCache();
}
async function archiveCache() {
  const now = Date.now;
  let clock = 100000, reads = 0, fail = true;
  Date.now = () => clock;
  const source = fakeChainSource({ getAccountStateAtSeqno: async (_account, seqno) => {
    reads++; if (fail) throw Error('archive unavailable');
    return { balance: '0', accountState: seqno < 10 ? 'uninitialized' : 'active', lastTxLt: seqno < 10 ? '0' : '1', lastTxHash: seqno < 10 ? Buffer.alloc(32).toString('base64') : hash };
  } });
  try {
    assert.equal(await findTransactionState(source, addr(1), { lt: '1', hash }, 20), null); assert.equal(reads, 1);
    assert.equal(await findTransactionState(source, addr(1), { lt: '1', hash }, 19), null); assert.equal(reads, 1);
    assert.equal(await findTransactionState(source, addr(1), { lt: '0', hash: Buffer.alloc(32).toString('base64') }, 20), null,
      'cached unavailability is never reported as authenticated absence'); assert.equal(reads, 1);
    assert.equal(await findTransactionState(source, addr(1), { lt: '1', hash }, 21), null); assert.equal(reads, 2, 'newer blocks still get a source attempt');
    clock += 60001; fail = false;
    const recovered = await findTransactionState(source, addr(1), { lt: '1', hash }, 20);
    assert.equal(recovered?.seqno, 10); assert.equal(recovered?.state.lastTxHash, hash);
    console.log('archive miss cache saves unavailable reads for 60 seconds, preserves newer attempts and never proves absence');
  } finally { Date.now = now; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
