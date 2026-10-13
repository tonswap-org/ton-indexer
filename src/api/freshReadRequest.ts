import { assertFreshReadActive, FreshReadUnavailableError } from '../data/freshRead';

/** The HTTP outcome and all source retries share one cancellation owner. */
export async function withFreshReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>, owner: AbortController, timeoutMs: number,
): Promise<T> {
  assertFreshReadActive(owner.signal);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new FreshReadUnavailableError(owner.signal.reason));
    owner.signal.addEventListener('abort', abort, { once: true });
  });
  const timer = setTimeout(() => owner.abort(new Error('Fresh read request deadline exceeded.')), timeoutMs);
  try {
    // Promise.race owns handlers on the still-draining source promise. Source
    // cancellation stops queued work; bounded active wires retain ownership
    // until their own transport timeout, rather than being retried after HTTP.
    const operation = Promise.resolve().then(() => {
      assertFreshReadActive(owner.signal);
      return read(owner.signal);
    });
    return await Promise.race([operation, cancelled]);
  } finally {
    clearTimeout(timer);
    owner.signal.removeEventListener('abort', abort);
  }
}
