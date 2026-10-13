import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { get, IncomingMessage } from 'node:http';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { createIndexerShutdown } from '../shutdown';
import { BalanceStreamHub } from '../balances/balanceStream';
import type { BalanceSnapshot } from '../balances/balanceService';
import { fixtureHead } from './support/chainFixture';

const addresses = [`0:${'1'.repeat(64)}`, `0:${'2'.repeat(64)}`];
const balances = (address: string): BalanceSnapshot => ({ address, head_seqno: 1, head_utime: fixtureHead().utime, assets: [{kind:'native',symbol:'GRAM',decimals:9,status:'ok',balance_raw:'0'}], complete: true, network: 'testnet' });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = async <T>(promise: Promise<T>, ms = 2500): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown test deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
};
const listen = async (service: any) => {
  const app = fastify({ logger: false });
  const hub = new BalanceStreamHub({ service, heads: { current: () => fixtureHead(), subscribe: () => () => {} } });
  registerRoutes(app, { network: 'testnet' }, {} as any, undefined, undefined, undefined, undefined, undefined, undefined, {
    streams: { subscribe(owners, sink) { const stop = hub.subscribe(owners, sink); return () => { stop(); service.unsubscribed?.(); }; } },
  });
  app.addHook('onClose', async () => { hub.close(); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  return { app, port: address.port };
};
const openStream = (port: number, alias = 'stream/balances', multiple = false) => new Promise<{ response: IncomingMessage; ended: Promise<void>; text: () => string }>((resolve, reject) => {
  const query = multiple ? `addresses=${encodeURIComponent(addresses.join(','))}` : `address=${encodeURIComponent(addresses[0])}`;
  const request = get({ host: '127.0.0.1', port, path: `/api/indexer/v1/${alias}?${query}` }, (response) => {
    if (response.statusCode !== 200) { response.destroy(); reject(new Error(`unexpected status ${response.statusCode}`)); return; }
    let text = '';
    const ended = new Promise<void>((done, fail) => { response.once('end', done); response.once('error', fail); });
    response.on('data', (chunk) => { text += chunk.toString(); });
    response.once('data', () => resolve({ response, ended, text: () => text }));
  });
  request.once('error', reject);
});
const simpleService = () => ({ read: async (address: string) => balances(address) });

const testOpenStreams = async () => {
  let unsubscribed = 0;
  const { app, port } = await listen({ ...simpleService(), unsubscribed: () => { unsubscribed++; } });
  const streams = await Promise.all([openStream(port), openStream(port, 'stream/balances')]);
  try {
    assert.ok(streams.every((stream) => stream.text().includes('subscribed')));
    // Leave clients open: preClose must end these responses before HTTP close can finish.
    await bounded(Promise.all([app.close(), ...streams.map((stream) => stream.ended)]));
    assert.equal(unsubscribed, 2);
    await app.close();
    assert.equal(unsubscribed, 2);
  } finally { streams.forEach((stream) => stream.response.destroy()); await app.close(); }
};
const testPendingPoll = async () => {
  const pending = deferred<ReturnType<typeof balances>>(), queried: string[] = [], signals: AbortSignal[] = [];
  let unsubscribed = 0;
  const { app, port } = await listen({
    read: async (address: string, options: {signal: AbortSignal}) => { queried.push(address); signals.push(options.signal); return pending.promise; },
    unsubscribed: () => { unsubscribed++; },
  });
  const stream = await openStream(port, 'stream/balances', true);
  try {
    assert.deepEqual(queried, addresses);
    await bounded(Promise.all([app.close(), stream.ended]));
    assert(signals.every(signal => signal.aborted), 'closing the last subscribers cancels shared owner work');
    pending.resolve(balances(addresses[0])); await nextTurn();
    assert.deepEqual(queried, addresses, 'closed stream starts no further work');
    assert.equal(unsubscribed, 1); assert.ok(!stream.text().includes('balances_snapshot'), 'late results never publish');
  } finally { pending.resolve(balances(addresses[0])); stream.response.destroy(); await app.close(); }
};
const childMain = async (mode: string) => {
  const { app, port } = await listen(simpleService());
  const shutdown = createIndexerShutdown({
    timeoutMs: 500,
    close: async () => {
      process.send?.({ event: 'closing' });
      await app.close();
      if (mode === 'hung') await new Promise<void>(() => undefined);
      if (mode === 'failed') throw new Error('test cleanup failure');
      await delay(100);
    },
    onFailure: (reason) => process.send?.({ event: 'failure', reason }),
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.send?.({ event: 'ready', port });
};
const testSignalProcess = async (mode: 'graceful' | 'hung' | 'failed') => {
  const child = fork(__filename, ['--shutdown-child', mode], { execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = deferred<number>();
  const events: any[] = [];
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.on('message', (message: any) => {
    events.push(message);
    if (message.event === 'ready') ready.resolve(message.port);
    if (message.event === 'closing') child.kill('SIGINT');
  });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    const port = await bounded(ready.promise, 10_000);
    stream = await bounded(openStream(port));
    child.kill('SIGTERM');
    const result = await bounded(exit);
    await bounded(stream.ended);
    assert.deepEqual(result, { code: mode === 'graceful' ? 0 : 1, signal: null }, stderr);
    assert.equal(events.filter((event) => event.event === 'closing').length, 1);
    assert.deepEqual(events.filter((event) => event.event === 'failure').map((event) => event.reason), mode === 'graceful' ? [] : [mode === 'hung' ? 'timeout' : 'cleanup']);
  } finally {
    stream?.response.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
};
const testLateCleanup = async () => {
  const pending = deferred<void>();
  const exits: number[] = [];
  const failures: string[] = [];
  let calls = 0;
  const shutdown = createIndexerShutdown({ close: () => { calls++; return pending.promise; }, timeoutMs: 20, exit: (code) => { exits.push(code); }, onFailure: (reason) => { failures.push(reason); } });
  const first = shutdown();
  assert.equal(shutdown(), first);
  await first;
  pending.resolve();
  await nextTurn();
  assert.equal(calls, 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(failures, ['timeout']);
};
const main = async () => {
  if (process.argv[2] === '--shutdown-child') return childMain(process.argv[3]);
  const cases: [string, () => Promise<void>][] = [
    ['open shared balance streams drain before HTTP close', testOpenStreams],
    ['pending shared balance reads cannot publish after close', testPendingPoll],
    ['real SIGTERM with open SSE exits cleanly once', () => testSignalProcess('graceful')],
    ['real stuck cleanup exits nonzero within deadline', () => testSignalProcess('hung')],
    ['real cleanup rejection exits nonzero once', () => testSignalProcess('failed')],
    ['late completion cannot override timeout outcome', testLateCleanup],
  ];
  for (const [name, test] of cases) { await test(); console.log(`PASS ${name}`); }
  console.log(`shutdown regressions: ${cases.length}/${cases.length} passed`);
};
main().catch((error) => { console.error(error); process.exit(1); });
