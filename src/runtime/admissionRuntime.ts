import { NativeAdmissionPool, type AdmissionExecutor, type AdmissionRuntimeConfig } from '../data/admission/nativePool';
import type { RuntimeDeps } from './worker';
import { errorDiagnostic } from '../utils/logger';

type StartingExecutor = AdmissionExecutor & { start(): Promise<void> };
export function createAdmissionRuntime(deps: RuntimeDeps, options: {
  factory?: (config: AdmissionRuntimeConfig) => StartingExecutor;
} = {}) {
  const { config, registry, bindings, logger } = deps;
  let executor: StartingExecutor | undefined;
  if (registry.PerpsEngine) {
    if (config.network !== 'testnet' || !bindings.perpsEngineCodeHash || !config.perpsAdmissionArtifacts)
      throw new Error('The registered PerpsEngine requires a qualified testnet admission runtime and exact artifact pins.');
    executor = (options.factory ?? (config => new NativeAdmissionPool(config)))({ ...config.perpsAdmissionArtifacts,
      engine: registry.PerpsEngine, codeHash: bindings.perpsEngineCodeHash });
  } else if (config.perpsAdmissionArtifacts) throw new Error('Admission runtime artifacts require a registered PerpsEngine.');
  let started = false;
  return {
    executor,
    start() {
      if (started || !executor) return; started = true;
      logger.info('authenticating perps admission runtime in background');
      void executor.start().then(() => logger.info('perps admission runtime authenticated and ready'),
        error => logger.warn('perps admission runtime unavailable; retrying in background', { error: errorDiagnostic(error) }));
    },
    async stop() { await executor?.close(); },
  };
}
