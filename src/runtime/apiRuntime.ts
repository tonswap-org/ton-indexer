import fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { MemoryStore } from '../store/memoryStore';
import { IndexerService } from '../indexerService';
import { registerRoutes } from '../api/routes';
import { installErrorHandlers } from '../api/errors';
import { createJettonWalletReader } from '../data/jettonWallet';
import { BalanceService } from '../balances/balanceService';
import { BalanceStreamHub } from '../balances/balanceStream';
import { setCorsHeaders } from '../api/cors';
import { BackfillWorker } from '../workers/backfillWorker';
import { BlockFollower } from '../workers/blockFollower';
import { MetricsService } from '../metrics';
import { MetricsCollector } from '../metricsCollector';
import { loadSnapshotFile, writeSnapshotFile } from '../snapshot';
import { SnapshotService } from '../snapshotService';
import { DebugService } from '../debugService';
import { RateLimiter } from '../api/rateLimit';
import { PoolTracker } from '../poolTracker';
import type { AdmissionExecutor } from '../data/admission/nativePool';
import type { RuntimeDeps } from './worker';
import type { LedgerRuntime } from './ledgerRuntime';

export type ApiRuntime = { app: FastifyInstance; listen(): Promise<string>; start(): void; close(): Promise<void> };
export function createApiRuntime(deps: RuntimeDeps & { ledger: LedgerRuntime; admission?: AdmissionExecutor }): ApiRuntime {
  const { config, logger, source, registry, manifest, bindings, opcodes, ledger, disk } = deps;
  const poolTracker = new PoolTracker(registry), store = new MemoryStore(config);
  if (config.snapshotPath) {
    try {
      const snapshot = loadSnapshotFile(config.snapshotPath);
      if (snapshot) { store.importSnapshot(snapshot); logger.info('snapshot loaded', { path: config.snapshotPath, entries: snapshot.entries.length }); }
    } catch (error) { logger.warn('snapshot load failed', { error: (error as Error).message }); }
  }
  const metricsCollector = new MetricsCollector();
  const service = new IndexerService(config, store, source, opcodes, bindings.jettonRoots, metricsCollector, poolTracker, { ledgerStatus: () => ledger.status(), diskState: () => disk.state() });
  if (deps.admission) service.setAdmissionExecutor(deps.admission);
  const balances = new BalanceService({ reader: createJettonWalletReader({ source, walletTemplateCodeHash: bindings.walletTemplateCodeHash }), roots: bindings.jettonRoots, network: config.network });
  const streams = new BalanceStreamHub({ service: balances, heads: deps.heads });
  const backfillWorker = new BackfillWorker(config, store, source, opcodes, logger, metricsCollector, poolTracker);
  const blockFollower = new BlockFollower(config, store, source, opcodes, logger, service, poolTracker, deps.heads);
  service.setBackfillEnqueue(address => backfillWorker.enqueue(address));
  const app = fastify({ logger: false });
  installErrorHandlers(app);
  void app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  if (config.corsEnabled) app.addHook('onRequest', async (request, reply) => {
    setCorsHeaders(request as any, reply, config);
    if (request.method === 'OPTIONS') return reply.status(204).send();
  });
  const metrics = new MetricsService(config, store, backfillWorker, service, metricsCollector, deps.metrics);
  registerRoutes(app, config, service, metrics, new SnapshotService(config, store),
    new DebugService(config, store, backfillWorker, poolTracker), new RateLimiter(config), registry, { ...manifest }, { source, balances, streams, metrics: deps.metrics, logger });
  ledger.registerRoutes(app);
  app.addHook('onRequest', async request => { (request as any).startTime = process.hrtime.bigint(); });
  app.addHook('onResponse', async request => {
    const start = (request as any).startTime as bigint | undefined;
    if (start) metricsCollector.recordRequest(Number(process.hrtime.bigint() - start) / 1_000_000);
  });
  let started = false, closed = false;
  let autosave: NodeJS.Timeout | undefined;
  let save: Promise<void> | undefined;
  const snapshot = (): Promise<void> => {
    if (save) return save;
    if (!config.snapshotPath || disk.state() !== 'ok') return Promise.resolve();
    save = (async () => {
      try { await writeSnapshotFile(config.snapshotPath!, store.exportSnapshot()); logger.info('snapshot saved', { path: config.snapshotPath }); }
      catch (error) { logger.warn('snapshot save failed', { error: (error as Error).message }); }
    })().finally(() => { save = undefined; });
    return save;
  };
  return {
    app,
    listen: () => app.listen({ port: config.port, host: config.host }),
    start() {
      if (started || closed) return; started = true;
      backfillWorker.start(); blockFollower.start();
      if (config.snapshotAutosaveEnabled && config.snapshotPath) {
        autosave = setInterval(() => { void snapshot(); }, Math.max(5_000, config.snapshotAutosaveIntervalMs)); autosave.unref();
      }
    },
    async close() {
      if (closed) return; closed = true;
      clearInterval(autosave); streams.close(); backfillWorker.stop(); blockFollower.stop();
      await app.close(); await save;
      if (config.snapshotOnExit) await snapshot();
    },
  };
}
