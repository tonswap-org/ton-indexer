import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, beginCell, type TupleItem } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { lookup } from 'node:dns/promises';
import { projectDlmmLiquidity, verifyDlmmDeposit } from '../ledger/dlmmLiquidity';
import { ledgerSchemas } from '../ledger/openapi';
import type { DlmmProofBinding } from '../ledger/dlmmProof';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from '../ledger/project';
import { canonicalLedgerAddress, canonicalLedgerHash, normalizeLedgerEvent } from '../ledger/normalize';
import { LedgerGraphBuilder } from '../ledger/graph';
import { readDlmmMarketState } from '../ledger/dlmmState';
import { COLLECT, COLLECT_TO, REMOVE, opcode } from '../ledger/wire';
import type { AccountStateResponse, RawTransaction, TonDataSource } from '../data/dataSource';
import type { MarketNode } from '../ledger/marketTypes';
import type { LedgerAsset, LedgerEvidenceRef, LedgerEvent } from '../ledger/types';
import { loadOpcodes } from '../utils/opcodes';
import { PostgresLedgerStore, LedgerCursorError, type LedgerSqlPool } from '../ledger/store';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';

const fixturePath = resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-settlements.json');
const fixtureBytes = readFileSync(fixturePath);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(fixtureBytes.toString());
const frozenJson = JSON.stringify(fixture);
const binding: DlmmProofBinding = { network: 'localnet', pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX,
  poolCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
  walletCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash };
const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
  const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
  return {account: entry.account, raw: entry.raw,
    // Zero names a local fixture archive slot; it is not an invented masterchain block.
    before: {seqno: 0, state: {...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState}},
    after: {seqno: 0, state: {...boundary.after, accountState: boundary.after.accountState === 'uninit' ? 'uninitialized' : boundary.after.accountState}}};
});
const matches = (node: MarketNode, ref: Pick<LedgerEvidenceRef, 'account' | 'lt' | 'hash'>) => node.account === ref.account && node.raw.lt === ref.lt && canonicalLedgerHash(node.raw.hash) === canonicalLedgerHash(ref.hash);
const sourceIntent = (acceptance: LedgerEvidenceRef) => fixture.intents.find((i: any) => fixture.transactions.slice(i.transactionStart, i.transactionEnd).some((t: any) => t.account === acceptance.account && t.raw.lt === acceptance.lt && canonicalLedgerHash(t.raw.hash) === canonicalLedgerHash(acceptance.hash)));
const project = (input = nodes, owner = fixture.accounts.lp) => projectDlmmLiquidity(binding, input, owner);
const success = project();
const checks: {name: string; status: string; error?: string}[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); checks.push({name, status: 'passed'}); console.log('PASS', name); }
  catch (error) { checks.push({name, status: 'failed', error: error instanceof Error ? error.stack : String(error)}); console.error('FAIL', name, error); }
}
function ownerInput(owner: string, input = nodes): ProjectionInput {
  const wallets = new Map<string, LedgerAsset>();
  for (const [name, pair] of Object.entries(fixture.accounts.wallets) as [string, string[]][]) {
    const walletOwner = name === 'other' ? fixture.accounts.otherPayer : fixture.accounts[name];
    for (const [side, wallet] of pair.entries()) {
      const master = side ? binding.tokenX : binding.tokenT;
      // Original root metadata does not document token precision. Keep it unresolved.
      wallets.set(wallet, {kind: 'jetton', id: `localnet:jetton:${master}`, master, wallet, owner: walletOwner});
    }
  }
  const chains = new Map<string, LedgerChain>();
  for (const node of input) {
    if (!chains.has(node.account)) chains.set(node.account, {account: node.account,
      role: node.account === owner ? 'owner' : node.account === binding.pool ? 'pool' : wallets.get(node.account)?.owner === owner ? 'owned_jetton_wallet' : 'counterparty',
      generation: 'sandbox-fixture-complete-physical-history', historyComplete: true, transactions: []});
    chains.get(node.account)!.transactions.push(node.raw);
  }
  return {network: 'localnet', owner, wallets, chains, pools: new Map([[binding.pool, {address: binding.pool, tokenT: binding.tokenT, tokenX: binding.tokenX, codeHash: binding.poolCodeHash}]]),
    opcodes: loadOpcodes(), stateAt: async (account, lt, hash) => {
      const current = input.find(n => matches(n, {account, lt, hash}));
      if (current) return current.after ?? null;
      const next = input.find(n => n.account === account && n.raw.prevTransactionLt === lt && n.raw.prevTransactionHash && canonicalLedgerHash(n.raw.prevTransactionHash) === canonicalLedgerHash(hash));
      return next?.before ?? null;
    }};
}
const relevant = (events: LedgerEvent[]) => events.filter(e => ['lp_withdraw', 'lp_fee_collect'].includes(e.kind));

const graphDiscovery: unknown[] = [];
async function buildDiscovery(label: string, options: {missingRecipientWallet?: boolean; registry?: 'absent' | 'denied'; noOwnerRequest?: boolean} = {}) {
  const intent = fixture.intents.find((row: any) => row.label === label); assert(intent);
  const selected = nodes.slice(intent.transactionStart, intent.transactionEnd);
  const owner = fixture.accounts.lp;
  const ownerTransactions = options.noOwnerRequest ? [] : selected.filter(node => node.account === owner).map(node => node.raw);
  const poolTransactions = selected.filter(node => node.account === binding.pool).map(node => node.raw);
  const current = new Map<string, AccountStateResponse>();
  for (const node of nodes) if (node.after && (!current.has(node.account) || BigInt(current.get(node.account)!.lastTxLt ?? '0') < BigInt(node.raw.lt)))
    current.set(node.account, node.after.state);
  const assets = new Map<string, LedgerAsset>(), balances = new Map<string, string>();
  for (const [account, state] of current) {
    if (!state.codeBoc || !state.dataBoc || Cell.fromBase64(state.codeBoc).hash().toString('hex') !== binding.walletCodeHash) continue;
    const data = readCurrentJettonWalletStorage(Cell.fromBase64(state.dataBoc));
    balances.set(account, data.balance.toString());
    const walletOwner = data.owner.toRawString(), master = data.root.toRawString();
    assets.set(account, {kind: 'jetton', id: `localnet:jetton:${master}`, owner: walletOwner, master, wallet: account});
  }
  const poolState = current.get(binding.pool)!;
  const decoded = readDlmmMarketState(poolState.dataBoc!);
  const guard = Cell.fromBase64(poolState.dataBoc!).refs[2].beginParse();
  const guards = [guard.loadUintBig(128), guard.loadUintBig(128), guard.loadUintBig(16), guard.loadUintBig(16), guard.loadUintBig(128)];
  assert.equal(guard.remainingBits, 0); assert.equal(guard.remainingRefs, 0);
  const addressItem = (value: string | null): TupleItem => ({type: 'slice', cell: beginCell().storeAddress(value ? Address.parse(value) : null).endCell()});
  const intItem = (value: bigint | number): TupleItem => ({type: 'int', value: BigInt(value)});
  const poolStack: TupleItem[] = [addressItem(decoded.tokenT), addressItem(decoded.tokenX), addressItem(decoded.treasury), addressItem(decoded.governance),
    ...[decoded.binSpacing, decoded.activeBinId, decoded.feePips, decoded.impactCapBps, ...guards].map(intItem)];
  // Deliberately synthetic registry qualification for discovery only. No registry was deployed by this fixture.
  const registry = new Address(0, Buffer.alloc(32, 0x72)).toRawString();
  const calls: {method: string; account?: string; master?: string; getter?: string}[] = [], forbiddenCalls: string[] = [], crawled: string[] = [];
  const requireRaw = (account: string) => assert.equal(account, canonicalLedgerAddress(account), 'all datasource and crawler addresses are canonical raw identities');
  const sourceMethods = {
    network: 'localnet',
    getAccountState: async (account: string) => {
      requireRaw(account); calls.push({method: 'getAccountState', account});
      return structuredClone(current.get(account) ?? {balance: '0', accountState: 'uninitialized', lastTxLt: '0'});
    },
    getJettonBalance: async (account: string, master: string) => {
      requireRaw(account); requireRaw(master); calls.push({method: 'getJettonBalance', account, master});
      if (options.missingRecipientWallet && account === fixture.accounts.recipient && master === binding.tokenT) return null;
      const asset = [...assets.values()].find(row => row.owner === account && row.master === master);
      // Provider-friendly wallet strings must be normalized before resolution or persistence.
      return asset?.wallet ? {wallet: Address.parse(asset.wallet).toString(), balance: balances.get(asset.wallet)!} : null;
    },
    runGetMethod: async (account: string, getter: string, args?: TupleItem[]) => {
      requireRaw(account); calls.push({method: 'runGetMethod', account, getter});
      if (account === binding.pool && getter === 'pool_state') return {exitCode: 0, stack: poolStack};
      if (account === registry && getter === 'pool_for') {
        assert.equal(args?.length, 2);
        assert.deepEqual(args!.map(item => { assert.equal(item.type, 'slice'); return (item as {cell: Cell}).cell.beginParse().loadAddress().toRawString(); }), [binding.tokenT, binding.tokenX]);
        return {exitCode: 0, stack: [intItem(options.registry === 'denied' ? 0 : 1), addressItem(binding.pool), ...[0, 0, 0, 0].map(intItem)]};
      }
      throw new Error(`Unexpected read-only fixture getter: ${getter}`);
    },
  };
  const source = new Proxy(sourceMethods, {get(target, key) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key);
    forbiddenCalls.push(String(key)); throw new Error(`Unsupported datasource operation: ${String(key)}`);
  }}) as unknown as TonDataSource;
  const db = new PGlite(); let discoveryReadOnly = false;
  const sql: LedgerSqlPool = {query: async (text, params) => {
    if (discoveryReadOnly) assert(/^SELECT\b/i.test(text.trim()), 'graph discovery never writes or publishes to the local ledger');
    return !params && text.includes(';') ? {rows: (await db.exec(text)).at(-1)?.rows ?? []} : db.query(text, params);
  }, connect: async () => sql, end: () => db.close()};
  try {
    const store = new PostgresLedgerStore(sql); await store.initialize();
    const histories = new Map<string, RawTransaction[]>();
    for (const node of nodes) histories.set(node.account, [...(histories.get(node.account) ?? []), node.raw]);
    histories.set(owner, ownerTransactions); histories.set(binding.pool, poolTransactions);
    const generations = new Map<string, string>();
    const observed = new Date(Math.max(...nodes.map(node => node.raw.utime)) * 1000).toISOString();
    for (const [account, raw] of histories) {
      const generation = randomUUID(); generations.set(account, generation);
      await store.begin('localnet', account, generation, raw.at(-1), observed);
      const events = await Promise.all(raw.map(tx => normalizeLedgerEvent('localnet', account, tx, loadOpcodes(), async wallet => assets.get(wallet) ?? null)));
      await store.append(generation, events, raw); await store.complete('localnet', account, generation, observed);
    }
    assert.deepEqual((await store.rawHistory(generations.get(owner)!)).map(row => row.raw), ownerTransactions);
    discoveryReadOnly = true;
    const builder = new LedgerGraphBuilder('localnet', source, store, [], options.registry === 'absent' ? undefined : registry,
      async wallet => { requireRaw(wallet); return assets.get(wallet) ?? null; },
      async account => { requireRaw(account); crawled.push(account); return true; });
    const graph = await builder.build(owner, generations.get(owner)!, observed);
    assert.deepEqual(forbiddenCalls, [], 'no send, signing, provider writes or unconfigured reads');
    assert(calls.every(call => ['runGetMethod', 'getJettonBalance', 'getAccountState'].includes(call.method)));
    assert([...graph.chains.keys(), ...graph.wallets.keys(), ...graph.pools.keys(), ...crawled].every(account => account === canonicalLedgerAddress(account)));
    assert.equal(JSON.stringify(fixture), frozenJson); assert.equal(sha(readFileSync(fixturePath)), sha(fixtureBytes));
    graphDiscovery.push({label, options, scope: 'targeted graph discovery with actual transaction subsets, real PGlite and synthetic registry responses; not new chain qualification',
      ownerTransactions: ownerTransactions.map(raw => ({lt: raw.lt, hash: raw.hash})), poolTransactions: poolTransactions.map(raw => ({lt: raw.lt, hash: raw.hash})),
      getterPoolDataHash: Cell.fromBase64(poolState.dataBoc!).hash().toString('hex'), calls, crawled, forbiddenCalls,
      chains: [...graph.chains.values()].map(({account, role}) => ({account, role})), pools: [...graph.pools.keys()], issues: graph.issues});
    return {graph, calls, crawled, ownerTransactions, poolTransactions};
  } finally { await sql.end(); }
}

async function main() {
  await test('actual partial withdrawal and four collections have exact source economics and qualified delivery', () => {
    assert.equal(success.length, 5);
    for (const row of success) {
      const intent = sourceIntent(row.acceptance); assert(intent, 'actual source operation');
      assert.deepEqual(row.issues, [], intent.label); assert(row.metadata, intent.label);
      const m = row.metadata!;
      assert.deepEqual(m.economics, {principalTRaw: intent.expected.principalT, principalXRaw: intent.expected.principalX,
        earnedFeeTRaw: intent.expected.feeT, earnedFeeXRaw: intent.expected.feeX, totalTRaw: intent.expected.totalT, totalXRaw: intent.expected.totalX});
      assert.equal(m.sharesBeforeRaw, intent.before.positions.lp.shares); assert.equal(m.sharesAfterRaw, intent.after.positions.lp.shares);
      if (row.kind === 'lp_fee_collect') assert.equal(m.sharesBeforeRaw, m.sharesAfterRaw);
      for (const payout of m.payouts) {
        assert.equal(BigInt(payout.principalRaw) + BigInt(payout.earnedFeeRaw), BigInt(payout.totalRaw));
        assert.equal(payout.status, payout.totalRaw === '0' ? 'none' : 'delivered');
        assert.equal(payout.finalization, payout.totalRaw === '0' ? 'none' : 'confirmed');
        if (payout.totalRaw !== '0') assert(payout.delivery && payout.deliveryEvidence && payout.settlementEvidence);
      }
    }
  });
  await test('query-zero collections retain independent physical operation identities and unchanged input order', () => {
    const collections = success.filter(r => r.kind === 'lp_fee_collect');
    assert(collections.every(row => row.queryId === null));
    assert.equal(new Set(collections.map(row => `${row.metadata!.request.transaction.account}:${row.metadata!.request.transaction.lt}:${row.metadata!.request.transaction.hash}`)).size, 4);
    assert.deepEqual(project([...nodes].reverse()).sort((a,b)=>a.acceptance.lt.localeCompare(b.acceptance.lt)), [...success].sort((a,b)=>a.acceptance.lt.localeCompare(b.acceptance.lt)));
    const drained = success.at(-2)!, zero = success.at(-1)!;
    assert.equal(drained.metadata!.request.bodyHash, zero.metadata!.request.bodyHash);
    assert.notEqual(drained.acceptance.hash, zero.acceptance.hash);
    assert(zero.metadata!.payouts.every(p => p.status === 'none' && p.settlementId === null));
  });
  const owned = await projectOwnerLedger(ownerInput(fixture.accounts.lp));
  const received = await projectOwnerLedger(ownerInput(fixture.accounts.recipient));
  const rows = relevant(owned.events);
  await test('canonical owner evidence uses original base64 transaction identities and no invented collection query', () => {
    let checked = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const row = value as Record<string, unknown>;
      if (typeof row.account === 'string' && typeof row.lt === 'string' && typeof row.hash === 'string') {
        assert.equal(row.hash, canonicalLedgerHash(row.hash));
        assert(nodes.some(node => matches(node, row as LedgerEvidenceRef)), 'reference identifies an actual original transaction');
        checked++;
      }
      for (const child of Object.values(row)) visit(child);
    };
    visit(success); visit(rows); assert(checked > 100, 'checks nested request, delivery and settlement references');
    for (const event of rows.filter(row => row.kind === 'lp_fee_collect')) {
      assert(!Object.hasOwn(event.settlement!, 'queryId'));
      const request = event.settlement!.dlmmLiquidity!.request;
      assert(/^[a-f0-9]{64}$/.test(request.bodyHash), 'cell hashes remain hexadecimal');
      const source = nodes.find(node => matches(node, request.transaction))!;
      assert.equal(Cell.fromBase64(source.raw.inMessage!.body!).hash().toString('hex'), request.bodyHash);
    }
    assert.equal(sha(readFileSync(fixturePath)), sha(fixtureBytes));
    assert.equal(JSON.stringify(fixture), frozenJson);
  });
  await test('actual paired add credits only the intended LP after both physical deposits', () => {
    const deposits = owned.events.filter(e=>e.kind==='lp_deposit'); assert.equal(deposits.length,1);
    assert.equal(deposits[0].settlement?.status,'confirmed');
    const tokens = deposits[0].movements.filter(m=>m.asset.kind==='jetton');
    assert.equal(tokens.length,2);assert(tokens.every(m=>m.direction==='out'&&m.amountRaw==='1000003'));
    const position = deposits[0].movements.filter(m=>m.asset.kind==='lp_position');
    assert.equal(position.length,1);assert.equal(position[0].direction,'in');assert.equal(position[0].amountRaw,'2000006');
  });
  const deposit = owned.events.find(event => event.kind === 'lp_deposit')!;
  const marker = deposit.movements.find(movement => movement.asset.kind === 'lp_position')!;
  await test('deposit evidence binds both original physical movements and exact archived shares without inventing value', () => {
    const m = marker.evidence.dlmmDeposit; assert(m);
    assert.equal(m.network, 'localnet'); assert.equal(m.owner, fixture.accounts.lp);
    assert.equal(m.pool, binding.pool); assert.equal(m.poolCodeHash, binding.poolCodeHash); assert.equal(m.walletCodeHash, binding.walletCodeHash);
    assert.equal(m.sharesBeforeRaw, '0'); assert.equal(m.sharesAfterRaw, '2000006'); assert.equal(m.mintedSharesRaw, marker.amountRaw);
    assert.equal(BigInt(m.sharesAfterRaw) - BigInt(m.sharesBeforeRaw), BigInt(m.mintedSharesRaw));
    assert(BigInt(m.mintedSharesRaw) >= BigInt(m.minSharesRaw));
    assert.equal(m.contributions.length, 2); assert.deepEqual(m.contributions.map(c => c.tokenSide).sort(), [0, 1]);
    assert.equal(new Set(m.contributions.map(c => c.movementId)).size, 2);
    for (const c of m.contributions) {
      const movement = deposit.movements.find(row => row.id === c.movementId); assert(movement);
      assert.equal(movement.direction, 'out'); assert.equal(movement.asset.id, c.assetId);
      assert.equal(movement.amountRaw, c.amountRaw); assert.equal(c.amountRaw, '1000003');
      assert.equal(movement.source, m.owner); assert.equal(movement.destination, m.pool);
      assert.equal(c.assetId, `localnet:jetton:${c.master}`); assert.equal(movement.asset.decimals, undefined);
      assert.equal(c.requestBodyHash, movement.evidence.requestBodyHash);
      assert.equal(c.origin.account, m.owner); assert.equal(c.debit.account, c.sourceWallet);
      assert.equal(c.credit.account, c.destinationWallet); assert.equal(c.acceptance.account, m.pool);
      assert.notEqual(c.transferQueryId, m.queryId); assert.equal(c.boundaries.length, 3);
      for (const evidence of [c.origin, c.debit, c.credit, c.acceptance, ...c.boundaries.map(b => b.transaction)]) {
        assert.equal(Buffer.from(evidence.hash, 'base64').length, 32); assert.equal(canonicalLedgerHash(evidence.hash), evidence.hash);
        assert(nodes.some(node => matches(node, evidence) && node.raw.utime === evidence.utime));
      }
      for (const b of c.boundaries) {
        const node = nodes.find(node => matches(node, b.transaction))!;
        assert.equal(b.beforeDataHash, node.before!.state.dataBoc ? Cell.fromBase64(node.before!.state.dataBoc).hash().toString('hex') : null);
        assert.equal(b.afterDataHash, Cell.fromBase64(node.after!.state.dataBoc!).hash().toString('hex'));
        assert.equal(b.codeHash, Cell.fromBase64(node.after!.state.codeBoc!).hash().toString('hex'));
      }
      assert.equal(Cell.fromBase64(nodes.find(node => matches(node, c.acceptance))!.raw.inMessage!.body!).hash().toString('hex'), c.notificationBodyHash);
      assert(BigInt(c.origin.lt) < BigInt(c.debit.lt) && BigInt(c.debit.lt) < BigInt(c.credit.lt) && BigInt(c.credit.lt) < BigInt(c.acceptance.lt));
    }
    assert.equal(m.stateBefore.dataHash, marker.evidence.stateBeforeHash); assert.equal(m.stateAfter.dataHash, marker.evidence.stateAfterHash);
    assert(nodes.some(node => matches(node, m.stateBefore.transaction))); assert(nodes.some(node => matches(node, m.stateAfter.transaction)));
    assert.deepEqual(Object.keys(m).sort(), ledgerSchemas.DlmmDepositMetadata.required.slice().sort());
    for (const contribution of m.contributions) assert.deepEqual(Object.keys(contribution).sort(), ledgerSchemas.DlmmDepositMetadata.properties.contributions.items.required.slice().sort());
    assert.equal(JSON.stringify(fixture), frozenJson);
  });
  if (marker.evidence.dlmmDeposit) {
    const m = marker.evidence.dlmmDeposit, refs = m.contributions.map(c => c.acceptance);
    const sourceChanges: [string, (input: MarketNode[]) => MarketNode[]][] = [
      ['missing original owner request', input => input.filter(n => !matches(n, m.contributions[0].origin))],
      ['missing funded debit', input => input.filter(n => !matches(n, m.contributions[0].debit))],
      ['missing pool-wallet credit', input => input.filter(n => !matches(n, m.contributions[1].credit))],
      ['missing contribution acceptance', input => input.filter(n => !matches(n, m.contributions[1].acceptance))],
      ['missing source-wallet archive', input => { input.find(n => matches(n, m.contributions[0].debit))!.before = null; return input; }],
      ['wrong credited wallet code', input => { input.find(n => matches(n, m.contributions[1].credit))!.after!.state.codeBoc = beginCell().storeUint(1, 1).endCell().toBoc().toString('base64'); return input; }],
      ['future pool archive substituted', input => { input.find(n => matches(n, m.stateAfter.transaction))!.before!.state.lastTxLt = nodes.at(-1)!.raw.lt; return input; }],
    ];
    for (const [name, change] of sourceChanges) await test(`deposit does not publish position evidence with ${name}`, async () => {
      const modified = change(structuredClone(nodes)), before = JSON.stringify(modified);
      assert.throws(() => verifyDlmmDeposit(binding, modified, fixture.accounts.lp, refs));
      const input = ownerInput(fixture.accounts.lp, modified), lookup = input.stateAt;
      // The projection hydrates a boundary from its predecessor's after-state.
      // Inject a changed archive response at that exact identity as well; merely
      // deleting a redundant next.before object leaves valid archived evidence.
      const changedBefore = modified.filter(node => JSON.stringify(node.before) !== JSON.stringify(nodes.find(original => matches(original, {account: node.account, lt: node.raw.lt, hash: node.raw.hash}))?.before));
      input.stateAt = async (account, lt, hash) => {
        const changed = changedBefore.find(node => node.account === account && node.raw.prevTransactionLt === lt && canonicalLedgerHash(node.raw.prevTransactionHash!) === canonicalLedgerHash(hash));
        return changed ? changed.before ?? null : lookup(account, lt, hash);
      };
      const projection = await projectOwnerLedger(input);
      assert(!projection.events.flatMap(e => e.movements).some(m => m.evidence.dlmmDeposit));
      assert.equal(JSON.stringify(modified), before); assert.equal(JSON.stringify(fixture), frozenJson);
    });
    await test('deposit proof rejects reused acceptance and a different owner without merging equal funding', () => {
      assert.throws(() => verifyDlmmDeposit(binding, nodes, fixture.accounts.lp, [refs[0], refs[0]]));
      assert.throws(() => verifyDlmmDeposit(binding, nodes, fixture.accounts.otherPayer, refs));
    });
  }
  await test('owner ledger records one physical receipt per token and keeps principal plus fee as components', () => {
    assert.equal(rows.length, 5);
    for (const event of rows) {
      assert.equal(event.settlement?.status, 'confirmed', JSON.stringify(event.issues));
      const m = event.settlement!.dlmmLiquidity!; assert(m);
      const jettons = event.movements.filter(x => x.asset.kind === 'jetton');
      assert.equal(jettons.length, m.recipient === fixture.accounts.lp ? m.payouts.filter(p => p.totalRaw !== '0').length : 0);
      for (const payout of m.payouts) {
        if (payout.totalRaw === '0' || m.recipient !== fixture.accounts.lp) { assert.equal(payout.movementId, null); continue; }
        const movement = jettons.find(x => x.id === payout.movementId)!; assert(movement);
        assert.equal(movement.amountRaw, payout.totalRaw); assert.equal(movement.direction, 'in');
        assert.equal(movement.evidence.dlmmReceipt?.principalRaw, payout.principalRaw);
        assert.equal(movement.evidence.dlmmReceipt?.earnedFeeRaw, payout.earnedFeeRaw);
      }
      const positions = event.movements.filter(x => x.asset.kind === 'lp_position');
      assert.equal(positions.length, event.kind === 'lp_withdraw' ? 1 : 0);
      if (positions.length) { assert.equal(positions[0].direction, 'out'); assert.equal(positions[0].amountRaw, '666667'); }
    }
    const allMovements = owned.events.flatMap(e => e.movements.map(m => m.id)); assert.equal(new Set(allMovements).size, allMovements.length);
    const sums = [binding.tokenT, binding.tokenX].map(master => rows.flatMap(e => e.movements).filter(m => m.asset.master === master && m.direction === 'in').reduce((n,m)=>n+BigInt(m.amountRaw),0n));
    assert.deepEqual(sums, [321146n, 345909n]);
  });
  await test('distinct recipient owns delivered token movements without receiving the LP owner position or fee classification', () => {
    assert.equal(project(nodes, fixture.accounts.recipient).length, 0);
    assert.equal(relevant(received.events).length, 0);
    assert(!received.events.flatMap(e => e.movements).some(m => m.asset.kind === 'lp_position'));
    const jettons = received.events.flatMap(e => e.movements).filter(m => m.asset.kind === 'jetton');
    assert.deepEqual(jettons.map(m=>[m.asset.master,m.direction,m.amountRaw]).sort(), [[binding.tokenT,'in','77']]);
    assert(jettons.every(m => m.asset.owner === fixture.accounts.recipient && !m.evidence.dlmmReceipt));
  });
  const target = success.find(r => r.kind === 'lp_withdraw')!;
  if (target.metadata?.payouts[0].settlementEvidence) {
    const payout = target.metadata.payouts[0], settlement = payout.settlementEvidence!;
    const alter = (input: MarketNode[], ref: LedgerEvidenceRef) => input.find(n => matches(n,ref))!;
    const negatives: {name:string; mutate:(input:MarketNode[])=>MarketNode[]}[] = [
      {name:'missing owner source transaction',mutate:input=>input.filter(n=>!matches(n,target.origin!))},
      {name:'missing recipient delivery',mutate:input=>input.filter(n=>!matches(n,settlement.credit))},
      {name:'missing source wallet debit',mutate:input=>input.filter(n=>!matches(n,settlement.debit))},
      {name:'missing wallet finalizer',mutate:input=>input.filter(n=>!matches(n,settlement.walletFinalized))},
      {name:'missing pool finalization',mutate:input=>input.filter(n=>!matches(n,settlement.poolFinalized))},
      {name:'missing pool state archive',mutate:input=>{alter(input,target.acceptance).before=null;return input;}},
      {name:'future pool archive identity',mutate:input=>{alter(input,target.acceptance).before!.state.lastTxLt=nodes.at(-1)!.raw.lt;return input;}},
      {name:'reversed archive ordering',mutate:input=>{alter(input,target.acceptance).before!.seqno=1;return input;}},
      {name:'wrong historical wallet code',mutate:input=>{alter(input,settlement.credit).after!.state.codeBoc=beginCell().storeUint(123,32).endCell().toBoc().toString('base64');return input;}},
      {name:'missing raw recipient body',mutate:input=>{delete alter(input,settlement.credit).raw.inMessage!.body;return input;}},
      {name:'wrong created logical time',mutate:input=>{alter(input,settlement.credit).raw.inMessage!.createdLt='1';return input;}},
      {name:'wrong physical recipient',mutate:input=>{alter(input,settlement.credit).raw.inMessage!.destination=fixture.accounts.lp;return input;}},
      {name:'failed recipient delivery',mutate:input=>{alter(input,settlement.credit).raw.success=false;alter(input,settlement.credit).raw.status='failed';return input;}},
      {name:'wrong settlement nonce',mutate:input=>{const n=alter(input,settlement.credit),s=Cell.fromBase64(n.raw.inMessage!.body!).beginParse(),op=s.loadUint(32);s.loadUintBig(64);n.raw.inMessage!.body=beginCell().storeUint(op,32).storeUint(1,64).storeSlice(s).endCell().toBoc().toString('base64');return input;}},
    ];
    for (const negative of negatives) await test('rejects '+negative.name+' without inventing a qualified withdrawal', () => {
      const input = negative.mutate(structuredClone(nodes)), before = JSON.stringify(input);
      const candidate = project(input).find(r=>r.acceptance.hash === target.acceptance.hash)!;
      assert(candidate && candidate.issues.length > 0, negative.name);
      assert.equal(JSON.stringify(input),before, 'negative input retained');
      assert(project(input).some(r=>r.kind==='lp_fee_collect'&&!r.issues.length), 'independent later collection remains available');
    });
    for (const [label, missing] of [['pool acknowledgement',settlement.acknowledged],['wallet finalizer',settlement.walletFinalized],['pool finalization',settlement.poolFinalized]] as const) {
      await test('missing '+label+' preserves actual delivered receipt and LP burn while finalization remains unresolved', async () => {
        const input = nodes.filter(n=>!matches(n,missing)), before = JSON.stringify(input);
        const row = project(input).find(r=>r.acceptance.hash===target.acceptance.hash)!;
        assert(row.issues.length,'overall settlement cannot be confirmed');
        const component = row.metadata!.payouts[0];
        assert.equal(component.status,'delivered');assert.equal(component.finalization,'unresolved');
        assert.deepEqual(component.delivery,payout.delivery);assert(component.deliveryEvidence);
        assert.deepEqual(component.deliveryEvidence.credit,payout.deliveryEvidence!.credit);
        assert.equal(component.settlementEvidence,undefined);
        assert.equal(component.totalRaw,'320912');assert.equal(component.principalRaw,'320757');assert.equal(component.earnedFeeRaw,'155');
        const projection = await projectOwnerLedger(ownerInput(fixture.accounts.lp,input));
        const event = relevant(projection.events).find(e=>e.kind==='lp_withdraw')!;
        assert.equal(event.settlement?.status,'incomplete');
        const positions = event.movements.filter(m=>m.asset.kind==='lp_position');
        assert.equal(positions.length,1);assert.equal(positions[0].direction,'out');assert.equal(positions[0].amountRaw,'666667');
        const tokens = event.movements.filter(m=>m.asset.kind==='jetton');assert.equal(tokens.length,2);
        assert.deepEqual(tokens.map(m=>m.amountRaw).sort(),['320912','345909']);
        const original = rows.find(e=>e.kind==='lp_withdraw')!.settlement!.dlmmLiquidity!.payouts[0];
        const movement = tokens.find(m=>m.id===original.movementId)!;assert(movement);
        assert.deepEqual(movement.evidence.dlmmReceipt?.delivery,original.delivery);
        assert.equal(movement.evidence.dlmmReceipt?.principalRaw,'320757');assert.equal(movement.evidence.dlmmReceipt?.earnedFeeRaw,'155');
        assert.equal(projection.events.flatMap(e=>e.movements).filter(m=>m.id===original.movementId).length,1,'physical cash is counted once');
        assert.equal(JSON.stringify(input),before);
      });
    }
    await test('one missing payout retains the independently delivered sibling without asserting full settlement', async () => {
      const missing = target.metadata!.payouts[1].delivery!;
      const input = nodes.filter(n=>!matches(n,missing));
      const row = project(input).find(r=>r.acceptance.hash===target.acceptance.hash)!;
      assert(row.issues.length);assert.equal(row.metadata!.payouts[0].status,'delivered');assert.equal(row.metadata!.payouts[1].status,'unresolved');
      assert.equal(row.metadata!.payouts[1].finalization,'unresolved');assert.equal(row.metadata!.payouts[1].delivery,null);assert.equal(row.metadata!.payouts[1].deliveryEvidence,undefined);
      const event = relevant((await projectOwnerLedger(ownerInput(fixture.accounts.lp,input))).events).find(e=>e.kind==='lp_withdraw')!;
      assert.equal(event.settlement?.status,'incomplete');
      const physical = event.movements.filter(m=>m.asset.kind==='jetton');
      assert.deepEqual(physical.map(m=>[m.asset.master,m.amountRaw]),[[binding.tokenT,'320912']]);
      assert.equal(event.settlement!.dlmmLiquidity!.payouts[1].movementId,null);
    });
    await test('owner projection retains actual receipt amounts when archive qualification is missing', async () => {
      const input = ownerInput(fixture.accounts.lp); const lookup = input.stateAt;
      input.stateAt = async (account,lt,hash)=>account===target.acceptance.account&&lt===target.acceptance.lt?null:lookup(account,lt,hash);
      const projection = await projectOwnerLedger(input);
      const altered = relevant(projection.events).find(e=>e.kind==='lp_withdraw')!;
      assert.equal(altered.settlement?.status,'incomplete');
      assert(!altered.settlement?.dlmmLiquidity);
      assert(!altered.movements.some(m=>m.asset.kind==='lp_position'));
      const ids = rows.find(e=>e.kind==='lp_withdraw')!.settlement!.dlmmLiquidity!.payouts.map(p=>p.movementId);
      const physical = projection.events.flatMap(e=>e.movements).filter(m=>ids.includes(m.id));
      const actual = physical.map(m=>m.amountRaw).sort();
      assert.deepEqual(actual,['320912','345909']);
      assert(physical.every(m=>!m.evidence.dlmmReceipt),'unqualified protocol components must not label unrelated cash movements');
    });
    await test('missing related-account history cannot certify full owner settlement', async () => {
      const input = ownerInput(fixture.accounts.lp); input.chains.get(settlement.credit.account)!.historyComplete=false;
      const altered = relevant((await projectOwnerLedger(input)).events).find(e=>e.kind==='lp_withdraw')!;
      assert.equal(altered.settlement?.status,'incomplete');
    });
  }
  await test('duplicate physical transaction is rejected and original fixture bytes stay immutable', () => {
    assert(project([...nodes,nodes[90]]).every(r=>r.issues.length));
    assert.equal(JSON.stringify(fixture),frozenJson);assert.equal(sha(readFileSync(fixturePath)),sha(fixtureBytes));
  });
  for (const [label, op] of [['partial-withdrawal-with-earned-fees', REMOVE], ['partial-collect-owner', COLLECT], ['partial-collect-distinct-recipient', COLLECT_TO]] as const) {
    await test(`graph discovers ${label} from its original owner request and keeps recipient custody separate`, async () => {
      const result = await buildDiscovery(label), {graph} = result;
      assert(result.ownerTransactions.some(tx => tx.outMessages.some(message => opcode(message) === op && message.destination === binding.pool)));
      assert.deepEqual([...graph.pools.keys()], [binding.pool]); assert(result.crawled.includes(binding.pool));
      assert.equal(graph.pools.get(binding.pool)!.codeHash, binding.poolCodeHash);
      for (const wallet of fixture.accounts.wallets.lp) assert.equal(graph.chains.get(wallet)?.role, 'owned_jetton_wallet');
      for (const wallet of fixture.accounts.wallets.pool) assert.equal(graph.chains.get(wallet)?.role, 'counterparty');
      assert(!graph.issues.includes('dlmm_recipient_wallet_unresolved'));
      if (op === COLLECT_TO) {
        for (const wallet of [fixture.accounts.wallets.recipient[0]]) {
          assert.equal(graph.chains.get(wallet)?.role, 'counterparty');
          assert.equal(graph.wallets.get(wallet)?.owner, fixture.accounts.recipient);
          assert(result.crawled.includes(wallet));
        }
        assert(!graph.wallets.has(fixture.accounts.wallets.recipient[1]), 'zero X payout has no deployed recipient wallet');
        assert(!result.calls.some(call => call.method === 'getJettonBalance' && call.account === fixture.accounts.recipient && call.master === binding.tokenX), 'zero payout does not request unrelated recipient history');
        assert(![...graph.chains.values()].some(chain => chain.role === 'owned_jetton_wallet' && graph.wallets.get(chain.account)?.owner !== fixture.accounts.lp));
      }
    });
  }
  await test('zero-credit original collection discovers its pool without any payout or earlier pool transaction', async () => {
    const result = await buildDiscovery('collect-zero-credit-rerun');
    assert.equal(result.ownerTransactions.length, 1); assert.equal(result.poolTransactions.length, 1);
    assert(result.ownerTransactions[0].outMessages.some(message => opcode(message) === COLLECT));
    assert.equal(result.poolTransactions[0].outMessages.length, 0);
    assert.deepEqual([...result.graph.pools.keys()], [binding.pool]);
    assert(!result.calls.some(call => call.account === fixture.accounts.recipient), 'an earlier external recipient is not fabricated for the isolated empty collection');
  });
  await test('missing positive recipient payout remains unresolved without inventing a zero-side wallet', async () => {
    const {graph} = await buildDiscovery('partial-collect-distinct-recipient', {missingRecipientWallet: true});
    assert(graph.pools.has(binding.pool)); assert(graph.issues.includes('dlmm_recipient_wallet_unresolved'));
    assert(!graph.wallets.has(fixture.accounts.wallets.recipient[0]));
    assert(!graph.chains.has(fixture.accounts.wallets.recipient[1]));
    assert(!graph.wallets.has(fixture.accounts.wallets.recipient[1]));
  });
  await test('unqualified registry cannot promote an original collection destination to a pool', async () => {
    for (const registry of ['absent', 'denied'] as const) {
      const {graph, crawled} = await buildDiscovery('partial-collect-owner', {registry});
      assert.equal(graph.pools.size, 0); assert(graph.issues.includes('protocol_pool_identity_unresolved'));
      assert(!crawled.includes(binding.pool));
    }
  });
  await test('related pool requests alone do not invent connected-owner discovery without an owner request', async () => {
    const {graph, calls, crawled} = await buildDiscovery('partial-collect-distinct-recipient', {noOwnerRequest: true});
    assert.equal(graph.pools.size, 0); assert.deepEqual(calls, []); assert.deepEqual(crawled, []);
    assert.deepEqual([...graph.chains.keys()], [fixture.accounts.lp]);
  });
  const verifyPersistence = async (sql: LedgerSqlPool) => {
    const store = new PostgresLedgerStore(sql), pristine = JSON.stringify({owned,received});
    try {
      await store.initialize();
      const publish = async (owner:string, projection:typeof owned) => {
        const generation = randomUUID(), head = [...nodes].reverse().find(n=>n.account===owner)!.raw;
        const observed = new Date((head.utime+1)*1000).toISOString();
        await store.begin('localnet',owner,generation,{lt:head.lt,hash:head.hash},observed);
        await store.project(generation,projection,[],['local_sandbox_scope_only','jetton_precision_unresolved']);
        await store.project(generation,projection,[],['local_sandbox_scope_only','jetton_precision_unresolved']);
        await store.complete('localnet',owner,generation,observed);
        return generation;
      };
      const first = await publish(fixture.accounts.lp,owned);
      const page = await store.page('localnet',fixture.accounts.lp,{limit:2});assert.equal(page.coverage.generation,first);assert(page.nextCursor);
      const second = await publish(fixture.accounts.lp,owned);
      assert.notEqual(first,second);
      const all = [...page.events];let cursor: string | null = page.nextCursor;
      while(cursor) {
        const next = await store.page('localnet',fixture.accounts.lp,{limit:2,cursor});
        assert.equal(next.coverage.generation,first,'cursor remains pinned across repeated exact publication');all.push(...next.events);cursor=next.nextCursor;
      }
      const ordered = (events:LedgerEvent[])=>[...events].sort((a,b)=>a.id.localeCompare(b.id));
      assert.deepEqual(ordered(all),ordered(JSON.parse(JSON.stringify(owned.events))));
      assert.equal(new Set(all.map(e=>e.id)).size,owned.events.length);
      const resumed = new PostgresLedgerStore(sql);
      assert.deepEqual(relevant((await resumed.page('localnet',fixture.accounts.lp,{limit:500})).events),relevant(page.events.concat(all.slice(page.events.length))));
      for(const e of relevant(all)) for(const p of e.settlement!.dlmmLiquidity!.payouts) {
        assert.equal(typeof p.totalRaw,'string');assert.equal(typeof p.principalRaw,'string');assert.equal(typeof p.earnedFeeRaw,'string');
        if(p.delivery) assert.equal(typeof p.delivery.lt,'string');
      }
      await publish(fixture.accounts.recipient,received);
      const recipientPage = await store.page('localnet',fixture.accounts.recipient,{limit:500});
      assert.deepEqual(ordered(recipientPage.events),ordered(JSON.parse(JSON.stringify(received.events))));
      assert(recipientPage.events.every(e=>!e.settlement?.dlmmLiquidity),'separate owner scope does not inherit LP ownership');
      await assert.rejects(()=>store.page('localnet',fixture.accounts.recipient,{cursor:page.nextCursor!}),LedgerCursorError);
      await assert.rejects(()=>store.page('mainnet',fixture.accounts.lp,{cursor:page.nextCursor!}),LedgerCursorError);
      await assert.rejects(()=>store.project(first,owned,[],[]),/not writable/);
      assert.equal(JSON.stringify({owned,received}),pristine);
      assert.equal(sha(readFileSync(fixturePath)),sha(fixtureBytes));
    } finally { await sql.end(); }
  };
  await test('PGlite JSON and cursor roundtrip retains actual DLMM components, publication identity and owner isolation', async () => {
    const db = new PGlite();
    // One local PostgreSQL engine session checks persistence, not concurrent connection locks.
    const sql: LedgerSqlPool = {query:async (text,params)=>!params&&text.includes(';')?{rows:(await db.exec(text)).at(-1)?.rows??[]}:db.query(text,params),
      connect:async()=>sql,end:()=>db.close()};
    await verifyPersistence(sql);
  });
  if (process.env.LEDGER_LIQUIDITY_TEST_DATABASE_URL) await test('native loopback PostgreSQL preserves the same exact owner projections in an isolated schema', async () => {
    const value = process.env.LEDGER_LIQUIDITY_TEST_DATABASE_URL!, url = new URL(value);
    assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1','[::1]','localhost'].includes(url.hostname) && !url.search && !url.hash,
      'Native fixture database must be a loopback PostgreSQL URL without connection overrides');
    if (url.hostname === 'localhost') assert((await lookup('localhost',{all:true})).every(row=>row.address==='127.0.0.1'||row.address==='::1'),'localhost must resolve only to loopback');
    const schema = `dlmm_liquidity_${randomUUID().replace(/-/g,'')}`;
    const admin = new Pool({connectionString:value,max:1});let created=false;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);created=true;
      const native = new Pool({connectionString:value,max:2,options:`-c search_path=${schema}`});
      await verifyPersistence(native as unknown as LedgerSqlPool);
    } finally {
      if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  if (process.env.DLMM_LIQUIDITY_EVIDENCE_OUT) {
    const dir=resolve(process.env.DLMM_LIQUIDITY_EVIDENCE_OUT);mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'results.json'),JSON.stringify({fixtureSha256:sha(fixtureBytes),checks,passed:checks.filter(c=>c.status==='passed').length,failed:checks.filter(c=>c.status==='failed').length},null,2)+'\n');
    writeFileSync(resolve(dir,'graph-discovery.json'),JSON.stringify({fixtureSha256:sha(fixtureBytes),cases:graphDiscovery},null,2)+'\n');
    writeFileSync(resolve(dir,'owner-ledger.json'),JSON.stringify({schema:'dlmm-liquidity-owner-fixture-v1',network:'localnet',fixtureSha256:sha(fixtureBytes),binding,
      limitations:['Actual local Sandbox source movements; no fiat value or tax classification','Token metadata precision remains unresolved','Native treasury setup funding is simulator-only'],
      owner:fixture.accounts.lp,projection:owned,recipient:fixture.accounts.recipient,recipientProjection:received,pureCandidates:success},null,2)+'\n');
  }
  assert(checks.every(c=>c.status==='passed'), `${checks.filter(c=>c.status==='failed').length} DLMM liquidity checks failed`);
  console.log(`DLMM liquidity actual evidence tests passed (${checks.length} groups)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
