import type { LedgerSqlPool } from '../ledger/store';
import { orderHash, orderJson, type OrderRelease } from '../orders/discovery';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { pageOpenOrders, type OpenOrderSnapshot } from '../orders/openOrders';
import { ARCHIVE_CHECKPOINT_BYTES, validateArchiveCheckpoint, type ArchiveBoundaryCheckpoint, type ArchiveCheckpointStore } from './archiveCheckpoint';

export interface OrderStore {
  evidence(account: string, lt: string, hash: string): Promise<OrderTransactionEvidence | null>;
  retain(evidence: OrderTransactionEvidence, seqno: number): Promise<void>;
  publish(snapshot: OpenOrderSnapshot, now?: number): Promise<boolean>;
  current(): Promise<OpenOrderSnapshot | null>;
  snapshot(id: string): Promise<OpenOrderSnapshot | null>;
}
/** Release namespace and full manifest hash both bind persisted evidence. Only
 * immutable original transaction boundaries are reused across current reads. */
export class PostgresOrderStore implements OrderStore, ArchiveCheckpointStore {
  constructor(private pool: LedgerSqlPool, private release: OrderRelease) {}
  async archiveCheckpoints(scope: string, account: string): Promise<ArchiveBoundaryCheckpoint[]> {
    // One MVCC statement binds the size decision to its returned payload. Two
    // statements permit concurrent immutable inserts to bypass the pre-load cap.
    const result = await this.pool.query(`WITH bounds AS MATERIALIZED (
      SELECT count(*) AS count,coalesce(sum(octet_length(checkpoint::text)),0) AS bytes
      FROM current_archive_checkpoints WHERE manifest_hash=$1 AND scope=$2 AND account=$3)
      SELECT count::text AS count,bytes::text AS bytes,
        CASE WHEN count<=10000 AND bytes<=$4 THEN (
          SELECT coalesce(jsonb_agg(checkpoint ORDER BY lt,hash),'[]'::jsonb)
          FROM current_archive_checkpoints WHERE manifest_hash=$1 AND scope=$2 AND account=$3
        ) ELSE NULL END AS checkpoints FROM bounds`, [this.release.manifestHash, scope, account, ARCHIVE_CHECKPOINT_BYTES]);
    const row = result.rows[0];
    if (BigInt(String(row?.count)) > 10000n || BigInt(String(row?.bytes)) > BigInt(ARCHIVE_CHECKPOINT_BYTES) || !Array.isArray(row?.checkpoints))
      throw Error('Archive checkpoint history/byte limit');
    return row.checkpoints.map((checkpoint: ArchiveBoundaryCheckpoint) => validateArchiveCheckpoint(checkpoint));
  }
  async retainArchiveCheckpoint(value: ArchiveBoundaryCheckpoint): Promise<void> {
    validateArchiveCheckpoint(value);
    await this.pool.query(`INSERT INTO current_archive_checkpoints(manifest_hash,scope,account,lt,hash,checkpoint)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(manifest_hash,scope,account,lt,hash) DO NOTHING`,
      [this.release.manifestHash, value.scope, value.account, value.lt, value.hash, value]);
    const retained = await this.pool.query(`SELECT checkpoint FROM current_archive_checkpoints
      WHERE manifest_hash=$1 AND scope=$2 AND account=$3 AND lt=$4 AND hash=$5`,
      [this.release.manifestHash, value.scope, value.account, value.lt, value.hash]);
    if (orderJson(retained.rows[0]?.checkpoint) !== orderJson(value)) throw Error('Immutable archive checkpoint conflict');
  }
  async evidence(account: string, lt: string, hash: string): Promise<OrderTransactionEvidence | null> {
    return (await this.evidenceBoundary(account, lt, hash))?.evidence ?? null;
  }
  async evidenceBoundary(account: string, lt: string, hash: string): Promise<{ evidence: OrderTransactionEvidence; seqno: number } | null> {
    const result = await this.pool.query('SELECT evidence, containing_seqno FROM current_transaction_evidence WHERE manifest_hash=$1 AND account=$2 AND lt=$3 AND hash=$4',
      [this.release.manifestHash, account, lt, hash]);
    if (!result.rows.length) return null;
    const evidence = result.rows[0].evidence as OrderTransactionEvidence, checked = verifyOrderTransaction(evidence);
    if (evidence.account !== account || checked.tx.lt.toString() !== lt || checked.hash !== hash) throw Error('Stored order evidence identity mismatch');
    const seqno = Number(result.rows[0].containing_seqno);
    if (!Number.isSafeInteger(seqno) || seqno < 0) throw Error('Stored evidence masterchain boundary is invalid');
    return { evidence, seqno };
  }
  async retain(evidence: OrderTransactionEvidence, seqno: number): Promise<void> {
    if (!Number.isSafeInteger(seqno) || seqno < 0) throw Error('Invalid evidence masterchain boundary');
    const checked = verifyOrderTransaction(evidence), lt = checked.tx.lt.toString();
    await this.pool.query(`INSERT INTO current_transaction_evidence(manifest_hash,account,lt,hash,evidence,containing_seqno)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(manifest_hash,account,lt,hash) DO NOTHING`,
      [this.release.manifestHash, evidence.account, lt, checked.hash, evidence, seqno]);
    const retained = await this.evidenceBoundary(evidence.account, lt, checked.hash);
    if (orderJson(retained?.evidence) !== orderJson(evidence) || retained?.seqno !== seqno) throw Error('Immutable transaction evidence conflict');
  }
  async snapshot(id: string): Promise<OpenOrderSnapshot | null> {
    const result = await this.pool.query('SELECT snapshot FROM current_order_snapshots WHERE manifest_hash=$1 AND snapshot_id=$2', [this.release.manifestHash, id]);
    return result.rows.length ? this.validate(result.rows[0].snapshot) : null;
  }
  async current(): Promise<OpenOrderSnapshot | null> {
    const result = await this.pool.query(`SELECT s.snapshot FROM current_order_publication p JOIN current_order_snapshots s
      ON s.manifest_hash=p.manifest_hash AND s.snapshot_id=p.snapshot_id WHERE p.manifest_hash=$1`, [this.release.manifestHash]);
    return result.rows.length ? this.validate(result.rows[0].snapshot) : null;
  }
  private validate(snapshot: OpenOrderSnapshot): OpenOrderSnapshot {
    const { snapshotId, ...content } = snapshot;
    if (snapshot.manifestHash !== this.release.manifestHash || snapshot.releaseId !== this.release.releaseId
      || snapshotId !== orderHash(content)) throw Error('Stored order snapshot identity mismatch');
    return snapshot;
  }
  async publish(snapshot: OpenOrderSnapshot, now = Date.now()): Promise<boolean> {
    this.validate(snapshot); pageOpenOrders(snapshot, this.release, { now, limit: 100 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`tonswap:orders:${this.release.manifestHash}`]);
      const previous = await client.query('SELECT s.snapshot FROM current_order_publication p JOIN current_order_snapshots s ON s.manifest_hash=p.manifest_hash AND s.snapshot_id=p.snapshot_id WHERE p.manifest_hash=$1', [this.release.manifestHash]);
      const current = previous.rows.length ? this.validate(previous.rows[0].snapshot) : null;
      if (current && snapshot.asOf.masterchainSeqno === current.asOf.masterchainSeqno && snapshot.asOf.blockRootHash !== current.asOf.blockRootHash)
        throw Error('Order publication has conflicting masterchain roots');
      if (current && snapshot.asOf.masterchainSeqno === current.asOf.masterchainSeqno && snapshot.asOf.unixTime !== current.asOf.unixTime)
        throw Error('Order publication has conflicting chain times');
      if (current && snapshot.asOf.masterchainSeqno > current.asOf.masterchainSeqno && snapshot.asOf.unixTime < current.asOf.unixTime)
        throw Error('Order publication chain time regressed');
      await client.query(`INSERT INTO current_order_snapshots(manifest_hash,snapshot_id,masterchain_seqno,block_root_hash,unix_time,snapshot)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(manifest_hash,snapshot_id) DO NOTHING`,
        [this.release.manifestHash, snapshot.snapshotId, snapshot.asOf.masterchainSeqno, snapshot.asOf.blockRootHash, snapshot.asOf.unixTime, snapshot]);
      const retained = await client.query('SELECT snapshot FROM current_order_snapshots WHERE manifest_hash=$1 AND snapshot_id=$2', [this.release.manifestHash, snapshot.snapshotId]);
      if (orderJson(retained.rows[0]?.snapshot) !== orderJson(snapshot)) throw Error('Immutable order snapshot conflict');
      // A late worker cannot replace a newer publication. For one exact head,
      // only a transition from incomplete to complete can replace its snapshot.
      const advance = !current || snapshot.asOf.masterchainSeqno > current.asOf.masterchainSeqno
        || (snapshot.asOf.masterchainSeqno === current.asOf.masterchainSeqno && !current.coverage.complete && snapshot.coverage.complete);
      if (advance) await client.query(`INSERT INTO current_order_publication(manifest_hash,snapshot_id) VALUES($1,$2)
        ON CONFLICT(manifest_hash) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`, [this.release.manifestHash, snapshot.snapshotId]);
      await client.query('COMMIT'); return advance;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release?.(); }
  }
}
