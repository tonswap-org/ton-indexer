import pino from 'pino';
import { writeSync } from 'node:fs';
import { BoundedLiteQueryError } from '../data/boundedLiteEngine';

export type Logger = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
};

/** Bounded operational evidence, without stacks or arbitrary error properties. */
export function errorDiagnostic(error: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 4) return { truncated: true };
  if (!(error instanceof Error)) return { name: 'NonError', type: typeof error };
  const text = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
  return {
    name: text(error.name, 80), message: text(error.message, 1024),
    ...(error.cause === undefined ? {} : { cause: errorDiagnostic(error.cause, depth + 1) }),
    ...(error instanceof BoundedLiteQueryError ? {
      attempts: error.attempts.slice(0, 8).map((attempt) => ({
        endpointIndex: attempt.endpointIndex, error: errorDiagnostic(attempt.cause, depth + 1),
      })),
      ...(error.attempts.length > 8 ? { attemptsTruncated: true } : {}),
    } : {}),
  };
}

/** A bounded, recoverable sink: a broken log volume must not take the worker down. */
export const createLogger = (level: string, destination: number | NodeJS.WritableStream = 1): Logger & { dropped(): number } => {
  let dropped = 0;
  const queue: string[] = [];
  let active: { fail(error: unknown): void } | undefined;
  let scheduled = false;
  const MAX_PENDING_LINES = 256;

  const schedule = () => {
    if (scheduled || active || !queue.length) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  };
  const pump = () => {
    if (active || !queue.length) return;
    const line = queue.shift()!;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) dropped += 1;
      active = undefined;
      // Stream callbacks and their paired error events finish before a new line.
      schedule();
    };
    active = { fail: finish };
    try {
      if (typeof destination !== 'number') destination.write(line, (error?: Error | null) => finish(error));
    } catch (error) { finish(error); }
  };
  if (typeof destination !== 'number') {
    // Node streams emit an error as well as invoking the write callback. Both
    // are consumed, and the one active line is counted only once.
    destination.on('error', error => { active?.fail(error); });
  }
  const logger = pino({ level }, {
    write(line: string) {
      if (typeof destination === 'number') {
        // Descriptor writes finish before a supervisor's process.exit. Catching
        // here also handles ENOSPC without an unhandled stream error event.
        try {
          const data = Buffer.from(line);
          let offset = 0;
          while (offset < data.length) {
            const written = writeSync(destination, data, offset, data.length - offset);
            if (written <= 0) throw new Error('Log destination made no progress');
            offset += written;
          }
        } catch { dropped += 1; }
        return;
      }
      if (queue.length >= MAX_PENDING_LINES) { dropped += 1; return; }
      queue.push(line);
      schedule();
    },
  });
  const log = (method: 'info' | 'error' | 'warn' | 'debug', msg: string, extra?: Record<string, unknown>) => {
    try { logger[method](extra ?? {}, msg); } catch { dropped += 1; }
  };
  return {
    info: (msg, extra) => log('info', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    debug: (msg, extra) => log('debug', msg, extra),
    dropped: () => dropped,
  };
};
