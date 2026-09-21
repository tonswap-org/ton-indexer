import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import fastify from 'fastify';
import { parseLedgerMarketBindings } from '../config/ledgerMarkets';
import { DlmmMarketGraphBuilder } from '../ledger/marketGraph';
import { DlmmMarketService } from '../ledger/marketService';
import { registerMarketLedgerRoutes } from '../ledger/marketRoutes';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { PostgresMarketStore } from '../ledger/marketStore';
import { canonicalLedgerHash, normalizeLedgerEvent } from '../ledger/normalize';
import { loadOpcodes } from '../utils/opcodes';
import type { LedgerService } from '../ledger/service';
import type { TonDataSource } from '../data/dataSource';
import type { Logger } from '../utils/logger';
import type { DlmmMarketBinding } from '../ledger/marketTypes';

async function main() {
  const f = JSON.parse(readFileSync(`${__dirname}/fixtures/dlmm-referral-market-current/dlmm-market-settlements.json`, 'utf8'));
  const binding: DlmmMarketBinding = { network: 'localnet', pool: f.accounts.pool, tokenT: f.accounts.tokenT, tokenX: f.accounts.tokenX, tokenTCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash, tokenXCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton/jetton_root.tolk')).codeHash,
    poolCodeHash: f.compiler.find((x: any) => x.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
    walletCodeHash: f.compiler.find((x: any) => x.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash };
  assert.deepEqual(parseLedgerMarketBindings(undefined, 'localnet'), []);
  assert.deepEqual(parseLedgerMarketBindings(JSON.stringify([binding]), 'localnet'), [binding]);
  for (const raw of ['{', '{}', JSON.stringify([binding, binding]), JSON.stringify([{ ...binding, network: 'mainnet' }]),
    JSON.stringify([{ ...binding, tokenX: binding.tokenT }]), JSON.stringify([{ ...binding, walletCodeHash: 'current' }]),
    JSON.stringify([{ ...binding, oldPoolCodeHash: binding.poolCodeHash }])]) assert.throws(() => parseLedgerMarketBindings(raw, 'localnet'));
  const db = new PGlite(), pool = { query: async (sql: string, args?: any[]) => args === undefined ? (await db.exec(sql)).at(-1) ?? { rows: [] } : db.query(sql, args), connect: async () => pool, end: async () => db.close() } as unknown as LedgerSqlPool;
  const ledgerStore = new PostgresLedgerStore(pool), marketStore = new PostgresMarketStore(pool); await ledgerStore.initialize();
  const accounts = [...new Set<string>(f.transactions.map((entry: any) => entry.account))], opcodes = loadOpcodes(), calls: string[] = [];
  for (const account of accounts) {
    const raws = f.transactions.filter((entry: any) => entry.account === account).map((entry: any) => entry.raw), head = raws.at(-1), generation = randomUUID();
    await ledgerStore.begin('localnet', account, generation, { lt: head.lt, hash: canonicalLedgerHash(head.hash) }, new Date((head.utime + 60) * 1000).toISOString());
    const events = await Promise.all(raws.map((raw: any) => normalizeLedgerEvent('localnet', account, raw, opcodes)));
    await ledgerStore.append(generation, events, raws); await ledgerStore.complete('localnet', account, generation);
  }
  for (const boundary of f.boundaries) for (const value of [boundary.before, boundary.after]) {
    const state = { ...value, accountState: value.accountState === 'uninit' ? 'uninitialized' : value.accountState };
    await pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
      ['localnet', boundary.account, state.lastTxLt, canonicalLedgerHash(state.lastTxHash), JSON.stringify({ seqno: 0, state })]);
  }
  const ledger = { network: 'localnet', store: ledgerStore, syncAccount: async (account: string, project: boolean) => { assert.equal(project, false); calls.push(account); return true; } } as unknown as LedgerService;
  const source = {} as TonDataSource, logger: Logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
  const graph = await new DlmmMarketGraphBuilder(ledger, source).build(binding);
  assert.deepEqual(graph.issues, []); assert.ok(graph.nodes.length > 0); assert.ok(graph.dependencies.every(value => value.historyComplete));
  assert.ok(calls.includes(binding.pool)); assert.ok(!calls.includes(f.accounts.tokenT), 'discovery does not recursively traverse unrelated root history');
  const service = new DlmmMarketService(ledger, source, marketStore, [binding], logger); await service.stop(); await service.sync(binding.pool);
  const stored = await marketStore.page('localnet', binding.pool); assert.equal(stored.coverage?.totalObservations, 5); assert.equal(stored.coverage?.historyComplete, true);
  const generation = stored.coverage!.generation;
  await pool.query("UPDATE ledger_accounts SET checked_at=checked_at + interval '1 minute' WHERE network=$1 AND account=$2", ['localnet', binding.pool]);
  await service.sync(binding.pool);
  const refreshed = await marketStore.page('localnet', binding.pool);
  assert.notEqual(refreshed.coverage!.generation, generation, 'quiet chain recheck advances dated coverage');
  assert.deepEqual(refreshed.observations, stored.observations, 'quiet refresh preserves exact historical execution evidence');
  assert.equal((await marketStore.page('localnet', binding.pool, { generation })).coverage!.generation, generation, 'previous coverage remains addressable');
  const app = fastify(); registerMarketLedgerRoutes(app, service); await app.ready();
  const url = `/api/indexer/v1/markets/${encodeURIComponent(binding.pool)}`;
  const page = await app.inject(`${url}/observations?limit=2`); assert.equal(page.statusCode, 200); assert.equal(page.headers['cache-control'], 'no-store');
  const data = page.json(); assert.equal(data.observations.length, 2); assert.equal(data.coverage.generation, refreshed.coverage!.generation); assert.equal(data.refresh, 'idle');
  assert.equal((await app.inject(`${url}/observations?limit=2&cursor=${encodeURIComponent(data.nextCursor)}`)).json().observations.length, 2);
  const candidates = await app.inject(`${url}/candidates?limit=3`); assert.equal(candidates.json().candidates.length, 3);
  assert.equal((await app.inject(`${url}/candidates?cursor=${encodeURIComponent(data.nextCursor)}`)).statusCode, 400);
  for (const suffix of ['?limit=0', '?limit=501', '?from_utime=2&to_utime=1', '?cursor=bad', '?generation=bad']) assert.equal((await app.inject(`${url}/observations${suffix}`)).statusCode, 400);
  assert.equal((await app.inject('/api/indexer/v1/markets/invalid/observations')).statusCode, 400);
  assert.equal((await app.inject(`/api/indexer/v1/markets/${encodeURIComponent(f.accounts.payer)}/observations`)).statusCode, 404);
  const unavailable = fastify(); registerMarketLedgerRoutes(unavailable); assert.equal((await unavailable.inject(`${url}/observations`)).statusCode, 503); await unavailable.close();
  const limited = await new DlmmMarketGraphBuilder(ledger, source, 1).build(binding); assert.ok(limited.issues.includes('market_related_account_limit'));
  await app.close(); await pool.end();
  console.log('Historical market durable graph, service, configuration and API tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
