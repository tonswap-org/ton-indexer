import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { bindOrderRelease, orderHash, orderJson } from '../orders/discovery';
import type { OpenOrderItem, OpenOrderSnapshot } from '../orders/openOrders';
import { PostgresOrderStore } from '../runtime/orderStore';
import { OrderPageError, readOrderPage } from '../runtime/ordersRuntime';
import type { LedgerSqlPool } from '../ledger/store';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { releasePoolConfig } from '../ledger/releasePool';

// These are synthetic persistence records only. Native transaction decoding is
// independently checked by current-order-discovery-test against retained BOCs.
const runtime = runtimeManifestFixture(), release = bindOrderRelease(runtime);
const now = 1_800_000_000_000, utime = now / 1000;
const row = (nonce: number): OpenOrderItem => ({ address: `0:${nonce.toString(16).padStart(64, '0')}`, codeHash: release.orderCodeHash,
  factory: release.factory, owner: `0:${'1'.repeat(64)}`, nonce: String(nonce), termsHash: 'b'.repeat(64), terms: {},
  creationLt: '100', creationTxHash: 'c'.repeat(64), creation: { factoryLt: '100', factoryHash: 'c'.repeat(64), messageHash: 'd'.repeat(64), childLt: '101', childHash: 'e'.repeat(64) },
  observed: { lastTxLt: '101', lastTxHash: 'e'.repeat(64) }, stage: 'ACTIVE', executedSlices: 0, execId: 0, lastExecutedAt: 0, attemptAt: 0,
  cancelRequested: false, refundSeen: false, refundKind: 0, refusal: 0, inputWallet: null, keeper: null, prevKeeper: null,
  soldInRaw: '0', inFlightRaw: '0', unexecutedInRaw: '1', cash: { output: 'unverified', inputRefund: 'unverified' } });
const snapshot = (seqno: number, complete = false, blockRootHash = seqno.toString(16).padStart(64, '0')): OpenOrderSnapshot => {
  const asOf = { masterchainSeqno: seqno, unixTime: utime, blockRootHash };
  const content = { schema: 'tonswap-open-orders-v1' as const, releaseId: release.releaseId, manifestHash: release.manifestHash, asOf,
    coverage: { factoryAddress: release.factory, codeHash: release.factoryCodeHash, asOf, factoryHistoryHash: 'f'.repeat(64),
      fromLt: '50', toLt: '100', toHash: 'c'.repeat(64), historyComplete: complete, boundaryComplete: true, complete,
      gaps: complete ? [] : [{ code: 'factory_history_incomplete', account: release.factory, lt: '49' }] },
    orders: [row(1), row(2), row(3)], failedInitializations: [] };
  return { ...content, snapshotId: orderHash(content) };
};
async function main() {
  const bounded = releasePoolConfig('postgres://localhost/orders?statement_timeout=0&options=-c%20search_path=public', release.manifestHash,
    { size: 3, statementTimeoutMs: 5_000 });
  assert.equal(bounded.max, 3);
  const poolUrl = new URL(bounded.connectionString);
  assert.equal(poolUrl.searchParams.get('statement_timeout'), '5000');
  assert(!poolUrl.searchParams.get('options')!.includes('public'));
  for (const statementTimeoutMs of [0, 30_001, 1.5, NaN])
    assert.throws(() => releasePoolConfig('postgres://localhost/orders', release.manifestHash, { statementTimeoutMs }), /statement timeout/);
  const db = new PGlite();
  const query = async (sql: string, params?: any[]) => db.query(sql, params);
  const pool: LedgerSqlPool = { query, connect: async () => ({ query }), end: async () => undefined };
  try {
    await db.exec(readFileSync(resolve(__dirname, '../../sql/ledger.sql'), 'utf8'));
    const store = new PostgresOrderStore(pool, release), first = snapshot(100), newer = snapshot(102);
    assert.equal(await store.publish(first, now), true);
    const page = await readOrderPage(store, release, { limit: 2 }, now);
    assert.equal(page.body.orders.length, 2); assert(page.body.nextCursor); assert.equal(page.body.coverage.complete, false);
    assert.deepEqual(page.headers, { 'x-tonswap-release': release.manifestHash, 'cache-control': 'no-store' });
    assert.equal(await store.publish(newer, now), true);
    assert.equal(await store.publish(snapshot(101), now), false, 'a late collection cannot regress the publication');
    const reopened = new PostgresOrderStore(pool, release);
    assert.equal((await reopened.current())!.snapshotId, newer.snapshotId, 'publication survives service reconstruction');
    const second = await readOrderPage(reopened, release, { cursor: page.body.nextCursor!, limit: 2 }, now);
    assert.equal(second.body.snapshotId, first.snapshotId); assert.deepEqual(second.body.asOf, first.asOf);
    assert.deepEqual(second.body.orders.map(item => item.nonce), ['3']); assert.equal(second.body.nextCursor, null);
    await assert.rejects(readOrderPage(store, release, { cursor: page.body.nextCursor!, limit: 3 }, now), OrderPageError);
    await assert.rejects(readOrderPage(store, release, { cursor: page.body.nextCursor!, limit: 2 }, now + 31_000), error => error instanceof OrderPageError && error.status === 409);
    await assert.rejects(readOrderPage(store, release, {}, now + 31_000), error => error instanceof OrderPageError && error.status === 503);
    for (const cursor of ['', '!', 'a'.repeat(1025), Buffer.from('{}').toString('base64url')])
      await assert.rejects(readOrderPage(store, release, { cursor }, now), error => error instanceof OrderPageError && error.status === 400);
    for (const limit of [0, 101, 1.1, NaN]) await assert.rejects(readOrderPage(store, release, { limit }, now), OrderPageError);
    await assert.rejects(store.publish(snapshot(102, false, '9'.repeat(64)), now), /conflicting masterchain roots/);
    const changedTime = structuredClone(newer); changedTime.asOf.unixTime++; changedTime.coverage.asOf.unixTime++;
    const { snapshotId: oldId, ...changedContent } = changedTime; changedTime.snapshotId = orderHash(changedContent);
    await assert.rejects(store.publish(changedTime, now), /conflicting chain times/);
    assert.equal((await store.current())!.snapshotId, newer.snapshotId);
    assert.equal(await store.publish(snapshot(102, true), now), true, 'one exact head may advance from incomplete to complete');
    assert.equal(await store.publish(newer, now), false, 'late incomplete work cannot replace complete evidence at one head');
    await assert.rejects(store.publish({ ...snapshot(103), orders: [] }, now), /identity mismatch/);
    const other = new PostgresOrderStore(pool, { ...release, manifestHash: '8'.repeat(64) });
    assert.equal(await other.current(), null); assert.equal(await other.snapshot(first.snapshotId), null);
    assert.equal(orderJson(await store.snapshot(first.snapshotId)), orderJson(first), 'retained snapshots are never rewritten');
    console.log('Durable order snapshots, restart persistence, stable bounded cursors, release isolation and monotonic publication passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
