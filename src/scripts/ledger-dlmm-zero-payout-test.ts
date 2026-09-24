import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cell, loadTransaction } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { projectDlmmLiquidity } from '../ledger/dlmmLiquidity';
import type { DlmmProofBinding } from '../ledger/dlmmProof';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import type { MarketNode } from '../ledger/marketTypes';
import type { LedgerAsset, LedgerEvidenceRef, LedgerEvent } from '../ledger/types';
import { loadOpcodes } from '../utils/opcodes';
import { PostgresLedgerStore, LedgerCursorError, type LedgerSqlPool } from '../ledger/store';

const fixturePath = resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/dlmm-zero-payout-settlements.json');
const fixtureBytes = readFileSync(fixturePath);
const provenance = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/provenance.json'), 'utf8'));
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

async function main() {
  const owned = await projectOwnerLedger(ownerInput(fixture.accounts.lp));
  const otherOwner = fixture.accounts.otherPayer;
  const other = await projectOwnerLedger(ownerInput(otherOwner));
  const ownerRows = relevant(owned.events), otherRows = relevant(other.events);
  if (process.env.DLMM_ZERO_PAYOUT_EVIDENCE_OUT) {
    const dir = resolve(process.env.DLMM_ZERO_PAYOUT_EVIDENCE_OUT); mkdirSync(dir, {recursive: true});
    writeFileSync(resolve(dir, 'owner-ledger.json'), JSON.stringify({schema: 'dlmm-zero-payout-owner-fixture-v1', network: 'localnet', fixtureSha256: sha(fixtureBytes), binding,
      limitations: ['Actual current-contract Sandbox movements; no fiat value or tax classification', 'Original token precision remains unresolved', 'Sandbox native treasury funding is explicitly documented outside chain transactions'],
      owner: fixture.accounts.lp, projection: owned, otherOwner, otherProjection: other,
      pureCandidates: success, otherCandidates: project(nodes, otherOwner),
      sourceCoverage: [...ownerInput(fixture.accounts.lp).chains.values()].map(chain => ({account: chain.account, role: chain.role, generation: chain.generation, historyComplete: chain.historyComplete, transactionCount: chain.transactions.length}))}, null, 2)+'\n');
  }
  await test('fixture is authentic current-contract execution with no seeded token or position state', () => {
    assert.equal(sha(fixtureBytes), provenance.files.find((row: any) => row.file === 'dlmm-zero-payout-settlements.json').sha256);
    assert.equal(binding.poolCodeHash, provenance.poolCodeHash);
    const count=provenance.files.find((row: any) => row.file === 'dlmm-zero-payout-settlements.json').transactions;
    assert.equal(fixture.transactions.length,count);assert.equal(fixture.boundaries.length,count);assert(count>=87);
    for (const entry of fixture.transactions) {
      const cell = Cell.fromBase64(entry.transactionBoc), tx = loadTransaction(cell.beginParse());
      assert.equal(cell.hash().toString('hex'), entry.raw.hash);
      assert.equal(tx.lt.toString(), entry.raw.lt); assert.equal(tx.now, entry.raw.utime);
      const boundary = fixture.boundaries.find((row: any) => row.account === entry.account && row.transactionHash === entry.raw.hash);
      assert.equal(Cell.fromBase64(boundary.before.shardAccountBoc).refs[0].hash().toString('hex'), tx.stateUpdate.oldHash.toString('hex'));
      assert.equal(Cell.fromBase64(boundary.after.shardAccountBoc).refs[0].hash().toString('hex'), tx.stateUpdate.newHash.toString('hex'));
    }
    assert.deepEqual(fixture.intents.slice(0, 2).map((row: any) => [row.amountT, row.amountX, row.mintedShares]), [['1','1','2'],['1','1','2']]);
    assert.equal(fixture.compiler.find((row: any) => row.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash, binding.poolCodeHash);
  });
  for (const [label, before, after] of [['partial-withdrawal-zero-dust', '2', '1'], ['full-owner-withdrawal-zero-dust', '1', '0']] as const) {
    await test(`${label} preserves real share burn, zero components and native completion without token movements`, () => {
      const candidate = success.find(row => sourceIntent(row.acceptance)?.label === label); assert(candidate);
      assert.deepEqual(candidate.issues, []); assert.equal(candidate.kind, 'lp_withdraw'); assert(candidate.metadata); assert(candidate.completion);
      const m = candidate.metadata;
      assert.equal(m.sharesBeforeRaw, before); assert.equal(m.sharesAfterRaw, after); assert.equal(m.request.sharesRaw, '1');
      assert.deepEqual(m.economics, {principalTRaw:'0',principalXRaw:'0',earnedFeeTRaw:'0',earnedFeeXRaw:'0',totalTRaw:'0',totalXRaw:'0'});
      assert.equal(m.payouts.length, 2);
      for (const payout of m.payouts) {
        assert.equal(payout.status, 'none'); assert.equal(payout.finalization, 'none');
        assert.equal(payout.totalRaw, '0'); assert.equal(payout.principalRaw, '0'); assert.equal(payout.earnedFeeRaw, '0');
        assert.equal(payout.settlementId, null); assert.equal(payout.movementId, null); assert.equal(payout.delivery, null);
        assert.equal(payout.deliveryEvidence, undefined); assert.equal(payout.settlementEvidence, undefined);
      }
      const event = ownerRows.find(row => row.settlement?.queryId === candidate.queryId); assert(event);
      assert.equal(event.settlement?.status, 'confirmed'); assert.equal(event.kind, 'lp_withdraw');
      assert.deepEqual(event.movements.filter(row => row.asset.kind === 'jetton'), []);
      const marker = event.movements.filter(row => row.asset.kind === 'lp_position');
      assert.equal(marker.length, 1); assert.equal(marker[0].direction, 'out'); assert.equal(marker[0].amountRaw, '1');
      assert.equal(marker[0].evidence.stateBeforeHash, m.stateBefore.dataHash); assert.equal(marker[0].evidence.stateAfterHash, m.stateAfter.dataHash);
      assert(event.settlement!.evidence.some(ref => matches(nodes.find(node => matches(node, candidate.completion!))!, ref)));
      const receipt = nodes.find(node => matches(node, candidate.completion!))!;
      assert.equal(receipt.account, fixture.accounts.lp); assert.equal(receipt.raw.inMessage!.op, 0x4457434d);
      assert.equal(receipt.raw.inMessage!.value, '50000000');
      assert(event.movements.some(row => row.direction === 'fee'), 'real native fees remain visible separately');
    });
  }
  await test('remaining owner receives all real pool tokens after the dust exits, with distinct ownership scope', () => {
    assert.equal(ownerRows.length, 2); assert.equal(otherRows.length, 1);
    const event = otherRows[0]; assert.equal(event.settlement?.status, 'confirmed');
    assert.equal(event.settlement!.dlmmLiquidity!.owner, otherOwner);
    assert.deepEqual(event.movements.filter(row => row.asset.kind === 'jetton').map(row => [row.direction, row.amountRaw]).sort(), [['in','2'],['in','2']]);
    assert.equal(event.settlement!.dlmmLiquidity!.sharesBeforeRaw, '2'); assert.equal(event.settlement!.dlmmLiquidity!.sharesAfterRaw, '0');
    assert(!owned.events.some(row => row.settlement?.queryId === '303'));
    assert(!other.events.some(row => row.settlement?.queryId === '301' || row.settlement?.queryId === '302'));
    const drained = fixture.intents.at(-1).after;
    assert.equal(drained.bin.reserveT, '0'); assert.equal(drained.bin.reserveX, '0'); assert.equal(drained.bin.liquidityShares, '0');
  });
  const target = success.find(row => sourceIntent(row.acceptance)?.label === 'partial-withdrawal-zero-dust')!;
  for (const [label, change] of [
    ['missing owner request', (rows: MarketNode[]) => rows.filter(row => !matches(row, target.origin!))],
    ['missing native completion', (rows: MarketNode[]) => rows.filter(row => !matches(row, target.completion!))],
    ['missing pool before archive', (rows: MarketNode[]) => { rows.find(row => matches(row, target.acceptance))!.before = null; return rows; }],
    ['failed native completion', (rows: MarketNode[]) => { const node = rows.find(row => matches(row,target.completion!))!; node.raw.success=false; node.raw.status='failed'; return rows; }],
    ['malformed native completion amount', (rows: MarketNode[]) => { rows.find(row => matches(row,target.completion!))!.raw.inMessage!.value='1'; return rows; }],
  ] as [string,(rows:MarketNode[])=>MarketNode[]][]) await test(`zero payout remains unresolved with ${label}`, () => {
    const altered = change(structuredClone(nodes)), before = JSON.stringify(altered), result = project(altered).find(row => row.acceptance.lt === target.acceptance.lt)!;
    assert(result); assert(result.issues.length > 0); assert.equal(JSON.stringify(altered),before);
    assert.equal(result.metadata?.payouts.filter(row => row.delivery).length ?? 0, 0);
  });
  await test('reversed input order retains exact zero withdrawal identity, proofs and owner isolation', () => {
    const sorted = (rows: typeof success) => [...rows].sort((a,b) => a.acceptance.lt.localeCompare(b.acceptance.lt));
    assert.deepEqual(sorted(project([...nodes].reverse())), sorted(success));
    for (const candidate of success) for (const ref of candidate.evidence) {
      assert.equal(ref.hash, canonicalLedgerHash(ref.hash)); assert(nodes.some(node=>matches(node,ref)));
    }
  });
  await test('durable publication and pinned cursor retain zero economic values, actual position state and completion evidence', async () => {
    const db = new PGlite();
    const sql: LedgerSqlPool = {query:async(text,params)=>!params&&text.includes(';')?{rows:(await db.exec(text)).at(-1)?.rows??[]}:db.query(text,params),connect:async()=>sql,end:()=>db.close()};
    const store = new PostgresLedgerStore(sql);
    try {
      await store.initialize();
      const publish = async (owner: string, projection: typeof owned) => {
        const generation = randomUUID(), head = nodes.filter(row=>row.account===owner).at(-1)!.raw, observed = new Date((head.utime+1)*1000).toISOString();
        await store.begin('localnet',owner,generation,{lt:head.lt,hash:head.hash},observed);
        await store.project(generation,projection,[],['local_sandbox_scope_only','jetton_precision_unresolved']);
        await store.project(generation,projection,[],['local_sandbox_scope_only','jetton_precision_unresolved']);
        await store.complete('localnet',owner,generation,observed); return generation;
      };
      const first = await publish(fixture.accounts.lp,owned), page = await store.page('localnet',fixture.accounts.lp,{limit:1}); assert(page.nextCursor);
      const second = await publish(fixture.accounts.lp,owned); assert.notEqual(first,second);
      const events = [...page.events]; let cursor: string | null = page.nextCursor;
      while(cursor) { const next = await store.page('localnet',fixture.accounts.lp,{limit:1,cursor}); assert.equal(next.coverage.generation,first); events.push(...next.events); cursor=next.nextCursor; }
      const sort = (events:LedgerEvent[])=>[...events].sort((a,b)=>a.id.localeCompare(b.id));
      assert.deepEqual(sort(events),sort(JSON.parse(JSON.stringify(owned.events))));
      assert.equal(new Set(events.map(row=>row.id)).size,owned.events.length);
      await publish(otherOwner,other);
      const resumed = new PostgresLedgerStore(sql); assert.deepEqual(sort((await resumed.page('localnet',otherOwner,{limit:500})).events),sort(JSON.parse(JSON.stringify(other.events))));
      await assert.rejects(()=>store.page('localnet',otherOwner,{cursor:page.nextCursor!}),LedgerCursorError);
      await assert.rejects(()=>store.page('mainnet',fixture.accounts.lp,{cursor:page.nextCursor!}),LedgerCursorError);
    } finally { await sql.end(); }
  });
  await test('all original fixture bytes and in-memory source evidence remain unchanged', () => {
    assert.equal(JSON.stringify(fixture),frozenJson); assert.equal(sha(readFileSync(fixturePath)),sha(fixtureBytes));
  });
  if (process.env.DLMM_ZERO_PAYOUT_EVIDENCE_OUT) writeFileSync(resolve(process.env.DLMM_ZERO_PAYOUT_EVIDENCE_OUT,'results.json'),JSON.stringify({fixtureSha256:sha(fixtureBytes),checks,passed:checks.filter(row=>row.status==='passed').length,failed:checks.filter(row=>row.status==='failed').length},null,2)+'\n');
  assert(checks.every(row=>row.status==='passed'),`${checks.filter(row=>row.status==='failed').length} zero-payout checks failed`);
  console.log(`DLMM zero-payout actual evidence tests passed (${checks.length} groups)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
