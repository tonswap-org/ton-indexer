import { collectCurrentPerpsRange } from './currentPerpsRange';
import { randomUUID, createHash } from 'node:crypto';
import type { Network } from '../models';
import type { ChainSource, RawTransaction, AccountStateResponse } from '../data/dataSource';
import { transactionPageIsLinkedInclusiveSegment, transactionPageReachesHistoryStart } from '../data/dataSource';
import type { OpcodeSets } from '../utils/opcodes';
import { canonicalLedgerHash } from './normalize';
import { PostgresLedgerStore, LedgerCursorError, validProjectionScope } from './store';
import type { LedgerEvent, LedgerPage, LedgerQuery, LedgerRangeCoverage } from './types';
import { projectOwnerLedger, type LedgerChain } from './project';
import { findTransactionState, type LedgerStateSnapshot } from './archive';
import type { Logger } from '../utils/logger';

const PERPS_PROTOCOL_PEER_LIMIT = 32;
type Bounds = { fromUtime: number; toUtime: number };
type Options = { currentPerpsBinding?: import("./currentPerpsProof").NativePerpsProofBinding; readStore?: PostgresLedgerStore; t3Root?: string; perpsEngine?: string; perpsEngineCodeHash?: string };
type RangeSnapshot = { schema: 'perps-range-v3'; masterSeqno: number; masterTimestamp: number;
  observedAt: string; projection: Awaited<ReturnType<typeof projectOwnerLedger>>;
  oraclePools: string[]; protocolPeers: string[];
  chains: Array<LedgerChain & { headLt: string | null; headHash: string | null; boundary: RawTransaction | null; headTransactions: RawTransaction[] }> };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WORKERS = 2, QUEUE_CAPACITY = 64, ACTIVE_CAPACITY = 128;
const RECOVERY_INTERVAL_MS = 5_000, ACTIVE_LIFETIME_SECONDS = 15 * 60;
export function ledgerFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && /^[0-9A-Z]{5}$/.test(String(error.code)))
    return 'ledger_storage_unavailable';
  const message = error instanceof Error ? error.message : '';
  return /^perps_range_[a-z_]+$/.test(message) ? message : 'history_source_unavailable';
}
/** Capture every linked transaction inside [from,to) at one immutable chain head.
 * The first transaction older than from is retained as the lower-bound witness. */
export async function capturePerpsRangeChain(source: ChainSource, account: string, state: AccountStateResponse,
  bounds: Bounds, budget: { pages: number; deadline: number }) {
  if (Date.now() > budget.deadline) throw Error('perps_range_capacity_exceeded');
  if (Boolean(state.lastTxLt) !== Boolean(state.lastTxHash)) throw Error('perps_range_head_unavailable');
  const transactions: RawTransaction[] = [], headTransactions: RawTransaction[] = [];
  let boundary: RawTransaction | null = null;
  if (!state.lastTxLt || state.lastTxLt === '0') {
    if (state.accountState !== 'uninitialized') throw Error('perps_range_head_unavailable');
    return { transactions, boundary, headTransactions };
  }
  let cursor = { lt: state.lastTxLt, hash: canonicalLedgerHash(state.lastTxHash!) };
  const seen = new Set<string>();
  let newerTime = Infinity;
  while (true) {
    if (--budget.pages < 0 || Date.now() > budget.deadline) throw Error('perps_range_capacity_exceeded');
    const key = `${cursor.lt}:${cursor.hash}`;
    if (seen.has(key)) throw Error('perps_range_cursor_stalled');
    seen.add(key);
    const page = await source.getTransactions(account, 100, cursor.lt, cursor.hash);
    if (!page.length || page.length > 100 || !transactionPageIsLinkedInclusiveSegment(page, cursor, page[page.length - 1]))
      throw Error('perps_range_chain_unverified');
    for (const tx of page) {
      headTransactions.push(tx);
      if (!Number.isSafeInteger(tx.utime) || tx.utime < 0 || tx.utime > newerTime)
        throw Error('perps_range_time_unverified');
      newerTime = tx.utime;
      if (tx.utime < bounds.fromUtime) { boundary = tx; return { transactions, boundary, headTransactions }; }
      if (tx.utime < bounds.toUtime) transactions.push(tx);
    }
    if (transactionPageReachesHistoryStart(page, cursor)) return { transactions, boundary, headTransactions };
    const tail = page[page.length - 1];
    if (!tail.prevTransactionLt || !tail.prevTransactionHash) throw Error('perps_range_predecessor_unavailable');
    cursor = { lt: tail.prevTransactionLt, hash: canonicalLedgerHash(tail.prevTransactionHash) };
  }
}

/** Separate queue, locks and durable snapshots; never advances an all-history cursor. */
export class PerpsRangeService {
  private running = new Map<string, Promise<unknown>>();
  private pending = new Set<string>();
  private foreground = new Set<string>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private readonly binding: string;
  constructor(private network: Network, private store: PostgresLedgerStore, private source: ChainSource,
    private opcodes: OpcodeSets, private options: Options, private logger?: Logger) {
    this.binding = digest({ network, engine: options.perpsEngine, root: options.t3Root, code: options.perpsEngineCodeHash, release: options.currentPerpsBinding?.manifestHash, decoder: 'current-perps-range-v1' });
  }
  /** Resume durable work at startup and without any client continuing to poll. */
  async start(onError: () => void = () => undefined) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.resume().catch(onError), RECOVERY_INTERVAL_MS);
    this.timer.unref();
    await this.resume();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear(); this.foreground.clear();
    await this.recovery?.catch(() => undefined);
    await Promise.allSettled(this.running.values());
  }
  /** A bounded scan includes crashed running jobs and jobs from replaced bindings.
   * The per-generation lock below is the authority to resume or retire each row. */
  async resume() {
    if (this.stopped) return;
    if (this.recovery) return this.recovery;
    const work = (async () => {
      const capacity = QUEUE_CAPACITY - this.pending.size - this.foreground.size;
      if (!capacity) return;
      const rows = (await this.store.pool.query(
        `SELECT generation FROM ledger_perps_ranges WHERE network=$1 AND status IN ('pending','running')
         AND generation <> ALL($2::uuid[])
         AND ((binding=$3 AND (retry_after IS NULL OR retry_after <= now()))
           OR created_at <= now()-$4*interval '1 second')
         ORDER BY created_at,generation_order LIMIT $5`,
        [this.network, [...this.running.keys(), ...this.pending, ...this.foreground], this.binding, ACTIVE_LIFETIME_SECONDS, capacity])).rows;
      for (const row of rows) this.schedule(row.generation);
      if (this.stopped) return;
      // Supersede only the latest immutable failed/incomplete generation for
      // each exact key. Six automatic retries stop at the 300-second cap.
      const due = (await this.store.pool.query(`SELECT r.account,r.from_utime,r.to_utime FROM ledger_perps_ranges r
        WHERE r.network=$1 AND r.binding=$2 AND r.status IN ('failed','complete')
          AND r.retry_after <= now() AND r.backoff_seconds < 300
          AND NOT EXISTS (SELECT 1 FROM ledger_perps_ranges newer WHERE newer.network=r.network
            AND newer.account=r.account AND newer.binding=r.binding AND newer.from_utime=r.from_utime
            AND newer.to_utime=r.to_utime AND newer.generation_order>r.generation_order)
        ORDER BY r.retry_after,r.generation_order LIMIT 8`, [this.network, this.binding])).rows;
      for (const key of due) {
        if (this.stopped || this.pending.size + this.foreground.size >= QUEUE_CAPACITY) break;
        try {
          const row = await this.admit(key.account, Number(key.from_utime), Number(key.to_utime), true);
          if (row && ['pending','running'].includes(row.status) && (!row.retry_after || row.retry_due === true)) this.schedule(row.generation);
        } catch (error) {
          if (error instanceof Error && error.message === 'perps_range_admission_capacity') break;
          throw error;
        }
      }
    })();
    this.recovery = work;
    try { await work; } finally { if (this.recovery === work) this.recovery = undefined; }
  }
  private schedule(generation: string, priority: 'foreground' | 'background' = 'background') {
    if (this.stopped || this.running.has(generation)) return;
    if (priority === 'foreground') {
      this.pending.delete(generation);
      if (!this.foreground.has(generation) && this.pending.size + this.foreground.size >= QUEUE_CAPACITY) {
        // Displaced background work remains durable and is picked up next sweep.
        const oldest = this.pending.values().next().value;
        if (oldest) this.pending.delete(oldest); else return;
      }
      this.foreground.add(generation);
    } else if (!this.foreground.has(generation) && this.pending.size + this.foreground.size < QUEUE_CAPACITY) this.pending.add(generation);
    this.drain();
  }
  private drain() {
    while (!this.stopped && this.running.size < WORKERS && (this.foreground.size || this.pending.size)) {
      const queue = this.foreground.size ? this.foreground : this.pending;
      const generation = queue.values().next().value!; queue.delete(generation);
      const work = this.collect(generation).catch(() => undefined).finally(() => { this.running.delete(generation); this.drain(); });
      this.running.set(generation, work);
    }
  }
  private async latest(account: string, from: number, to: number, store = this.store) {
    return (await store.pool.query(`SELECT *,retry_after <= now() AS retry_due FROM ledger_perps_ranges
      WHERE network=$1 AND account=$2 AND binding=$3 AND from_utime=$4 AND to_utime=$5
      ORDER BY generation_order DESC LIMIT 1`, [this.network, account, this.binding, from, to])).rows[0];
  }
  private async admit(account: string, from: number, to: number, automatic = false) {
    const store = automatic ? this.store : this.options.readStore ?? this.store;
    let row = await this.latest(account, from, to, store);
    const needsGeneration = (value: typeof row) => (!value && !automatic) ||
      (value && ['failed','complete'].includes(value.status) && value.retry_due === true && (!automatic || value.backoff_seconds < 300));
    if (!needsGeneration(row)) return row;
    // Admission and the active-capacity check share the existing cross-process
    // lock. A contender may retain the earlier immutable answer until next poll.
    const admitted = await store.withAccountLock(this.network, 'perps-range-admission', async () => {
      row = await this.latest(account, from, to, store);
      if (!needsGeneration(row)) return;
      const count = (await store.pool.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE network=$1 AND status IN ('pending','running')", [this.network])).rows[0].count;
      if (count >= ACTIVE_CAPACITY) throw Error('perps_range_admission_capacity');
      const backoff = row ? Math.min(300, row.backoff_seconds * 2) : 5;
      const inserted = (await store.pool.query(`INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,backoff_seconds)
        VALUES($1,$2,$3,$4,$5,$6,'pending',$7) ON CONFLICT DO NOTHING RETURNING *`,
        [randomUUID(), this.network, account, from, to, this.binding, backoff])).rows[0];
      row = inserted ?? await this.latest(account, from, to, store);
    });
    return admitted ? row : this.latest(account, from, to, store);
  }
  async page(account: string, query: LedgerQuery): Promise<LedgerPage> {
    const from = query.fromUtime, to = query.toUtime;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from! < 0 || to! <= from!)
      throw new LedgerCursorError('Perps range requires exact valid date bounds');
    let cursor: { generation: string; offset: number; binding: string; account: string; from: number; to: number } | undefined;
    if (query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (!cursor || Object.keys(cursor).sort().join(',') !== 'account,binding,from,generation,offset,to' ||
          !UUID.test(cursor.generation) || cursor.binding !== this.binding || cursor.account !== account ||
          cursor.from !== from || cursor.to !== to || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw Error();
      } catch { throw new LedgerCursorError('Invalid perps range cursor or changed bounds'); }
    }
    const row = cursor ? (await (this.options.readStore ?? this.store).pool.query(
      `SELECT * FROM ledger_perps_ranges WHERE generation=$1 AND network=$2 AND account=$3 AND binding=$4 AND from_utime=$5 AND to_utime=$6`,
      [cursor.generation, this.network, account, this.binding, from, to])).rows[0] : await this.admit(account, from!, to!);
    if (cursor && !row) throw new LedgerCursorError('Perps range cursor snapshot not found');
    if (!row) throw Error('perps_range_admission_busy');
    if (!cursor && ['pending', 'running'].includes(row.status) && (!row.retry_after || row.retry_due === true)) this.schedule(row.generation, 'foreground');
    const range: LedgerRangeCoverage = { scope: 'perps', fromUtime: from!, toUtime: to!, status: row.status, complete: row.status === 'complete',
      retryAfter: row.retry_after ? new Date(row.retry_after).toISOString() : null };
    const snapshot = row.snapshot as RangeSnapshot | null;
    if (range.complete && (!snapshot || snapshot.schema !== 'perps-range-v3' || !validProjectionScope(snapshot.projection.projectionScope, account) ||
      !Array.isArray(snapshot.oraclePools) || snapshot.oraclePools.length > 128 ||
      new Set(snapshot.oraclePools).size !== snapshot.oraclePools.length ||
      !Array.isArray(snapshot.protocolPeers) || snapshot.protocolPeers.length > PERPS_PROTOCOL_PEER_LIMIT * 2 ||
      new Set([...snapshot.oraclePools, ...snapshot.protocolPeers]).size !== snapshot.oraclePools.length + snapshot.protocolPeers.length ||
      snapshot.chains.length !== 4 + snapshot.oraclePools.length + snapshot.protocolPeers.length || new Set(snapshot.chains.map(c => c.account)).size !== snapshot.chains.length ||
      [...snapshot.oraclePools, ...snapshot.protocolPeers].some(peer => !snapshot.chains.some(chain => chain.account === peer && chain.role === 'counterparty')) ||
      snapshot.chains.some(c => c.historyComplete || c.verifiedRange?.fromUtime !== from || c.verifiedRange?.toUtime !== to)))
      throw Error('perps_range_snapshot_invalid');
    const all = snapshot?.projection.events ?? [], offset = cursor?.offset ?? 0, limit = Math.max(1, Math.min(500, query.limit ?? 100));
    if (offset > all.length || cursor && !range.complete) throw new LedgerCursorError('Invalid perps range cursor position');
    const events = all.slice(offset, offset + limit);
    const issues = [...new Set(all.flatMap(e => e.issues))];
    if (!range.complete) issues.push(row.error_code ?? 'perps_range_pending');
    return { network: this.network, account, events,
      nextCursor: offset + limit < all.length ? Buffer.from(JSON.stringify({ generation: row.generation, offset: offset + limit, binding: this.binding, account, from, to })).toString('base64url') : null,
      coverage: { generation: row.generation, range, projectionScope: snapshot?.projection.projectionScope ?? null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        headObservedAt: snapshot?.observedAt ?? null, checkedAt: snapshot ? new Date(snapshot.masterTimestamp * 1000).toISOString() : null,
        snapshotComplete: range.complete, historyComplete: false, decodingComplete: range.complete && !issues.length,
        syncing: ['pending', 'running'].includes(row.status), oldestUtime: all.length ? Math.min(...all.map(e => e.utime)) : null,
        newestUtime: all.length ? Math.max(...all.map(e => e.utime)) : null, syncedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        relatedAccounts: snapshot?.chains.map(({ transactions, headTransactions, boundary, headLt, headHash, checkedAt, verifiedRange, ...chain }) => chain), issues } };
  }
  async collect(generation: string) {
    return this.store.withAccountLock(this.network, `perps-range:${generation}`, async () => {
      const row = (await this.store.pool.query(
        `SELECT *,retry_after IS NULL OR retry_after <= now() AS retry_due,
         created_at <= now()-$3*interval '1 second' AS expired
         FROM ledger_perps_ranges WHERE generation=$1 AND network=$2`,
        [generation, this.network, ACTIVE_LIFETIME_SECONDS])).rows[0];
      if (!row || !['pending', 'running'].includes(row.status)) return;
      // A never-ready head or an abandoned release binding cannot own admission
      // forever. Keep the terminal failure as evidence; published rows are untouched.
      if (row.expired === true) {
        await this.store.pool.query(
          `UPDATE ledger_perps_ranges SET status='failed',error_code=$2,
           retry_after=now()+backoff_seconds*interval '1 second'
           WHERE generation=$1 AND status IN ('pending','running')`,
          [generation, 'perps_range_expired']);
        return;
      }
      if (row.binding !== this.binding || row.retry_due !== true) return;
      try {
        await this.store.pool.query("UPDATE ledger_perps_ranges SET status='running',attempted_at=now(),error_code=NULL,retry_after=NULL WHERE generation=$1", [generation]);
        const bounds = { fromUtime: Number(row.from_utime), toUtime: Number(row.to_utime) };
        const master = await this.source.head();
        if (!Number.isSafeInteger(master.seqno) || master.seqno < 0) throw Error('perps_range_head_unavailable');
        if (master.utime < bounds.toUtime) {
          await this.store.pool.query("UPDATE ledger_perps_ranges SET status='pending',error_code='perps_range_head_not_ready',retry_after=now()+backoff_seconds*interval '1 second',backoff_seconds=LEAST(300,backoff_seconds*2) WHERE generation=$1", [generation]);
          return;
        }
        const binding=this.options.currentPerpsBinding;if(!binding)throw Error('perps_range_binding_unconfigured');
        const owner=row.account,observedAt=new Date().toISOString(),budget={pages:128,deadline:Date.now()+120_000};
        // Reuse exact positive boundary reads across before/after proofs, and
        // never move beyond the masterchain head captured for this interval.
        const boundaryReads = new Map<string, Promise<AccountStateResponse>>();
        const archiveSource = {
          head: () => this.source.head(),
          getAccountStateAtSeqno: (account: string, seqno: number) => {
            const key = `${account}:${seqno}`;
            let read = boundaryReads.get(key);
            if (!read) {
              read = this.source.getAccountStateAtSeqno(account, seqno);
              boundaryReads.set(key, read);
              void read.catch(() => boundaryReads.delete(key));
            }
            return read;
          },
          getAccountStateAtTransaction: this.source.getAccountStateAtTransaction.bind(this.source),
        } satisfies Pick<ChainSource, 'head' | 'getAccountStateAtSeqno' | 'getAccountStateAtTransaction'>;
        const stateAt = async (account: string, lt: string, hash: string): Promise<LedgerStateSnapshot | null> => {
          const h = canonicalLedgerHash(hash), params = [this.network, account, lt, h];
          const cached = (await this.store.pool.query('SELECT snapshot FROM ledger_account_states WHERE network=$1 AND account=$2 AND lt=$3 AND hash=$4', params)).rows[0];
          if (cached) return cached.snapshot;
          const state = await findTransactionState(archiveSource, account, { lt, hash: h }, master.seqno);
          if (state) await this.store.pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING', [...params, JSON.stringify(state)]);
          return state;
        };
        const collected=await collectCurrentPerpsRange({network:this.network,owner,generation,source:this.source,head:master,binding,bounds,opcodes:this.opcodes,stateAt,capture:(account,state,bounds)=>capturePerpsRangeChain(this.source,account,state,bounds,budget)});
        const projection=collected.projection;
        const snapshot:RangeSnapshot={schema:'perps-range-v3',masterSeqno:master.seqno,masterTimestamp:master.utime,observedAt,...collected};
        // Exact chain coverage may still lack archive state needed to decode an
        // operation. Publish that honest snapshot, then permit a new generation
        // after backoff; existing cursors keep the original snapshot unchanged.
        const incomplete = projection.events.some(event => event.settlement?.status === 'incomplete');
        await this.store.pool.query("UPDATE ledger_perps_ranges SET status='complete',snapshot=$2::jsonb,published_at=now(),retry_after=CASE WHEN $3 THEN now()+backoff_seconds*interval '1 second' ELSE NULL END WHERE generation=$1 AND status='running'", [generation, JSON.stringify(snapshot), incomplete]);
      } catch (error) {
        this.logger?.warn('ledger perps range collection failed', { code: ledgerFailureCode(error), generation });
        await this.store.pool.query("UPDATE ledger_perps_ranges SET status='failed',error_code=$2,retry_after=now()+backoff_seconds*interval '1 second' WHERE generation=$1 AND status IN ('pending','running')", [generation, ledgerFailureCode(error)]);
        throw error;
      }
    });
  }
}
