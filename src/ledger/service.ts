import { PerpsRangeService } from './perpsRange';
import { randomUUID } from 'node:crypto';
import type { AccountStateResponse, ChainSource } from '../data/dataSource';
import type { Network } from '../models';
import type { OpcodeSets } from '../utils/opcodes';
import type { Logger } from '../utils/logger';
import { PostgresLedgerStore, projectionFingerprint, validProjectionScope, type OwnerCheckRecord } from './store';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import type { LedgerQuery, LedgerDiscoveryQuery, LedgerEvent } from './types';
import { LedgerGraphBuilder } from './graph';
import { projectOwnerLedger } from './project';
import { WalletIdentityStore } from './identities';
import { createRefreshDependency, syncOwnerChain, type ChainSyncDeps } from './chainSync';
import type { OwnerCycle } from './cycle';
import { decidePublication, countConfirmedRegressions, encodeBindings, decodeBindings, parseArchiveBindingKey, type PublicationInputs } from './publication';

export type OwnerCycleResult = {
  status: 'published' | 'kept' | 'quiet'; generation: string | null; retry: boolean;
  pendingAccounts: string[]; confirmedRegressions: number; errorCode?: string;
  timings: { headMs: number; chainMs: number; graphMs: number; projectMs: number; publishMs: number; totalMs: number };
};
function pointer(state: AccountStateResponse): { headLt: string | null; headHash: string | null } {
  if (state.accountState === 'uninitialized' && ((!state.lastTxLt && !state.lastTxHash) ||
    (state.lastTxLt === '0' && state.lastTxHash && canonicalLedgerHash(state.lastTxHash) === Buffer.alloc(32).toString('base64'))))
    return { headLt: null, headHash: null };
  if (!state.lastTxLt || !/^[1-9][0-9]*$/.test(state.lastTxLt) || BigInt(state.lastTxLt) > 0xffffffffffffffffn || !state.lastTxHash)
    throw new Error('head_unavailable');
  return { headLt: state.lastTxLt, headHash: canonicalLedgerHash(state.lastTxHash) };
}
const samePointer = (a: { headLt: string | null; headHash: string | null }, b: { headLt: string | null; headHash: string | null }) =>
  a.headLt === b.headLt && a.headHash === b.headHash;

/** Persists and validates account chains without consulting MemoryStore or its retention cap. */
export class LedgerService {
  private ranges?: PerpsRangeService;
  private pending = new Set<string>();
  private running = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private identities?: WalletIdentityStore;

  constructor(
    readonly network: Network,
    readonly store: PostgresLedgerStore,
    private source: ChainSource,
    private opcodes: OpcodeSets,
    private logger: Logger,
    private concurrency = 2,
    private options: {
      jettonRoots?: string[];
      walletTemplateCodeHash?: string | null;
      tokens?: Array<{ master: string; symbol?: string; decimals?: number }>;
      dlmmRegistry?: string;
      marketBindings?: import("./marketTypes").DlmmMarketBinding[];
      optionFactory?: string;
      optionVault?: string;
      optionCodeHashes?: import("./bindings").LedgerOptionsCodeHashes;
      launchpadCodeHashes?: import("./bindings").LedgerLaunchpadCodeHashes;
      launchpadControllers?: string[];
      t3RedemptionBinding?: import("./bindings").LedgerT3RedemptionBinding;
      t3Hub?: string;
      t3Root?: string;
      perpsEngine?: string;
      perpsEngineCodeHash?: string;
      maxWatchedAccounts?: number;
      maxPagesPerSync?: number;
      maxRelatedAccounts?: number;
    } = {},
  ) {}

  start() {
    this.stopped = false;
    this.ranges ??= new PerpsRangeService(this.network, this.store, this.source, this.opcodes, this.options);
    void this.ranges.start(() => this.logger.warn("perps range resume unavailable"))
      .catch(() => this.logger.warn("perps range resume unavailable"));
    this.timer = setInterval(
      () =>
        void this.resume().catch(() =>
          this.logger.warn("ledger resume unavailable"),
        ),
      30_000,
    );
    this.timer.unref();
    void this.resume().catch(() =>
      this.logger.warn("ledger resume unavailable"),
    );
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.pending.clear();
    await this.ranges?.stop();
    await Promise.allSettled(this.running.values());
  }

  private async resume() {
    const rows = (
      await this.store.pool.query(
        `SELECT a.account FROM ledger_watch_accounts w JOIN ledger_accounts a USING(network,account) WHERE a.network=$1
      ORDER BY a.attempted_at ASC NULLS FIRST LIMIT 100`,
        [this.network],
      )
    ).rows;
    for (const row of rows)
      if (!this.running.has(row.account)) this.pending.add(row.account);
    this.drain();
  }

  async requestSync(address: string) {
    const account = canonicalLedgerAddress(address);
    let admitted = false;
    await this.store.withAccountLock(
      this.network,
      "watch-admission",
      async () => {
        const existing =
          (
            await this.store.pool.query(
              "SELECT 1 FROM ledger_watch_accounts WHERE network=$1 AND account=$2",
              [this.network, account],
            )
          ).rows.length > 0;
        const count = Number(
          (
            await this.store.pool.query(
              "SELECT count(*)::text AS count FROM ledger_watch_accounts WHERE network=$1",
              [this.network],
            )
          ).rows[0].count,
        );
        if (!existing && count >= (this.options.maxWatchedAccounts ?? 1000))
          return;
        await this.store.pool.query(
          "INSERT INTO ledger_accounts(network,account) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [this.network, account],
        );
        await this.store.pool.query(
          "INSERT INTO ledger_watch_accounts(network,account) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [this.network, account],
        );
        admitted = true;
      },
    );
    if (!admitted) return false;
    const state = await this.store.account(this.network, account);
    // Freshness is independent of whether the account cache still exists.
    if (
      state?.synced_at &&
      Date.now() - new Date(state.synced_at).getTime() < 15_000 &&
      !state.error_code
    )
      return true;
    if (!this.running.has(account)) this.pending.add(account);
    this.drain();
    return true;
  }

  private drain() {
    if (this.stopped) return;
    while (this.running.size < this.concurrency && this.pending.size) {
      const account = this.pending.values().next().value as string;
      this.pending.delete(account);
      const work = this.runOwnerCycle(account)
        .catch(() =>
          this.logger.warn("ledger synchronization failed", { account }),
        )
        .finally(() => {
          this.running.delete(account);
          this.drain();
        });
      this.running.set(account, work);
    }
  }

  async page(address: string, query: LedgerQuery = {}) {
    const account = canonicalLedgerAddress(address);
    if (query.scope === "perps") {
      this.ranges ??= new PerpsRangeService(this.network, this.store, this.source, this.opcodes, this.options);
      return this.ranges.page(account, query);
    }
    // Cursor requests keep reading the same immutable run and never restart it.
    const admitted = query.cursor ? true : await this.requestSync(account);
    const page = await this.store.page(this.network, account, query);
    if (!admitted) {
      page.coverage.historyComplete = false;
      page.coverage.decodingComplete = false;
      page.coverage.issues.push("watch_capacity_reached");
    }
    if (this.pending.has(account) || this.running.has(account))
      page.coverage.syncing = true;
    return page;
  }

  async discoveries(address: string, query: LedgerDiscoveryQuery) {
    const account = canonicalLedgerAddress(address);
    const admitted = query.cursor ? true : await this.requestSync(account);
    const page = await this.store.discoveries(this.network, account, query);
    if (!admitted) {
      page.coverage.historyComplete = false;
      page.coverage.issues.push('watch_capacity_reached');
    }
    if (this.pending.has(account) || this.running.has(account)) page.coverage.syncing = true;
    return page;
  }

  /** One pinned owner check. Scheduling belongs to the worker, not this method. */
  async runOwnerCycle(address: string): Promise<OwnerCycleResult> {
    const account = canonicalLedgerAddress(address), started = performance.now();
    const timings: OwnerCycleResult['timings'] = { headMs: 0, chainMs: 0, graphMs: 0, projectMs: 0, publishMs: 0, totalMs: 0 };
    let result: OwnerCycleResult = { status: 'kept', generation: null, retry: true, pendingAccounts: [account], confirmedRegressions: 0, timings, errorCode: 'lock_busy' };
    // All quiet-check inputs are reloaded AFTER taking the owner lock. An earlier
    // observer cannot clear a pending dependency or overwrite a newer checkpoint.
    const locked = await this.store.withAccountLock(this.network, account, async () => {
      let previousCheck: OwnerCheckRecord | null = null;
      let cycle: OwnerCycle | undefined;
      let checkpoint: ReturnType<typeof decodeBindings> = null;
      let previous: any;
      const save = async (record: OwnerCheckRecord) => this.store.saveOwnerCheck(this.network, account, record);
      try {
        previous = await this.store.account(this.network, account);
        result.generation = previous?.current_generation ?? null;
        previousCheck = await this.store.ownerCheck(this.network, account);
        checkpoint = decodeBindings(previousCheck?.bindings);
        let phase = performance.now();
        cycle = { boundary: await this.source.head() };
        timings.headMs = performance.now() - phase;
        const boundary = { seqno: cycle.boundary.seqno, utime: cycle.boundary.utime };
        const old = previous?.current_generation ? (await this.store.pool.query(
          'SELECT projection_scope,related_accounts,fingerprint FROM ledger_projection_coverage WHERE generation=$1',
          [previous.current_generation])).rows[0] : null;
        if (old && (!validProjectionScope(old.projection_scope, account) || !checkpoint?.published ||
          checkpoint.published.generation !== previous.current_generation)) throw new Error('publication_checkpoint_invalid');
        if (previousCheck && boundary.seqno < previousCheck.boundary.seqno) throw new Error('boundary_behind');
        let ownerHead: ReturnType<typeof pointer> | undefined;
        if (old && previousCheck && !previousCheck.pendingAccounts.length && !previousCheck.unresolved && !previousCheck.errorCode &&
          previousCheck.headVector.some(row => row.account === account)) {
          const vector = previousCheck.headVector;
          try {
            const batch = await this.source.read(vector.map(row => ({ kind: 'account' as const, address: row.account })), { at: cycle.boundary });
            if (JSON.stringify(batch.head) !== JSON.stringify(cycle.boundary) || batch.results.length !== vector.length) throw new Error('boundary_mismatch');
            const heads = batch.results.map((row, index) => {
              if (row.kind !== 'account' || row.address !== vector[index].account) throw new Error('boundary_mismatch');
              return { account: row.address, ...pointer(row.state) };
            });
            ownerHead = heads.find(row => row.account === account);
            if (heads.every((row, index) => samePointer(row, vector[index]))) {
              await save({ ...previousCheck, checkedAt: new Date().toISOString(), boundary });
              result = { status: 'quiet', generation: previous.current_generation, retry: false, pendingAccounts: [], confirmedRegressions: 0, timings };
              return;
            }
          } catch { /* Retry each dependency; a failed batch never certifies quiet. */ }
        }
        this.identities ??= new WalletIdentityStore({ network: this.network, store: this.store, source: this.source,
          walletTemplateCodeHash: this.options.walletTemplateCodeHash ?? null, tokens: this.options.tokens });
        const deps: ChainSyncDeps = { network: this.network, store: this.store, source: this.source, opcodes: this.opcodes,
          logger: this.logger, maxPagesPerAccount: this.options.maxPagesPerSync ?? 20,
          resolveIdentity: wallet => this.identities!.resolve(wallet, cycle!) };
        phase = performance.now();
        ownerHead ??= pointer(await this.source.getAccountState(account, { at: cycle.boundary }));
        let generation: string;
        if (previous?.complete && samePointer(ownerHead, { headLt: previous.head_lt, headHash: previous.head_hash })) {
          generation = previous.current_generation;
        } else {
          const synced = await syncOwnerChain(deps, account, cycle);
          if ('errorCode' in synced) throw new Error(synced.errorCode);
          generation = synced.generation;
        }
        timings.chainMs = performance.now() - phase;
        phase = performance.now();
        const builder = new LedgerGraphBuilder(this.network, this.source, this.store,
          this.options.jettonRoots ?? [], this.options.dlmmRegistry, this.identities, createRefreshDependency(deps),
          this.options.maxRelatedAccounts ?? 256, this.options.optionFactory, this.options.t3Hub, this.options.t3Root,
          this.options.perpsEngine, this.options.perpsEngineCodeHash, this.options.optionVault, this.options.optionCodeHashes,
          this.options.t3RedemptionBinding, this.options.launchpadCodeHashes, this.options.launchpadControllers, this.options.marketBindings);
        const graph = await builder.build(account, generation, cycle);
        timings.graphMs = performance.now() - phase;
        phase = performance.now();
        const projection = await projectOwnerLedger({ network: this.network, owner: account, opcodes: this.opcodes, ...graph });
        // Historical bindings are populated by project-time stateAt calls. A
        // skipped old operation cannot silently drop its published proof inputs:
        // recheck those exact archives before applying the publication rule.
        for (const [key, resolved] of Object.entries(checkpoint?.published?.bindings ?? {})) {
          if (!resolved || Object.hasOwn(graph.bindings, key)) continue;
          const archive = parseArchiveBindingKey(key);
          if (archive) await graph.stateAt(archive.account, archive.lt, archive.hash).catch(() => null);
        }
        const related = [...graph.chains.values()].map(({ transactions, checkedAt, ...chain }) => chain);
        const inputs: PublicationInputs = { accounts: related.map(row => ({ account: row.account,
          headLt: row.headLt ?? null, headHash: row.headHash ?? null })), bindings: graph.bindings };
        const priorInputs: PublicationInputs | null = old ? { accounts: old.related_accounts.map((row: any) => ({
          account: row.account, headLt: row.headLt ?? null, headHash: row.headHash ?? null })), bindings: checkpoint!.published!.bindings } : null;
        const decision = decidePublication(priorInputs, inputs);
        const pendingAccounts = [...new Set([...graph.pendingAccounts, ...(!decision.publish ? decision.accounts : [])])].sort();
        const unresolved = Object.values(graph.bindings).some(flag => !flag) || !decision.publish;
        const errorCode = !decision.publish ? decision.reason : pendingAccounts.length ? 'related_account_refresh_pending' : null;
        if ((unresolved || pendingAccounts.length) && !graph.issues.includes('related_account_refresh_pending'))
          graph.issues.push('related_account_refresh_pending');
        const record: OwnerCheckRecord = { checkedAt: new Date().toISOString(), boundary, headVector: inputs.accounts,
          pendingAccounts, bindings: encodeBindings(graph.bindings, checkpoint?.published ?? null), unresolved, errorCode };
        timings.projectMs = performance.now() - phase;
        const fingerprint = projectionFingerprint(projection, related, graph.issues);
        if (!decision.publish || old?.fingerprint === fingerprint) {
          await save(record);
          if (generation !== previous?.current_generation)
            await this.store.failed(this.network, account, errorCode ?? 'owner_projection_pending');
          result = { status: 'kept', generation: previous?.current_generation ?? null, retry: unresolved || pendingAccounts.length > 0,
            pendingAccounts, confirmedRegressions: 0, timings, ...(errorCode ? { errorCode } : {}) };
          return;
        }
        phase = performance.now();
        // Unchanged owner history must not allocate a run until publication is
        // admitted and its economic fingerprint differs. Copy only physical rows.
        if (generation === previous?.current_generation) {
          const sourceGeneration = generation;
          generation = randomUUID();
          await this.store.begin(this.network, account, generation, ownerHead.headLt && ownerHead.headHash
            ? { lt: ownerHead.headLt, hash: ownerHead.headHash } : undefined);
          if (ownerHead.headLt && ownerHead.headHash && !await this.store.copySourceTail(generation, sourceGeneration, ownerHead.headLt, ownerHead.headHash))
            throw new Error('owner_history_unavailable');
        }
        const previousEvents: LedgerEvent[] = old ? (await this.store.pool.query(
          'SELECT event FROM ledger_projection_events WHERE generation=$1', [previous.current_generation])).rows.map(row => row.event) : [];
        const regressions = countConfirmedRegressions(previousEvents, projection.events);
        await this.store.project(generation, projection, related.map(row => row.role === 'owner' ? { ...row, generation } : row), graph.issues, boundary);
        record.bindings = encodeBindings(graph.bindings, { generation, bindings: graph.bindings });
        await this.store.complete(this.network, account, generation, record.checkedAt, record);
        timings.publishMs = performance.now() - phase;
        result = { status: 'published', generation, retry: unresolved || pendingAccounts.length > 0, pendingAccounts,
          confirmedRegressions: regressions, timings, ...(errorCode ? { errorCode } : {}) };
      } catch (error) {
        const known = ['publication_checkpoint_invalid', 'boundary_behind', 'head_unavailable', 'page_allowance',
          'history_chain_unverified', 'history_cursor_stalled', 'history_predecessor_unavailable', 'owner_history_unavailable', 'source_unavailable'];
        const code = error instanceof Error && known.includes(error.message) ? error.message : 'owner_cycle_unavailable';
        // Retain the publication checkpoint on every failure, including failed
        // diagnostics writes. Never derive authority from the last current map.
        const state = await this.store.account(this.network, account).catch(() => null);
        if (state && (cycle || previousCheck)) await save({
          checkedAt: new Date().toISOString(), boundary: cycle ? { seqno: cycle.boundary.seqno, utime: cycle.boundary.utime } : previousCheck!.boundary,
          headVector: previousCheck?.headVector ?? [], pendingAccounts: [...new Set([...(previousCheck?.pendingAccounts ?? []), account])].sort(),
          bindings: previousCheck?.bindings ?? encodeBindings({}, null), unresolved: true, errorCode: code,
        }).catch(() => undefined);
        await this.store.failed(this.network, account, code).catch(() => undefined);
        result = { status: 'kept', generation: state?.current_generation ?? previous?.current_generation ?? null, retry: true,
          pendingAccounts: [account], confirmedRegressions: 0, timings, errorCode: code };
        this.logger.warn('ledger owner check pending', { account, code });
      }
    });
    if (!locked) result.generation = (await this.store.account(this.network, account))?.current_generation ?? null;
    timings.totalMs = performance.now() - started;
    return result;
  }
}
