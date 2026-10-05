import fastify from 'fastify';
import { createIndexerShutdown } from './shutdown';
import { NativeAdmissionPool } from './data/admission/nativePool';
import helmet from '@fastify/helmet';
import { loadConfig } from './config';
import { createLogger } from './utils/logger';
import { MemoryStore } from './store/memoryStore';
import { TonClient4DataSource } from './data/tonClient4Source';
import { LiteClientDataSource } from './data/liteClientSource';
import { ResilientTonDataSource } from './data/resilientSource';
import { loadOpcodes } from './utils/opcodes';
import { IndexerService } from './indexerService';
import { registerRoutes } from './api/routes';
import { setCorsHeaders } from './api/cors';
import { BackfillWorker } from './workers/backfillWorker';
import { BlockFollower } from './workers/blockFollower';
import { MetricsService } from './metrics';
import { MetricsCollector } from './metricsCollector';
import { loadSnapshotFile, saveSnapshotFile } from './snapshot';
import { SnapshotService } from './snapshotService';
import { DebugService } from './debugService';
import { RateLimiter } from './api/rateLimit';
import { PoolTracker } from './poolTracker';
import { parseCanonicalReleaseManifest, RegistryMetadata } from './config/releaseManifest';
import { deriveRuntimeManifestBindings } from './config/runtimeManifestBindings';
import { loadRuntimeManifest, type LoadedManifest } from './config/manifestSource';
import { createManifestSupervisor } from './manifestSupervisor';
import { launchManifestWorker } from './manifestWorker';
import { releaseSnapshotPath } from './releaseState';
import { createReleaseLedgerPool } from './ledger/releasePool';
import { deriveT3RedemptionBinding } from './ledger/runtimeT3Binding';
import { PostgresLedgerStore } from './ledger/store';
import { LedgerService } from './ledger/service';
import { registerLedgerRoutes } from './ledger/routes';
import { registerMarketLedgerRoutes } from './ledger/marketRoutes';
import { DlmmMarketService } from './ledger/marketService';
import { PostgresMarketStore } from './ledger/marketStore';

let admissionRuntime: NativeAdmissionPool | undefined;
const stopAdmissionDuringStartup = () => {
  void admissionRuntime?.close().finally(() => process.exit(0));
};
const start = async (manifest: LoadedManifest) => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const registry = manifest.contracts;
  const registryMetadata: RegistryMetadata = { ...manifest };
  const bindings = deriveRuntimeManifestBindings(manifest.runtime);
  config.snapshotPath = releaseSnapshotPath(config.snapshotPath, manifest.runtime.manifestHash);

  if (config.snapshotAutosaveEnabled && !config.snapshotPath) {
    throw new Error('SNAPSHOT_PATH is required when SNAPSHOT_AUTOSAVE_ENABLED=true.');
  }
  if (registry.PerpsEngine) {
    if (config.network !== 'testnet' || !bindings.perpsEngineCodeHash || !config.perpsAdmissionArtifacts) {
      throw new Error('The registered PerpsEngine requires a qualified testnet admission runtime and exact artifact pins.');
    }
    admissionRuntime = new NativeAdmissionPool({ ...config.perpsAdmissionArtifacts, engine: registry.PerpsEngine,
      codeHash: bindings.perpsEngineCodeHash });
    process.once('SIGTERM', stopAdmissionDuringStartup);
    process.once('SIGINT', stopAdmissionDuringStartup);
    logger.info('authenticating perps admission runtime before service readiness');
    await admissionRuntime.start();
    logger.info('perps admission runtime authenticated and ready');
  } else if (config.perpsAdmissionArtifacts) {
    throw new Error('Admission runtime artifacts require a registered PerpsEngine.');
  }

  const opcodes = loadOpcodes();
  const jettonRoots = bindings.jettonRoots;
  const poolTracker = new PoolTracker(registry);
  const store = new MemoryStore(config);
  if (config.snapshotPath) {
    try {
      const snapshot = loadSnapshotFile(config.snapshotPath);
      if (snapshot) {
        store.importSnapshot(snapshot);
        logger.info('snapshot loaded', { path: config.snapshotPath, entries: snapshot.entries.length });
      }
    } catch (error) {
      logger.warn('snapshot load failed', { error: (error as Error).message });
    }
  }
  const metricsCollector = new MetricsCollector();
  const canUseHttp = TonClient4DataSource.isAvailable();
  if (!canUseHttp && config.dataSource !== 'lite') {
    logger.warn('TonClient4 unavailable; falling back to lite client');
    config.dataSource = 'lite';
  }
  if (config.dataSource !== 'lite' && config.liteserverPool) {
    logger.info('liteserver pool configured but ignored because TON_DATASOURCE is http');
  }
  const source =
    config.dataSource === 'lite' || !canUseHttp
      ? await LiteClientDataSource.create(config.network, config.liteserverPool, logger)
      : await (async () => {
          const primary = await TonClient4DataSource.create(config.network, config.httpEndpoint);
          try {
            const fallback = await LiteClientDataSource.create(config.network, config.liteserverPool, logger);
            logger.info('enabled resilient data source', {
              primary: config.httpEndpoint ? 'http4:custom' : 'http4:auto',
              fallback: config.liteserverPool ? 'liteserver:custom' : 'liteserver:ton.org'
            });
            return new ResilientTonDataSource(primary, fallback);
          } catch (error) {
            logger.warn('lite fallback source unavailable; using http4 only', {
              error: (error as Error).message
            });
            return primary;
          }
        })();
  const service = new IndexerService(config, store, source, opcodes, jettonRoots, metricsCollector, poolTracker);
  if (admissionRuntime) service.setAdmissionExecutor(admissionRuntime);
  const t3RedemptionBinding = config.databaseUrl ? await deriveT3RedemptionBinding(manifest.runtime, source) : undefined;
  const ledgerPool = config.databaseUrl ? await createReleaseLedgerPool(config.databaseUrl, manifest.runtime.manifestHash) : undefined;
  const ledgerStore = ledgerPool ? new PostgresLedgerStore(ledgerPool) : undefined;
  if (ledgerStore) await ledgerStore.initialize();
  const ledger = ledgerStore ? new LedgerService(config.network, ledgerStore, source, opcodes, logger, 2, {
    jettonRoots: jettonRoots.map(root => root.master),
    dlmmRegistry: registry.DlmmRegistry,
    marketBindings: bindings.marketBindings,
    optionFactory: registry.OptionFactory,
    optionVault: registry.OptionVault,
    optionCodeHashes: bindings.optionCodeHashes,
    launchpadCodeHashes: bindings.launchpadCodeHashes,
    launchpadControllers: bindings.launchpadControllers,
    t3Hub: registry.T3,
    t3Root: registry.T3Root,
    t3RedemptionBinding,
    perpsEngine: registry.PerpsEngine,
    perpsEngineCodeHash: bindings.perpsEngineCodeHash,
    maxWatchedAccounts: config.ledgerMaxWatchedAccounts,
    maxPagesPerSync: config.ledgerMaxPagesPerSync,
    maxRelatedAccounts: config.ledgerMaxRelatedAccounts
  }) : undefined;

  if (ledger) service.setSwapLedgerReader((owner, query) => ledger.page(owner, query));

  const marketLedger = ledger && ledgerStore ? new DlmmMarketService(ledger, source, new PostgresMarketStore(ledgerStore.pool), bindings.marketBindings, logger, config.ledgerMaxRelatedAccounts) : undefined;

  const backfillWorker = new BackfillWorker(config, store, source, opcodes, logger, metricsCollector, poolTracker);
  const blockFollower = new BlockFollower(config, store, source, opcodes, logger, service, poolTracker);
  service.setBackfillEnqueue((address) => backfillWorker.enqueue(address));

  const app = fastify({ logger: false, trustProxy: config.trustProxy });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });
  if (config.corsEnabled) {
    app.addHook('onRequest', async (request, reply) => {
      setCorsHeaders(request as any, reply, config);
      if (request.method === 'OPTIONS') {
        reply.status(204).send();
      }
    });
  }
  const metrics = new MetricsService(config, store, backfillWorker, service, metricsCollector);
  const snapshotService = new SnapshotService(config, store);
  const debugService = new DebugService(config, store, backfillWorker, poolTracker);
  const rateLimiter = new RateLimiter(config);
  registerRoutes(
    app,
    config,
    service,
    metrics,
    snapshotService,
    debugService,
    rateLimiter,
    registry,
    registryMetadata
  );
  registerLedgerRoutes(app,ledger);
  registerMarketLedgerRoutes(app,marketLedger);
  const snapshotAutosaveTimer =
    config.snapshotAutosaveEnabled && config.snapshotPath
      ? setInterval(() => {
          try {
            const snapshot = store.exportSnapshot();
            saveSnapshotFile(config.snapshotPath as string, snapshot);
            logger.info('snapshot autosaved', { path: config.snapshotPath, entries: snapshot.entries.length });
          } catch (error) {
            logger.warn('snapshot autosave failed', { error: (error as Error).message });
          }
        }, Math.max(5_000, config.snapshotAutosaveIntervalMs))
      : null;
  snapshotAutosaveTimer?.unref?.();

  app.addHook('onRequest', async (req) => {
    (req as any).startTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req) => {
    const start = (req as any).startTime as bigint | undefined;
    if (!start) return;
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    metricsCollector.recordRequest(durationMs);
  });

  backfillWorker.start();
  blockFollower.start();
  ledger?.start();
  marketLedger?.start();

  const address = await app.listen({ port: config.port, host: config.host });
  logger.info('server started', { address, network: config.network, registryLoaded: Object.keys(registry).length > 0 });

  const shutdown = createIndexerShutdown({
    close: async () => {
      if (snapshotAutosaveTimer) clearInterval(snapshotAutosaveTimer);
      backfillWorker.stop();
      blockFollower.stop();
      // Stop accepting requests and drain SSE while ledger work finishes.
      await Promise.all([app.close(), admissionRuntime?.close(), (async () => { await marketLedger?.stop(); await ledger?.stop(); })()]);
      if (config.snapshotOnExit && config.snapshotPath) {
        try {
          const snapshot = store.exportSnapshot();
          saveSnapshotFile(config.snapshotPath, snapshot);
          logger.info('snapshot saved', { path: config.snapshotPath, entries: snapshot.entries.length });
        } catch (error) {
          logger.warn('snapshot save failed', { error: (error as Error).message });
        }
      }
      await source.close();
      await ledgerPool?.end();
    },
    onFailure: (reason) => logger.error('shutdown failed', { reason }),
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.removeListener('SIGTERM', stopAdmissionDuringStartup);
  process.removeListener('SIGINT', stopAdmissionDuringStartup);
  process.send?.({ type: 'manifest-ready', manifestHash: manifest.runtime.manifestHash });
};

const fatal = async (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', error);
  await admissionRuntime?.close();
  process.exit(1);
};

if (process.argv.includes('--manifest-worker')) {
  if (!process.send) void fatal(Error('Manifest workers require the supervisor IPC channel'));
  else {
    process.once('message', (message: any) => {
      try {
        if (message?.type !== 'manifest-start') throw Error('Invalid manifest worker initialization');
        const config = loadConfig();
        const manifest = parseCanonicalReleaseManifest(message.manifest, config.network);
        void start(manifest).catch(fatal);
      } catch (error) { void fatal(error); }
    });
    // A killed supervisor must not leave a process serving retired bindings.
    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  }
} else {
  const config = loadConfig();
  if (!config.releaseManifestSource) void fatal(Error('INDEXER_RELEASE_MANIFEST is required'));
  else {
    const logger = createLogger(config.logLevel);
    const supervisor = createManifestSupervisor({
      read: () => loadRuntimeManifest(config.releaseManifestSource!, config.network),
      launch: manifest => launchManifestWorker(__filename, manifest),
      onError: error => logger.error('manifest reload failed; worker stopped', { reason: String(error) }),
    });
    const shutdown = createIndexerShutdown({ close: () => supervisor.stop(), timeoutMs: 30_000,
      onFailure: reason => logger.error('manifest supervisor shutdown failed', { reason }) });
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    void supervisor.start().catch(fatal);
  }
}
