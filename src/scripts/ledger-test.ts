import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDatabaseUrl } from '../config/database';
import { Address, Cell, beginCell } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import fastify from 'fastify';
import type { RawTransaction, TonDataSource } from '../data/dataSource';
import { normalizeLedgerEvent } from '../ledger/normalize';
import {
  PostgresLedgerStore,
  projectionFingerprint,
  LedgerCursorError,
  type LedgerSqlPool,
} from '../ledger/store';
import { LedgerService } from '../ledger/service';
import { LedgerGraphBuilder } from '../ledger/graph';
import type { LedgerEvent, LedgerProjection } from '../ledger/types';
import { registerLedgerRoutes } from '../ledger/routes';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { createLogger } from '../utils/logger';

const account = `0:${'1'.repeat(64)}`;
const other = `0:${'2'.repeat(64)}`;
const master = `0:${'3'.repeat(64)}`;
const hash = (lt: number) =>
  Buffer.from(BigInt(lt).toString(16).padStart(64, '0'), 'hex').toString(
    'base64'
  );
const tx = (lt: number): RawTransaction => ({
  lt: String(lt),
  hash: hash(lt),
  prevTransactionLt: String(lt - 1),
  prevTransactionHash: hash(lt - 1),
  utime: 1700000000 + lt,
  success: true,
  status: 'success',
  totalFeesRaw: '100',
  inMessage: {
    source: other,
    destination: account,
    value: '9007199254740993123',
    op: 0,
  },
  outMessages: [],
});
const opcodes = loadOpcodes();
const projection = (owner: string, events: LedgerEvent[] = [], physicalAccounts = [owner]): LedgerProjection => ({
  events, projectionScope: { kind: 'owner', owner, physicalAccounts },
});

async function testNormalization() {
  const event = await normalizeLedgerEvent('testnet', account, tx(1), opcodes);
  assert.equal(event.movements[0].amountRaw, '9007199254740993123');
  assert.equal(event.movements[1].direction, 'fee');
  assert.equal(event.movements[1].amountRaw, '100');
  assert.deepEqual(event.issues, []);
  assert.equal(event.movements[0].asset.id, 'testnet:native');
  assert.equal(
    classifyTransaction(account, tx(1), opcodes).totalFeesRaw,
    '100'
  );
  const hex = await normalizeLedgerEvent(
    'testnet',
    Address.parse(account).toString(),
    { ...tx(1), hash: Buffer.from(hash(1), 'base64').toString('hex') },
    opcodes
  );
  assert.equal(hex.id, event.id);
  assert.notEqual(
    (await normalizeLedgerEvent('mainnet', account, tx(1), opcodes)).id,
    event.id
  );
  const missing = await normalizeLedgerEvent(
    'testnet',
    account,
    { ...tx(1), totalFeesRaw: undefined },
    opcodes
  );
  assert.equal(missing.totalFeesRaw, null);
  assert(missing.issues.includes('transaction_fee_unavailable'));
  assert(!missing.movements.some((m) => m.direction === 'fee'));
  await assert.rejects(() =>
    normalizeLedgerEvent('testnet', account, { ...tx(1), hash: 'bad' }, opcodes)
  );
  const body = beginCell()
    .storeUint(0x7362d09c, 32)
    .storeUint(4, 64)
    .storeCoins(12345678901234567890n)
    .storeAddress(Address.parse(other))
    .storeBit(false)
    .endCell()
    .toBoc()
    .toString('base64');
  const notification = {
    ...tx(2),
    inMessage: {
      source: other,
      destination: account,
      value: '1',
      op: 0x7362d09c,
      body,
    },
  };
  const received = await normalizeLedgerEvent(
    'testnet',
    account,
    notification,
    opcodes,
    async (wallet) => ({
      kind: 'jetton',
      id: `testnet:jetton:${master}`,
      master,
      wallet,
      owner: account,
      decimals: 18,
    })
  );
  assert.equal(
    received.movements.find((m) => m.asset.kind === 'jetton')?.amountRaw,
    '12345678901234567890'
  );
  assert(received.issues.includes('related_account_coverage_unverified'));
  const unknown = await normalizeLedgerEvent(
    'testnet',
    account,
    notification,
    opcodes
  );
  assert(unknown.issues.includes('jetton_identity_unresolved'));
  assert.equal(
    unknown.movements.find((m) => m.asset.kind === 'unknown')?.amountRaw,
    '12345678901234567890'
  );
  const failed = await normalizeLedgerEvent(
    'testnet',
    account,
    { ...notification, status: 'failed', success: false },
    opcodes
  );
  assert(
    !failed.movements.some(
      (m) => m.asset.kind === 'jetton' || m.asset.kind === 'unknown'
    )
  );
  assert(failed.issues.includes('jetton_settlement_unconfirmed'));
  const requestBody = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .endCell()
    .toBoc()
    .toString('base64');
  const request = await normalizeLedgerEvent(
    'testnet',
    account,
    {
      ...tx(3),
      outMessages: [
        {
          source: account,
          destination: other,
          value: '20',
          op: 0x0f8a7ea5,
          body: requestBody,
        },
      ],
    },
    opcodes
  );
  assert(request.issues.includes('settlement_not_decoded'));
  assert(request.movements.every((m) => m.asset.kind === 'native'));
}

function sourceWithHistory(
  getHead: () => number,
  onRead?: () => void
): TonDataSource {
  return {
    network: 'testnet',
    getMasterchainInfo: async () => ({ seqno: 1 }),
    getAccountState: async () =>
      getHead()
        ? {
            balance: '0',
            lastTxLt: String(getHead()),
            lastTxHash: hash(getHead()),
          }
        : { balance: '0' },
    getTransactions: async (_address, limit, lt) => {
      onRead?.();
      const end = Number(lt);
      return Array.from({ length: Math.min(limit, end) }, (_, i) =>
        tx(end - i)
      );
    },
    runGetMethod: async () => null,
    getJettonBalance: async () => null,
    getJettonMetadata: async () => null,
    close: async () => {},
  };
}

async function testProjectionScope(store: PostgresLedgerStore, pool: LedgerSqlPool) {
  const owner = `0:${'b'.repeat(64)}`, wallet = `0:${'c'.repeat(64)}`, third = `0:${'d'.repeat(64)}`;
  const firstScope = projection(owner).projectionScope;
  const secondScope = projection(owner, [], [owner, wallet]).projectionScope;
  assert.notEqual(projectionFingerprint(projection(owner), [], []), projectionFingerprint(projection(owner, [], [owner, wallet]), [], []),
    'a physical scope change changes the fingerprint even without economic events');
  assert.throws(() => projectionFingerprint([] as unknown as LedgerProjection, [], []), /projection scope/,
    'the old bare event-array signature is not admitted');
  assert.equal((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='ledger_projection_coverage' AND column_name='projection_scope'")).rows[0].is_nullable, 'NO');

  const event1 = await normalizeLedgerEvent('testnet', owner, tx(1), opcodes);
  const event2 = await normalizeLedgerEvent('testnet', owner, tx(2), opcodes);
  const firstGeneration = randomUUID();
  await store.begin('testnet', owner, firstGeneration, { lt: '2', hash: hash(2) }, '2025-01-01T00:00:00Z');
  await store.append(firstGeneration, [event1, event2], [tx(1), tx(2)]);
  await store.project(firstGeneration, projection(owner, [event1, event2]), [], []);
  const unpublished = await store.page('testnet', owner);
  assert.equal(unpublished.coverage.projectionScope, null); assert.equal(unpublished.events.length, 0);
  await store.complete('testnet', owner, firstGeneration, '2025-01-01T00:00:00Z');
  const first = await store.page('testnet', owner, { limit: 1 });
  assert.deepEqual(first.coverage.projectionScope, firstScope); assert(first.nextCursor);
  const nextGeneration = randomUUID();
  await store.begin('testnet', owner, nextGeneration, { lt: '2', hash: hash(2) }, '2025-02-01T00:00:00Z');
  await store.project(nextGeneration, projection(owner, [event1, event2], secondScope.physicalAccounts), [], ['supported_partial_decoding_gap']);
  await store.complete('testnet', owner, nextGeneration, '2025-02-01T00:00:00Z');
  const current = await store.page('testnet', owner);
  assert.deepEqual(current.coverage.projectionScope, secondScope); assert.equal(current.events.length, 2);
  assert.equal(current.coverage.snapshotComplete, true); assert.equal(current.coverage.decodingComplete, false);
  const pinned = await store.page('testnet', owner, { cursor: first.nextCursor! });
  assert.deepEqual(pinned.coverage.projectionScope, firstScope); assert.equal(pinned.coverage.generation, firstGeneration);
  assert.equal(pinned.coverage.checkedAt, first.coverage.checkedAt); assert.equal(pinned.events[0].lt, '1');

  const invalidScopes: unknown[] = [
    null, [], {}, { kind: 'account', owner, physicalAccounts: [owner] },
    { kind: 'owner', owner: wallet, physicalAccounts: [wallet] }, { kind: 'owner', owner },
    { kind: 'owner', owner, physicalAccounts: [] }, { kind: 'owner', owner, physicalAccounts: [wallet] },
    { kind: 'owner', owner, physicalAccounts: [owner, owner] },
    { kind: 'owner', owner, physicalAccounts: [wallet, owner] },
    { kind: 'owner', owner, physicalAccounts: [owner, wallet.toUpperCase()] },
    { kind: 'owner', owner, physicalAccounts: [owner, Address.parse(wallet).toString()] },
    { kind: 'owner', owner, physicalAccounts: [owner], assumed: true },
  ];
  const assertSuppressed = async () => {
    const page = await store.page('testnet', owner);
    assert.deepEqual(page.events, []); assert.equal(page.nextCursor, null); assert.equal(page.coverage.projectionScope, null);
    assert.equal(page.coverage.snapshotComplete, false); assert.equal(page.coverage.historyComplete, false);
    assert.equal(page.coverage.decodingComplete, false); assert.equal(page.coverage.checkedAt, null);
    assert(page.coverage.issues.includes('owner_projection_metadata_invalid'));
  };
  for (const scope of invalidScopes) {
    await pool.query('UPDATE ledger_projection_coverage SET projection_scope=$2::jsonb WHERE generation=$1', [nextGeneration, JSON.stringify(scope)]);
    await assertSuppressed();
  }
  await pool.query('UPDATE ledger_projection_coverage SET projection_scope=$2::jsonb WHERE generation=$1', [nextGeneration, JSON.stringify(secondScope)]);
  await assert.rejects(() => pool.query('UPDATE ledger_projection_coverage SET projection_scope=NULL WHERE generation=$1', [nextGeneration]), /null/);
  assert.deepEqual((await store.page('testnet', owner)).coverage.projectionScope, secondScope);
  await pool.query('DELETE FROM ledger_projection_coverage WHERE generation=$1', [nextGeneration]);
  await assertSuppressed();
  assert.deepEqual((await store.page('testnet', owner, { cursor: first.nextCursor! })).coverage.projectionScope, firstScope,
    'corrupt current metadata cannot replace an older cursor scope');

  const writable = randomUUID();
  await store.begin('testnet', third, writable);
  const thirdEvent = await normalizeLedgerEvent('testnet', third, tx(1), opcodes);
  await store.project(writable, projection(third, [thirdEvent]), [], []);
  const before = (await pool.query('SELECT projection_scope,fingerprint FROM ledger_projection_coverage WHERE generation=$1', [writable])).rows;
  const invalidWrites: LedgerProjection[] = [
    [] as unknown as LedgerProjection,
    { events: [thirdEvent] } as unknown as LedgerProjection,
    projection(owner, [thirdEvent]),
    projection(third, [{ ...thirdEvent, account: owner }]),
    projection(third, [{ ...thirdEvent, network: 'mainnet' }]),
    projection(third, [thirdEvent], [third, third]),
  ];
  for (const invalid of invalidWrites) await assert.rejects(() => store.project(writable, invalid, [], []), /projection/);
  await assert.rejects(() => store.project(writable, projection(third, [thirdEvent, thirdEvent]), [], []), /duplicate/);
  assert.deepEqual((await pool.query('SELECT projection_scope,fingerprint FROM ledger_projection_coverage WHERE generation=$1', [writable])).rows, before,
    'failed projection replacement rolls back immutable scope and fingerprint together');
  assert.equal((await pool.query('SELECT count(*)::text AS count FROM ledger_projection_events WHERE generation=$1', [writable])).rows[0].count, '1',
    'deleting and partially replacing events rolls back after a duplicate insert');
  await assert.rejects(() => store.complete('mainnet', third, writable), /owner or network mismatch/);
  await assert.rejects(() => store.complete('testnet', owner, writable), /owner or network mismatch/);
  await store.complete('testnet', third, writable);
  await assert.rejects(() => store.project(writable, projection(third), [], []), /not writable/);
  await assert.rejects(() => store.project(randomUUID(), projection(third), [], []), /not writable/);

  // Keep related chains and economic events identical; only the verified ownership map changes.
  const emptyOwner = `0:${'e'.repeat(64)}`, emptyWallet = `0:${'f'.repeat(64)}`;
  const build = LedgerGraphBuilder.prototype.build;
  let includeWallet = false;
  LedgerGraphBuilder.prototype.build = async function (...args) {
    const graph = await build.apply(this, args);
    if (args[0] === emptyOwner && includeWallet) graph.wallets.set(emptyWallet, {
      kind: 'jetton', id: `testnet:jetton:${master}`, master, wallet: emptyWallet, owner: emptyOwner, decimals: 9,
    });
    return graph;
  };
  try {
    const service = new LedgerService('testnet', store, sourceWithHistory(() => 0), opcodes, createLogger('silent'));
    await service.syncAccount(emptyOwner);
    const emptyFirst = await store.page('testnet', emptyOwner);
    assert.deepEqual(emptyFirst.events, []); assert.deepEqual(emptyFirst.coverage.projectionScope, projection(emptyOwner).projectionScope);
    await service.syncAccount(emptyOwner);
    assert.equal((await store.page('testnet', emptyOwner)).coverage.generation, emptyFirst.coverage.generation);
    // Captured from the pre-change exact-ledger-v13 implementation for this
    // empty owner projection and its single complete owner-chain dependency.
    const v13Fingerprint = '2da0f08f826c70d1221888dedf8e53497df2e6f861503461d8f4515b14e7c1fe';
    await pool.query('UPDATE ledger_projection_coverage SET fingerprint=$2 WHERE generation=$1', [emptyFirst.coverage.generation, v13Fingerprint]);
    await service.syncAccount(emptyOwner);
    const decoderUpdated = await store.page('testnet', emptyOwner);
    assert.notEqual(decoderUpdated.coverage.generation, emptyFirst.coverage.generation,
      'a v13 decoder fingerprint cannot reuse a quiet owner projection after the settlement admission change');
    assert.deepEqual(decoderUpdated.events, emptyFirst.events);
    assert.deepEqual(decoderUpdated.coverage.projectionScope, emptyFirst.coverage.projectionScope);
    assert.equal((await pool.query('SELECT fingerprint FROM ledger_projection_coverage WHERE generation=$1', [emptyFirst.coverage.generation])).rows[0].fingerprint, v13Fingerprint,
      'decoder refresh publishes a new generation without rewriting the previous cursor snapshot');
    await service.syncAccount(emptyOwner);
    assert.equal((await store.page('testnet', emptyOwner)).coverage.generation, decoderUpdated.coverage.generation,
      'the new decoder generation is reusable after an identical quiet recheck');
    includeWallet = true;
    await service.syncAccount(emptyOwner);
    const emptyChanged = await store.page('testnet', emptyOwner);
    assert.deepEqual(emptyChanged.events, []); assert.notEqual(emptyChanged.coverage.generation, emptyFirst.coverage.generation);
    assert.deepEqual(emptyChanged.coverage.projectionScope, projection(emptyOwner, [], [emptyOwner, emptyWallet]).projectionScope);
    assert.deepEqual(emptyChanged.coverage.relatedAccounts?.map(({ generation, ...row }) => row), emptyFirst.coverage.relatedAccounts?.map(({ generation, ...row }) => row));
    await pool.query('UPDATE ledger_projection_coverage SET projection_scope=$2::jsonb WHERE generation=$1', [emptyChanged.coverage.generation, JSON.stringify(projection(emptyOwner).projectionScope)]);
    await service.syncAccount(emptyOwner);
    const repaired = await store.page('testnet', emptyOwner);
    assert.notEqual(repaired.coverage.generation, emptyChanged.coverage.generation,
      'quiet reuse cannot trust a mismatched scope merely because the stored fingerprint still matches');
    assert.deepEqual(repaired.coverage.projectionScope, emptyChanged.coverage.projectionScope);
  } finally { LedgerGraphBuilder.prototype.build = build; }
  console.log('ledger projection scope: exact fingerprint, persisted cursor identity, 13 corrupt scopes, rollback, publication binding and empty-generation refresh passed');
}

async function testDatabase() {
  const db = new PGlite();
  // PGlite executes PostgreSQL itself; production uses node-postgres connections.
  // A single embedded session tests SQL/atomicity, not multi-process lock exclusion.
  const pool: LedgerSqlPool = {
    query: async (sql, params) => {
      if (!params && sql.includes(';')) {
        const result = await db.exec(sql);
        return { rows: result.at(-1)?.rows ?? [] };
      }
      return db.query(sql, params);
    },
    connect: async () => pool,
    end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool);
  try {
    await store.initialize();
    await store.initialize();
    await testProjectionScope(store, pool);
    let head = 1705;
    let reads = 0;
    const service = new LedgerService(
      'testnet',
      store,
      sourceWithHistory(
        () => head,
        () => reads++
      ),
      opcodes,
      createLogger('silent')
    );
    await service.syncAccount(account);
    const first = await store.page('testnet', account, { limit: 500 });
    assert.equal(first.events.length, 500);
    assert.equal(first.coverage.historyComplete, true);
    assert.equal(first.coverage.decodingComplete, true);
    assert.deepEqual(first.coverage.projectionScope, projection(account).projectionScope);
    assert(first.nextCursor);
    assert.equal(first.events[0].lt, '1705');
    let count = first.events.length;
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = await store.page('testnet', account, { limit: 500, cursor });
      count += page.events.length;
      cursor = page.nextCursor;
    }
    assert.equal(
      count,
      1705,
      'history is independent of the 1,500 transaction cache limit'
    );
    const counts = await pool.query(
      'SELECT (SELECT count(*) FROM ledger_runs)::text AS runs,(SELECT count(*) FROM ledger_membership)::text AS members,(SELECT count(*) FROM ledger_projection_events)::text AS events'
    );
    await service.syncAccount(account);
    const quiet = await store.page('testnet', account);
    assert.equal(
      quiet.coverage.generation,
      first.coverage.generation,
      'unchanged dependency evidence reuses its published generation'
    );
    assert.equal(quiet.coverage.publishedAt, first.coverage.publishedAt);
    assert(quiet.coverage.checkedAt! >= first.coverage.checkedAt!);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT (SELECT count(*) FROM ledger_runs)::text AS runs,(SELECT count(*) FROM ledger_membership)::text AS members,(SELECT count(*) FROM ledger_projection_events)::text AS events'
        )
      ).rows,
      counts.rows,
      'quiet polling creates no full-history copies'
    );
    const previousReads = reads;
    head = 1706;
    await service.syncAccount(account);
    assert.equal(
      reads - previousReads,
      1,
      'a verified historical tail is reused after a new head'
    );
    const latest = await store.page('testnet', account, { limit: 10 });
    assert.equal(latest.events[0].lt, '1706');
    const pinned = await store.page('testnet', account, {
      limit: 500,
      cursor: first.nextCursor!,
    });
    assert.equal(
      pinned.events[0].lt,
      '1205',
      'cursor is pinned to its original snapshot'
    );
    const filtered = await store.page('testnet', account, {
      fromUtime: 1700000002,
      toUtime: 1700000004,
    });
    assert.deepEqual(
      filtered.events.map((e) => e.lt),
      ['3', '2']
    );
    assert.equal(
      filtered.events[0].movements[0].amountRaw,
      '9007199254740993123'
    );
    await assert.rejects(
      () =>
        store.page('testnet', account, {
          cursor: first.nextCursor!,
          fromUtime: 1,
        }),
      LedgerCursorError
    );
    await assert.rejects(
      () => store.page('mainnet', account, { cursor: first.nextCursor! }),
      LedgerCursorError
    );
    await assert.rejects(
      () => store.page('testnet', other, { cursor: first.nextCursor! }),
      LedgerCursorError
    );
    const anotherNetwork = await store.page('mainnet', account);
    assert.equal(anotherNetwork.events.length, 0);
    assert.equal(anotherNetwork.coverage.historyComplete, false);
    assert.equal(anotherNetwork.coverage.projectionScope, null);
    const generation = randomUUID();
    await store.begin('testnet', other, generation, { lt: '1', hash: hash(1) });
    const event = await normalizeLedgerEvent('testnet', other, tx(1), opcodes);
    await store.append(generation, [event, event], [tx(1), tx(1)]);
    assert.equal(
      (await store.page('testnet', other)).events.length,
      0,
      'unpublished evidence is hidden'
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::text AS count FROM ledger_projection_events WHERE generation=$1',
          [generation]
        )
      ).rows[0].count,
      '1',
      'repeated evidence is deduplicated'
    );
    assert.equal(
      (await store.page('testnet', other)).coverage.historyComplete,
      false
    );
    await store.project(generation, projection(other, [event]), [], []);
    await store.project(generation, projection(other, [event]), [], []); // Crash after projection but before publication can resume.
    await store.complete('testnet', other, generation);
    assert.equal((await store.page('testnet', other)).events.length, 1);
    await assert.rejects(
      () => store.project(generation, projection(other), [], []),
      /not writable/
    );
    await assert.rejects(
      () => store.append(generation, [event], [tx(1)]),
      /not writable/
    );
    assert.equal(
      (await store.page('testnet', other)).events.length,
      1,
      'published snapshots cannot be overwritten'
    );
    const invalidGeneration = randomUUID();
    const event2 = await normalizeLedgerEvent('testnet', other, tx(2), opcodes);
    await assert.rejects(() =>
      store.append(invalidGeneration, [event2], [tx(2)])
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM ledger_transactions WHERE event_id=$1',
          [event2.id]
        )
      ).rows.length,
      0,
      'failed membership insert rolls back its evidence'
    );
    const empty = new LedgerService(
      'testnet',
      store,
      sourceWithHistory(() => 0),
      opcodes,
      createLogger('silent')
    );
    await empty.syncAccount(master);
    assert.equal(
      (await store.page('testnet', master)).coverage.historyComplete,
      true
    );
    assert.equal((await store.page('testnet', master)).events.length, 0);
    const brokenAccount = `0:${'4'.repeat(64)}`;
    let brokenReads = 0;
    const brokenSource = sourceWithHistory(() => 200);
    const getGood = brokenSource.getTransactions;
    brokenSource.getTransactions = async (...args) => {
      if (++brokenReads > 1) throw new Error('upstream secret');
      return getGood(...args);
    };
    const broken = new LedgerService(
      'testnet',
      store,
      brokenSource,
      opcodes,
      createLogger('silent')
    );
    await assert.rejects(() => broken.syncAccount(brokenAccount));
    const partial = await store.page('testnet', brokenAccount);
    assert.equal(
      partial.events.length,
      0,
      'failed unpublished snapshots never expose mutable pages'
    );
    assert.equal(partial.coverage.historyComplete, false);
    assert.equal(partial.coverage.projectionScope, null);
    assert(partial.coverage.issues.includes('history_source_unavailable'));
    assert(!JSON.stringify(partial).includes('upstream secret'));
    const forgedAccount = `0:${'5'.repeat(64)}`;
    const forgedSource = sourceWithHistory(() => 3);
    forgedSource.getTransactions = async () => [
      tx(3),
      { ...tx(2), prevTransactionHash: hash(99) },
      tx(1),
    ];
    const forged = new LedgerService(
      'testnet',
      store,
      forgedSource,
      opcodes,
      createLogger('silent')
    );
    await assert.rejects(() => forged.syncAccount(forgedAccount));
    assert.equal(
      (await store.page('testnet', forgedAccount)).coverage.historyComplete,
      false
    );
    // Bounded passes resume the existing unpublished run, without pruning history.
    const largeAccount = `0:${'6'.repeat(64)}`;
    let boundedReads = 0;
    const bounded = new LedgerService(
      'testnet',
      store,
      sourceWithHistory(
        () => 205,
        () => boundedReads++
      ),
      opcodes,
      createLogger('silent'),
      2,
      { maxPagesPerSync: 1 }
    );
    await bounded.syncAccount(largeAccount);
    const boundedGeneration = (await store.account('testnet', largeAccount))
      .latest_generation;
    await pool.query(
      "UPDATE ledger_runs SET head_observed_at='2020-01-01T00:00:00Z' WHERE generation=$1",
      [boundedGeneration]
    );
    const deferred = await store.page('testnet', largeAccount);
    assert.equal(deferred.coverage.snapshotComplete, false);
    assert(deferred.coverage.issues.includes('backfill_capacity_deferred'));
    await bounded.syncAccount(largeAccount);
    await bounded.syncAccount(largeAccount);
    assert.equal(
      (await store.page('testnet', largeAccount)).coverage.checkedAt,
      '2020-01-01T00:00:00.000Z',
      'publication after a long backfill does not advance the chain watermark'
    );
    assert.equal(boundedReads, 3);
    assert.equal(
      (await store.page('testnet', largeAccount)).coverage.generation,
      boundedGeneration
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::text AS count FROM ledger_membership WHERE generation=$1',
          [boundedGeneration]
        )
      ).rows[0].count,
      '205'
    );
    const physicalAccount = `0:${'a'.repeat(64)}`;
    await bounded.syncAccount(physicalAccount, false, { pages: 3 });
    const physicalOnly = await store.page('testnet', physicalAccount);
    assert.equal(physicalOnly.coverage.snapshotComplete, false);
    assert.equal(physicalOnly.coverage.projectionScope, null);
    assert(physicalOnly.coverage.issues.includes('owner_projection_pending'));
    assert.equal(physicalOnly.events.length, 0);
    // Configured root discovery catches incoming tokens even when the owner head is empty/unchanged.
    const custodyOwner = `0:${'7'.repeat(64)}`,
      custodyWallet = `0:${'8'.repeat(64)}`;
    let custodyHead = 2;
    const custodyTx = (lt: number): RawTransaction => ({
      ...tx(lt),
      inMessage: {
        source: master,
        destination: custodyWallet,
        value: '0',
        createdLt: String(lt),
        op: 0x178d4519,
        body: beginCell()
          .storeUint(0x178d4519, 32)
          .storeUint(lt, 64)
          .storeCoins(BigInt(lt) * 100n)
          .storeAddress(Address.parse(master))
          .storeAddress(Address.parse(custodyOwner))
          .storeCoins(0)
          .storeRef(Cell.EMPTY)
          .endCell()
          .toBoc()
          .toString('base64'),
      },
    });
    const custodySource: TonDataSource = {
      ...sourceWithHistory(() => 0),
      getAccountState: async (address) =>
        address === custodyWallet
          ? {
              balance: '0',
              lastTxLt: String(custodyHead),
              lastTxHash: hash(custodyHead),
            }
          : { balance: '0' },
      getTransactions: async (address, limit, lt) =>
        address === custodyWallet
          ? Array.from({ length: Math.min(limit, Number(lt)) }, (_, i) =>
              custodyTx(Number(lt) - i)
            )
          : [],
      getJettonBalance: async (who, root) =>
        who === custodyOwner && root === master
          ? { wallet: custodyWallet, balance: '300' }
          : null,
      getJettonMetadata: async () => ({ decimals: 9 }),
      runGetMethod: async (address, method) =>
        address === custodyWallet && method === 'get_wallet_data'
          ? {
              exitCode: 0,
              stack: [
                { type: 'int', value: 300n },
                {
                  type: 'slice',
                  cell: beginCell()
                    .storeAddress(Address.parse(custodyOwner))
                    .endCell(),
                },
                {
                  type: 'slice',
                  cell: beginCell()
                    .storeAddress(Address.parse(master))
                    .endCell(),
                },
                { type: 'cell', cell: Cell.EMPTY },
              ],
            }
          : null,
    };
    const custody = new LedgerService(
      'testnet',
      store,
      custodySource,
      opcodes,
      createLogger('silent'),
      2,
      { jettonRoots: [master] }
    );
    await custody.syncAccount(custodyOwner);
    const custodyFirst = await store.page('testnet', custodyOwner, {
      limit: 1,
    });
    assert.equal(
      custodyFirst.events[0].movements.find((m) => m.asset.kind === 'jetton')
        ?.amountRaw,
      '200'
    );
    assert(custodyFirst.nextCursor);
    assert.deepEqual(custodyFirst.coverage.projectionScope, projection(custodyOwner, [], [custodyOwner, custodyWallet].sort()).projectionScope);
    assert(
      custodyFirst.coverage.relatedAccounts?.some(
        (a) => a.account === custodyWallet && a.historyComplete
      )
    );
    await custody.syncAccount(custodyOwner);
    assert.equal(
      (await store.page('testnet', custodyOwner)).coverage.generation,
      custodyFirst.coverage.generation
    );
    custodyHead = 3;
    await custody.syncAccount(custodyOwner);
    const custodyChanged = await store.page('testnet', custodyOwner);
    assert.notEqual(
      custodyChanged.coverage.generation,
      custodyFirst.coverage.generation
    );
    assert.equal(custodyChanged.events.length, 3);
    const custodyPinned = await store.page('testnet', custodyOwner, {
      cursor: custodyFirst.nextCursor!,
    });
    assert.equal(custodyPinned.events.length, 1);
    assert.equal(custodyPinned.events[0].lt, '1');
    assert.equal(
      custodyPinned.coverage.publishedAt,
      custodyFirst.coverage.publishedAt
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM ledger_watch_accounts WHERE account=$1',
          [custodyWallet]
        )
      ).rows.length,
      0,
      'related accounts are not implicitly admitted as owner watches'
    );
    const capped = new LedgerService(
      'testnet',
      store,
      sourceWithHistory(() => 0),
      opcodes,
      createLogger('silent'),
      2,
      { maxWatchedAccounts: 0 }
    );
    const denied = await capped.page(`0:${'9'.repeat(64)}`);
    assert(denied.coverage.issues.includes('watch_capacity_reached'));
    assert.equal(denied.coverage.snapshotComplete, false);
    assert.equal(
      await store.account('testnet', `0:${'9'.repeat(64)}`),
      null,
      'rejected admission creates no persistent account'
    );
    const api = fastify();
    registerLedgerRoutes(api, service);
    assert.equal(
      (
        await api.inject({
          url: `/api/indexer/v1/accounts/${account}/ledger?limit=501`,
        })
      ).statusCode,
      400
    );
    assert.equal(
      (
        await api.inject({
          url: `/api/indexer/v1/accounts/${account}/ledger?from_utime=3&to_utime=2`,
        })
      ).statusCode,
      400
    );
    assert.equal(
      (
        await api.inject({
          url: `/api/indexer/v1/accounts/${account}/ledger?cursor=not-a-cursor`,
        })
      ).statusCode,
      400
    );
    const response = await api.inject({
      url: `/api/indexer/v1/accounts/${account}/ledger?from_utime=1700000002&to_utime=1700000004`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().events.map((e: { lt: string }) => e.lt),
      ['3', '2']
    );
    await api.close();
    const absent = fastify();
    registerLedgerRoutes(absent);
    assert.equal(
      (
        await absent.inject({
          url: `/api/indexer/v1/accounts/${account}/ledger`,
        })
      ).statusCode,
      503
    );
    await absent.close();
  } finally {
    await pool.end();
  }
}

async function testUnscopedSchemaRejected() {
  const db = new PGlite();
  const pool: LedgerSqlPool = {
    query: async (sql, params) => {
      if (!params && sql.includes(';')) return { rows: (await db.exec(sql)).at(-1)?.rows ?? [] };
      return db.query(sql, params);
    },
    connect: async () => pool,
    end: () => db.close(),
  };
  try {
    // A separate disposable database models a superseded schema, never an app DB.
    await db.exec(`CREATE TABLE ledger_projection_coverage (
      generation uuid PRIMARY KEY, fingerprint text NOT NULL,
      related_accounts jsonb NOT NULL, issues jsonb NOT NULL
    );`);
    await assert.rejects(() => new PostgresLedgerStore(pool).initialize(), /projection_scope.*does not exist/,
      'bootstrap must fail instead of inferring or migrating an unscoped schema');
    const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='ledger_projection_coverage' ORDER BY ordinal_position");
    assert.deepEqual(columns.rows.map(row => row.column_name), ['generation', 'fingerprint', 'related_accounts', 'issues'],
      'rejected bootstrap leaves the original coverage schema unchanged');
  } finally { await db.close(); }
}

function testDatabaseSecret() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-secret-'));
  const path = join(dir, 'database-url');
  try {
    writeFileSync(
      path,
      'postgresql://ledger:private-value@db.internal/ledger\n'
    );
    assert.equal(
      readDatabaseUrl({ INDEXER_DATABASE_URL_FILE: path }),
      'postgresql://ledger:private-value@db.internal/ledger'
    );
    assert.equal(readDatabaseUrl({}), undefined);
    assert.throws(() =>
      readDatabaseUrl({
        INDEXER_DATABASE_URL: 'postgresql://db/ledger',
        INDEXER_DATABASE_URL_FILE: path,
      })
    );
    assert.throws(
      () =>
        readDatabaseUrl({ INDEXER_DATABASE_URL_FILE: join(dir, 'missing') }),
      /could not be read/
    );
    writeFileSync(path, '');
    assert.throws(
      () => readDatabaseUrl({ INDEXER_DATABASE_URL_FILE: path }),
      /empty/
    );
    assert.throws(
      () => readDatabaseUrl({ INDEXER_DATABASE_URL: 'https://private-value' }),
      (error) => !String(error).includes('private-value')
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function main() {
  testDatabaseSecret();
  await testNormalization();
  await testUnscopedSchemaRejected();
  await testDatabase();
  console.log(
    'ledger normalization, PostgreSQL persistence, chain coverage, and API tests passed'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
