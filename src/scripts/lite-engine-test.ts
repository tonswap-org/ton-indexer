import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { ADNLClientTCP } from 'adnl';
import { Codecs } from 'ton-lite-client/dist/schema';
import { TLReadBuffer, TLWriteBuffer, type TLFunction } from 'ton-tl';
import { AbortableLitePeer, BoundedLiteEngine, BoundedLiteQueryError } from '../data/boundedLiteEngine';
import { ChainReadError } from '../data/dataSource';
import { FakeLiteEngine } from './support/fakeLiteEngine';

const method: TLFunction<{}, number> = { encodeRequest: (_req, writer) => { writer.writeInt32(1); }, decodeResponse: reader => reader.readInt32() };
async function main() {
  const failing = new FakeLiteEngine(async () => { throw new Error('peer unavailable'); });
  const healthy = new FakeLiteEngine(async () => 7);
  const observations: Array<{ index: number; ok: boolean; ms: number }> = [];
  const engine = new BoundedLiteEngine([failing, healthy], undefined, (index, ok, ms) => observations.push({ index, ok, ms }));
  try {
    assert.equal(await engine.query(method, {}, { awaitSeqno: 100 }), 7);
    assert.equal(healthy.requests[0].options.awaitSeqno, 100);
    assert.equal(observations.filter(row => !row.ok).length, 1);
    healthy.ready = false;
    await assert.rejects(engine.query(method, {}), BoundedLiteQueryError);
    assert.equal(failing.requests.length, 2);
    assert.equal(engine.health()[0].open, true);
    await assert.rejects(engine.query(method, {}));
    assert.equal(failing.requests.length, 2, 'open circuit never dispatches a dead peer');
    healthy.ready = true;
    assert.equal(await engine.query(method, {}), 7);
    healthy.ready = false;
    failing.handler = async () => 9;
    await delay(2_010);
    assert.equal(await engine.query(method, {}), 9, 'one half-open probe restores a recovered peer');
    assert.equal(engine.health()[0].failures, 0);
  } finally { engine.close(); }

  const slow = new FakeLiteEngine(async () => new Promise(() => {}));
  const fast = new FakeLiteEngine(async () => 42);
  const third = new FakeLiteEngine(async () => 43);
  const hedged = new BoundedLiteEngine([slow, fast, third]);
  try {
    const start = performance.now();
    assert.equal(await hedged.query(method, {}), 42);
    assert.ok(performance.now() - start >= 700, 'unknown peer does not get an immediate hedge');
    assert.equal(slow.requests.length, 1);
    assert.equal(fast.requests.length, 1);
    assert.equal(third.requests.length, 0, 'only one extra hedge');
    await delay(0);
    assert.equal(slow.active, 0, 'winning hedge cancels the loser');
  } finally { hedged.close(); }

  const hanging = new FakeLiteEngine(async () => new Promise(() => {}));
  const aborting = new BoundedLiteEngine([hanging]);
  try {
    const controller = new AbortController();
    const pending = aborting.query(method, {}, { signal: controller.signal });
    await delay(10); controller.abort(new ChainReadError('upstream_timeout'));
    await assert.rejects(pending, ChainReadError);
    await delay(0);
    assert.equal(hanging.active, 0);
    assert.equal(hanging.requests.length, 1);
    await delay(20);
    assert.equal(hanging.requests.length, 1, 'abort cannot start another attempt');
  } finally { aborting.close(); }

  const primary = new FakeLiteEngine(async () => new Promise(() => {}));
  const secondary = new FakeLiteEngine(async () => new Promise(() => {}));
  const limited = new BoundedLiteEngine([primary, secondary]);
  const controller = new AbortController();
  try {
    const calls = Array.from({ length: 12 }, () => limited.query(method, {}, { signal: controller.signal }));
    const settled = Promise.allSettled(calls);
    await delay(900);
    assert.equal(primary.requests.length, 12);
    assert.equal(secondary.requests.length, 8, 'global hedge count is bounded across independent requests');
    controller.abort(); await settled; await delay(0);
    assert.equal(primary.active + secondary.active, 0);
  } finally { controller.abort(); limited.close(); }

  const uncertain = new FakeLiteEngine(async () => { throw new Error('connection lost after write'); });
  const duplicate = new FakeLiteEngine(async () => 1);
  const submitter = new BoundedLiteEngine([uncertain, duplicate]);
  try {
    await assert.rejects(submitter.query(method, { kind: 'liteServer.sendMessage' }));
    assert.equal(uncertain.requests.length, 1);
    assert.equal(duplicate.requests.length, 0, 'a submission is never hedged or automatically repeated');
  } finally { submitter.close(); }

  class Transport extends EventEmitter {
    packets: Buffer[] = [];
    ended = false;
    async connect() { queueMicrotask(() => this.emit('ready')); }
    write(packet: Buffer) { this.packets.push(packet); }
    end() { this.ended = true; this.emit('close'); }
    reply(index: number, value: number) {
      const request = Codecs.adnl_Message.decode(new TLReadBuffer(this.packets[index]));
      assert.equal(request.kind, 'adnl.message.query'); if (request.kind !== 'adnl.message.query') throw new Error('query expected');
      const data = new TLWriteBuffer(); data.writeInt32(value);
      const packet = new TLWriteBuffer(); Codecs.adnl_Message.encode({ kind: 'adnl.message.answer', queryId: request.queryId, answer: data.build() }, packet);
      this.emit('data', packet.build());
    }
  }
  const transport = new Transport();
  const native = new AbortableLitePeer('tcp://127.0.0.1:1', Buffer.alloc(32), () => transport as unknown as ADNLClientTCP);
  await delay(0);
  try {
    const controller = new AbortController();
    const cancelled = native.query(method, {}, { signal: controller.signal, timeout: 5_000, awaitSeqno: 100 });
    const live = native.query(method, {}, { timeout: 100 });
    controller.abort(new ChainReadError('upstream_timeout'));
    await assert.rejects(cancelled, ChainReadError);
    transport.reply(0, 99); // Late answer to the removed query must have no effect.
    transport.reply(1, 42);
    assert.equal(await live, 42, 'cancelling one real ADNL query does not disconnect another');
    assert.equal(transport.ended, false);
    await assert.rejects(native.query(method, {}, { timeout: 5 }), ChainReadError);
    const pending = native.query(method, {}, { timeout: 5_000 });
    native.close();
    await assert.rejects(pending, /closed/);
    assert.equal(transport.ended, true);
    assert.equal(native.isClosed(), true);
  } finally { native.close(); }
  console.log('Lite engine: health ordering, circuit exclusion, delayed single hedge, cancellation and owned ADNL lifecycle passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
