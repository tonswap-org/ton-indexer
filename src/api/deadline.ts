import type { FastifyRequest } from 'fastify';
import type { Socket } from 'node:net';
import { ChainReadError } from '../data/dataSource';

export const ROUTE_DEADLINE_MS = { getter: 5000, fresh: 18000, balances: 5000, snapshot: 10000, rpc: 5000 } as const;
// One close listener per keep-alive socket, even when many requests finish before their deadlines.
const sockets = new WeakMap<Socket, { listeners: Set<() => void>; close(): void }>();
export function requestDeadline(request: FastifyRequest, ms: number): AbortSignal {
  const controller = new AbortController(), raw = request.raw, socket = raw.socket;
  let watched = sockets.get(socket);
  if (!watched) {
    const listeners = new Set<() => void>();
    watched = { listeners, close() { [...listeners].forEach(listener => listener()); } };
    sockets.set(socket, watched); socket.once('close', watched.close);
  }
  const cleanup = () => {
    clearTimeout(timer); raw.off('aborted', closed); watched!.listeners.delete(closed);
    if (!watched!.listeners.size) { socket.off('close', watched!.close); sockets.delete(socket); }
  };
  const finish = (code: 'upstream_timeout' | 'upstream_unavailable') => { cleanup(); controller.abort(new ChainReadError(code)); };
  const closed = () => finish('upstream_unavailable');
  const timer = setTimeout(() => finish('upstream_timeout'), Math.max(0, Math.min(2_147_483_647, Number.isFinite(ms) ? ms : 0)));
  timer.unref();
  watched.listeners.add(closed); raw.once('aborted', closed);
  if (raw.aborted || socket.destroyed) closed();
  return controller.signal;
}
