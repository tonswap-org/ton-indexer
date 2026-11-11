import { ChainReadError, type ChainHead, type ChainSource } from '../data/dataSource';

type Reuse = { maxAgeMs: number; account?: string };
export type SnapshotReadOptions<T extends object> = {
  key: string; deadlineMs: number; signal?: AbortSignal; reuse?: Reuse;
  load: (context: {head: ChainHead; signal: AbortSignal}) => Promise<T>;
};
export type SnapshotReader = { read<T extends object>(options: SnapshotReadOptions<T>): Promise<T & {asOfSeqno: number}> };
type CacheEntry = { value: object & {asOfSeqno: number}; savedAt: number; account?: string; pointer?: string };
type Flight = { controller: AbortController; expiresAt: number; users: number; settled: boolean; reuse?: Reuse;
  promise: Promise<object & {asOfSeqno: number}> };
const MAX_ENTRIES = 128;
const aborted = (signal: AbortSignal) => signal.reason instanceof ChainReadError ? signal.reason
  : new ChainReadError(signal.reason?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unavailable', {cause: signal.reason});

/** Completed reuse is explicit. In-flight loads, cached values and timers are
 * bounded; cancelling the last waiter aborts the underlying chain work. */
export function createSnapshotReader(source: ChainSource): SnapshotReader {
  const flights = new Map<string, Flight>(), cache = new Map<string, CacheEntry>();
  const fresh = (entry: CacheEntry | undefined, reuse: Reuse | undefined) => Boolean(entry && reuse &&
    entry.account === reuse.account && Date.now() - entry.savedAt >= 0 && Date.now() - entry.savedAt < reuse.maxAgeMs);
  const remember = (key: string, entry: CacheEntry) => {
    cache.delete(key); cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  };
  function consume<T extends object>(flight: Flight, options: SnapshotReadOptions<T>): Promise<T & {asOfSeqno: number}> {
    flight.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return false;
        done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
        flight.users--;
        if (!flight.users && !flight.settled) flight.controller.abort(new ChainReadError('upstream_unavailable'));
        return true;
      };
      const cancel = () => {const reason = aborted(options.signal!); if (cleanup()) reject(reason);};
      const timer = setTimeout(() => {if (cleanup()) reject(new ChainReadError('upstream_timeout'));}, options.deadlineMs);
      options.signal?.addEventListener('abort', cancel, {once:true});
      flight.promise.then(value => {if (cleanup()) resolve(value as T & {asOfSeqno:number});}, error => {if (cleanup()) reject(error);});
      if (options.signal?.aborted) cancel();
    });
  }
  return {
    async read<T extends object>(options: SnapshotReadOptions<T>): Promise<T & {asOfSeqno:number}> {
      if (options.signal?.aborted) throw aborted(options.signal);
      if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0 || options.deadlineMs > 2_147_483_647)
        throw new ChainReadError('upstream_timeout');
      if (!options.key || options.key.length > 4096 || options.reuse && (!Number.isFinite(options.reuse.maxAgeMs) || options.reuse.maxAgeMs < 0))
        throw new TypeError('Invalid snapshot reader options');
      let flight = flights.get(options.key);
      if (flight && (flight.controller.signal.aborted || flight.expiresAt <= Date.now())) {
        flight.controller.abort(new ChainReadError('upstream_timeout')); flights.delete(options.key); flight = undefined;
      }
      if (flight) {
        // A caller demanding a fresh value cannot receive another caller's
        // optional cached result. Otherwise choose the stricter reuse age.
        if (!options.reuse || !flight.reuse || options.reuse.account !== flight.reuse.account) flight.reuse = undefined;
        else flight.reuse.maxAgeMs = Math.min(flight.reuse.maxAgeMs, options.reuse.maxAgeMs);
        return consume(flight, options);
      }
      const cached = cache.get(options.key);
      if (fresh(cached, options.reuse) && !options.reuse!.account) {
        remember(options.key, cached!); return cached!.value as T & {asOfSeqno:number};
      }
      if (flights.size >= MAX_ENTRIES) throw new ChainReadError('upstream_unavailable');
      const controller = new AbortController();
      flight = {controller, expiresAt: Date.now()+options.deadlineMs, users:0, settled:false,
        reuse: options.reuse ? {...options.reuse} : undefined, promise: undefined!};
      const current = flight;
      // Install the entry before the microtask starts source work, so all
      // concurrent callers join the same pinned-head load.
      flights.set(options.key, current);
      current.promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => controller.abort(new ChainReadError('upstream_timeout')), options.deadlineMs);
        const finish = () => {
          current.settled = true; clearTimeout(timeout); controller.signal.removeEventListener('abort', cancel);
          if (flights.get(options.key) === current) flights.delete(options.key);
        };
        const cancel = () => {finish(); reject(aborted(controller.signal));};
        controller.signal.addEventListener('abort', cancel, {once:true});
        void Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          const head = await source.head({signal:controller.signal});
          controller.signal.throwIfAborted();
          const account = current.reuse?.account;
          const state = account ? await source.getAccountState(account,{at:head,signal:controller.signal}) : undefined;
          controller.signal.throwIfAborted();
          const pointer = state ? JSON.stringify([state.lastTxLt ?? null,state.lastTxHash ?? null]) : undefined;
          if (fresh(cached,current.reuse) && current.reuse?.account === account && cached!.pointer === pointer) {
            remember(options.key,cached!); return cached!.value;
          }
          const value = {...await options.load({head,signal:controller.signal}),asOfSeqno:head.seqno};
          controller.signal.throwIfAborted();
          if (current.reuse && current.reuse.account === account) remember(options.key,{value,savedAt:Date.now(),account,pointer});
          return value;
        }).then(value=>{if(!current.settled){finish();resolve(value);}},error=>{if(!current.settled){finish();reject(error);}});
      });
      return consume(current, options);
    },
  };
}
