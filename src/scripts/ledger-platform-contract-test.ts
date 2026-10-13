import assert from 'node:assert/strict';
import { cycleHarness } from './ledger-dependency-refresh-test';
import type { LedgerPage } from '../ledger/types';
function platform(page: LedgerPage) {
  const coverage = page.coverage;
  assert(coverage.snapshotComplete && coverage.historyComplete && coverage.generation && coverage.publishedAt && coverage.headObservedAt && coverage.checkedAt);
  assert(Date.parse(coverage.headObservedAt) <= Date.parse(coverage.publishedAt));
  assert(Date.parse(coverage.publishedAt) <= Date.now()); assert(Date.parse(coverage.checkedAt) <= Date.now());
  assert(Date.now() - Date.parse(coverage.checkedAt) < 300_000);
}
async function main() {
  for (const offset of [-120, 120]) {
    const h = await cycleHarness();
    try {
      h.controls.utime = Math.floor(Date.now() / 1000) + offset;
      h.f.tx(h.owner);
      await h.service.runOwnerCycle(h.owner);
      const first = await h.store.page('localnet', h.owner, { limit: 1 }); platform(first); assert(first.nextCursor);
      assert.equal(first.coverage.boundary?.utime, h.controls.utime);
      h.controls.seqno++; await h.service.runOwnerCycle(h.owner);
      const quiet = await h.page(); platform(quiet);
      const discovery = await h.store.discoveries('localnet', h.owner, { since: '2020-01-01T00:00:00.000Z', limit: 1 });
      assert.equal(discovery.coverage.checkedAt, quiet.coverage.checkedAt, 'first discovery page merges the latest completed check');
      assert.equal(quiet.coverage.generation, first.coverage.generation); assert.equal(quiet.coverage.publishedAt, first.coverage.publishedAt);
      h.controls.failed = h.vault; await h.due(); await h.service.runOwnerCycle(h.owner);
      const failed = await h.page(); platform(failed); assert(failed.coverage.refreshPending!.length > 0);
      const cursor = await h.store.page('localnet', h.owner, { cursor: first.nextCursor! }); platform(cursor);
      assert.equal(cursor.coverage.checkedAt, first.coverage.checkedAt); assert.deepEqual(cursor.coverage.boundary, first.coverage.boundary);
      assert.deepEqual(cursor.coverage.refreshPending, []);
    } finally { await h.close(); }
  }
  console.log('platform timestamp relations hold 120s ahead/behind chain time across publication, quiet, failure and immutable cursors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
