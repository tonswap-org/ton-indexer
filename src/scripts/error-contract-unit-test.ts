import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fastify, { type FastifyRequest } from 'fastify';
import { AdmissionError, type AdmissionErrorCode } from '../data/admission/protocol';
import { ChainReadError } from '../data/dataSource';
import { installErrorHandlers, PROXY_ERROR_BODY, publicAdmissionError, sendError, sendFailure } from '../api/errors';
import { requestDeadline, ROUTE_DEADLINE_MS } from '../api/deadline';

async function main() {
  const app = fastify(); installErrorHandlers(app);
  const fallback = { code: 'fresh_read_unavailable' as const, message: 'Fresh chain read unavailable.' };
  app.get('/timeout', (_request, reply) => sendFailure(reply, new ChainReadError('upstream_timeout', { cause: new Error('private upstream bytes') }), fallback));
  app.get('/unavailable', (_request, reply) => sendFailure(reply, new ChainReadError('upstream_unavailable'), fallback));
  app.get('/unknown', (_request, reply) => sendFailure(reply, new Error('private backend path /api/indexer/secret'), fallback));
  app.get('/throw', () => { throw new Error('private backend path /api/indexer/secret'); });
  app.get('/bare', (_request, reply) => reply.status(503).send({ error: 'Ledger unavailable.', code: 'ledger_unavailable' }));
  app.get('/custom-retry', (_request, reply) => sendError(reply, 429, 'rate_limited', 'Rate limit exceeded.', { retryAfterSeconds: 4.1 }));
  app.get('/existing-retry', (_request, reply) => reply.header('retry-after', '9').status(504).send({ error: 'Timed out.', code: 'upstream_timeout' }));
  app.post('/schema', { schema: { body: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } } }, () => ({ ok: true }));
  const admission: AdmissionErrorCode[] = ['admission_unavailable', 'admission_busy', 'admission_timeout', 'admission_invalid_request', 'admission_invalid_proof', 'admission_invalid_context', 'admission_worker_failure'];
  for (const code of admission) app.get(`/${code}`, (_request, reply) => sendFailure(reply, new AdmissionError(code), fallback));
  try {
    for (const [url, status, code, retry] of [
      ['/timeout', 504, 'upstream_timeout', '1'], ['/unavailable', 503, 'upstream_unavailable', '2'],
      ['/bare', 503, 'ledger_unavailable', '2'], ['/custom-retry', 429, 'rate_limited', '5'], ['/existing-retry', 504, 'upstream_timeout', '9'],
      ['/unknown', 500, 'internal_error', undefined], ['/throw', 500, 'internal_error', undefined], ['/api/indexer/private/missing', 404, 'not_found', undefined]
    ] as const) {
      const response = await app.inject(url); assert.equal(response.statusCode, status); assert.equal(response.headers['retry-after'], retry);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'error']);
      assert.equal(response.json().code, code); assert(!response.body.includes('/api/indexer')); assert(!response.body.includes('private'));
    }
    const invalid = await app.inject({ method: 'POST', url: '/schema', payload: {} });
    assert.equal(invalid.statusCode, 400); assert.deepEqual(invalid.json(), { error: 'The request is invalid.', code: 'bad_request' });
    for (const code of admission) {
      const response = await app.inject(`/${code}`), expected = publicAdmissionError(new AdmissionError(code))!;
      assert.equal(response.statusCode, expected.status); assert.deepEqual(response.json(), { error: expected.message, code });
      if (expected.status >= 503) assert(response.headers['retry-after']);
    }
    assert.deepEqual(PROXY_ERROR_BODY, { error: 'The indexer is temporarily unavailable.', code: 'indexer_unavailable' });
  } finally { await app.close(); }

  assert.deepEqual(ROUTE_DEADLINE_MS, { getter: 5000, fresh: 18000, balances: 5000, snapshot: 10000, rpc: 5000 });
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const raw = Object.assign(new EventEmitter(), { socket, aborted: false, complete: true });
  const request = { raw } as unknown as FastifyRequest;
  const timed = requestDeadline(request, 10); raw.emit('close'); // Normal request-body completion is not a client disconnect.
  assert.equal(timed.aborted, false); await delay(20); assert.equal(timed.aborted, true); assert.equal(timed.reason.code, 'upstream_timeout');
  assert.equal(socket.listenerCount('close'), 0); assert.equal(raw.listenerCount('aborted'), 0);
  const signals = Array.from({ length: 20 }, () => requestDeadline({ raw: Object.assign(new EventEmitter(), { socket, aborted: false }) } as unknown as FastifyRequest, 10_000));
  assert.equal(socket.listenerCount('close'), 1); socket.emit('close');
  assert(signals.every(signal => signal.aborted && signal.reason.code === 'upstream_unavailable')); assert.equal(socket.listenerCount('close'), 0);
  const disconnected = requestDeadline(request, 10_000); raw.emit('aborted'); assert(disconnected.aborted); assert.equal(socket.listenerCount('close'), 0);
  socket.destroyed = true; assert(requestDeadline(request, 10_000).aborted);
  console.log('error contract and request deadlines ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
