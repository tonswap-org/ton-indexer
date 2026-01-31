import fastify from 'fastify';
import { createServer } from 'node:net';
import { loadConfig, readRegistryFile } from './config';
import { createLogger } from './utils/logger';
import { MemoryStore } from './store/memoryStore';
import { TonClient4DataSource } from './data/tonClient4Source';
import { LiteClientDataSource } from './data/liteClientSource';
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
    logger.warn('registry load failed', { error: (error as Error).message });
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
  const source =
    config.dataSource === 'lite' || config.liteserverPool
      ? await LiteClientDataSource.create(config.network, config.liteserverPool)
      : await TonClient4DataSource.create(config.network, config.httpEndpoint);
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
  registerRoutes(app, config, service, metrics, snapshotService, adminGuard, debugService, rateLimiter);

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
