import type { FastifyInstance } from 'fastify';
import { deriveT3RedemptionBinding } from '../ledger/runtimeT3Binding';
import { createReleaseLedgerPool, type ReleasePoolOptions } from '../ledger/releasePool';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { LedgerService } from '../ledger/service';
import { DlmmMarketService } from '../ledger/marketService';
import { PostgresMarketStore } from '../ledger/marketStore';
import { registerLedgerRoutes } from '../ledger/routes';
import { registerMarketLedgerRoutes } from '../ledger/marketRoutes';
import { registerLedgerReadinessRoute } from '../ledger/readiness';
import { runningLedgerBuild } from '../ledger/buildIdentity';
import { assertLedgerDatabaseReady, type LedgerCatalog } from '../ledger/schemaReadiness';
import { errorDiagnostic } from '../utils/logger';
import type { RuntimeDeps } from './worker';

export type LedgerRuntime = { ledger(): LedgerService | undefined; market(): DlmmMarketService | undefined; readPool(): LedgerSqlPool | undefined;
  status(): 'disabled' | 'connecting' | 'ready' | 'unavailable'; start(): void; stop(): Promise<void>; registerRoutes(app: FastifyInstance): void };
export function createLedgerRuntime(deps: RuntimeDeps, options: {
  poolFactory?: (url: string, manifestHash: string, options?: ReleasePoolOptions) => Promise<LedgerSqlPool>;
  /** Tests supply a catalog generated from canonical SQL in their isolated DB. */
  catalog?: LedgerCatalog;
} = {}): LedgerRuntime {
  const { config, manifest, bindings, registry, source, opcodes, logger } = deps;
  let pool: LedgerSqlPool | undefined, readPool: LedgerSqlPool | undefined, ledger: LedgerService | undefined, market: DlmmMarketService | undefined;
  let status: ReturnType<LedgerRuntime['status']> = config.databaseUrl ? 'connecting' : 'disabled';
  let stopped = false, started = false, failures = 0;
  let sizeTimer: NodeJS.Timeout | undefined, sizeWork: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined, work: Promise<void> | undefined, lastError: string | undefined;
  const attempt = async () => {
    let candidate: LedgerSqlPool | undefined, readCandidate: LedgerSqlPool | undefined;
    try {
      status = 'connecting';
      if (!bindings.currentLedgerDecodersQualified) throw new Error('Current contract ledger decoders are not qualified');
      candidate = await (options.poolFactory ?? createReleaseLedgerPool)(config.databaseUrl!, manifest.runtime.manifestHash, { size: config.ledgerWorkers * 5 + 4, metrics: deps.metrics, role: 'worker' });
      const store = new PostgresLedgerStore(candidate);
      await store.initialize();
      const catalog = options.catalog ?? runningLedgerBuild?.catalog;
      if (!catalog) throw new Error('Canonical compiled ledger catalog is unavailable');
      runningLedgerBuild?.assertCurrent();
      await assertLedgerDatabaseReady(candidate, manifest.runtime.manifestHash, catalog);
      readCandidate = await (options.poolFactory ?? createReleaseLedgerPool)(config.databaseUrl!, manifest.runtime.manifestHash, { size: 10, metrics: deps.metrics, role: 'read' });
      const readStore = new PostgresLedgerStore(readCandidate);
      const t3RedemptionBinding = await deriveT3RedemptionBinding(manifest.runtime, source);
      if (stopped) return;
      ledger = new LedgerService(config.network, store, source, opcodes, logger, config.ledgerWorkers, {
        readStore, metrics: deps.metrics, router: registry.DexRouter, dependencyPools: manifest.runtime.spotMarkets.map(market => market.pool),
        tokens: bindings.jettonRoots,
        jettonRoots: bindings.jettonRoots.map(root => root.master), dlmmRegistry: registry.DlmmRegistry,
        marketBindings: bindings.marketBindings, optionFactory: registry.OptionFactory, optionVault: registry.OptionVault,
        optionCodeHashes: bindings.optionCodeHashes, launchpadCodeHashes: bindings.launchpadCodeHashes,
        launchpadControllers: bindings.launchpadControllers, t3Hub: bindings.t3Hub, t3Root: bindings.t3Hub, t3RedemptionBinding,
        perpsEngine: registry.PerpsEngine, perpsEngineCodeHash: bindings.perpsEngineCodeHash,
        maxWatchedAccounts: config.ledgerMaxWatchedAccounts, maxPagesPerSync: config.ledgerMaxPagesPerSync,
        maxRelatedAccounts: config.ledgerMaxRelatedAccounts,
      });
      market = new DlmmMarketService(ledger, source, new PostgresMarketStore(candidate), bindings.marketBindings, logger, config.ledgerMaxRelatedAccounts, new PostgresMarketStore(readCandidate));
      pool = candidate; readPool = readCandidate; candidate = undefined; readCandidate = undefined; status = 'ready';
      ledger.start(); market.start(); logger.info('durable ledger ready');
      const size = () => {
        if (sizeWork || stopped) return;
        sizeWork = readPool!.query('SELECT pg_database_size(current_database())::text AS bytes')
          .then(result => { deps.metrics.gauge('ledger_database_bytes', Number(result.rows[0].bytes)); })
          .catch(() => logger.warn('ledger database size unavailable')).finally(() => { sizeWork = undefined; });
      };
      size(); sizeTimer = setInterval(size, 300_000); sizeTimer.unref();
    } catch (error) {
      status = 'unavailable';
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) logger.warn('durable ledger unavailable', { error: errorDiagnostic(error) });
      lastError = message;
      // An incompatible first-release catalog cannot be repaired by a reconnect.
      const terminal = ['Current contract ledger decoders are not qualified', 'Durable ledger catalog differs from the canonical SQL schema',
        'Durable ledger namespace differs from the release', 'Durable ledger full release identity differs',
        'Canonical compiled ledger catalog is unavailable', 'Release database search path does not match the manifest namespace',
        'Release database namespace belongs to a different manifest', 'Running compiled build changed after authentication'].includes(message)
        || ['42703', '42804', '23514'].includes(String((error as { code?: unknown })?.code));
      if (!stopped && !terminal) {
        timer = setTimeout(() => { timer = undefined; work = attempt(); }, Math.min(60_000, 2_000 * 2 ** Math.min(failures++, 5)));
        timer.unref();
      }
    } finally { for (const value of new Set([candidate, readCandidate])) if (value) await value.end().catch(() => {}); }
  };
  const requireLedger = () => { if (!ledger) throw new Error('Ledger unavailable'); return ledger; };
  return {
    ledger: () => ledger, market: () => market, readPool: () => readPool, status: () => status,
    start() { if (started || stopped || !config.databaseUrl) return; started = true; work = attempt(); },
    async stop() {
      stopped = true; clearTimeout(timer); clearInterval(sizeTimer); await work; await sizeWork;
      await market?.stop(); await ledger?.stop(); for (const value of new Set([pool, readPool])) await value?.end();
      ledger = undefined; market = undefined; pool = undefined; readPool = undefined;
      status = config.databaseUrl ? 'unavailable' : 'disabled';
    },
    registerRoutes(app) {
      // The route registrars keep their public interfaces; these delegates pick
      // up the authenticated runtime when its background connection succeeds.
      void app.register(async routes => {
        routes.addHook('onRequest', async (_request, reply) => {
          if (!ledger) return reply.code(503).send({ code: 'ledger_unavailable', error: 'Durable ledger storage is temporarily unavailable.' });
        });
        registerLedgerRoutes(routes, { page: (...args: Parameters<LedgerService['page']>) => requireLedger().page(...args),
          discoveries: (...args: Parameters<LedgerService['discoveries']>) => requireLedger().discoveries(...args) } as LedgerService);
      });
      void app.register(async routes => {
        routes.addHook('onRequest', async (_request, reply) => {
          if (!market) return reply.code(503).send({ code: 'historical_market_unavailable', error: 'Durable historical market storage is temporarily unavailable.' });
        });
        registerMarketLedgerRoutes(routes, {
          configured: (address: string) => Boolean(market?.configured(address)),
          page: (...args: Parameters<DlmmMarketService['page']>) => market!.page(...args),
        } as DlmmMarketService);
      });
      registerLedgerReadinessRoute(app, { config, metadata: { ...manifest }, get pool() { return readPool; } });
    },
  };
}
