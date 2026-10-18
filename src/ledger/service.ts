import { LedgerScheduler, type LedgerPriority } from './scheduler';
import type { RuntimeMetrics } from '../runtimeMetrics';
import type { RefreshDependency } from './cycle';
import { PerpsRangeService } from './perpsRange';
import { randomUUID } from 'node:crypto';
import type { AccountStateResponse, ChainSource } from '../data/dataSource';
import type { Network } from '../models';
import type { OpcodeSets } from '../utils/opcodes';
import type { Logger } from '../utils/logger';
import { PostgresLedgerStore, ledgerCycleIo, projectionFingerprint, validProjectionScope, type OwnerCheckRecord } from './store';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import type { LedgerQuery, LedgerDiscoveryQuery, LedgerEvent } from './types';
import { LedgerGraphBuilder } from './graph';
import { projectOwnerLedger } from './project';
import { WalletIdentityStore } from './identities';
import type { JettonTokenPin } from '../data/jettonWallet';
import { createRefreshDependency, syncOwnerChain, type ChainSyncDeps } from './chainSync';
import type { OwnerCycle } from './cycle';
import { decidePublication, countConfirmedRegressions, encodeBindings, decodeBindings, parseArchiveBindingKey, type PublicationInputs } from './publication';

export type OwnerCycleResult = {
  status: 'published' | 'kept' | 'quiet'; generation: string | null; retry: boolean;
  pendingAccounts: string[]; confirmedRegressions: number; errorCode?: string;
  timings: { sourceMs: number; databaseMs: number; headMs: number; chainMs: number; graphMs: number; projectMs: number; publishMs: number; totalMs: number };
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
  private scheduler: LedgerScheduler;
  private scheduled = new Map<string, number>();
  private admissions = new Map<string, { priority: LedgerPriority; work: Promise<boolean> }>();
  private sweepWork?: Promise<void>;
  private started = false;
  private metricsTimer?: NodeJS.Timeout;
  readonly refreshDependency: RefreshDependency;
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
      tokens?: Array<JettonTokenPin & { symbol?: string; decimals?: number }>;
      dlmmRegistry?: string;
      marketBindings?: import("./marketTypes").DlmmMarketBinding[];
      optionFactory?: string;
      optionVault?: string;
      currentDlmmBinding?: import("./currentDlmmPhysical").CurrentDlmmConfigBinding;
      currentLaunchpadBinding?: import("./currentLaunchpadProof").CurrentLaunchpadBinding;
      currentPerpsBinding?: import("./currentPerpsProof").NativePerpsProofBinding;
      currentOptionsBinding?: import("./currentOptionsProof").NativeOptionProofBinding;
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
      router?: string;
      dependencyPools?: string[];
      readStore?: PostgresLedgerStore;
      metrics?: RuntimeMetrics;
    } = {},
  ) {
    const target = this.source;
    this.source = new Proxy(target, { get: (object, key) => {
      const value = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      if (key === 'health') return value.bind(object);
      return async (...args: unknown[]) => {
        const context = ledgerCycleIo.getStore(), started = performance.now();
        try { return await value.apply(object, args); }
        finally { if (context) context.sourceMs += performance.now() - started; }
      };
    } });
    this.refreshDependency = async (account, cycle) => {
      this.identities ??= new WalletIdentityStore({ network, store, source: this.source,
        tokens: options.tokens ?? [] });
      return createRefreshDependency({ network, store, source: this.source, opcodes, logger,
        maxPagesPerAccount: options.maxPagesPerSync ?? 20, metrics: options.metrics,
        resolveIdentity: wallet => this.identities!.resolve(wallet, cycle) })(account, cycle);
    };
    this.scheduler = new LedgerScheduler({ workers: concurrency, now: Date.now, run: async key => {
      const revision = this.scheduled.get(key);
      let retry = true;
      try {
        if (key.startsWith('dependency:')) {
          const result = await this.refreshDependency(key.slice(11), { boundary: await this.source.head() });
          retry = !result.atBoundary;
        } else {
          const result = await this.runOwnerCycle(key); retry = result.retry;
          for (const [phase, value] of Object.entries(result.timings))
            options.metrics?.observe('ledger_cycle_phase_ms', value, { phase: phase.replace(/Ms$/, '') });
          options.metrics?.count('ledger_confirmed_regressions_total', result.confirmedRegressions);
          if (result.status === 'published' && result.generation && options.metrics) {
            try { for (const latency of await store.firstPublicationLatencies(result.generation))
              options.metrics.observe('ledger_first_publication_ms', Math.max(0, latency)); }
            catch { logger.warn('ledger publication metrics unavailable'); }
          }
        }
        return { retry };
      } finally {
        if (!retry && this.scheduled.get(key) === revision) this.scheduled.delete(key);
        this.recordSchedulerMetrics();
      }
    } });
  }

  private recordSchedulerMetrics() {
    this.options.metrics?.gauge('ledger_scheduler_depth', this.scheduler.depth());
    this.options.metrics?.gauge('ledger_foreground_oldest_ms', this.scheduler.oldestForegroundAgeMs());
  }
  private enqueue(account: string, priority: LedgerPriority) {
    if (this.stopped) return;
    this.scheduled.set(account, (this.scheduled.get(account) ?? 0) + 1);
    this.scheduler.request(account, priority); this.recordSchedulerMetrics();
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.ranges ??= new PerpsRangeService(this.network, this.store, this.source, this.opcodes, this.options, this.logger);
    void this.ranges.start(() => this.logger.warn('perps range resume unavailable'))
      .catch(() => this.logger.warn('perps range resume unavailable'));
    const singletons = [this.options.t3Hub, this.options.t3Root, this.options.perpsEngine, this.options.optionFactory,
      this.options.optionVault, this.options.router, ...(this.options.dependencyPools ?? []), ...(this.options.marketBindings ?? []).map(binding => binding.pool)];
    for (const account of new Set(singletons.filter((value): value is string => Boolean(value))))
      this.enqueue(`dependency:${canonicalLedgerAddress(account)}`, 'background');
    const sweep = () => {
      if (this.sweepWork) return;
      this.sweepWork = this.sweep().catch(() => this.logger.warn('ledger sweep unavailable')).finally(() => { this.sweepWork = undefined; });
    };
    this.timer = setInterval(sweep, 30_000); this.timer.unref(); sweep();
    this.metricsTimer = setInterval(() => this.recordSchedulerMetrics(), 1_000); this.metricsTimer.unref();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer); clearInterval(this.metricsTimer);
    await this.sweepWork;
    await this.ranges?.stop(); await this.scheduler.stop();
    this.scheduled.clear(); this.recordSchedulerMetrics();
  }

  private async sweep() {
    for (const account of await this.store.activeWatches(this.network)) this.enqueue(account, 'background');
  }

  async requestSync(address: string, priority: LedgerPriority = 'foreground') {
    const account = canonicalLedgerAddress(address);
    let entry = this.admissions.get(account);
    if (!entry) {
      const created = { priority, work: Promise.resolve(false) };
      created.work = (async () => {
        const admitted = await (this.options.readStore ?? this.store).admitWatch(this.network, account, this.options.maxWatchedAccounts ?? 1000);
        if (admitted) this.enqueue(account, created.priority);
        return admitted;
      })().finally(() => this.admissions.delete(account));
      this.admissions.set(account, created); entry = created;
    } else if (priority === 'foreground') entry.priority = 'foreground';
    return entry.work;
  }

  async page(address: string, query: LedgerQuery = {}) {
    const account = canonicalLedgerAddress(address);
    if (query.scope === "perps") {
      this.ranges ??= new PerpsRangeService(this.network, this.store, this.source, this.opcodes, this.options, this.logger);
      return this.ranges.page(account, query);
    }
    // Cursor requests keep reading the same immutable run and never restart it.
    const admitted = query.cursor ? true : await this.requestSync(account);
    const page = await (this.options.readStore ?? this.store).page(this.network, account, query);
    if (!admitted) {
      page.coverage.historyComplete = false;
      page.coverage.decodingComplete = false;
      page.coverage.issues.push("watch_capacity_reached");
    }
    if (this.scheduled.has(account))
      page.coverage.syncing = true;
    return page;
  }

  async discoveries(address: string, query: LedgerDiscoveryQuery) {
    const account = canonicalLedgerAddress(address);
    const admitted = query.cursor ? true : await this.requestSync(account, 'background');
    const page = await (this.options.readStore ?? this.store).discoveries(this.network, account, query);
    if (!admitted) {
      page.coverage.historyComplete = false;
      page.coverage.issues.push('watch_capacity_reached');
    }
    if (this.scheduled.has(account)) page.coverage.syncing = true;
    return page;
  }

  /** One pinned owner check. Scheduling belongs to the worker, not this method. */
  async runOwnerCycle(address: string): Promise<OwnerCycleResult> {
    const io = { sourceMs: 0, databaseMs: 0 };
    return ledgerCycleIo.run(io, async () => {
      const result = await this.checkOwnerCycle(address);
      Object.assign(result.timings, io); return result;
    });
  }
  private async checkOwnerCycle(address: string): Promise<OwnerCycleResult> {
    const account = canonicalLedgerAddress(address), started = performance.now();
    const timings: OwnerCycleResult['timings'] = { sourceMs: 0, databaseMs: 0, headMs: 0, chainMs: 0, graphMs: 0, projectMs: 0, publishMs: 0, totalMs: 0 };
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
          tokens: this.options.tokens ?? [] });
        const deps: ChainSyncDeps = { network: this.network, store: this.store, source: this.source, opcodes: this.opcodes,
          logger: this.logger, metrics: this.options.metrics, maxPagesPerAccount: this.options.maxPagesPerSync ?? 20,
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
          this.options.t3RedemptionBinding, this.options.launchpadCodeHashes, this.options.launchpadControllers, this.options.marketBindings, this.options.currentOptionsBinding, this.options.currentPerpsBinding, this.options.currentDlmmBinding, this.options.currentLaunchpadBinding);
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
