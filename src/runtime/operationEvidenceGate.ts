/** A shared live-work limit, cancellation and shutdown boundary. Results are
 * never retained after completion; each operation observes the current chain. */
export function createOperationEvidenceGate(timeoutMs = 20_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw Error('Invalid evidence deadline');
  const active = new Map<AbortController, Promise<unknown>>();
  let closed = false;
  return {
    async run<T>(job: (signal: AbortSignal) => Promise<T>, unavailable: () => Error, signal?: AbortSignal): Promise<T> {
      if (closed || active.size >= 2) throw unavailable();
      const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException('Operation evidence deadline', 'TimeoutError')), timeoutMs); timer.unref();
      const pending = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return job(controller.signal); });
      active.set(controller, pending);
      try { const result = await pending; controller.signal.throwIfAborted(); return result; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller); }
    },
    async stop() {
      closed = true;
      for (const controller of active.keys()) controller.abort(new DOMException('Operation service stopped', 'AbortError'));
      await Promise.allSettled(active.values());
    },
  };
}
