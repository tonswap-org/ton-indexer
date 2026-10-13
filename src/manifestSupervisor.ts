import { ManifestTransportError, type LoadedManifest } from './config/manifestSource';

export const MANIFEST_POLL_INTERVAL_MS = 5_000;
export type ManifestWorker = {
  ready: Promise<void>;
  exited: Promise<void>;
  stop: () => Promise<void>;
};

/** Stop the old process before starting a new release. In-flight work can never
 * mutate the next release's store, bindings, admission worker or caches. */
export function createManifestSupervisor(options: {
  read: () => Promise<LoadedManifest>;
  launch: (manifest: LoadedManifest) => ManifestWorker;
  onError: (error: unknown) => void;
  pollMs?: number;
}) {
  let worker: ManifestWorker | undefined;
  let hash: string | undefined;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | undefined;
  const stopWorker = async () => {
    const previous = worker;
    worker = undefined;
    hash = undefined;
    await previous?.stop();
  };
  const report = (error: unknown) => {
    const message = String(error);
    if (message !== lastError) options.onError(error);
    lastError = message;
  };
  const refresh = (initial = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const manifest = await options.read();
        if (stopped) return;
        if (worker && hash === manifest.runtime.manifestHash) { lastError = undefined; return; }
        await stopWorker();
        if (stopped) return;
        const next = options.launch(manifest);
        worker = next;
        hash = manifest.runtime.manifestHash;
        void next.exited.then(() => {
          if (worker === next) { worker = undefined; hash = undefined; }
        });
        // Native authentication may take minutes. Continue polling while the
        // child warms up so a changed or invalid publication can retire it.
        void next.ready.then(() => {
          if (worker === next) lastError = undefined;
        }, error => {
          if (worker !== next || stopped) return;
          report(error);
          // Keep its identity until exit: a retry must not overlap a child
          // that is still draining after startup failure.
          void next.stop().catch(report);
        });
      } catch (error) {
        if (!(error instanceof ManifestTransportError)) await stopWorker();
        if (!stopped) { report(error); if (initial) throw error; }
      }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void refresh().finally(schedule); }, options.pollMs ?? MANIFEST_POLL_INTERVAL_MS);
  };
  return {
    async start() { await refresh(true); schedule(); },
    refresh: () => refresh(),
    async stop() { stopped = true; clearTimeout(timer); await stopWorker(); await inFlight; },
  };
}
