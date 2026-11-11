import assert from 'node:assert/strict';
import { cycleHarness } from './ledger-dependency-refresh-test';
import { fixtureHead } from './support/chainFixture';
async function main() {
  const h = await cycleHarness();
  try {
    const firstResult = await h.service.runOwnerCycle(h.owner); assert.equal(firstResult.status, 'published');
    assert.equal(h.controls.heads, 1, 'owner cycle captures head once');
    assert(h.pins.every(pin => JSON.stringify(pin) === JSON.stringify(fixtureHead(100, h.controls.utime))));
    const first = await h.page(), runs = await h.runs();
    const counters = { pages: h.controls.pages, getters: h.controls.getters, projects: h.controls.projects, builds: h.controls.graphBuilds, batches: h.controls.batches };
    h.controls.seqno++;
    const checked = Date.parse(first.coverage.checkedAt!);
    while (Date.now() <= checked) await new Promise(resolve => setTimeout(resolve, 1));
    const quiet = await h.service.runOwnerCycle(h.owner), page = await h.page();
    assert.equal(quiet.status, 'quiet'); assert.equal(h.controls.heads, 2);
    assert.equal(h.controls.batches, counters.batches + 1);
    assert.equal(h.controls.pages, counters.pages); assert.equal(h.controls.getters, counters.getters);
    assert.equal(h.controls.projects, counters.projects); assert.equal(h.controls.graphBuilds, counters.builds);
    assert.equal(await h.runs(), runs); assert.equal(page.coverage.generation, first.coverage.generation);
    assert(Date.parse(page.coverage.checkedAt!) > checked); assert.equal(page.coverage.boundary?.seqno, 101);
    // A pending dependency cannot be erased by equal heads. Revalidation occurs
    // under the actual owner lock, after an earlier observer might have changed it.
    const lock = h.store.withAccountLock.bind(h.store);
    let injected = false;
    h.store.withAccountLock = (network, account, work) => lock(network, account, async () => {
      if (account === h.owner && !injected) { injected = true; await h.due(); }
      await work();
    });
    await h.service.runOwnerCycle(h.owner);
    assert(h.controls.graphBuilds > counters.builds, 'under-lock revalidation preserves pending retry work');
    const pinned = await h.store.page('localnet', h.owner, { generation: first.coverage.generation! });
    assert.equal(pinned.coverage.checkedAt, first.coverage.checkedAt); assert.equal(pinned.coverage.boundary?.seqno, 100);
  } finally { await h.close(); }
  console.log('one pinned boundary, one-batch quiet check, zero projection/generation writes and under-lock retry revalidation passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
