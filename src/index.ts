import fastify from 'fastify';
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
import { BackfillWorker } from './workers/backfillWorker';
import { BlockFollower } from './workers/blockFollower';
import { MetricsService } from './metrics';
import { MetricsCollector } from './metricsCollector';
import { loadSnapshotFile, saveSnapshotFile } from './snapshot';
import { SnapshotService } from './snapshotService';
import { AdminGuard } from './api/admin';
import { DebugService } from './debugService';
import { RateLimiter } from './api/rateLimit';
import { PoolTracker } from './poolTracker';

const MAINNET_PLACEHOLDER_PREFIX = 'REPLACE_WITH_MAINNET_';
const REQUIRED_MAINNET_REGISTRY_KEYS = [
  'ClmmRouter',
  'ClmmPoolFactory',
  'FeeRouter',
  'Treasury',
  'ReferralRegistry',
  'T3Root',
  'TSRoot',
  'UsdtRoot',
  'UsdcRoot',
  'KusdRoot',
  'DlmmRegistry',
  'DlmmPoolFactory'
] as const;

const isLikelyTonAddress = (value: string) =>
  /^([A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/.test(value.trim());

const validateMainnetRegistry = (registry: Record<string, string>) => {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const key of REQUIRED_MAINNET_REGISTRY_KEYS) {
    const value = registry[key];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed.startsWith(MAINNET_PLACEHOLDER_PREFIX)) {
      missing.push(key);
      continue;
    }
    if (!isLikelyTonAddress(trimmed)) {
      invalid.push(key);
    }
  }
  if (!missing.length && !invalid.length) return;
  const parts: string[] = [];
  if (missing.length) parts.push(`missing/placeholder keys: ${missing.join(', ')}`);
  if (invalid.length) parts.push(`invalid address format keys: ${invalid.join(', ')}`);
  throw new Error(`Mainnet registry validation failed: ${parts.join(' | ')}`);
};

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

const start = async () => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  let registry: Record<string, string> = {};
  try {
    registry = readRegistryFile(config.registryPath);
  } catch (error) {
    if (config.mode === 'production') {
      throw error;
    }
    logger.warn('registry load failed', { error: (error as Error).message });
  }

  if (config.mode === 'production' && config.adminEnabled && !config.adminToken) {
    throw new Error('ADMIN_TOKEN is required when INDEXER_MODE=production and ADMIN_ENABLED=true.');
  }
  if (config.snapshotAutosaveEnabled && !config.snapshotPath) {
    throw new Error('SNAPSHOT_PATH is required when SNAPSHOT_AUTOSAVE_ENABLED=true.');
  }
  if (config.mode === 'production' && config.network === 'mainnet') {
    validateMainnetRegistry(registry);
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
      ? await LiteClientDataSource.create(config.network, config.liteserverPool)
      : await (async () => {
          const primary = await TonClient4DataSource.create(config.network, config.httpEndpoint);
          try {
            const fallback = await LiteClientDataSource.create(config.network, config.liteserverPool);
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

  const backfillWorker = new BackfillWorker(config, store, source, opcodes, logger, metricsCollector, poolTracker);
  const blockFollower = new BlockFollower(config, store, source, opcodes, logger, service, poolTracker);
  service.setBackfillEnqueue((address) => backfillWorker.enqueue(address));

  const app = fastify({ logger: false });
  if (config.corsEnabled) {
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      const allowOrigin = config.corsAllowOrigin === 'reflect' ? origin ?? '*' : config.corsAllowOrigin;
      reply.header('access-control-allow-origin', allowOrigin);
      if (config.corsAllowOrigin === 'reflect') {
        reply.header('vary', 'origin');
      }
      if (allowOrigin !== '*') {
        reply.header('access-control-allow-credentials', 'true');
      }
      reply.header('access-control-allow-methods', config.corsAllowMethods);
      reply.header('access-control-allow-headers', config.corsAllowHeaders);
      reply.header('access-control-expose-headers', config.corsExposeHeaders);
      reply.header('access-control-max-age', config.corsMaxAge);
      if (request.method === 'OPTIONS') {
        reply.status(204).send();
      }
    });
  }
  const metrics = new MetricsService(config, store, backfillWorker, service, metricsCollector);
  const snapshotService = new SnapshotService(config, store);
  const debugService = new DebugService(config, store, backfillWorker, poolTracker);
  const adminGuard = new AdminGuard(config);
  const rateLimiter = new RateLimiter(config);
  registerRoutes(app, config, service, metrics, snapshotService, adminGuard, debugService, rateLimiter, registry);
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

  const address = await app.listen({ port, host: config.host });
  logger.info('server started', { address, network: config.network, registryLoaded: Object.keys(registry).length > 0 });

  const shutdown = async () => {
    try {
      if (snapshotAutosaveTimer) clearInterval(snapshotAutosaveTimer);
      backfillWorker.stop();
      blockFollower.stop();
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
      await app.close();
    } catch (error) {
      logger.error('shutdown error', { error: (error as Error).message });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', error);
  process.exit(1);
});
