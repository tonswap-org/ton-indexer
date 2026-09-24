import fastify from 'fastify';
import { createIndexerShutdown } from './shutdown';
import { NativeAdmissionPool } from './data/admission/nativePool';
import helmet from '@fastify/helmet';
import { createServer } from 'node:net';
import { loadConfig, readRegistryFile } from './config';
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
import { validateMainnetRegistry } from './config/registry';
import { buildRegistryBundle, RegistryMetadata } from './config/releaseManifest';
import { Pool } from 'pg';
import { PostgresLedgerStore } from './ledger/store';
import { LedgerService } from './ledger/service';
import { registerLedgerRoutes } from './ledger/routes';
import { registerMarketLedgerRoutes } from './ledger/marketRoutes';
import { DlmmMarketService } from './ledger/marketService';
import { PostgresMarketStore } from './ledger/marketStore';

const isPortAvailable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host });
  });

const findAvailablePort = async (host: string, port: number, attempts = 20) => {
  if (port === 0) return 0;
  for (let i = 0; i < attempts; i += 1) {
    const candidate = port + i;
    if (await isPortAvailable(host, candidate)) return candidate;
  }
  throw new Error(`No available port found starting at ${port}`);
};

let admissionRuntime: NativeAdmissionPool | undefined;
const stopAdmissionDuringStartup = () => {
  void admissionRuntime?.close().finally(() => process.exit(0));
};
const start = async () => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  let registry: Record<string, string> = {};
  let registryMetadata: RegistryMetadata | undefined;
  try {
    registry = readRegistryFile(config.registryPath);
    const bundle = buildRegistryBundle(registry, config.network, config.releaseManifestPath);
    registry = bundle.contracts;
    registryMetadata = bundle.metadata;
  } catch (error) {
    if (config.mode === 'production' || config.releaseManifestPath) {
      throw error;
    }
    logger.warn('registry load failed', { error: (error as Error).message });
  }

  if (config.snapshotAutosaveEnabled && !config.snapshotPath) {
    throw new Error('SNAPSHOT_PATH is required when SNAPSHOT_AUTOSAVE_ENABLED=true.');
  }
  if (config.mode === 'production' && config.network === 'mainnet') {
    validateMainnetRegistry(registry);
  }

  if (registry.PerpsEngine) {
    if (config.network !== 'testnet' || !config.ledgerPerpsEngineCodeHash || !config.perpsAdmissionArtifacts) {
      throw new Error('The registered PerpsEngine requires a qualified testnet admission runtime and exact artifact pins.');
    }
    admissionRuntime = new NativeAdmissionPool({ ...config.perpsAdmissionArtifacts, engine: registry.PerpsEngine,
      codeHash: config.ledgerPerpsEngineCodeHash });
    process.once('SIGTERM', stopAdmissionDuringStartup);
    process.once('SIGINT', stopAdmissionDuringStartup);
    logger.info('authenticating perps admission runtime before service readiness');
    await admissionRuntime.start();
    logger.info('perps admission runtime authenticated and ready');
  } else if (config.perpsAdmissionArtifacts) {
    throw new Error('Admission runtime artifacts require a registered PerpsEngine.');
  }

  const opcodes = loadOpcodes(config.opcodesPath);
  const jettonRoots = Object.entries(registry)
    .filter(([key, value]) => key.endsWith('Root') && value && !value.startsWith('REPLACE_'))
    .map(([key, value]) => ({ master: value, symbol: key.replace(/Root$/, '') }));
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
  const ledgerPool = config.databaseUrl ? new Pool({connectionString:config.databaseUrl,max:10,connectionTimeoutMillis:10_000}) : undefined;
  const ledgerStore = ledgerPool ? new PostgresLedgerStore(ledgerPool) : undefined;
  if (ledgerStore) await ledgerStore.initialize();
  const ledger = ledgerStore ? new LedgerService(config.network, ledgerStore, source, opcodes, logger, 2, {
    jettonRoots: jettonRoots.map(root => root.master),
    dlmmRegistry: registry.DlmmRegistry,
    marketBindings: config.ledgerMarketBindings,
    optionFactory: registry.OptionFactory,
    optionVault: registry.OptionVault,
    optionCodeHashes: config.ledgerOptionsCodeHashes,
    launchpadCodeHashes: config.ledgerLaunchpadCodeHashes,
    launchpadControllers: [
      registry.SaleFactory,
      registry.VestingVault,
      ...(registryMetadata?.markets ?? []).map(market => market.sale)
    ].filter((value): value is string => Boolean(value)),
    t3Hub: registry.T3Hub,
    t3Root: registry.T3Root,
    t3RedemptionBinding: config.ledgerT3RedemptionBinding,
    perpsEngine: registry.PerpsEngine,
    perpsEngineCodeHash: config.ledgerPerpsEngineCodeHash,
    maxWatchedAccounts: config.ledgerMaxWatchedAccounts,
    maxPagesPerSync: config.ledgerMaxPagesPerSync,
    maxRelatedAccounts: config.ledgerMaxRelatedAccounts
  }) : undefined;

  if (ledger) service.setSwapLedgerReader((owner, query) => ledger.page(owner, query));

  const marketLedger = ledger && ledgerStore ? new DlmmMarketService(ledger, source, new PostgresMarketStore(ledgerStore.pool), config.ledgerMarketBindings, logger, config.ledgerMaxRelatedAccounts) : undefined;

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

  const port = await findAvailablePort(config.host, config.port);
  if (port !== config.port) {
    logger.warn('port in use, selected next available', { requested: config.port, selected: port });
  }

  backfillWorker.start();
  blockFollower.start();
  ledger?.start();
  marketLedger?.start();

  const address = await app.listen({ port, host: config.host });
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
};

start().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', error);
  await admissionRuntime?.close();
  process.exit(1);
});
