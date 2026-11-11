export const INDEXER_SHUTDOWN_TIMEOUT_MS = 20_000;

/** One graceful drain per process; a stuck dependency cannot block replacement forever. */
export const createIndexerShutdown = (options: {
  close: () => Promise<void>;
  onFailure: (reason: 'timeout' | 'cleanup') => void;
  timeoutMs?: number;
  exit?: (code: number) => void;
}) => {
  let shutdown: Promise<void> | undefined;
  return () => {
    if (shutdown) return shutdown;
    let complete!: () => void;
    shutdown = new Promise<void>((resolve) => { complete = resolve; });
    let finished = false;
    const finish = (reason?: 'timeout' | 'cleanup') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (reason) options.onFailure(reason);
      } finally {
        complete();
        (options.exit ?? ((code) => process.exit(code)))(reason ? 1 : 0);
      }
    };
    // Keep the deadline referenced even after HTTP and worker handles have drained.
    const timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? INDEXER_SHUTDOWN_TIMEOUT_MS);
    void Promise.resolve().then(options.close).then(() => finish(), () => finish('cleanup'));
    return shutdown;
  };
};
