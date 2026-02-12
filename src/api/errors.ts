import { FastifyReply } from 'fastify';

export type ErrorCode =
  | 'invalid_address'
  | 'invalid_cursor'
  | 'cursor_mismatch'
  | 'invalid_method'
  | 'invalid_stack'
  | 'rate_limited'
  | 'unauthorized'
  | 'metrics_disabled'
  | 'snapshot_disabled'
  | 'debug_disabled'
  | 'bad_request';

export const sendError = (reply: FastifyReply, status: number, code: ErrorCode, message: string) => {
  return reply.status(status).send({ error: message, code });
};
