import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { LedgerGraphBuilder } from '../ledger/graph';
import { projectOwnerLedger } from '../ledger/project';
import type { LedgerAsset } from '../ledger/types';
import { DlmmMarketGraphBuilder } from '../ledger/marketGraph';
import { projectDlmmMarket } from '../ledger/marketProjection';
import { PostgresMarketStore } from '../ledger/marketStore';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { canonicalLedgerHash, normalizeLedgerEvent } from '../ledger/normalize';
import { parseLedgerMarketBindings } from '../config/ledgerMarkets';
import { loadOpcodes } from '../utils/opcodes';
import type { LedgerService } from '../ledger/service';
import type { TonDataSource } from '../data/dataSource';
import type { DlmmMarketBinding } from '../ledger/marketTypes';
async function main() {
    const f = JSON.parse(readFileSync(`${__dirname}/fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-settlements.json`, 'utf8'));
    const code = (suffix: string) => f.compiler.find((c: any) => c.entrypointFileName.endsWith(suffix)).codeHash;
    const binding: DlmmMarketBinding = { network: 'localnet', pool: f.accounts.pool, router: f.accounts.router, routerCodeHash: code('/dex/router.tolk'), poolCodeHash: code('/dlmm/pool.tolk'), walletCodeHash: code('/jetton/jetton_wallet.tolk'), tokenT: f.accounts.tokenT, tokenX: f.accounts.tokenX, tokenTCodeHash: code('/jetton/jetton_root.tolk'), tokenXCodeHash: code('/jetton/jetton_root.tolk') };
    assert.deepEqual(parseLedgerMarketBindings(JSON.stringify([binding]), 'localnet'), [binding]);
    for (const changed of [{ ...binding, router: null }, { ...binding, routerCodeHash: null }, { ...binding, routerCodeHash: 'current' }])
        assert.throws(() => parseLedgerMarketBindings(JSON.stringify([changed]), 'localnet'));
    const db = new PGlite(), pool = { query: async (sql: string, args?: any[]) => args === undefined ? (await db.exec(sql)).at(-1) ?? { rows: [] } : db.query(sql, args), connect: async () => pool, end: async () => db.close() } as unknown as LedgerSqlPool;
    const store = new PostgresLedgerStore(pool), market = new PostgresMarketStore(pool);
    await store.initialize();
    const opcodes = loadOpcodes(), calls = new Set<string>();
    for (const account of new Set<string>(f.transactions.map((t: any) => t.account))) {
        const raws = f.transactions.filter((t: any) => t.account === account).map((t: any) => t.raw), head = raws.at(-1), generation = randomUUID();
        await store.begin('localnet', account, generation, { lt: head.lt, hash: canonicalLedgerHash(head.hash) }, new Date((head.utime + 60) * 1000).toISOString());
        await store.append(generation, await Promise.all(raws.map((raw: any) => normalizeLedgerEvent('localnet', account, raw, opcodes))), raws);
        await store.complete('localnet', account, generation);
    }
    for (const b of f.boundaries)
        for (const value of [b.before, b.after]) {
            const state = { ...value, accountState: value.accountState === 'uninit' ? 'uninitialized' : value.accountState };
            await pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING', ['localnet', b.account, state.lastTxLt, canonicalLedgerHash(state.lastTxHash), JSON.stringify({ seqno: 0, state })]);
        }
    const ledger = { network: 'localnet', store, syncAccount: async (account: string, project: boolean) => { assert.equal(project, false); calls.add(account); } } as unknown as LedgerService;
    const graph = await new DlmmMarketGraphBuilder(ledger, {} as TonDataSource).build(binding);
    assert.deepEqual(graph.issues, []);
    assert.ok(calls.has(binding.router!));
    assert.ok(calls.has(f.accounts.payer));
    const projection = projectDlmmMarket(binding, graph.nodes, graph.dependencies);
    assert.equal(projection.observations.length, 2, JSON.stringify(projection.candidates));
    assert.equal(projection.historyComplete, true, JSON.stringify(projection.issues));
    const publication = await market.publish(projection, null), page = await market.page('localnet', binding.pool);
    assert.equal(page.coverage?.generation, publication.generation);
    assert.equal(page.observations.length, 2);
    assert.ok(page.observations.every(o => o.routing?.router === binding.router));
    const limited = await new DlmmMarketGraphBuilder(ledger, {} as TonDataSource, 1).build(binding);
    assert.ok(limited.issues.includes('market_related_account_limit'));
    assert.equal(projectDlmmMarket(binding, limited.nodes, limited.dependencies).observations.length, 0);
    const wallets = new Map<string, LedgerAsset>();
    for (const [name, pair] of Object.entries(f.accounts.wallets) as [
        string,
        string[]
    ][])
        for (const [side, wallet] of pair.entries()) {
            const owner = name === 'other' ? f.accounts.otherPayer : f.accounts[name], master = side ? binding.tokenX : binding.tokenT;
            wallets.set(wallet, { kind: 'jetton', id: `localnet:jetton:${master}`, wallet, owner, master });
        }
    const source = { network: 'localnet', getJettonBalance: async (owner: string, root: string) => { const entry = [...wallets.values()].find(w => w.owner === owner && w.master === root); return entry ? { wallet: entry.wallet, balance: '0' } : null; }, runGetMethod: async () => ({ exitCode: 11, stack: [] }) } as unknown as TonDataSource;
    const generation = (await store.account('localnet', f.accounts.payer))!.current_generation!;
    const build = (limit = 256) => new LedgerGraphBuilder('localnet', source, store, [binding.tokenT, binding.tokenX], undefined, async (wallet) => wallets.get(wallet) ?? null, async () => true, limit, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], [binding]).build(f.accounts.payer, generation);
    const ownerGraph = await build();
    assert.ok(ownerGraph.chains.has(binding.router!));
    assert.ok(ownerGraph.pools.has(binding.pool));
    const owner = await projectOwnerLedger({ network: 'localnet', owner: f.accounts.payer, opcodes, ...ownerGraph });
    const trades = owner.events.filter(e => e.kind === 'swap');
    assert.equal(trades.length, 2);
    assert.ok(trades.every(e => e.settlement?.status === 'confirmed'), JSON.stringify(trades.map(e => e.issues)));
    const capped = await build(1);
    assert.ok(capped.issues.includes('related_account_limit_reached'));
    await pool.end();
    console.log('Routed market bounded durable graph and immutable publication passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
