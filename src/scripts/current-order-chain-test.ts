/** Transport orchestration test using retained original transaction/state BOCs.
 * The fake source supplies a synthetic masterchain boundary; it is not live
 * consensus proof and the missing factory prehistory must stay incomplete. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Address, Cell, loadShardAccount } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import type { AccountStateResponse } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import { bindOrderRelease, orderHash, orderJson } from '../orders/discovery';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { collectCurrentOrders } from '../runtime/orderChain';
import type { OrderStore } from '../runtime/orderStore';

const dir = process.argv[2];
assert(dir && isAbsolute(dir), 'Supply the absolute retained current orders capture directory');
const receipt = JSON.parse(readFileSync(join(dir, 'producer-receipt.json'), 'utf8'));
assert.equal(receipt.exitCode, 0); assert.equal(receipt.producer, 'orders');
for (const [file, hash] of Object.entries(receipt.artifacts)) {
  assert(!file.startsWith('/') && !file.split('/').includes('..'));
  assert.equal(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'), hash);
}
const capture = JSON.parse(readFileSync(join(dir, 'case-01.json'), 'utf8'));
const rows: OrderTransactionEvidence[] = capture.transactions.map((row: any) => ({ account: row.account, transactionBoc: row.boc,
  beforeShardAccountBoc: row.before.originalShardAccount, afterShardAccountBoc: row.after.originalShardAccount }));
const factory = rows[0].account;
const content = { schema: 'tonswap-release-v1', releaseId: 'synthetic-orders-transport', network: 'ton:testnet',
  contracts: { SpotOrderFactory: { address: factory, codeHash: receipt.compiled.SpotOrderFactory.codeHash } },
  templates: { SpotOrder: receipt.compiled.SpotOrder.codeHash } };
const release = bindOrderRelease({ ...content, manifestHash: orderHash(content) });
const byAccount = new Map<string, OrderTransactionEvidence[]>();
for (const row of rows) { const list = byAccount.get(row.account) ?? []; list.push(row); byAccount.set(row.account, list); }
for (const list of byAccount.values()) list.sort((a, b) => Number(verifyOrderTransaction(a).tx.lt - verifyOrderTransaction(b).tx.lt));
const utime = Math.max(...rows.map(row => verifyOrderTransaction(row).tx.now)), head = fixtureHead(100, utime);
const state = (boc: string): AccountStateResponse => {
  const shard = loadShardAccount(Cell.fromBase64(boc).beginParse()), account = shard.account;
  const active = account?.storage.state.type === 'active' ? account.storage.state.state : null;
  return { balance: account?.storage.balance.coins.toString() ?? '0', lastTxLt: shard.lastTransactionLt.toString(),
    lastTxHash: Buffer.from(shard.lastTransactionHash.toString(16).padStart(64, '0'), 'hex').toString('base64'),
    accountState: active ? 'active' : 'uninitialized', codeBoc: active?.code?.toBoc().toString('base64') ?? null,
    dataBoc: active?.data?.toBoc().toString('base64') ?? null, shardAccountBoc: boc,
    anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: head.utime } };
};
let currentReads = 0, replayReads = 0, wrongCurrent = false;
const source = fakeChainSource({ head: async () => head,
  getAccountState: async (address, options) => { assert.deepEqual(options?.at, head); currentReads++;
    const row = byAccount.get(address)?.at(-1); assert(row);
    return wrongCurrent ? { ...state(row.afterShardAccountBoc), shardAccountBoc: undefined } : state(row.afterShardAccountBoc); },
  getAccountStateAtSeqno: async (address, seqno) => {
    const list = byAccount.get(address); assert(list);
    const index = Math.min(list.length - 1, seqno - 10);
    return state(index < 0 ? list[0].beforeShardAccountBoc : list[index].afterShardAccountBoc);
  },
  getTransactions: async (address, _limit, lt, hash) => {
    const row = byAccount.get(address)?.find(row => { const tx = verifyOrderTransaction(row); return tx.tx.lt.toString() === lt
      && Buffer.from(tx.hash, 'hex').toString('base64') === hash; });
    return row ? [decodeOriginalTransaction(Cell.fromBase64(row.transactionBoc), Address.parse(address))] : [];
  },
  getAccountStateAtTransaction: async (address, cursor) => {
    replayReads++;
    const row = byAccount.get(address)?.find(row => verifyOrderTransaction(row).tx.lt.toString() === cursor.lt); assert(row);
    return { ...state(row.afterShardAccountBoc), replayBoundary: { ...row, blockBoc: Cell.EMPTY.toBoc().toString('base64'), configBoc: Cell.EMPTY.toBoc().toString('base64') } };
  },
});
const cache = new Map<string, OrderTransactionEvidence>();
const key = (account: string, lt: string, hash: string) => `${account}:${lt}:${hash}`;
const store: OrderStore = { evidence: async (account, lt, hash) => cache.get(key(account, lt, hash)) ?? null,
  retain: async row => { const tx = verifyOrderTransaction(row); cache.set(key(row.account, tx.tx.lt.toString(), tx.hash), row); },
  current: async () => null, snapshot: async () => null, publish: async () => { throw Error('not used'); } };
async function main() {
  const first = await collectCurrentOrders(source, release, store, { now: () => utime * 1000 });
  assert.equal(first.coverage.complete, false, 'capture lacks real factory genesis history');
  assert(first.coverage.gaps.some(gap => gap.code === 'factory_history_incomplete' || gap.code === 'factory_history_gap'));
  assert(cache.size > 0); assert(replayReads > 0);
  const prior = replayReads, reads = currentReads;
  const second = await collectCurrentOrders(source, release, store, { now: () => utime * 1000 });
  assert.equal(replayReads, prior, 'original immutable boundaries may be reused');
  assert(currentReads > reads, 'current account states are always re-read at the selected head');
  assert.equal(orderJson(second), orderJson(first));
  wrongCurrent = true;
  await assert.rejects(collectCurrentOrders(source, release, store, { now: () => utime * 1000 }), /unavailable/i);
  wrongCurrent = false;
  await assert.rejects(collectCurrentOrders(source, release, store, { now: () => (utime + 31) * 1000 }));
  console.log(`Order chain orchestration retained ${cache.size} exact original boundaries; incomplete genesis, current-state rereads and missing-proof rejection passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
