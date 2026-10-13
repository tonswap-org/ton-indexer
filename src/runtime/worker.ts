import type { LiteEngine } from 'ton-lite-client';
import { loadConfig, type Config } from '../config';
import { createLogger, type Logger } from '../utils/logger';
import { createDiskGuard } from '../diskGuard';
import { createRuntimeMetrics, type RuntimeMetrics } from '../runtimeMetrics';
import type { LoadedManifest } from '../config/manifestSource';
import { deriveRuntimeManifestBindings, type RuntimeManifestBindings } from '../config/runtimeManifestBindings';
import { loadOpcodes, type OpcodeSets } from '../utils/opcodes';
import type { LiteClientDataSource } from '../data/liteClientSource';
import type { LiteserverPeer } from '../data/liteserverPool';
import type { HeadFeed } from './headFeed';
import { releaseSnapshotPath } from '../releaseState';
import { createChainRuntime } from './chainRuntime';
import { createLedgerRuntime } from './ledgerRuntime';
import { createAdmissionRuntime } from './admissionRuntime';
import { createApiRuntime } from './apiRuntime';

export type RuntimeDeps = { config: Config; manifest: LoadedManifest; bindings: RuntimeManifestBindings; registry: Record<string, string>;
  source: LiteClientDataSource; heads: HeadFeed; opcodes: OpcodeSets; logger: Logger; metrics: RuntimeMetrics; disk: ReturnType<typeof createDiskGuard> };

export async function startWorker(manifest: LoadedManifest, options: {
  config?: Config; logger?: Logger; engineFactory?: (peer: LiteserverPeer) => LiteEngine;
  ledger?: Parameters<typeof createLedgerRuntime>[1]; admission?: Parameters<typeof createAdmissionRuntime>[1];
  onReady?: () => void;
} = {}) {
  const config = { ...(options.config ?? loadConfig()) }, logger = options.logger ?? createLogger(config.logLevel);
  config.snapshotPath = releaseSnapshotPath(config.snapshotPath, manifest.runtime.manifestHash);
  if (config.snapshotAutosaveEnabled && !config.snapshotPath) throw new Error('SNAPSHOT_PATH is required when SNAPSHOT_AUTOSAVE_ENABLED=true.');
  const metrics = createRuntimeMetrics();
  const bindings = deriveRuntimeManifestBindings(manifest.runtime), opcodes = loadOpcodes();
  const chain = createChainRuntime(config, logger, metrics, { engineFactory: options.engineFactory });
  const disk = createDiskGuard({ paths: [config.diskGuardPath], softFloorBytes: config.diskSoftFloorBytes, hardFloorBytes: config.diskHardFloorBytes,
    onChange: (state, path, freeBytes) => { metrics.gauge('disk_free_bytes', freeBytes); logger.info('disk state changed', { state, path, freeBytes }); } });
  const deps: RuntimeDeps = { config, manifest, registry: manifest.contracts, bindings,
    source: chain.source, heads: chain.heads, logger, metrics, disk, opcodes };
  let admission: ReturnType<typeof createAdmissionRuntime> | undefined;
  let ledger: ReturnType<typeof createLedgerRuntime> | undefined;
  let api: ReturnType<typeof createApiRuntime> | undefined;
  let stopMonitor: (() => void) | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    disk.stop(); stopMonitor?.();
    await Promise.all([api?.close(), admission?.stop(), chain.stop(), ledger?.stop()]);
  })();
  try {
    admission = createAdmissionRuntime(deps, options.admission);
    ledger = createLedgerRuntime(deps, options.ledger);
    api = createApiRuntime({ ...deps, ledger, admission: admission.executor });
    const address = await api.listen();
    logger.info('server started', { address, network: config.network, registryLoaded: Object.keys(deps.registry).length > 0 });
    options.onReady?.();
    stopMonitor = metrics.startEventLoopMonitor();
    admission.start(); ledger.start(); api.start();
    return { ...deps, api, ledger, admission, address, close };
  } catch (error) { await close(); throw error; }
}
