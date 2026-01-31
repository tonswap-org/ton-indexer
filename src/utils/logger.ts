import pino from 'pino';

export type Logger = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
};

export const createLogger = (level: string): Logger => {
  const logger = pino({ level });
  return {
    info: (msg, extra) => logger.info(extra ?? {}, msg),
    error: (msg, extra) => logger.error(extra ?? {}, msg),
    warn: (msg, extra) => logger.warn(extra ?? {}, msg),
    debug: (msg, extra) => logger.debug(extra ?? {}, msg),
  };
};
