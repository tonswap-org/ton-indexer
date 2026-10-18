import { isDeepStrictEqual } from 'node:util';
import type { ChainSource } from '../data/dataSource';
import type { Logger } from '../utils/logger';
import type { LedgerService } from './service';
import type { CurrentDlmmMarketBinding, CurrentDlmmMarketProjection } from './currentDlmmMarketTypes';
import { CurrentDlmmMarketGraphBuilder } from './currentDlmmMarketGraph';
import { projectCurrentDlmmMarket, validateCurrentDlmmMarketBinding } from './currentDlmmMarketProjection';
import { PostgresMarketStore, type MarketQuery } from './marketStore';

/** Configured pools only. Reads schedule durable backfill without wallet actions. */
export class DlmmMarketService {
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private activePool?: string;
  private pending = new Set<string>();
  private stopped = false;
  private attempts = new Map<string, number>();
  private errors = new Set<string>();
  private bindings: Map<string, CurrentDlmmMarketBinding>;
  private graph: CurrentDlmmMarketGraphBuilder;
  constructor(private ledger: LedgerService, private source: ChainSource, readonly store: PostgresMarketStore<CurrentDlmmMarketProjection>,
    bindings: CurrentDlmmMarketBinding[], private logger: Logger, maxAccounts = 256, private readStore: PostgresMarketStore<CurrentDlmmMarketProjection> = store) {
    bindings.forEach(validateCurrentDlmmMarketBinding);
    this.bindings = new Map(bindings.map(binding => [binding.pool, binding]));
    this.graph = new CurrentDlmmMarketGraphBuilder(ledger, source, maxAccounts);
  }
  configured(pool: string) { return this.bindings.has(pool); }
  start() {
    this.stopped = false;
    const refresh = () => { for (const pool of this.bindings.keys()) this.requestSync(pool); };
    this.timer = setInterval(refresh, 30_000); this.timer.unref(); refresh();
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.pending.clear(); await this.work; }
  requestSync(pool: string) {
    if (this.stopped || !this.bindings.has(pool) || Date.now() - (this.attempts.get(pool) ?? 0) < 30_000) return;
    this.pending.add(pool); this.drain();
  }
  private drain() {
    if (this.work || this.stopped || !this.pending.size) return;
    const pool = this.pending.values().next().value!; this.pending.delete(pool); this.attempts.set(pool, Date.now()); this.activePool = pool;
    this.work = this.sync(pool).then(() => { this.errors.delete(pool); }, () => {
      this.errors.add(pool); this.logger.warn('historical market refresh unavailable', { pool });
    }).finally(() => { this.work = undefined; this.activePool = undefined; this.drain(); });
  }
  async sync(pool: string) {
    const binding = this.bindings.get(pool); if (!binding) throw new Error('market_binding_unconfigured');
    await this.ledger.store.withAccountLock(binding.network, `market:${pool}`, async () => {
      const prior = await this.store.current(binding.network, pool), graph = await this.graph.build(binding);
      if (!graph.dependencies.some(dependency => dependency.account === pool)) throw new Error('market_pool_history_unavailable');
      const projection = projectCurrentDlmmMarket(binding, graph.evidence, graph.wallets, graph.dependencies, graph.executionSeqnos, graph.archives, graph.anchors);
      projection.issues = [...new Set([...projection.issues, ...graph.issues])].sort();
      if (graph.issues.length) projection.historyComplete = false;
      await this.store.publish(projection, prior?.generation ?? null);
    });
  }
  async page(pool: string, query: MarketQuery, candidates = false) {
    if (!this.bindings.has(pool)) throw new Error('market_binding_unconfigured');
    if (!query.cursor && !query.generation) this.requestSync(pool);
    const page = candidates ? await this.readStore.candidatesPage(this.ledger.network, pool, query) : await this.readStore.page(this.ledger.network, pool, query);
    if(page.coverage && (page.coverage.schema !== 'dlmm-market-ledger-v2' || !isDeepStrictEqual(page.coverage.binding, this.bindings.get(pool)))) throw Error('market_current_schema_required');
    return { ...page, refresh: this.errors.has(pool) ? 'unavailable' : this.activePool === pool || this.pending.has(pool) ? 'running' : 'idle' };
  }
}
