import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { get, type IncomingMessage } from 'node:http';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Address } from '@ton/core';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { BalanceStreamAdmission, BalanceStreamWriter, BALANCE_STREAM_LIMITS, canonicalStreamClient } from '../api/balanceStreamTransport';
import { BalanceStreamHub, BalanceStreamCapacityError, BALANCE_STREAM_MAX_OWNERS, BALANCE_STREAM_MAX_SUBSCRIPTIONS } from '../balances/balanceStream';
import type { BalanceSnapshot } from '../balances/balanceService';
import { fixtureHead } from './support/chainFixture';

const owner = (value: number) => `0:${value.toString(16).padStart(64, '0')}`;
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  throw Error('Balance stream cleanup did not settle');
};
function admission() {
  const capacity = new BalanceStreamAdmission(), releases: Array<() => void> = [];
  assert.equal(canonicalStreamClient('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(canonicalStreamClient('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(canonicalStreamClient('::ffff:c000:201'), '192.0.2.1');
  for (let i = 0; i < BALANCE_STREAM_LIMITS.perClient; i++) {
    const reserved = capacity.reserve(i % 2 ? '2001:db8::1' : '2001:0db8:0:0:0:0:0:1');
    assert('release' in reserved); releases.push(reserved.release);
  }
  assert.deepEqual(capacity.reserve('2001:db8::1'), { status: 429 });
  releases.pop()!(); const reused = capacity.reserve('2001:db8::1'); assert('release' in reused);
  reused.release(); reused.release(); releases.forEach(release => release());
  const full: Array<() => void> = [];
  for (let i = 0; i < BALANCE_STREAM_LIMITS.connections; i++) {
    const reserved = capacity.reserve(`192.0.2.${1 + Math.floor(i / BALANCE_STREAM_LIMITS.perClient)}`);
    assert('release' in reserved); full.push(reserved.release);
  }
  assert.deepEqual(capacity.reserve('198.51.100.1'), { status: 503 });
  full.forEach(release => release());
  const fresh = capacity.reserve('198.51.100.1'); assert('release' in fresh); fresh.release();
}

class Output extends EventEmitter {
  writableLength = 0; destroyed = false; ended = false; writable = true; fail = false; writes: string[] = [];
  write(value: string) {
    if (this.fail) throw Error('closed socket');
    this.writes.push(value);
    if (!this.writable) this.writableLength += Buffer.byteLength(value);
    return this.writable;
  }
  end() { this.ended = true; return this; }
  destroy() { this.destroyed = true; return this; }
  drain() { this.writableLength = 0; this.writable = true; this.emit('drain'); }
  asResponse() { return this as unknown as ConstructorParameters<typeof BalanceStreamWriter>[0]; }
}
function writer() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const out = new Output(); let closed = 0;
    const stream = new BalanceStreamWriter(out.asResponse(), () => closed++);
    stream.event({ type: 'subscribed' }); stream.event({ type: 'balances_snapshot' });
    assert.equal(out.writes.length, 0, 'eager snapshots stay staged before HTTP success');
    out.writable = false; stream.start(() => {});
    assert.equal(out.writes.length, 1);
    stream.event({ type: 'balances_changed' }); assert.equal(out.writes.length, 1, 'no writes while blocked');
    out.drain(); assert.deepEqual(out.writes.map(value => JSON.parse(value.slice(6)).type), ['subscribed', 'balances_snapshot', 'balances_changed']);
    mock.timers.tick(BALANCE_STREAM_LIMITS.lifetimeMs);
    assert(stream.closed); assert(out.ended); assert.equal(closed, 1);
    stream.close(); out.emit('drain'); assert.equal(closed, 1);
    assert.equal(out.listenerCount('drain'), 0); assert.equal(out.listenerCount('close'), 0);

    const slow = new Output(); slow.writable = false;
    const blocked = new BalanceStreamWriter(slow.asResponse(), () => {});
    blocked.start(() => {}); blocked.event({ amount: '1' });
    mock.timers.tick(BALANCE_STREAM_LIMITS.drainMs - 1); assert(!blocked.closed);
    mock.timers.tick(1); assert(blocked.closed); assert(slow.destroyed);

    const large = new Output(); let stagedClosed = 0, begun = false;
    const staging = new BalanceStreamWriter(large.asResponse(), () => stagedClosed++);
    staging.event({ value: '€'.repeat(Math.ceil(BALANCE_STREAM_LIMITS.pendingBytes / 3)) });
    staging.start(() => { begun = true; });
    assert(staging.closed); assert.equal(stagedClosed, 1); assert(!begun); assert(!large.destroyed);

    const queued = new Output(); queued.writable = false;
    const capped = new BalanceStreamWriter(queued.asResponse(), () => {}); capped.start(() => {});
    capped.event({ value: 'x' });
    for (let i = 0; i <= BALANCE_STREAM_LIMITS.pendingEvents; i++) capped.event({ value: i });
    assert(capped.closed); assert(queued.destroyed); assert.equal(queued.writes.length, 1);

    const broken = new Output(); broken.fail = true; let failures = 0;
    const failed = new BalanceStreamWriter(broken.asResponse(), () => failures++);
    failed.event({ type: 'subscribed' }); failed.start(() => {});
    assert(failed.closed); assert(broken.destroyed); assert.equal(failures, 1);

    const disconnect = new Output(); let disconnected = 0;
    const gone = new BalanceStreamWriter(disconnect.asResponse(), () => disconnected++);
    gone.start(() => {}); disconnect.emit('error', Error('peer reset')); gone.close();
    assert(gone.closed); assert(disconnect.destroyed); assert.equal(disconnected, 1);
  } finally { mock.timers.reset(); }
}

async function hub() {
  let subscriptions = 0, listeners = 0, reads = 0;
  const heads = { current: () => null, subscribe: () => { subscriptions++; listeners++; return () => { listeners--; }; } };
  const service = { read: async () => { reads++; throw Error('No head is available'); } };
  const streams = new BalanceStreamHub({ heads, service });
  const owners = Array.from({ length: BALANCE_STREAM_MAX_OWNERS }, (_, i) => owner(i + 1));
  const stop = streams.subscribe(owners, () => {});
  assert.throws(() => streams.subscribe([owner(1000)], () => {}), BalanceStreamCapacityError);
  const shared = streams.subscribe([Address.parse(owners[0]).toString(), owners[0]], () => {});
  assert.equal(subscriptions, 1); assert.equal(reads, 0);
  stop(); const replacement = streams.subscribe([owner(1000)], () => {});
  replacement(); shared(); assert.equal(listeners, 0);
  const same: Array<() => void> = [];
  for (let i = 0; i < BALANCE_STREAM_MAX_SUBSCRIPTIONS; i++) same.push(streams.subscribe([owner(1)], () => {}));
  assert.throws(() => streams.subscribe([owner(1)], () => {}), BalanceStreamCapacityError);
  same.forEach(close => close()); assert.equal(listeners, 0); streams.close();

  let fail = true, cleanup = 0;
  const rollback = new BalanceStreamHub({ service, heads: {
    current: () => { if (fail) throw Error('head unavailable'); return null; },
    subscribe: () => () => { cleanup++; },
  } });
  assert.throws(() => rollback.subscribe(owners, () => {}), /head unavailable/); assert.equal(cleanup, 1);
  fail = false; rollback.subscribe([owner(1000)], () => {})(); assert.equal(cleanup, 2); rollback.close();

  let syncReads = 0;
  const synchronousFailure = new BalanceStreamHub({ heads: { current: () => fixtureHead(1), subscribe: () => () => {} },
    service: { read: () => { syncReads++; throw Error('synchronous read failure'); } } });
  const stopFailures = synchronousFailure.subscribe(owners.slice(0, 16), () => {});
  await until(() => syncReads === 16); stopFailures();
  const stopRetry = synchronousFailure.subscribe([owner(1000)], () => {});
  await until(() => syncReads === 17); stopRetry(); synchronousFailure.close();

  let cachedReads = 0, cachedListeners = 0, ready = false;
  const cached = new BalanceStreamHub({ heads: {
    current: () => fixtureHead(1), subscribe: () => { cachedListeners++; return () => { cachedListeners--; }; },
  }, service: { read: async address => {
    cachedReads++;
    return { address, network: 'testnet', head_seqno: 1, head_utime: fixtureHead(1).utime, complete: true,
      assets: [{ kind: 'native', symbol: 'GRAM', decimals: 9, status: 'ok', balance_raw: '1' }] } satisfies BalanceSnapshot;
  } } });
  cached.subscribe([owner(1)], () => { ready = true; }); await until(() => ready);
  const eager = cached.subscribe([owner(1), owner(2)], () => cached.close()); eager();
  assert.equal(cachedListeners, 0, 'eager cached callbacks release the complete admitted owner set');
  assert.equal(cachedReads, 1, 'a closed eager subscriber cannot start another owner read');
}

async function routes() {
  const edgeKey = 'owned-edge-fixture-key-32-characters';
  let active = 0, disposed = 0, mode: 'normal' | 'throw' | 'oversize' = 'normal';
  const app = Fastify(), responses: IncomingMessage[] = [];
  registerRoutes(app, { network: 'testnet', edgeKey }, {} as any, undefined, undefined, undefined, undefined, undefined, undefined, {
    streams: { subscribe(_owners, sink) {
      if (mode === 'throw') throw new BalanceStreamCapacityError();
      active++;
      if (mode === 'oversize') sink({ value: 'x'.repeat(BALANCE_STREAM_LIMITS.pendingBytes) } as any);
      else sink({ type: 'balances_snapshot', address: owner(1), seq: 1, ts: 1, balances: {} } as any);
      return () => { active--; disposed++; };
    } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const open = (headers: Record<string, string> = {}) => new Promise<{ response: IncomingMessage; data: () => string }>((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port: address.port, path: `/api/indexer/v1/stream/balances?address=${owner(1)}`, headers }, response => {
      responses.push(response); let text = '';
      response.on('error', () => {}); response.on('data', data => { text += data.toString(); });
      if (response.statusCode === 200) response.once('data', () => resolve({ response, data: () => text }));
      else response.once('end', () => resolve({ response, data: () => text }));
    });
    req.once('error', reject);
  });
  try {
    const opened: Awaited<ReturnType<typeof open>>[] = [];
    for (let i = 0; i < BALANCE_STREAM_LIMITS.perClient; i++) opened.push(await open({ 'x-forwarded-for': `192.0.2.${i}`, 'x-tonswap-client-ip': `192.0.2.${i}`, 'x-tonswap-edge-key': 'forged' }));
    assert.equal(active, BALANCE_STREAM_LIMITS.perClient);
    const denied = await open(); assert.equal(denied.response.statusCode, 429);
    assert.equal(JSON.parse(denied.data()).code, 'rate_limited'); assert(Number(denied.response.headers['retry-after']) >= 1);
    assert.equal(active, BALANCE_STREAM_LIMITS.perClient);
    await until(() => opened[0].data().split('\n\n').filter(value => value.startsWith('data: ')).length === 2);
    const events = opened[0].data().split('\n\n').filter(value => value.startsWith('data: ')).map(value => JSON.parse(value.slice(6)));
    assert.deepEqual(events.map(event => event.type), ['subscribed', 'balances_snapshot']);
    opened[0].response.destroy(); await until(() => active === BALANCE_STREAM_LIMITS.perClient - 1);
    assert.equal((await open()).response.statusCode, 200);
    const trusted = await open({ 'x-tonswap-edge-key': edgeKey, 'x-tonswap-client-ip': '2001:db8::1' });
    assert.equal(trusted.response.statusCode, 200, 'authenticated edge clients have separate capacity');
    responses.forEach(response => response.destroy()); await until(() => active === 0);
    mode = 'throw';
    for (let i = 0; i < BALANCE_STREAM_LIMITS.perClient + 1; i++) assert.equal((await open()).response.statusCode, 503);
    mode = 'oversize'; const before = disposed;
    assert.equal((await open()).response.statusCode, 503); assert.equal(active, 0); assert.equal(disposed, before + 1, 'eager rejection consumes the returned disposer');
    mode = 'normal'; assert.equal((await open()).response.statusCode, 200);
    await app.close(); assert.equal(active, 0, 'shutdown releases subscriptions and admission');
  } finally { responses.forEach(response => response.destroy()); await app.close(); }
}

async function main() {
  admission(); writer(); await hub(); await routes();
  console.log('Balance stream admission, owner caps, byte/event/drain/lifetime bounds, eager setup rollback and HTTP cleanup passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
