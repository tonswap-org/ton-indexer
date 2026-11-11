import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { LedgerSqlPool } from '../ledger/store';
import { bindOrderRelease, orderJson } from '../orders/discovery';
import { ARCHIVE_CHECKPOINT_BYTES, archiveCheckpoint, readArchiveCheckpointHistory, validateArchiveCheckpoint, type ArchiveBoundaryCheckpoint } from '../runtime/archiveCheckpoint';
import { PostgresOrderStore } from '../runtime/orderStore';
import { createOperationEvidenceGate } from '../runtime/operationEvidenceGate';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';

// Synthetic summaries test persistence and orchestration, not native proof.
// Original execution, sparse transitions and caller responses have separate
// retained native default/x6 tests under the unchanged 20-second gate.
const hash = (n: number) => n.toString(16).padStart(64, '0');
const account = runtimeAddress(920), scope = hash(1000), release = bindOrderRelease(runtimeManifestFixture());
const row = (n: number, override: Partial<Omit<ArchiveBoundaryCheckpoint, 'digest'>> = {}) => archiveCheckpoint({
  scope, account, lt: String(n), hash: hash(n), previousLt: String(n - 1), previousHash: hash(n - 1),
  before: hash(100 + n - 1), after: hash(100 + n), seqno: n, unixTime: 1000 + n, payload: { verifiedOriginal: n }, ...override,
});
const head = (n: number, override: Partial<{ lt: string; hash: string; shardHash: string; seqno: number; unixTime: number }> = {}) =>
  ({ lt: String(n), hash: hash(n), shardHash: hash(100 + n), seqno: n, unixTime: 1000 + n, ...override });
async function main() {
  const db = new PGlite(), query = async (sql: string, params?: any[]) => db.query(sql, params);
  const pool: LedgerSqlPool = { query, connect: async () => ({ query }), end: async () => undefined };
  await db.exec(readFileSync(resolve(__dirname, '../../sql/ledger.sql'), 'utf8'));
  const store = () => new PostgresOrderStore(pool, release);
  const seed = async (r: ArchiveBoundaryCheckpoint) => {
    await query('INSERT INTO current_transaction_evidence(manifest_hash,account,lt,hash,evidence,containing_seqno) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [release.manifestHash, account, r.lt, r.hash, { syntheticForeignKeyOnly: true }, r.seqno]);
  };
  const verified: string[] = [];
  const verify = async (lt: string, requestedHash: string) => { const r = row(Number(lt)); assert.equal(r.hash, requestedHash); verified.push(lt); await seed(r); return r; };
  const request = (n: number, options: Partial<Parameters<typeof readArchiveCheckpointHistory>[0]> = {}) =>
    readArchiveCheckpointHistory({ scope, account, current: head(n), store: store(), verify, historyLimit: 10000, slice: { rows: 2, milliseconds: 8000 }, ...options });
  try {
    let result = await request(5); assert.equal(result.complete, false); assert.equal(result.verified, 2); assert.deepEqual(result.rows.map(r => r.lt), ['5', '4']);
    result = await request(5); assert.equal(result.complete, false); assert.equal(result.verified, 2); assert.deepEqual(verified, ['5', '4', '3', '2']);
    result = await request(5); assert.equal(result.complete, true); assert.equal(result.verified, 1); assert.deepEqual(result.rows.map(r => r.lt), ['5', '4', '3', '2', '1']);
    result = await request(5, { verify: async () => { throw Error('cached immutable original must survive service reconstruction'); } }); assert(result.complete); assert.equal(result.verified, 0);
    // An advancing anchor adds just the new exact tail, not a restarted scan.
    result = await request(7); assert(result.complete); assert.equal(result.verified, 2); assert.equal(result.rows.length, 7);
    // Concurrent requests admit identical immutable facts without replacing them.
    const concurrent = await Promise.all([request(9), request(9)]); assert(concurrent.every(r => r.complete));
    assert.equal((await store().archiveCheckpoints(scope, account)).length, 9);
    const retained = row(9); await assert.rejects(store().retainArchiveCheckpoint(row(9, { payload: { changed: true } })), /Immutable archive checkpoint conflict/);
    assert.equal(orderJson((await store().archiveCheckpoints(scope, account)).find(r => r.lt === '9')), orderJson(retained));
    assert.throws(() => validateArchiveCheckpoint({ ...retained, after: hash(777) }), /Invalid immutable/);
    assert.equal((await new PostgresOrderStore(pool, { ...release, manifestHash: hash(888) }).archiveCheckpoints(scope, account)).length, 0);
    assert.equal((await store().archiveCheckpoints(hash(1001), account)).length, 0);
    const unretained = row(30); await assert.rejects(store().retainArchiveCheckpoint(unretained), /foreign key/i);
    // A fork can reuse only its exact linked prefix; same LT does not mean same transaction.
    const fork = row(10, { hash: hash(5010), previousLt: '5', previousHash: hash(5), before: hash(105) }); await seed(fork);
    result = await request(10, { current: head(10, { hash: fork.hash }), verify: async () => fork }); assert(result.complete); assert.equal(result.rows.length, 6);
    await assert.rejects(request(9, { current: head(9, { shardHash: hash(999) }) }), /chain mismatch/);
    await assert.rejects(request(9, { current: head(9, { seqno: 8 }) }), /chain mismatch/);
    await assert.rejects(request(9, { current: head(9, { unixTime: 1008 }) }), /chain mismatch/);
    const badTail = row(11, { previousLt: '9', previousHash: hash(9), before: hash(666) }); await seed(badTail);
    await assert.rejects(request(11, { verify: async () => badTail }), /chain mismatch/);
    // The tail itself is immutable, but it cannot join a different predecessor.
    assert((await store().archiveCheckpoints(scope, account)).some(r => r.lt === '11'));
    const wrongAfter = row(12, { after: hash(999) }); await seed(wrongAfter);
    await assert.rejects(request(12, { verify: async () => wrongAfter }), /outside the current chain/);
    assert(!(await store().archiveCheckpoints(scope, account)).some(r => r.lt === '12'));
    // Abort preserves only previously completed, linked verification, then a new
    // request resumes from those facts. No partial result is returned as ready.
    const cancellationScope = hash(2000), controller = new AbortController(); let calls = 0;
    const cancellable = async (lt: string) => { const r = row(Number(lt), { scope: cancellationScope }); await seed(r); if (++calls === 2) controller.abort(); return r; };
    await assert.rejects(request(3, { scope: cancellationScope, signal: controller.signal, verify: cancellable }), { name: 'AbortError' });
    assert.equal((await store().archiveCheckpoints(cancellationScope, account)).length, 1);
    result = await request(3, { scope: cancellationScope, verify: async lt => row(Number(lt), { scope: cancellationScope }) }); assert(result.complete); assert.equal(result.verified, 2);
    await assert.rejects(request(9, { historyLimit: 2 }), /history limit/);
    const missingScope = hash(3000); await assert.rejects(request(1, { scope: missingScope, verify: async () => { throw Error('Missing original boundary'); } }), /Missing original/);
    assert.equal((await store().archiveCheckpoints(missingScope, account)).length, 0);
    // Grow the durable scope immediately after its first read statement. The
    // old aggregate-then-payload implementation would return >16MiB here. The
    // single statement must return its bounded snapshot, then refuse the next
    // read without loading payloads from the now oversized scope.
    const growingScope = hash(4000), large = Array.from({ length: 67 }, (_, i) => row(1000 + i, { scope: growingScope, payload: { padding: 'x'.repeat(250000) } }));
    for (const r of large) await seed(r);
    const insert = async (r: ArchiveBoundaryCheckpoint) => query(`INSERT INTO current_archive_checkpoints(manifest_hash,scope,account,lt,hash,checkpoint) VALUES($1,$2,$3,$4,$5,$6)`,
      [release.manifestHash, growingScope, account, r.lt, r.hash, r]);
    for (const r of large.slice(0, 66)) await insert(r);
    const beforeSize = await db.query<{ bytes: string }>('SELECT sum(octet_length(checkpoint::text))::text AS bytes FROM current_archive_checkpoints WHERE scope=$1', [growingScope]);
    assert(BigInt(String(beforeSize.rows[0].bytes)) < BigInt(ARCHIVE_CHECKPOINT_BYTES));
    let statements = 0;
    const growingQuery = async (sql: string, params?: any[]) => { const result = await query(sql, params); if (++statements === 1) await insert(large[66]); return result; };
    const growingStore = new PostgresOrderStore({ query: growingQuery, connect: async () => ({ query: growingQuery }), end: async () => undefined }, release);
    const bounded = await growingStore.archiveCheckpoints(growingScope, account);
    assert.equal(statements, 1); assert.equal(bounded.length, 66); assert(Buffer.byteLength(orderJson(bounded)) < ARCHIVE_CHECKPOINT_BYTES);
    await assert.rejects(growingStore.archiveCheckpoints(growingScope, account), /history\/byte limit/);
    assert.equal(statements, 2);
    const gate = createOperationEvidenceGate(1);
    await assert.rejects(gate.run(async signal => { await new Promise(resolve => setTimeout(resolve, 5)); signal.throwIfAborted(); }, () => Error('busy')), { name: 'TimeoutError' }); await gate.stop();
    assert.throws(() => createOperationEvidenceGate(20001), /Invalid evidence deadline/);
    console.log('Archive bounded progress, SQL immutable/FK persistence, restart, release/decoder isolation, concurrency, anchor advance/fork, cancellation, missing evidence and unchanged maximum deadline passed. Synthetic summaries do not qualify native evidence.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
