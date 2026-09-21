import { randomUUID, createHash } from 'node:crypto';
import { Cell, type Slice } from '@ton/core';
import type { Network } from '../models';
import type { TonDataSource, RawTransaction, AccountStateResponse } from '../data/dataSource';
import { transactionPageIsLinkedInclusiveSegment, transactionPageReachesHistoryStart } from '../data/dataSource';
import type { OpcodeSets } from '../utils/opcodes';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { PostgresLedgerStore, LedgerCursorError, validProjectionScope } from './store';
import type { LedgerAsset, LedgerEvent, LedgerPage, LedgerQuery, LedgerRangeCoverage } from './types';
import { projectOwnerLedger, type LedgerChain } from './project';
import { readPerpsState } from './perpsState';
import { qualifyPerpsRangeWallet } from './perpsRangeWallet';
import { PERPS_ORACLE_PULL, perpsOracleMessage, perpsWalletAddress } from './perpsWire';
import { findTransactionState, type LedgerStateSnapshot } from './archive';
import { businessBodyCell, tokenWire, TRANSFER } from './wire';

type Bounds = { fromUtime: number; toUtime: number };
type Options = { t3Root?: string; perpsEngine?: string; perpsEngineCodeHash?: string };
type RangeSnapshot = { schema: 'perps-range-v3'; masterSeqno: number; masterTimestamp: number;
  observedAt: string; projection: Awaited<ReturnType<typeof projectOwnerLedger>>;
  oraclePools: string[]; protocolPeers: string[];
  chains: Array<LedgerChain & { headLt: string | null; headHash: string | null; boundary: RawTransaction | null; headTransactions: RawTransaction[] }> };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WORKERS = 2, QUEUE_CAPACITY = 64, ACTIVE_CAPACITY = 128;
const RECOVERY_INTERVAL_MS = 5_000, ACTIVE_LIFETIME_SECONDS = 15 * 60;
const PROTOCOL_PEER_LIMIT = 32;
/** Discovery is limited to complete current requests emitted by the qualified
 * engine. It grants no settlement authority: the projector still checks each
 * original edge against its exact historical engine state and receipt. */
export function discoverPerpsRangePeers(transactions: RawTransaction[], engine: string, engineWallet: string) {
  const peers = new Set<string>(), custodyOwners = new Set<string>();
  const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw Error('Trailing request'); };
  const add = (destination: string, custody: boolean) => {
    peers.add(destination); if (custody) custodyOwners.add(destination);
  };
  for (const tx of transactions) {
    if (!tx.success || tx.status && tx.status !== 'success') continue;
    for (const message of tx.outMessages) {
      try {
        if (message.bounced || !message.source || !message.destination || canonicalLedgerAddress(message.source) !== engine) continue;
        const destination = canonicalLedgerAddress(message.destination), body = businessBodyCell(message);
        if (!body) continue;
        const s = body.beginParse(), op = s.loadUint(32);
        if (op === 0x52564c54) { // RVLT: actual reservation request
          if (!s.loadUintBig(64)) continue;
          s.loadUint(16); s.loadUintBig(256); s.loadCoins(); s.loadCoins(); s.loadCoins(); end(s);
          add(destination, true);
        } else if (op === 0x52565053) { // RVPS: atomic reservation replacement and payout
          if (!s.loadUintBig(64)) continue;
          s.loadUint(16); s.loadUintBig(256); s.loadUintBig(64); s.loadUintBig(256); s.loadCoins();
          const target = s.loadRef().beginParse(); end(s);
          target.loadCoins(); target.loadCoins(); target.loadCoins(); target.loadAddress(); target.loadRef(); end(target);
          add(destination, true);
        } else if (op === 0x52505251) { // RPRQ: policy request and exact callback
          if (!s.loadUint(32) || !s.loadUintBig(64)) continue; end(s); add(destination, false);
        } else if (op === 0x43524544) { // CRED: registry credit and acknowledgement
          if (!s.loadUintBig(64) || !s.loadUint(32)) continue;
          s.loadAddress(); s.loadCoins(); s.loadMaybeAddress(); end(s); add(destination, false);
        } else if (op === TRANSFER && destination === engineWallet) {
          const transfer = tokenWire(message);
          if (!transfer?.owner || transfer.op !== TRANSFER) continue;
          const f = transfer.forward.beginParse(), tag = f.loadUint(32);
          if (tag === 0x5246464c) { // RFFL: physical protocol fee custody
            if (!f.loadUintBig(64) || !f.loadUintBig(256)) continue;
            if (f.loadCoins() > BigInt(transfer.amountRaw)) continue; end(f);
          } else if (tag === 0x52564450) { // RVDP: physical collected trader-loss deposit
            f.loadUint(16); if (f.loadCoins().toString() !== transfer.amountRaw) continue; f.loadRef(); end(f);
          } else continue;
          add(canonicalLedgerAddress(transfer.owner), true);
        }
      } catch { /* Malformed output cannot widen the captured graph. */ }
    }
    if (peers.size > PROTOCOL_PEER_LIMIT) throw Error('perps_range_protocol_account_limit');
  }
  return { peers, custodyOwners };
}
export function ledgerFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && /^[0-9A-Z]{5}$/.test(String(error.code)))
    return 'ledger_storage_unavailable';
  const message = error instanceof Error ? error.message : '';
  return /^perps_range_[a-z_]+$/.test(message) ? message : 'history_source_unavailable';
}
/** Capture every linked transaction inside [from,to) at one immutable chain head.
 * The first transaction older than from is retained as the lower-bound witness. */
export async function capturePerpsRangeChain(source: TonDataSource, account: string, state: AccountStateResponse,
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
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private readonly binding: string;
  constructor(private network: Network, private store: PostgresLedgerStore, private source: TonDataSource,
    private opcodes: OpcodeSets, private options: Options) {
    this.binding = digest({ network, engine: options.perpsEngine, root: options.t3Root, code: options.perpsEngineCodeHash, decoder: 'perps-range-v3' });
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
    this.pending.clear();
    await this.recovery?.catch(() => undefined);
    await Promise.allSettled(this.running.values());
  }
  /** A bounded scan includes crashed running jobs and jobs from replaced bindings.
   * The per-generation lock below is the authority to resume or retire each row. */
  async resume() {
    if (this.stopped) return;
    if (this.recovery) return this.recovery;
    const work = (async () => {
      const capacity = QUEUE_CAPACITY - this.pending.size;
      if (!capacity) return;
      const rows = (await this.store.pool.query(
        `SELECT generation FROM ledger_perps_ranges WHERE network=$1 AND status IN ('pending','running')
         AND generation <> ALL($2::uuid[])
         AND ((binding=$3 AND (retry_after IS NULL OR retry_after <= now()))
           OR created_at <= now()-$4*interval '1 second')
         ORDER BY created_at,generation_order LIMIT $5`,
        [this.network, [...this.running.keys(), ...this.pending], this.binding, ACTIVE_LIFETIME_SECONDS, capacity])).rows;
      for (const row of rows) this.schedule(row.generation);
    })();
    this.recovery = work;
    try { await work; } finally { if (this.recovery === work) this.recovery = undefined; }
  }
  private schedule(generation: string) {
    if (this.stopped) return;
    if (!this.running.has(generation) && this.pending.size < QUEUE_CAPACITY) this.pending.add(generation);
    this.drain();
  }
  private drain() {
    while (!this.stopped && this.running.size < WORKERS && this.pending.size) {
      const generation = this.pending.values().next().value!;
      this.pending.delete(generation);
      const work = this.collect(generation).catch(() => undefined).finally(() => { this.running.delete(generation); this.drain(); });
      this.running.set(generation, work);
    }
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
    const latest = async () => (await this.store.pool.query(
      `SELECT *,retry_after <= now() AS retry_due FROM ledger_perps_ranges
       WHERE network=$1 AND account=$2 AND binding=$3 AND from_utime=$4 AND to_utime=$5
       ORDER BY generation_order DESC LIMIT 1`, [this.network, account, this.binding, from, to])).rows[0];
    let row = cursor ? (await this.store.pool.query(
      `SELECT * FROM ledger_perps_ranges WHERE generation=$1 AND network=$2 AND account=$3 AND binding=$4 AND from_utime=$5 AND to_utime=$6`,
      [cursor.generation, this.network, account, this.binding, from, to])).rows[0] : await latest();
    if (cursor && !row) throw new LedgerCursorError('Perps range cursor snapshot not found');
    const needsGeneration = (value: typeof row) => !value ||
      (['failed', 'complete'].includes(value.status) && value.retry_due === true);
    if (!cursor && needsGeneration(row)) {
      // Admission is serialized across processes, and the partial unique index
      // also prevents duplicate active generations for identical requested bounds.
      const admitted = await this.store.withAccountLock(this.network, 'perps-range-admission', async () => {
        row = await latest();
        if (!needsGeneration(row)) return;
        const count = (await this.store.pool.query("SELECT count(*)::int AS count FROM ledger_perps_ranges WHERE network=$1 AND status IN ('pending','running')", [this.network])).rows[0].count;
        if (count >= ACTIVE_CAPACITY) throw Error('perps_range_admission_capacity');
        const backoff = row ? Math.min(300, row.backoff_seconds * 2) : 5;
        const inserted = (await this.store.pool.query(
          `INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status,backoff_seconds)
           VALUES($1,$2,$3,$4,$5,$6,'pending',$7) ON CONFLICT DO NOTHING RETURNING *`,
          [randomUUID(), this.network, account, from, to, this.binding, backoff])).rows[0];
        row = inserted ?? await latest();
      });
      if (!admitted) row = await latest();
      if (!row) throw Error('perps_range_admission_busy');
    }
    if (!cursor && ['pending', 'running'].includes(row.status) && (!row.retry_after || row.retry_due === true)) this.schedule(row.generation);
    const range: LedgerRangeCoverage = { scope: 'perps', fromUtime: from!, toUtime: to!, status: row.status, complete: row.status === 'complete',
      retryAfter: row.retry_after ? new Date(row.retry_after).toISOString() : null };
    const snapshot = row.snapshot as RangeSnapshot | null;
    if (range.complete && (!snapshot || snapshot.schema !== 'perps-range-v3' || !validProjectionScope(snapshot.projection.projectionScope, account) ||
      !Array.isArray(snapshot.oraclePools) || snapshot.oraclePools.length > 128 ||
      new Set(snapshot.oraclePools).size !== snapshot.oraclePools.length ||
      !Array.isArray(snapshot.protocolPeers) || snapshot.protocolPeers.length > PROTOCOL_PEER_LIMIT * 2 ||
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
        const master = await this.source.getMasterchainInfo();
        if (!Number.isSafeInteger(master.seqno) || master.seqno < 0) throw Error('perps_range_head_unavailable');
        if (!Number.isSafeInteger(master.timestamp) || master.timestamp! < 0) throw Error('perps_range_head_time_unavailable');
        if (master.timestamp! < bounds.toUtime) {
          await this.store.pool.query("UPDATE ledger_perps_ranges SET status='pending',error_code='perps_range_head_not_ready',retry_after=now()+backoff_seconds*interval '1 second',backoff_seconds=LEAST(300,backoff_seconds*2) WHERE generation=$1", [generation]);
          return;
        }
        if (!this.source.getAccountStateAtSeqno) throw Error('perps_range_archive_unavailable');
        const { perpsEngine, perpsEngineCodeHash, t3Root } = this.options;
        if (!perpsEngine || !perpsEngineCodeHash || !t3Root) throw Error('perps_range_binding_unconfigured');
        const engine = canonicalLedgerAddress(perpsEngine), owner = row.account;
        const current = await this.source.getAccountStateAtSeqno(engine, master.seqno);
        if (!current.codeBoc || !current.dataBoc || Cell.fromBase64(current.codeBoc).hash().toString('hex') !== perpsEngineCodeHash)
          throw Error('perps_range_engine_identity_unverified');
        const parsed = readPerpsState(current.dataBoc, perpsEngineCodeHash);
        if (parsed.root !== canonicalLedgerAddress(t3Root)) throw Error('perps_range_root_identity_unverified');
        const ownerWallet = perpsWalletAddress(parsed.walletCode, parsed.root, owner), engineWallet = perpsWalletAddress(parsed.walletCode, parsed.root, engine);
        const accounts = [owner, ownerWallet, engine, engineWallet];
        if (new Set(accounts).size !== 4) throw Error('perps_range_account_identity_conflict');
        const states = await Promise.all(accounts.map(a => a === engine ? current : this.source.getAccountStateAtSeqno!(a, master.seqno)));
        const wallets = new Map<string, LedgerAsset>();
        for (const [i, expectedOwner] of [[1, owner], [3, engine]] as const) {
          wallets.set(accounts[i], qualifyPerpsRangeWallet(this.network, accounts[i], expectedOwner,
            parsed.root, parsed.walletCode, states[i]));
        }
        const observedAt = new Date().toISOString(), budget = { pages: 128, deadline: Date.now() + 120_000 };
        const chains = new Map<string, RangeSnapshot['chains'][number]>();
        for (let i = 0; i < accounts.length; i++) {
          const captured = await capturePerpsRangeChain(this.source, accounts[i], states[i], bounds, budget);
          chains.set(accounts[i], { account: accounts[i], generation, role: i === 0 ? 'owner' : i === 1 ? 'owned_jetton_wallet' : 'counterparty',
            historyComplete: false, verifiedRange: bounds, checkedAt: new Date(master.timestamp! * 1000).toISOString(), ...captured,
            headLt: states[i].lastTxLt ?? null, headHash: states[i].lastTxHash ? canonicalLedgerHash(states[i].lastTxHash!) : null });
        }
        const oraclePools = new Set<string>();
        for (const transaction of chains.get(engine)?.transactions ?? []) for (const message of transaction.outMessages) {
          const request = perpsOracleMessage(message);
          if (request?.opcode !== PERPS_ORACLE_PULL || !message.source || !message.destination ||
              canonicalLedgerAddress(message.source) !== engine) continue;
          oraclePools.add(canonicalLedgerAddress(message.destination));
        }
        if (oraclePools.size > 128) throw Error('perps_range_oracle_account_limit');
        const { peers, custodyOwners } = discoverPerpsRangePeers(chains.get(engine)?.transactions ?? [], engine, engineWallet);
        const custody = new Map<string, string>();
        for (const custodyOwner of custodyOwners) {
          const wallet = perpsWalletAddress(parsed.walletCode, parsed.root, custodyOwner);
          if (accounts.includes(custodyOwner) || accounts.includes(wallet) || peers.has(wallet) || oraclePools.has(wallet))
            throw Error('perps_range_account_identity_conflict');
          custody.set(wallet, custodyOwner);
        }
        const protocolPeers = new Set([...peers, ...custody.keys()].filter(peer => !accounts.includes(peer) && !oraclePools.has(peer)));
        for (const peer of new Set([...oraclePools, ...protocolPeers])) {
          if (chains.has(peer)) continue;
          if (Date.now() > budget.deadline) throw Error('perps_range_capacity_exceeded');
          const state = await this.source.getAccountStateAtSeqno(peer, master.seqno);
          const custodyOwner = custody.get(peer);
          // A never-created wallet is honest absent custody, not an arbitrary
          // identity. Active wallets must match the engine-pinned current code.
          if (custodyOwner && state.accountState !== 'uninitialized')
            wallets.set(peer, qualifyPerpsRangeWallet(this.network, peer, custodyOwner, parsed.root, parsed.walletCode, state));
          const captured = await capturePerpsRangeChain(this.source, peer, state, bounds, budget);
          chains.set(peer, { account: peer, generation, role: 'counterparty', historyComplete: false, verifiedRange: bounds,
            checkedAt: new Date(master.timestamp! * 1000).toISOString(), ...captured,
            headLt: state.lastTxLt ?? null, headHash: state.lastTxHash ? canonicalLedgerHash(state.lastTxHash) : null });
        }
        // Reuse exact positive boundary reads across before/after proofs, and
        // never move beyond the masterchain head captured for this interval.
        const boundaryReads = new Map<string, Promise<AccountStateResponse>>();
        const archiveSource = {
          getMasterchainInfo: () => this.source.getMasterchainInfo(),
          getAccountStateAtSeqno: (account: string, seqno: number) => {
            const key = `${account}:${seqno}`;
            let read = boundaryReads.get(key);
            if (!read) {
              read = this.source.getAccountStateAtSeqno!(account, seqno);
              boundaryReads.set(key, read);
              void read.catch(() => boundaryReads.delete(key));
            }
            return read;
          },
          getAccountStateAtTransaction: this.source.getAccountStateAtTransaction?.bind(this.source),
        } as TonDataSource;
        const stateAt = async (account: string, lt: string, hash: string): Promise<LedgerStateSnapshot | null> => {
          const h = canonicalLedgerHash(hash), params = [this.network, account, lt, h];
          const cached = (await this.store.pool.query('SELECT snapshot FROM ledger_account_states WHERE network=$1 AND account=$2 AND lt=$3 AND hash=$4', params)).rows[0];
          if (cached) return cached.snapshot;
          const state = await findTransactionState(archiveSource, account, { lt, hash: h }, master.seqno);
          if (state) await this.store.pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING', [...params, JSON.stringify(state)]);
          return state;
        };
        const projection = await projectOwnerLedger({ network: this.network, owner, opcodes: this.opcodes, chains, wallets, pools: new Map(), stateAt,
          perpsEngines: new Map([[engine, { address: engine, root: parsed.root, codeHash: perpsEngineCodeHash, walletCodeHash: parsed.walletCode.hash().toString('hex'), ownerWallet, engineWallet }]]) });
        projection.events = projection.events.filter(e => e.kind === 'perps_operation' || e.settlement?.protocol === 'perps')
          .sort((a, b) => BigInt(a.lt) === BigInt(b.lt) ? b.hash.localeCompare(a.hash) : BigInt(a.lt) > BigInt(b.lt) ? -1 : 1);
        const snapshot: RangeSnapshot = { schema: 'perps-range-v3', masterSeqno: master.seqno, masterTimestamp: master.timestamp!, observedAt,
          oraclePools: [...oraclePools].filter(pool => !accounts.includes(pool)), protocolPeers: [...protocolPeers], projection, chains: [...chains.values()] };
        // Exact chain coverage may still lack archive state needed to decode an
        // operation. Publish that honest snapshot, then permit a new generation
        // after backoff; existing cursors keep the original snapshot unchanged.
        const incomplete = projection.events.some(event => event.settlement?.status === 'incomplete');
        await this.store.pool.query("UPDATE ledger_perps_ranges SET status='complete',snapshot=$2::jsonb,published_at=now(),retry_after=CASE WHEN $3 THEN now()+backoff_seconds*interval '1 second' ELSE NULL END WHERE generation=$1 AND status='running'", [generation, JSON.stringify(snapshot), incomplete]);
      } catch (error) {
        await this.store.pool.query("UPDATE ledger_perps_ranges SET status='failed',error_code=$2,retry_after=now()+backoff_seconds*interval '1 second' WHERE generation=$1 AND status IN ('pending','running')", [generation, ledgerFailureCode(error)]);
        throw error;
      }
    });
  }
}
