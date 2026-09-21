import pino from 'pino';
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

export const createLogger = (level: string, destination = 1): Logger => {
  const logger = pino({ level }, pino.destination(destination));
  return {
    info: (msg, extra) => logger.info(extra ?? {}, msg),
    error: (msg, extra) => logger.error(extra ?? {}, msg),
    warn: (msg, extra) => logger.warn(extra ?? {}, msg),
    debug: (msg, extra) => logger.debug(extra ?? {}, msg),
  };
};
