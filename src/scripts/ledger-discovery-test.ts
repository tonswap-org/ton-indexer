import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import fastify from 'fastify';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { LedgerDiscoveryCursorError } from '../ledger/discovery';
import { registerLedgerRoutes } from '../ledger/routes';
import type { LedgerService } from '../ledger/service';
import type { LedgerEvent } from '../ledger/types';

const owner = '0:' + '1'.repeat(64), other = '0:' + '2'.repeat(64);
const hash = Buffer.alloc(32, 7).toString('base64');
const since = new Date(Date.now() - 120_000).toISOString(), epoch = Math.floor(Date.parse(since) / 1000);
const event = (id: string, utime = epoch - 100): LedgerEvent => ({ id, network: 'testnet', account: owner,
  lt: '1', hash, txId: `1:${hash}`, utime, status: 'success', kind: 'swap', actions: [], issues: [],
  totalFeesRaw: '0', movements: [], settlement: { status: 'incomplete', protocol: 'dlmm', operation: 'swap',
    evidence: [{ account: owner, lt: '1', hash, utime }] } });

async function main() {
  const db = new PGlite();
  const pool: LedgerSqlPool = { query: async (sql, values) => !values && sql.includes(';')
    ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, values), connect: async () => pool, end: () => db.close() };
  const store = new PostgresLedgerStore(pool);
  async function publish(events: LedgerEvent[], account = owner, network: 'testnet' | 'mainnet' = 'testnet') {
    const generation = randomUUID();
    await store.begin(network, account, generation);
    await store.project(generation, { events, projectionScope: { kind: 'owner', owner: account, physicalAccounts: [account] } }, [], []);
    await store.complete(network, account, generation);
    return generation;
  }
  try {
    await store.initialize();
    const original = event('requested-before-enrollment');
    const first = await publish([original]);
    // An event published before enrollment can still be a candidate if the
    // particular chain stage reaches enrollment; publication is not its time.
    await pool.query('UPDATE ledger_discovery_events SET discovered_at=$1 WHERE generation=$2', [new Date(Date.parse(since) - 1000).toISOString(), first]);
    assert.deepEqual((await store.discoveries('testnet', owner, { since })).revisions, []);
    const confirmed = structuredClone(original);
    confirmed.settlement!.status = 'confirmed';
    confirmed.settlement!.evidence.push({ account: other, lt: '2', hash, utime: epoch + 30 });
    const second = await publish([confirmed]);
    const recovered = await store.discoveries('testnet', owner, { since });
    assert.equal(recovered.revisions.length, 1);
    assert.equal(recovered.revisions[0].revision, '2');
    assert.equal(recovered.revisions[0].event.utime, original.utime);
    assert.equal(recovered.revisions[0].evidenceUtime, epoch + 30);
    await pool.query('UPDATE ledger_discovery_events SET discovered_at=$1 WHERE generation=$2', [new Date(Date.parse(since) - 1000).toISOString(), second]);
    assert.equal((await store.discoveries('testnet', owner, { since })).revisions[0].revision, '2', 'chain evidence bounds preserve a pre-publication enrollment candidate');
    await publish([confirmed]);
    assert.equal((await store.discoveries('testnet', owner, { since, afterRevision: '2' })).revisions.length, 0, 'unchanged projection creates no revision');
    const changed = structuredClone(confirmed); changed.issues.push('fee_breakdown_unavailable');
    await publish([changed, event('another-old-request')]);
    const page = await store.discoveries('testnet', owner, { since, afterRevision: '2', limit: 1 });
    assert.equal(page.revisions[0].revision, '3'); assert(page.nextCursor);
    const through = page.throughRevision;
    const later = structuredClone(changed); later.movements.push({ id: 'fee', asset: { id: 'testnet:native', kind: 'native', decimals: 9 }, direction: 'fee', amountRaw: '1', source: owner,
      evidence: { kind: 'transaction_fee', transactionStatus: 'success', transactions: [{ account: owner, lt: '1', hash, utime: epoch - 100 }] } });
    await publish([later, event('another-old-request')]);
    const resumed = await new PostgresLedgerStore(pool).discoveries('testnet', owner, { since, cursor: page.nextCursor! });
    assert.equal(resumed.throughRevision, through); assert.equal(resumed.coverage.generation, page.coverage.generation);
    assert.equal(resumed.revisions[0].revision, '4'); assert.equal(resumed.nextCursor, null);
    assert.equal((await store.discoveries('testnet', owner, { since, afterRevision: through })).revisions[0].revision, '5', 'a later old-request discovery survives a completed cursor');
    assert.deepEqual((await store.discoveries('testnet', other, { since })).revisions, []);
    assert.deepEqual((await store.discoveries('mainnet', owner, { since })).revisions, []);
    await assert.rejects(store.discoveries('testnet', owner, { since, cursor: page.nextCursor!, afterRevision: '0' }), LedgerDiscoveryCursorError);
    await assert.rejects(store.discoveries('testnet', owner, { since: new Date(Date.parse(since) + 1).toISOString(), cursor: page.nextCursor! }), LedgerDiscoveryCursorError);
    await assert.rejects(store.discoveries('testnet', other, { since, cursor: page.nextCursor! }), LedgerDiscoveryCursorError);
    await assert.rejects(store.discoveries('mainnet', owner, { since, cursor: page.nextCursor! }), LedgerDiscoveryCursorError);
    await assert.rejects(store.discoveries('testnet', owner, { since, afterRevision: '999' }), LedgerDiscoveryCursorError);
    const forged = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()); forged.through = '5';
    await assert.rejects(store.discoveries('testnet', owner, { since, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }), LedgerDiscoveryCursorError);
    const before = await store.discoveries('testnet', owner, { since });
    const broken = event('invalid-time'); broken.settlement!.evidence[0].utime = -1;
    await assert.rejects(publish([broken]), /Invalid discovery transaction time/);
    const after = await store.discoveries('testnet', owner, { since });
    assert.equal(after.throughRevision, before.throughRevision); assert.equal(after.coverage.generation, before.coverage.generation, 'failed discovery publication rolls back the entire owner head');
    await pool.query('UPDATE ledger_discovery_heads SET revision=$1 WHERE network=$2 AND account=$3', ['9007199254740993', 'testnet', owner]);
    await publish([event('exact-large-revision')]);
    assert.equal((await store.discoveries('testnet', owner, { since, afterRevision: '9007199254740993' })).revisions[0].revision, '9007199254740994');
    const getter = event('getter-refresh'); getter.account = other;
    getter.movements = [{ id: 'getter-movement', direction: 'out', amountRaw: '1', asset: { kind: 'jetton', id: 'testnet:jetton:' + owner },
      evidence: { kind: 't3_mint', getter: { account: other, method: 'redemption_identity', args: ['1'], result: ['1'], observedAt: since } } }];
    await publish([getter], other);
    getter.movements[0].evidence.getter!.observedAt = new Date().toISOString();
    await publish([getter], other);
    assert.equal((await store.discoveries('testnet', other, { since })).throughRevision, '1', 'getter timestamp-only refresh cannot create economic discovery');
    const app = fastify();
    registerLedgerRoutes(app, { discoveries: (account: string, query: any) => store.discoveries('testnet', account, query) } as LedgerService);
    assert.equal((await app.inject(`/api/indexer/v1/accounts/${owner}/ledger/discoveries?since=${encodeURIComponent(since)}`)).statusCode, 200);
    assert.equal((await app.inject(`/api/indexer/v1/accounts/${owner}/ledger/discoveries?since=invalid`)).statusCode, 400);
    await app.close();
    console.log('Ledger discovery assertions passed (late settlement, independent clocks, dedup, cursor pinning/restart, wallet/network isolation, rollback and exact revisions).');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
