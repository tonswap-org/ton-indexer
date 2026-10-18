/** Offline regression against retained current-contract captures. The capture
 * heads are deliberately synthetic unit-test boundaries: these files contain no
 * live masterchain proof and omit pre-creation factory history. Passing this
 * script does not grant live admission or complete production coverage.
 * Usage: tsx src/scripts/current-order-discovery-test.ts /absolute/orders-captures
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Address, beginCell, Cell, Dictionary, loadMessage, loadShardAccount, loadTransaction, storeMessage,
  storeShardAccount, storeTransaction, type Message, type ShardAccount, type Transaction } from '@ton/core';
import { activeOrderAccount, digest, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { bindOrderRelease, discoverOrder, discoverOrders, orderHash, orderJson } from '../orders/discovery';
import { buildOpenOrderSnapshot, orderFactoryCoverage, pageOpenOrders, type CurrentOrderAccount, type OrderHead } from '../orders/openOrders';
import { decodeOrderState, orderInitialData, orderTermsToCell, parseOrderTerms } from '../orders/state';

const root = process.argv[2];
assert(root && isAbsolute(root), 'Supply the absolute retained current orders capture directory');
let tests = 0;
function test(name: string, fn: () => void) { fn(); tests++; console.log(`ok ${tests} - ${name}`); }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const json = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const receipt = json('producer-receipt.json');
test('producer receipt pins the current offline capture and artifacts', () => {
  assert.equal(receipt.schema, 'tonswap-capture-producer-v1'); assert.equal(receipt.producer, 'orders');
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.tests, 2); assert.equal(receipt.runtime.tolk, '1.5.0');
  for (const [path, hash] of Object.entries(receipt.artifacts)) {
    assert(!path.startsWith('/') && !path.split('/').includes('..')); assert.equal(sha(readFileSync(join(root, path))), hash);
  }
  for (const role of ['SpotOrder', 'SpotOrderFactory']) {
    const c = receipt.compiled[role]; assert.equal(digest(Cell.fromBoc(readFileSync(join(root, c.boc)))[0]), c.codeHash);
  }
});
const boc = (c: Cell) => c.toBoc().toString('base64');
const ev = (r: any): OrderTransactionEvidence => ({ account: r.account, transactionBoc: r.boc,
  beforeShardAccountBoc: r.before.originalShardAccount, afterShardAccountBoc: r.after.originalShardAccount });
const stateBoc = (s: ShardAccount) => boc(beginCell().store(storeShardAccount(s)).endCell());
const replaceData = (s: ShardAccount, data: Cell) => {
  assert(s.account?.storage.state.type === 'active'); s.account.storage.state.state.data = data;
};
/** Only synthetic mutation tests call this. Recompute all state/hash links while
 * retaining raw message cells, to reach semantic checks rather than checksum
 * failure. This never changes the retained source captures. */
function mutation(e: OrderTransactionEvidence, fn: (m: { tx: Transaction; before: ShardAccount; after: ShardAccount;
  incoming: Cell | null; outgoing: Dictionary<number, Cell> }) => void): OrderTransactionEvidence {
  const v = verifyOrderTransaction(e);
  const m = { tx: loadTransaction(orderCell(e.transactionBoc).beginParse()),
    before: loadShardAccount(orderCell(e.beforeShardAccountBoc).beginParse()),
    after: loadShardAccount(orderCell(e.afterShardAccountBoc).beginParse()), incoming: v.incoming, outgoing: v.outgoing };
  fn(m);
  m.tx.prevTransactionLt = m.before.lastTransactionLt; m.tx.prevTransactionHash = m.before.lastTransactionHash;
  const beforeCell = orderCell(stateBoc(m.before)), afterCell = orderCell(stateBoc(m.after));
  m.tx.stateUpdate = { oldHash: beforeCell.refs[0].hash(), newHash: afterCell.refs[0].hash() };
  m.tx.outMessagesCount = m.outgoing.size;
  const encoded = beginCell().store(storeTransaction(m.tx)).endCell();
  const messages = beginCell().storeMaybeRef(m.incoming).storeDict(m.outgoing).endCell();
  const exact = beginCell().storeBits(encoded.bits).storeRef(messages);
  for (const ref of encoded.refs.slice(1)) exact.storeRef(ref);
  const original = exact.endCell(); m.after.lastTransactionLt = m.tx.lt; m.after.lastTransactionHash = BigInt('0x' + digest(original));
  return { account: e.account, transactionBoc: boc(original), beforeShardAccountBoc: stateBoc(m.before), afterShardAccountBoc: stateBoc(m.after) };
}
function rewriteMessage(raw: Cell, fn: (m: Message) => void): Cell { const m = loadMessage(raw.beginParse()); fn(m); return beginCell().store(storeMessage(m)).endCell(); }
function withCurrent(e: OrderTransactionEvidence, head: OrderHead): CurrentOrderAccount { return { address: e.account, asOf: { ...head }, shardAccountBoc: e.afterShardAccountBoc }; }

for (const name of ['case-01.json', 'case-02.json']) {
  const capture = json(name), rows = capture.transactions, facts = rows.map(ev);
  assert.equal(capture.schema, 'tonswap.factory-original-boundaries.v1');
  const factory = facts[0].account, factoryRows = facts.filter((e: OrderTransactionEvidence) => e.account === factory);
  const manifestContent = { schema: 'tonswap-release-v1', releaseId: `offline-orders-${name}`, network: 'ton:localnet',
    contracts: { SpotOrderFactory: { address: factory, codeHash: receipt.compiled.SpotOrderFactory.codeHash } },
    templates: { SpotOrder: receipt.compiled.SpotOrder.codeHash } };
  // This minimal fixture is solely the order module's binding unit input, not a
  // substitute for the service owner's full current release-manifest validator.
  const manifest = { ...manifestContent, manifestHash: orderHash(manifestContent) }, release = bindOrderRelease(manifest);
  const children = facts.filter((e: OrderTransactionEvidence) => e.account !== factory && digest(orderCell(rows[facts.indexOf(e)].codeBoc)) === release.orderCodeHash);
  const discovered = discoverOrders(release, factoryRows, children);
  const head: OrderHead = { masterchainSeqno: 100, unixTime: Math.max(...rows.map((r: any) => r.utime)), blockRootHash: 'a'.repeat(64) };
  const now = head.unixTime * 1000;
  const factoryCurrent = withCurrent(factoryRows[factoryRows.length - 1], head);
  const input = { factoryCurrent, factoryHistory: [...factoryRows].reverse(), childHistory: children,
    accounts: [1, 19, 29].map(i => withCurrent(facts[i], head)) };
  const snapshot = buildOpenOrderSnapshot(release, head, input, now);

  test(`${name}: every original transaction and its exact state commitments verify`, () => { for (const e of facts) verifyOrderTransaction(e); });
  test(`${name}: three current factory creations bind owner/nonce/code/StateInit/immutable terms`, () => {
    assert.equal(discovered.orders.length, 3); assert.deepEqual(discovered.gaps, []);
    assert.deepEqual(discovered.failedInitializations, []);
    for (let i = 0; i < 3; i++) {
      const order = discoverOrder(release, factoryRows[i], facts[[1, 19, 29][i]]);
      assert.equal(order.nonce, String(i + 1)); assert.equal(order.termsHash, digest(orderCell(order.termsBoc)));
      assert.deepEqual(order, discovered.orders[i]);
    }
  });
  test(`${name}: all captured child before/after states consume the exact current layout`, () => {
    let count = 0;
    for (const e of children) for (const b of [e.beforeShardAccountBoc, e.afterShardAccountBoc]) {
      const s = orderShard(b, e.account).shard;
      if (s.account?.storage.state.type === 'active') { decodeOrderState(activeOrderAccount(s, release.orderCodeHash).data); count++; }
    }
    assert.equal(count, 31);
  });
  test(`${name}: actual retained factory history is explicitly incomplete`, () => {
    const c = orderFactoryCoverage(release, head, factoryCurrent, input.factoryHistory);
    assert.equal(c.boundaryComplete, true); assert.equal(c.historyComplete, false); assert.equal(c.complete, false);
    assert.equal(c.gaps[0].code, 'factory_history_incomplete'); assert.equal(c.gaps[0].lt, '92000000');
    assert.equal(snapshot.coverage.complete, false); assert.equal(snapshot.orders.length, 3);
  });
  test(`${name}: a synthetic genesis-linked chain can be complete; missing creation or current state cannot`, () => {
    // Structural unit fixture only: the real producer capture starts after
    // deployment. This synthetic prefix must never be retained as live evidence.
    const deploy = mutation(factoryRows[0], m => {
      m.before = { account: undefined, lastTransactionLt: 0n, lastTransactionHash: 0n };
      m.after = loadShardAccount(orderCell(factoryRows[0].beforeShardAccountBoc).beginParse());
      m.tx.lt = m.after.lastTransactionLt; m.tx.oldStatus = 'non-existing'; m.tx.endStatus = 'active';
      assert(m.incoming); m.incoming = rewriteMessage(m.incoming, value => { value.body = beginCell().endCell(); });
      m.outgoing = Dictionary.empty(Dictionary.Keys.Uint(15), Dictionary.Values.Cell());
    });
    const linked: OrderTransactionEvidence[] = [deploy];
    for (const e of factoryRows) linked.push(mutation(e, m => {
      m.before = loadShardAccount(orderCell(linked[linked.length - 1].afterShardAccountBoc).beginParse());
    }));
    const completeInput = { ...input, factoryCurrent: withCurrent(linked[linked.length - 1], head), factoryHistory: [...linked].reverse() };
    const full = buildOpenOrderSnapshot(release, head, completeInput, now);
    assert.equal(full.coverage.complete, true); assert.equal(full.coverage.historyComplete, true); assert.equal(full.orders.length, 3);
    assert.deepEqual(full.coverage.gaps, []);
    const missingChild = buildOpenOrderSnapshot(release, head, { ...completeInput, childHistory: children.filter((e: OrderTransactionEvidence) => e.account !== facts[19].account) }, now);
    assert.equal(missingChild.coverage.complete, false); assert.equal(missingChild.orders.length, 2);
    const missingState = buildOpenOrderSnapshot(release, head, { ...completeInput, accounts: input.accounts.slice(1) }, now);
    assert.equal(missingState.coverage.complete, false); assert.equal(missingState.orders.length, 2);
    const missingFactory = buildOpenOrderSnapshot(release, head, { ...completeInput, factoryHistory: completeInput.factoryHistory.filter((_, i) => i !== 1) }, now);
    assert.equal(missingFactory.coverage.complete, false); assert.equal(missingFactory.orders.length, 2);
  });
  test(`${name}: omitted factory middle transaction cannot inherit complete coverage`, () => {
    const s = buildOpenOrderSnapshot(release, head, { ...input, factoryHistory: input.factoryHistory.filter((_, i) => i !== 1) }, now);
    assert.equal(s.coverage.boundaryComplete, false); assert(s.coverage.gaps.some(g => g.code === 'factory_history_gap'));
    assert.equal(s.orders.length, 2); assert.equal(s.coverage.complete, false);
  });
  test(`${name}: missing child is an explicit discovery gap`, () => {
    const d = discoverOrders(release, factoryRows, children.filter((e: OrderTransactionEvidence) => e.account !== facts[19].account));
    assert.equal(d.orders.length, 2); assert(d.gaps.some(g => g.code === 'creation_unresolved'));
  });
  test(`${name}: malformed factory evidence becomes a gap instead of escaping the batch`, () => {
    const d = discoverOrders(release, [factoryRows[0], { ...factoryRows[1], transactionBoc: 'bad' }], children);
    assert.equal(d.orders.length, 1); assert(d.gaps.length > 0);
  });
  test(`${name}: repeated archive rows do not create duplicate orders or ambiguity`, () => {
    const d = discoverOrders(release, [...factoryRows, factoryRows[0]], [...children, facts[1]]);
    assert.equal(d.orders.length, 3); assert.deepEqual(d.gaps, []);
    const repeated = orderFactoryCoverage(release, head, factoryCurrent, [...input.factoryHistory, input.factoryHistory[0]]);
    assert.equal(repeated.boundaryComplete, true); assert.equal(repeated.gaps[0].code, 'factory_history_incomplete');
  });
  // Synthetic authenticated-cell mutations exercise retry semantics absent from
  // the retained producer cases. They are not additional real execution captures.
  const repeatedAttempt = (differentTerms: boolean) => {
    let emitted: Cell | undefined;
    const f = mutation(factoryRows[0], m => {
      m.before = loadShardAccount(orderCell(factoryRows[0].afterShardAccountBoc).beginParse());
      m.after = loadShardAccount(orderCell(factoryRows[0].afterShardAccountBoc).beginParse());
      m.tx.lt += 10_000_000n;
      assert(m.incoming); let terms: Cell;
      m.incoming = rewriteMessage(m.incoming, msg => {
        const s = msg.body.beginParse(), op = s.loadUint(32), q = s.loadUintBig(64), n = s.loadUintBig(64), original = s.loadRef();
        const t = parseOrderTerms(original); terms = differentTerms ? orderTermsToCell({ ...t, minOutTotal: t.minOutTotal + 1n }) : original;
        msg.body = beginCell().storeUint(op, 32).storeUint(q, 64).storeUint(n, 64).storeRef(terms).endCell();
      });
      for (const [key, raw] of m.outgoing) {
        const msg = loadMessage(raw.beginParse());
        if (msg.body.bits.length >= 32 && msg.body.beginParse().preloadUint(32) === 0x4f494e49) {
          emitted = rewriteMessage(raw, value => { assert(value.info.type === 'internal'); value.info.createdLt += 10_000_000n;
            const body = value.body.beginParse(); const op = body.loadUint(32), q = body.loadUintBig(64);
            const requested = parseOrderTerms(terms!);
            value.body = beginCell().storeUint(op, 32).storeUint(q, 64).storeRef(orderTermsToCell({ ...requested, startAt: Math.max(requested.startAt, m.tx.now) })).endCell(); });
          m.outgoing.set(key, emitted);
        }
      }
    });
    assert(emitted);
    const c = mutation(facts[1], m => {
      m.before = loadShardAccount(orderCell(facts[1].afterShardAccountBoc).beginParse());
      m.after = loadShardAccount(orderCell(facts[1].afterShardAccountBoc).beginParse());
      m.tx.lt += 10_000_000n; m.incoming = emitted!;
    });
    return { f, c };
  };
  test(`${name}: duplicate owner/nonce retains original immutable terms, even with new requested terms`, () => {
    const { f, c } = repeatedAttempt(true), d = discoverOrders(release, [f, factoryRows[0]], [c, facts[1]]);
    assert.deepEqual(d.gaps, []); assert.deepEqual(d.orders, [discovered.orders[0]]);
    assert.equal(d.failedInitializations.length, 0);
    assert.equal(discoverOrders(release, [f], [c]).gaps.length, 1, 'duplicate without original creation is unresolved');
    const corrupted = mutation(c, m => {
      const s = activeOrderAccount(m.after, release.orderCodeHash).data.beginParse();
      const f = s.loadAddress(), o = s.loadAddress(), n = s.loadUintBig(64), body = s.loadRef();
      replaceData(m.after, beginCell().storeAddress(f).storeAddress(o).storeUint(n + 1n, 64).storeRef(body).endCell());
    });
    assert(discoverOrders(release, [factoryRows[0], f], [facts[1], corrupted]).gaps.length > 0);
  });
  test(`${name}: proven failed initialization is separate and a later accepted retry binds its own first terms`, () => {
    const failed = mutation(facts[1], m => {
      assert(m.tx.description.type === 'generic' && m.tx.description.computePhase.type === 'vm');
      m.tx.description.aborted = true; m.tx.description.computePhase.success = false; m.tx.description.computePhase.exitCode = 702;
      replaceData(m.after, orderInitialData(Address.parse(factory), Address.parse(discovered.orders[0].owner), 1n));
    });
    const d = discoverOrders(release, [factoryRows[0]], [failed]);
    assert.deepEqual(d.gaps, []); assert.equal(d.orders.length, 0); assert.equal(d.failedInitializations.length, 1);
    const { f, c } = repeatedAttempt(false);
    const retried = mutation(c, m => { m.before = loadShardAccount(orderCell(failed.afterShardAccountBoc).beginParse()); });
    const retry = discoverOrders(release, [f, factoryRows[0]], [retried, failed]);
    assert.deepEqual(retry.gaps, []); assert.equal(retry.failedInitializations.length, 1); assert.equal(retry.orders.length, 1);
    assert.equal(retry.orders[0].creation.factoryHash, verifyOrderTransaction(f).hash);
    const falseFailure = mutation(facts[1], m => { assert(m.tx.description.type === 'generic'); m.tx.description.aborted = true; });
    const inconsistent = discoverOrders(release, [factoryRows[0]], [falseFailure]);
    assert.equal(inconsistent.failedInitializations.length, 0); assert.equal(inconsistent.gaps.length, 1);
  });
  test(`${name}: emitted StateInit substitution is rejected even with an exact matching delivery`, () => {
    for (const changed of ['code', 'data', 'special']) {
      let emitted: Cell | undefined;
      const f = mutation(factoryRows[0], m => {
        for (const [key, raw] of m.outgoing) {
          const msg = loadMessage(raw.beginParse());
          if (msg.body.bits.length >= 32 && msg.body.beginParse().preloadUint(32) === 0x4f494e49) {
            emitted = rewriteMessage(raw, value => { assert(value.init);
              if (changed === 'code') value.init.code = beginCell().storeUint(1, 8).endCell();
              else if (changed === 'special') value.init.special = { tick: false, tock: true };
              else value.init.data = orderInitialData(Address.parse(factory), Address.parse(discovered.orders[0].owner), 2n);
            });
            m.outgoing.set(key, emitted);
          }
        }
      });
      const c = mutation(facts[1], m => { m.incoming = emitted!; });
      assert.throws(() => discoverOrder(release, f, c), /StateInit mismatch/);
    }
  });
  test(`${name}: release hash, code pin and factory address substitutions are rejected`, () => {
    assert.throws(() => bindOrderRelease({ ...manifest, releaseId: 'changed' }), /release hash/);
    assert.throws(() => discoverOrder({ ...release, orderCodeHash: '0'.repeat(64) }, factoryRows[0], facts[1]), /child code/);
    assert.throws(() => discoverOrder({ ...release, factoryCodeHash: '0'.repeat(64) }, factoryRows[0], facts[1]), /code pin/);
    assert.throws(() => discoverOrder({ ...release, factory: facts[1].account }, factoryRows[0], facts[1]), /wrong factory/);
  });
  test(`${name}: checksum, current code and immutable factory data tampering are rejected`, () => {
    assert.throws(() => verifyOrderTransaction({ ...facts[1], afterShardAccountBoc: facts[19].afterShardAccountBoc }));
    const badCode = mutation(facts[1], m => { assert(m.after.account?.storage.state.type === 'active'); m.after.account.storage.state.state.code = beginCell().storeUint(7, 8).endCell(); });
    assert.throws(() => discoverOrder(release, factoryRows[0], badCode), /code pin/);
    const badFactory = mutation(factoryRows[0], m => { const d = activeOrderAccount(m.after, release.factoryCodeHash).data; replaceData(m.after, beginCell().storeSlice(d.beginParse()).storeBit(0).endCell()); });
    assert.throws(() => discoverOrder(release, badFactory, facts[1]), /immutable state/);
  });
  test(`${name}: substituted owner, nonce, requested terms and trailing OCRT bits are rejected`, () => {
    for (const change of ['owner', 'nonce', 'terms', 'suffix']) {
      const altered = mutation(factoryRows[0], m => { assert(m.incoming); m.incoming = rewriteMessage(m.incoming, msg => {
        if (change === 'owner') { assert(msg.info.type === 'internal'); msg.info.src = Address.parse(facts[19].account); return; }
        const s = msg.body.beginParse(), op = s.loadUint(32), q = s.loadUintBig(64), n = s.loadUintBig(64), t = s.loadRef();
        const terms = parseOrderTerms(t); const b = beginCell().storeUint(op, 32).storeUint(q, 64).storeUint(change === 'nonce' ? n + 1n : n, 64)
          .storeRef(change === 'terms' ? orderTermsToCell({ ...terms, minOutTotal: terms.minOutTotal + 1n }) : t);
        if (change === 'suffix') b.storeBit(0); msg.body = b.endCell();
      }); });
      assert.throws(() => discoverOrder(release, altered, facts[1]), change);
    }
  });
  test(`${name}: exact original emitted message is required, not parsed reserialization`, () => {
    const original = verifyOrderTransaction(facts[1]).incoming!;
    const reserialized = beginCell().store(storeMessage(loadMessage(original.beginParse()), { forceRef: true })).endCell();
    assert.equal(digest(loadMessage(original.beginParse()).body), digest(loadMessage(reserialized.beginParse()).body));
    // Some wire encodings already use references; explicitly flip the body mode
    // through the serializer only when the original representation differs.
    assert(!original.equals(reserialized), 'native original differs from ordinary forced-reference encoding');
    {
      const altered = mutation(facts[1], m => { m.incoming = reserialized; });
      assert.throws(() => discoverOrder(release, factoryRows[0], altered), /exact factory message/);
    }
    const altered = mutation(facts[1], m => { m.incoming = rewriteMessage(original, msg => { assert(msg.info.type === 'internal'); msg.info.createdLt += 1n; }); });
    assert.throws(() => discoverOrder(release, factoryRows[0], altered), /exact factory message/);
  });
  test(`${name}: fresh full-head binding, code and immutable terms are required per account`, () => {
    assert.throws(() => buildOpenOrderSnapshot(release, { ...head, blockRootHash: 'b'.repeat(64) }, input, now), /factory boundary/);
    for (const altered of [{ ...input.accounts[0], asOf: { ...head, blockRootHash: 'b'.repeat(64) } },
      { ...input.accounts[0], shardAccountBoc: facts[19].afterShardAccountBoc }]) {
      const s = buildOpenOrderSnapshot(release, head, { ...input, accounts: [altered, ...input.accounts.slice(1)] }, now);
      assert.equal(s.orders.length, 2); assert(s.coverage.gaps.some(g => g.code === 'current_order_unavailable'));
    }
    const changed = mutation(facts[1], m => { const d = activeOrderAccount(m.after, release.orderCodeHash).data, ds = d.beginParse();
      ds.loadAddress(); ds.loadAddress(); ds.loadUintBig(64); const body = ds.loadMaybeRef();
      replaceData(m.after, beginCell().storeAddress(Address.parse(factory)).storeAddress(Address.parse(facts[19].account)).storeUint(1, 64).storeMaybeRef(body).endCell()); });
    const s = buildOpenOrderSnapshot(release, head, { ...input, accounts: [withCurrent(changed, head), ...input.accounts.slice(1)] }, now);
    assert.equal(s.orders.length, 2); assert.equal(s.coverage.complete, false);
  });
  test(`${name}: current factory data must match its last physical transaction state`, () => {
    const s = loadShardAccount(orderCell(factoryCurrent.shardAccountBoc).beginParse());
    assert(s.account); s.account.storage.balance.coins += 1n;
    const c = orderFactoryCoverage(release, head, { ...factoryCurrent, shardAccountBoc: stateBoc(s) }, input.factoryHistory);
    assert.equal(c.boundaryComplete, false); assert.equal(c.complete, false);
  });
  test(`${name}: refusal alone stays EXECUTING with in-flight input; verified credit returns ACTIVE`, () => {
    const read = (i: number) => buildOpenOrderSnapshot(release, head, { ...input, accounts: [withCurrent(facts[15], head), withCurrent(facts[25], head), withCurrent(facts[i], head)] }, now);
    const refused = read(35).orders[0]; assert.equal(refused.stage, 'EXECUTING'); assert.equal(refused.refusal, 1);
    assert.equal(refused.refundSeen, false); assert.equal(refused.inFlightRaw, '1000000000');
    assert.deepEqual(refused.cash, { output: 'unverified', inputRefund: 'unverified' });
    const credited = read(36).orders[0]; assert.equal(credited.stage, 'ACTIVE'); assert.equal(credited.refundKind, 1); assert.equal(credited.inFlightRaw, '0');
    assert.deepEqual(credited.cash, { output: 'unverified', inputRefund: 'unverified' });
    assert.equal(read(39).orders.length, 0);
  });
  test(`${name}: fill and close accounting do not claim physical recipient or owner cash`, () => {
    const filled = decodeOrderState(activeOrderAccount(orderShard(facts[15].afterShardAccountBoc, facts[15].account).shard, release.orderCodeHash).data);
    assert.equal(filled.state, 3); assert.equal(filled.closeReason, 1); assert.equal(filled.soldIn, 3_000_000_000n);
    const closed = decodeOrderState(activeOrderAccount(orderShard(facts[39].afterShardAccountBoc, facts[39].account).shard, release.orderCodeHash).data);
    assert.equal(closed.state, 3); assert.equal(closed.closeReason, 2); assert.equal(closed.unexecutedIn, 1_000_000_000n);
  });
  test(`${name}: pagination binds release, full head, contents, limit and immutable cursor`, () => {
    const first = pageOpenOrders(snapshot, release, { limit: 1, now });
    assert.equal(first.headers['x-tonswap-release'], release.manifestHash); assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.body.schema, 'tonswap-open-orders-v1'); assert.equal(first.body.orders.length, 1); assert(first.body.nextCursor);
    const second = pageOpenOrders(snapshot, release, { limit: 1, cursor: first.body.nextCursor!, now });
    assert.deepEqual(second.body.asOf, first.body.asOf); assert.equal(second.headers['x-tonswap-release'], first.headers['x-tonswap-release']);
    assert.notEqual(second.body.orders[0].address, first.body.orders[0].address);
    const last = pageOpenOrders(snapshot, release, { limit: 1, cursor: second.body.nextCursor!, now }); assert.equal(last.body.nextCursor, null);
    assert.throws(() => pageOpenOrders(snapshot, release, { cursor: first.body.nextCursor!, limit: 2, now }), /cursor snapshot/);
    assert.throws(() => pageOpenOrders({ ...snapshot, orders: snapshot.orders.slice(1) }, release, { now }), /snapshot changed/);
    assert.throws(() => pageOpenOrders(snapshot, { ...release, manifestHash: 'b'.repeat(64) }, { now }), /release mismatch/);
    assert.throws(() => pageOpenOrders(snapshot, release, { now: now + 30001 }), /stale/);
    assert.throws(() => pageOpenOrders(snapshot, release, { limit: 101, now }), /limit/);
    assert.throws(() => pageOpenOrders(snapshot, release, { cursor: 'not.a.cursor', now }));
    assert.throws(() => pageOpenOrders(snapshot, release, { cursor: Buffer.from(orderJson({ limit: 1, offset: 1, snapshotId: 'b'.repeat(64) })).toString('base64url'), limit: 1, now }), /cursor snapshot/);
  });
  test(`${name}: suffix-bearing child storage/terms and nonordinary absence fail closed`, () => {
    const data = activeOrderAccount(orderShard(facts[1].afterShardAccountBoc, facts[1].account).shard, release.orderCodeHash).data;
    assert.throws(() => decodeOrderState(beginCell().storeSlice(data.beginParse()).storeBit(0).endCell()));
    const terms = orderCell(discovered.orders[0].termsBoc);
    assert.throws(() => parseOrderTerms(beginCell().storeSlice(terms.beginParse()).storeBit(0).endCell()));
    const nullAccountWithTail = beginCell().storeBit(0).storeBit(1).endCell();
    const invalidShard = beginCell().storeRef(nullAccountWithTail).storeUint(0, 256).storeUint(0, 64).endCell();
    assert.throws(() => orderShard(boc(invalidShard), facts[1].account));
  });
}
console.log(`PASS ${tests} current order regression groups; 6 authentic creations, default/x6. Capture factory coverage remains incomplete. No live chain admission claimed.`);
