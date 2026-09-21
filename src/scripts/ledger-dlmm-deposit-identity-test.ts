import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Cell, loadTransaction } from '@ton/core';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { verifyDlmmDeposit } from '../ledger/dlmmLiquidity';
import type { DlmmProofBinding } from '../ledger/dlmmProof';
import type { MarketNode } from '../ledger/marketTypes';
import type { LedgerAsset, LedgerEvent, LedgerEvidenceRef } from '../ledger/types';
import { loadOpcodes } from '../utils/opcodes';

const fixtureBytes = gunzipSync(readFileSync(resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-reused-query.json.gz')));
const provenance = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-reused-query.provenance.json'), 'utf8'));
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), provenance.sha256);
const fixture = JSON.parse(fixtureBytes.toString());
const binding: DlmmProofBinding = { network: 'localnet', pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX,
  poolCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
  walletCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash };
const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
  const tx = loadTransaction(Cell.fromBase64(entry.transactionBoc).beginParse());
  assert.equal(tx.hash().toString('hex'), entry.raw.hash, 'original transaction BOC');
  const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
  assert.equal(tx.stateUpdate.oldHash.toString('hex'), Cell.fromBase64(boundary.before.shardAccountBoc).refs[0].hash().toString('hex'));
  assert.equal(tx.stateUpdate.newHash.toString('hex'), Cell.fromBase64(boundary.after.shardAccountBoc).refs[0].hash().toString('hex'));
  return {account: entry.account, raw: entry.raw,
    before: {seqno: 0, state: {...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState}},
    after: {seqno: 0, state: {...boundary.after, accountState: boundary.after.accountState === 'uninit' ? 'uninitialized' : boundary.after.accountState}}};
});
const matches = (node: MarketNode, ref: Pick<LedgerEvidenceRef, 'account' | 'lt' | 'hash'>) => node.account === ref.account && node.raw.lt === ref.lt && canonicalLedgerHash(node.raw.hash) === canonicalLedgerHash(ref.hash);
function ownerInput(input = nodes): ProjectionInput {
  const owner = fixture.accounts.lp, wallets = new Map<string, LedgerAsset>();
  for (const [name, pair] of Object.entries(fixture.accounts.wallets) as [string, string[]][]) {
    const walletOwner = name === 'other' ? fixture.accounts.otherPayer : fixture.accounts[name];
    for (const [side, wallet] of pair.entries()) {
      const master = side ? binding.tokenX : binding.tokenT;
      wallets.set(wallet, {kind: 'jetton', id: `localnet:jetton:${master}`, master, wallet, owner: walletOwner});
    }
  }
  const chains = new Map<string, LedgerChain>();
  for (const node of input) {
    if (!chains.has(node.account)) chains.set(node.account, {account: node.account,
      role: node.account === owner ? 'owner' : node.account === binding.pool ? 'pool' : wallets.get(node.account)?.owner === owner ? 'owned_jetton_wallet' : 'counterparty',
      generation: 'sandbox-original-linked-account-history', historyComplete: true, transactions: []});
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
const deposits = (events: LedgerEvent[]) => events.filter(event => event.kind === 'lp_deposit');
const marker = (event: LedgerEvent) => event.movements.find(m => m.asset.kind === 'lp_position');
const checks: {name: string; status: string}[] = [];
const test = async (name: string, run: () => void | Promise<void>) => {await run(); checks.push({name, status: 'passed'}); console.log('PASS', name);};
async function main() {
  const adds = fixture.intents.filter((intent: any) => intent.kind === 'add');
  assert.equal(adds.length, 2); assert(adds.every((intent: any) => intent.owner === fixture.accounts.lp && intent.businessQueryId === '100'));
  const proven = adds.map((intent: any) => {
    const refs = nodes.slice(intent.transactionStart, intent.transactionEnd).filter(node => node.account === binding.pool && node.raw.inMessage?.op === 0x7362d09c)
      .map(node => ({account: node.account, lt: node.raw.lt, hash: node.raw.hash, utime: node.raw.utime}));
    const proof = verifyDlmmDeposit(binding, nodes, fixture.accounts.lp, refs);
    assert.equal(proof.metadata.mintedSharesRaw, intent.mintedShares); return proof.metadata;
  });
  const result = await projectOwnerLedger(ownerInput()), rows = deposits(result.events).sort((a,b) => BigInt(marker(a)!.evidence.dlmmDeposit!.stateAfter.transaction.lt) < BigInt(marker(b)!.evidence.dlmmDeposit!.stateAfter.transaction.lt) ? -1 : 1);
  await test('two actual same-query adds retain independent mint boundaries and physical debits', () => {
    assert.equal(rows.length, 2); assert(rows.every(row => row.settlement?.status === 'confirmed'));
    assert.equal(new Set(rows.map(row => row.id)).size, 2);
    assert.deepEqual(rows.map(row => marker(row)!.amountRaw), ['2000006', '666674']);
    assert.equal(rows.reduce((total,row) => total + BigInt(marker(row)!.amountRaw),0n), 2666680n);
    const movementIds = new Set<string>();
    rows.forEach((row,index) => {
      const m = marker(row)!.evidence.dlmmDeposit!;
      assert.deepEqual(m.stateAfter, proven[index].stateAfter);
      assert.equal(row.movements.filter(m => m.asset.kind === 'jetton' && m.direction === 'out').length, 2);
      for (const contribution of m.contributions) {
        assert(!movementIds.has(contribution.movementId)); movementIds.add(contribution.movementId);
        assert(row.movements.some(m => m.id === contribution.movementId && m.amountRaw === contribution.amountRaw));
      }
    });
  });
  await test('physical input ordering cannot change operation identity or mint evidence', async () => {
    const reverse = deposits((await projectOwnerLedger(ownerInput([...nodes].reverse()))).events);
    assert.deepEqual(reverse.sort((a,b) => a.id.localeCompare(b.id)), [...rows].sort((a,b) => a.id.localeCompare(b.id)));
  });
  await test('later one-sided reuse cannot absorb a previously completed deposit', async () => {
    const prefix = nodes.slice(0, adds[1].stages[0].transactionCount);
    const partial = deposits((await projectOwnerLedger(ownerInput(prefix))).events);
    assert.equal(partial.length, 2);
    const confirmed = partial.filter(row => row.settlement?.status === 'confirmed'); assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].id, rows[0].id); assert.deepEqual(marker(confirmed[0]), marker(rows[0]));
    const unresolved = partial.find(row => row.settlement?.status !== 'confirmed')!;
    assert.equal(unresolved.movements.filter(m => m.asset.kind === 'jetton' && m.direction === 'out').length, 1);
    assert.equal(marker(unresolved), undefined);
  });
  for (const missing of [0, 1]) await test(`missing pending archive for operation ${missing + 1} leaves the other operation intact`, async () => {
    const input = ownerInput(), archive = input.stateAt, absent = proven[missing].contributions[0].acceptance;
    input.stateAt = async (account, lt, hash) => account === absent.account && lt === absent.lt && canonicalLedgerHash(hash) === absent.hash ? null : archive(account, lt, hash);
    const projection = deposits((await projectOwnerLedger(input)).events);
    assert.equal(projection.length, 3, 'one proven pair and two independent unqualified contributions');
    const confirmed = projection.filter(row => row.settlement?.status === 'confirmed'); assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].id, rows[1 - missing].id); assert.deepEqual(marker(confirmed[0]), marker(rows[1 - missing]));
    const unresolved = projection.filter(row => row.settlement?.status !== 'confirmed');
    assert(unresolved.every(row => !marker(row) && row.movements.filter(m => m.asset.kind === 'jetton' && m.direction === 'out').length === 1));
  });
  for (const missing of [0, 1]) await test(`missing original contribution for operation ${missing + 1} cannot borrow one from the other pair`, async () => {
    const absent = proven[missing].contributions[0].acceptance;
    const projection = deposits((await projectOwnerLedger(ownerInput(nodes.filter(node => !matches(node, absent))))).events);
    const confirmed = projection.filter(row => row.settlement?.status === 'confirmed'); assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].id, rows[1 - missing].id); assert.deepEqual(marker(confirmed[0]), marker(rows[1 - missing]));
    assert.equal(projection.filter(row => marker(row)).length, 1);
  });
  if (process.env.DLMM_DEPOSIT_IDENTITY_EVIDENCE_OUT) {
    const out = resolve(process.env.DLMM_DEPOSIT_IDENTITY_EVIDENCE_OUT); mkdirSync(out, {recursive: true});
    writeFileSync(resolve(out,'checks.json'), JSON.stringify({provenance,binding,checks,events: rows},null,2)+'\n');
  }
  console.log(`PASS ${checks.length} exact deposit-identity regression checks`);
}
main().catch(error => {console.error(error); process.exitCode = 1;});
