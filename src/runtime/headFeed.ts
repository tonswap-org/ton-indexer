import type { ChainHead, ChainSource } from '../data/dataSource';

export interface HeadFeed { current(): ChainHead | null; subscribe(listener: (head: ChainHead) => void): () => void }

/** Polling begins with the first subscriber, after the listener is up. */
export function createHeadFeed(source: ChainSource, intervalMs: number, onError: (error: unknown) => void): HeadFeed & { stop(): void } {
  const listeners = new Set<(head: ChainHead) => void>();
  let value: ChainHead | null = null, stopped = false;
  let timer: NodeJS.Timeout | undefined, inFlight = false;
  const controller = new AbortController();
  async function poll() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const head = await source.head({ signal: controller.signal });
      if (!stopped && (!value || head.seqno > value.seqno)) {
        value = head;
        for (const listener of listeners) { try { listener(head); } catch (error) { onError(error); } }
      }
    } catch (error) { if (!stopped) onError(error); }
    finally { inFlight = false; }
  }
  return {
    current: () => value,
    subscribe(listener) {
      if (stopped) return () => {};
      listeners.add(listener);
      if (!timer) { timer = setInterval(() => { void poll(); }, intervalMs); timer.unref(); void poll(); }
      if (value) listener(value);
      return () => { listeners.delete(listener); };
    },
    stop() { stopped = true; clearInterval(timer); listeners.clear(); controller.abort(); },
  };
}
