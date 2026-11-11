import type { ServerResponse } from 'node:http';
import { isIP } from 'node:net';

export const BALANCE_STREAM_LIMITS = Object.freeze({
  connections: 128, perClient: 8, lifetimeMs: 300_000,
  pendingBytes: 256 * 1024, pendingEvents: 256, drainMs: 5_000, keepAliveMs: 15_000,
});

/** Use only the authenticated edge-or-socket identity supplied by rateLimitKey. */
export function canonicalStreamClient(value: string): string {
  if (isIP(value) !== 6) return value;
  const address = new URL(`http://[${value.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(address);
  if (!mapped) return address;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export class BalanceStreamAdmission {
  private active = 0;
  private readonly clients = new Map<string, number>();
  reserve(value: string): { release(): void } | { status: 429 | 503 } {
    const client = canonicalStreamClient(value), count = this.clients.get(client) ?? 0;
    if (count >= BALANCE_STREAM_LIMITS.perClient) return { status: 429 };
    if (this.active >= BALANCE_STREAM_LIMITS.connections) return { status: 503 };
    this.active++; this.clients.set(client, count + 1);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true; this.active--;
      const remaining = this.clients.get(client)! - 1;
      if (remaining) this.clients.set(client, remaining); else this.clients.delete(client);
    } };
  }
}

type Output = Pick<ServerResponse, 'write' | 'end' | 'destroy' | 'on' | 'off' | 'writableLength' | 'destroyed'>;

/** Stage initial events before HTTP 200; preserve order while a socket is blocked. */
export class BalanceStreamWriter {
  private queue: string[] = [];
  private queuedBytes = 0;
  private started = false;
  private blocked = false;
  private ended = false;
  private keepAlive?: NodeJS.Timeout;
  private lifetime?: NodeJS.Timeout;
  private drainTimeout?: NodeJS.Timeout;
  constructor(private readonly output: Output, private readonly onClosed: () => void) {
    output.on('close', this.onClose); output.on('error', this.onError); output.on('drain', this.onDrain);
  }
  get closed(): boolean { return this.ended; }
  event(payload: unknown): void {
    if (this.ended) return;
    try { this.write(`data: ${JSON.stringify(payload)}\n\n`); }
    catch { this.close(true); }
  }
  start(begin: () => void): void {
    if (this.ended || this.started) return;
    this.started = true;
    try {
      begin();
      if (this.ended) return;
      if (this.output.destroyed) { this.close(); return; }
      this.keepAlive = setInterval(() => this.write(': keepalive\n\n'), BALANCE_STREAM_LIMITS.keepAliveMs);
      this.lifetime = setTimeout(() => this.close(), BALANCE_STREAM_LIMITS.lifetimeMs);
      this.keepAlive.unref(); this.lifetime.unref();
      this.flush();
    } catch { this.close(true); }
  }
  close(destroy = false): void {
    if (this.ended) return;
    this.ended = true;
    const pending = this.blocked || this.queuedBytes > 0 || this.output.writableLength > 0;
    this.queue = []; this.queuedBytes = 0;
    clearInterval(this.keepAlive); clearTimeout(this.lifetime); clearTimeout(this.drainTimeout);
    this.output.off('close', this.onClose); this.output.off('error', this.onError); this.output.off('drain', this.onDrain);
    try { this.onClosed(); }
    finally {
      if (this.started && !this.output.destroyed) {
        try { if (destroy || pending) this.output.destroy(); else this.output.end(); }
        catch { this.output.destroy(); }
      }
    }
  }
  private readonly onClose = () => this.close();
  private readonly onError = () => this.close(true);
  private readonly onDrain = () => {
    this.blocked = false; clearTimeout(this.drainTimeout); this.drainTimeout = undefined; this.flush();
  };
  private write(value: string): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(value);
    if (this.queue.length >= BALANCE_STREAM_LIMITS.pendingEvents ||
        bytes + this.queuedBytes + this.output.writableLength > BALANCE_STREAM_LIMITS.pendingBytes) {
      this.close(true); return;
    }
    this.queue.push(value); this.queuedBytes += bytes; this.flush();
  }
  private flush(): void {
    if (!this.started || this.blocked || this.ended) return;
    try {
      while (this.queue.length && !this.ended) {
        const value = this.queue.shift()!; this.queuedBytes -= Buffer.byteLength(value);
        const writable = this.output.write(value);
        if (this.ended) return;
        if (!writable) {
          this.blocked = true;
          this.drainTimeout = setTimeout(() => this.close(true), BALANCE_STREAM_LIMITS.drainMs);
          this.drainTimeout.unref();
          break;
        }
      }
      if (this.output.writableLength > BALANCE_STREAM_LIMITS.pendingBytes) this.close(true);
    } catch { this.close(true); }
  }
}
