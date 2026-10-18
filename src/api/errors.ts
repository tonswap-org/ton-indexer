import { FastifyInstance, FastifyReply } from 'fastify';
import { AdmissionError, AdmissionErrorCode } from '../data/admission/protocol';
import { ChainReadError } from '../data/dataSource';
import { FreshReadUnavailableError } from '../data/freshRead';

export type ErrorCode = AdmissionErrorCode
  | 'upstream_timeout' | 'upstream_unavailable' | 'indexer_unavailable' | 'ledger_unavailable' | 'internal_error'
  | 'invalid_address'
  | 'head_mismatch'
  | 'release_mismatch'
  | 'invalid_cursor'
  | 'cursor_mismatch'
  | 'invalid_method'
  | 'invalid_stack'
  | 'invalid_fresh_read'
  | 'rate_limited'
  | 'shutting_down'
  | 'metrics_disabled'
  | 'snapshot_disabled'
  | 'debug_disabled'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request';

const retryDefault = (status: number): number | null => status === 503 ? 2 : status === 429 || status === 504 ? 1 : null;
export const sendError = (reply: FastifyReply, status: number, code: ErrorCode, message: string,
  options: { retryAfterSeconds?: number } = {}) => {
  const fallback = retryDefault(status);
  reply.header('cache-control', 'no-store');
  if (fallback !== null) reply.header('retry-after', Number.isFinite(options.retryAfterSeconds)
    ? Math.max(1, Math.ceil(options.retryAfterSeconds!)) : fallback);
  return reply.status(status).send({ error: message, code });
};

export const PROXY_ERROR_BODY = { error: 'The indexer is temporarily unavailable.', code: 'indexer_unavailable' } as const;

export function sendFailure(reply: FastifyReply, error: unknown, fallback: { code: ErrorCode; message: string }): FastifyReply {
  if (error instanceof FreshReadUnavailableError) return sendError(reply, 503, 'upstream_unavailable', fallback.message);
  if (error instanceof ChainReadError) return sendError(reply, error.code === 'upstream_timeout' ? 504 : 503, error.code, fallback.message);
  const admission = publicAdmissionError(error);
  if (admission) return sendError(reply, admission.status, admission.code, admission.message);
  return sendError(reply, 500, 'internal_error', fallback.message);
}

const installed = new WeakSet<FastifyInstance>();
export function installErrorHandlers(app: FastifyInstance): void {
  if (installed.has(app)) return;
  installed.add(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && 'validation' in error && error.validation)
      return sendError(reply, 400, 'bad_request', 'The request is invalid.');
    const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500)
      return sendError(reply, status, 'bad_request', 'The request is invalid.');
    return sendFailure(reply, error, { code: 'internal_error', message: 'The request could not be completed.' });
  });
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'not_found', 'The requested resource was not found.'));
  app.addHook('onSend', async (_request, reply, payload) => {
    const retry = retryDefault(reply.statusCode);
    if (retry !== null) {
      if (!reply.hasHeader('retry-after')) reply.header('retry-after', retry);
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}


/** Only locally created typed admission failures cross the public boundary.
 * Upstream text, process output and proof bytes are never exposed as errors. */
export const publicAdmissionError = (error: unknown) => {
  if (!(error instanceof AdmissionError)) return null;
  const status = error.code === 'admission_invalid_request' ? 400 :
    error.code === 'admission_timeout' ? 504 :
    error.code === 'admission_busy' || error.code === 'admission_unavailable' ? 503 : 502;
  return { status, code: error.code, message: error.code };
};
