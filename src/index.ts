import { loadConfig } from './config';
import { createLogger, errorDiagnostic } from './utils/logger';
import { createIndexerShutdown } from './shutdown';
import { parseCanonicalReleaseManifest } from './config/releaseManifest';
import { loadRuntimeManifest } from './config/manifestSource';
import { createManifestSupervisor } from './manifestSupervisor';
import { launchManifestWorker } from './manifestWorker';
import { startWorker } from './runtime/worker';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const startupFailure = (error: unknown) => { logger.error('startup failed', { error: errorDiagnostic(error) }); process.exit(1); };
if (process.argv.includes('--manifest-worker')) {
  if (!process.send) startupFailure(Error('Manifest workers require the supervisor IPC channel'));
  else {
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let starting: Promise<void> | undefined;
    const shutdown = createIndexerShutdown({ close: async () => { await starting; await worker?.close(); },
      onFailure: reason => logger.error('shutdown failed', { reason }) });
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    process.once('message', (message: any) => {
      starting = (async () => {
        if (message?.type !== 'manifest-start') throw Error('Invalid manifest worker initialization');
        const config = loadConfig(), manifest = parseCanonicalReleaseManifest(message.manifest, config.network);
        worker = await startWorker(manifest, { config, logger,
          onReady: () => { process.send?.({ type: 'manifest-ready', manifestHash: manifest.runtime.manifestHash }); } });
      })();
      void starting.catch(startupFailure);
    });
    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  }
} else {
  const config = loadConfig();
  if (!config.releaseManifestSource) startupFailure(Error('INDEXER_RELEASE_MANIFEST is required'));
  else {
    const supervisor = createManifestSupervisor({ read: () => loadRuntimeManifest(config.releaseManifestSource!, config.network),
      launch: manifest => launchManifestWorker(__filename, manifest),
      onError: error => logger.error('manifest reload failed', { error: errorDiagnostic(error) }) });
    const shutdown = createIndexerShutdown({ close: () => supervisor.stop(), timeoutMs: 30_000,
      onFailure: reason => logger.error('manifest supervisor shutdown failed', { reason }) });
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    void supervisor.start().catch(startupFailure);
  }
}
