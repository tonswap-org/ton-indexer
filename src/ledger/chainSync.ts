import { randomUUID } from 'node:crypto';
import type { AccountStateResponse, ChainSource, TransactionCursor } from '../data/dataSource';
import { transactionPageIsLinkedInclusiveSegment, transactionPageReachesHistoryStart } from '../data/dataSource';
import type { Network } from '../models';
import type { RuntimeMetrics } from '../runtimeMetrics';
import type { Logger } from '../utils/logger';
import type { OpcodeSets } from '../utils/opcodes';
import type { DependencyRefresh, OwnerCycle, RefreshDependency } from './cycle';
import { canonicalLedgerAddress, canonicalLedgerHash, normalizeLedgerEvent } from './normalize';
import type { PostgresLedgerStore } from './store';
import type { LedgerAsset } from './types';

export type ChainSyncDeps = {
  network: Network; store: PostgresLedgerStore; source: ChainSource; opcodes: OpcodeSets; logger: Logger;
  resolveIdentity: (wallet: string) => Promise<LedgerAsset | null>; maxPagesPerAccount: number; metrics?: RuntimeMetrics;
};
type Head = TransactionCursor | null;
type Run = { generation: string; head_lt: string | null; head_hash: string | null;
  next_lt: string | null; next_hash: string | null; source_complete: boolean };
class SyncFailure extends Error {}
const sameHead = (left: Head, right: Head) => left?.lt === right?.lt && left?.hash === right?.hash;
const runHead = (run: { head_lt: string | null; head_hash: string | null }): Head =>
  run.head_lt && run.head_hash ? { lt: run.head_lt, hash: run.head_hash } : null;
function assertNotBehind(target: Head, stored: Head) {
  if (stored && (!target || BigInt(target.lt) < BigInt(stored.lt))) throw new SyncFailure('boundary_behind');
  if (stored && target && target.lt === stored.lt && target.hash !== stored.hash) throw new SyncFailure('head_conflict');
}
function accountHead(state: AccountStateResponse): Head {
  if (state.lastTxLt === undefined && state.lastTxHash === undefined && state.accountState === 'uninitialized') return null;
  if (state.lastTxLt === '0' && state.lastTxHash && canonicalLedgerHash(state.lastTxHash) === Buffer.alloc(32).toString('base64')
    && state.accountState === 'uninitialized') return null;
  if (!state.lastTxLt || !/^[1-9][0-9]*$/.test(state.lastTxLt) || BigInt(state.lastTxLt) > 0xffffffffffffffffn || !state.lastTxHash)
    throw new SyncFailure('head_unavailable');
  try { return { lt: state.lastTxLt, hash: canonicalLedgerHash(state.lastTxHash) }; }
  catch { throw new SyncFailure('head_unavailable'); }
}
const failureCode = (error: unknown) => error instanceof SyncFailure ? error.message
  : error && typeof error === 'object' && 'code' in error && /^[0-9A-Z]{5}$/.test(String(error.code))
    ? 'ledger_storage_unavailable' : 'source_unavailable';
const states = new WeakMap<PostgresLedgerStore, Map<string, string>>();
function report(deps: ChainSyncDeps, account: string, code: string | null) {
  let map = states.get(deps.store);
  if (!map) states.set(deps.store, map = new Map());
  const key = `${deps.network}:${account}`;
  if (code === null) { map.delete(key); return; }
  if (map.get(key) === code) return;
  if (map.size >= 4096) map.delete(map.keys().next().value!);
  map.set(key, code);
  deps.logger.warn('ledger chain refresh pending', { account, code });
  deps.metrics?.count('ledger_chain_refresh_pending', 1, { code });
}
function storedResult(account: string, row: any): DependencyRefresh {
  return { account, generation: row?.current_generation ?? null, head: row ? runHead(row) : null,
    complete: row?.complete === true, atBoundary: false, errorCode: null };
}

/** Under the caller's account lock, retain old progress and follow the pinned
 * head. Each invocation owns its allowance; no other account can spend it. */
async function syncLocked(deps: ChainSyncDeps, account: string, cycle: OwnerCycle, publish: boolean,
  boundaryHead: Head, previous: any): Promise<{ generation: string; head: Head }> {
  const { store, network, source } = deps;
  const observedAt = new Date().toISOString();
  assertNotBehind(boundaryHead, previous?.complete ? runHead(previous) : null);
  let pages = deps.maxPagesPerAccount;
  if (!Number.isSafeInteger(pages) || pages < 0) throw new SyncFailure('page_allowance');
  let reusable = previous?.complete ? previous.current_generation as string : null;
  let run: Run | undefined = previous?.latest_generation ? (await store.pool.query(
    `SELECT generation,head_lt::text,head_hash,next_lt::text,next_hash,source_complete FROM ledger_runs
     WHERE generation=$1 AND network=$2 AND account=$3 AND complete=false`,
    [previous.latest_generation, network, account])).rows[0] : undefined;
  for (;;) {
    cycle.signal?.throwIfAborted();
    if (!run) {
      const generation = randomUUID();
      await store.begin(network, account, generation, boundaryHead ?? undefined, observedAt);
      run = { generation, head_lt: boundaryHead?.lt ?? null, head_hash: boundaryHead?.hash ?? null,
        next_lt: boundaryHead?.lt ?? null, next_hash: boundaryHead?.hash ?? null, source_complete: boundaryHead === null };
    }
    await store.pool.query('UPDATE ledger_accounts SET attempted_at=now(),syncing=true,error_code=NULL WHERE network=$1 AND account=$2', [network, account]);
    if (run.head_lt === null && run.head_hash === null) run.source_complete = true;
    let cursor = run.next_lt && run.next_hash ? { lt: run.next_lt, hash: run.next_hash } : null;
    const seen = new Set<string>();
    while (!run.source_complete) {
      cycle.signal?.throwIfAborted();
      if (!cursor) throw new SyncFailure('history_predecessor_unavailable');
      // A completed physical run may be unpublished owner history. Reuse only
      // its authenticated membership, never its projection or owner coverage.
      if (reusable && await store.copySourceTail(run.generation, reusable, cursor.lt, cursor.hash)) {
        run.source_complete = true; break;
      }
      if (pages <= 0) throw new SyncFailure('page_allowance');
      pages--;
      const key = `${cursor.lt}:${cursor.hash}`;
      if (seen.has(key)) throw new SyncFailure('history_cursor_stalled');
      seen.add(key);
      const raw = await source.getTransactions(account, 100, cursor.lt, cursor.hash, { signal: cycle.signal });
      if (!raw.length || raw.length > 100 || !transactionPageIsLinkedInclusiveSegment(raw, cursor, raw[raw.length - 1]))
        throw new SyncFailure('history_chain_unverified');
      const events = [];
      for (const tx of raw) events.push(await normalizeLedgerEvent(network, account, tx, deps.opcodes, deps.resolveIdentity));
      await store.append(run.generation, events, raw);
      const tail = raw[raw.length - 1];
      if (transactionPageReachesHistoryStart(raw, cursor)) { run.source_complete = true; break; }
      if (!tail.prevTransactionLt || !tail.prevTransactionHash) throw new SyncFailure('history_predecessor_unavailable');
      cursor = { lt: tail.prevTransactionLt, hash: canonicalLedgerHash(tail.prevTransactionHash) };
      await store.pool.query('UPDATE ledger_runs SET next_lt=$2,next_hash=$3 WHERE generation=$1', [run.generation, cursor.lt, cursor.hash]);
    }
    await store.pool.query('UPDATE ledger_runs SET source_complete=true,next_lt=NULL,next_hash=NULL WHERE generation=$1', [run.generation]);
    const head = runHead(run);
    if (publish) await store.complete(network, account, run.generation, observedAt);
    if (sameHead(head, boundaryHead)) return { generation: run.generation, head };
    assertNotBehind(boundaryHead, head);
    // Finishing an old head is progress, never freshness. Finish it as physical
    // history, then follow the boundary head inside this same allowance.
    reusable = run.generation;
    run = undefined;
  }
}

/** Promise maps are shared by all refresh factories using this store instance. */
const flights = new WeakMap<PostgresLedgerStore, Map<string, { boundary: string; signal?: AbortSignal; promise: Promise<DependencyRefresh> }>>();
export function createRefreshDependency(deps: ChainSyncDeps): RefreshDependency {
  let pending = flights.get(deps.store);
  if (!pending) flights.set(deps.store, pending = new Map());
  const perform: RefreshDependency = async (account, cycle) => {
    let result = storedResult(account, null);
    try {
      result = storedResult(account, await deps.store.account(deps.network, account));
      const locked = await deps.store.withAccountLock(deps.network, account, async () => {
        const previous = await deps.store.account(deps.network, account);
        result = storedResult(account, previous);
        cycle.signal?.throwIfAborted();
        const head = accountHead(await deps.source.getAccountState(account, { at: cycle.boundary, signal: cycle.signal }));
        if (result.complete && sameHead(head, result.head)) { result.atBoundary = true; return; }
        const synced = await syncLocked(deps, account, cycle, true, head, previous);
        result = { account, generation: synced.generation, head: synced.head, complete: true,
          atBoundary: sameHead(synced.head, head), errorCode: null };
      });
      if (!locked) result.errorCode = 'lock_busy';
    } catch (error) {
      // A resumed run may have completed before its newer head failed. Report
      // the actual stored generation, or retain our snapshot if storage failed.
      try { result = storedResult(account, await deps.store.account(deps.network, account)); } catch { /* preserve facts */ }
      result.atBoundary = false;
      result.errorCode = failureCode(error);
      try { await deps.store.failed(deps.network, account, result.errorCode); } catch { /* preserve original failure */ }
    }
    report(deps, account, result.errorCode);
    return result;
  };
  return async (address, cycle) => {
    let account: string;
    try { account = canonicalLedgerAddress(address); }
    catch { return { ...storedResult(address, null), errorCode: 'invalid_account' }; }
    const key = `${deps.network}:${account}`;
    const boundary = JSON.stringify(cycle.boundary);
    for (;;) {
      const active = pending!.get(key);
      if (active) {
        const result = await active.promise;
        // Different cycle/cancellation domains await progress, then recheck at
        // their own boundary; H1's result cannot certify H2's freshness.
        if (active.boundary === boundary && active.signal === cycle.signal) return result;
        continue;
      }
      const promise = perform(account, cycle);
      pending!.set(key, { boundary, signal: cycle.signal, promise });
      try { return await promise; }
      finally { if (pending!.get(key)?.promise === promise) pending!.delete(key); }
    }
  };
}

/** The owner-cycle caller holds the account lock through projection/publication.
 * Never publish here, including a resumed run whose old head is now complete. */
export async function syncOwnerChain(deps: ChainSyncDeps, owner: string, cycle: OwnerCycle):
  Promise<{ generation: string; head: Head } | { errorCode: string }> {
  let account = owner;
  try {
    account = canonicalLedgerAddress(owner);
    cycle.signal?.throwIfAborted();
    const head = accountHead(await deps.source.getAccountState(account, { at: cycle.boundary, signal: cycle.signal }));
    const previous = await deps.store.account(deps.network, account);
    const result = await syncLocked(deps, account, cycle, false, head, previous);
    report(deps, account, null);
    return result;
  } catch (error) {
    const errorCode = failureCode(error);
    try { await deps.store.failed(deps.network, account, errorCode); } catch { /* original code retained */ }
    report(deps, account, errorCode);
    return { errorCode };
  }
}
