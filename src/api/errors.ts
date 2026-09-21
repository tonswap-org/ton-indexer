import { FastifyReply } from 'fastify';
import { AdmissionError, AdmissionErrorCode } from '../data/admission/protocol';

export type ErrorCode = AdmissionErrorCode
  | 'balance_unavailable'
  | 'invalid_address'
  | 'invalid_cursor'
  | 'cursor_mismatch'
  | 'invalid_method'
  | 'invalid_stack'
  | 'rate_limited'
  | 'shutting_down'
  | 'metrics_disabled'
  | 'snapshot_disabled'
  | 'debug_disabled'
  | 'unauthorized'
  | 'not_found'
  | 'history_source_timeout'
  | 'bad_request';

export const sendError = (reply: FastifyReply, status: number, code: ErrorCode, message: string) => {
  return reply.status(status).send({ error: message, code });
};

export const publicErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message === 'timeout') {
    return 'request timed out';
  }
  return fallback;
};

/** Only locally created typed admission failures cross the public boundary.
 * Upstream text, process output and proof bytes are never exposed as errors. */
export const publicAdmissionError = (error: unknown) => {
  if (!(error instanceof AdmissionError)) return null;
  const status = error.code === 'admission_invalid_request' ? 400 :
    error.code === 'admission_timeout' ? 504 :
    error.code === 'admission_busy' || error.code === 'admission_unavailable' ? 503 : 502;
  return { status, code: error.code, message: error.code };
};
