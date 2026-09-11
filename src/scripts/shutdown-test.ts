import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { get, IncomingMessage } from 'node:http';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { createIndexerShutdown } from '../shutdown';

const addresses = [`0:${'1'.repeat(64)}`, `0:${'2'.repeat(64)}`];
const balances = (address: string) => ({ address, ton_raw: '0', ton: '0', assets: [], confirmed: true, updated_at: 1, network: 'testnet' });
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
  registerRoutes(app, { network: 'testnet' }, service);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  return { app, port: address.port };
};
const openStream = (port: number, alias = 'stream', multiple = false) => new Promise<{ response: IncomingMessage; ended: Promise<void>; text: () => string }>((resolve, reject) => {
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
const simpleService = () => ({ getBalances: async (address: string) => balances(address), getBalancesSignature: () => 'stable', subscribeBalanceChanges: () => () => undefined });

const testOpenStreams = async () => {
  let unsubscribed = 0;
  const { app, port } = await listen({ ...simpleService(), subscribeBalanceChanges: () => () => { unsubscribed++; } });
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
  const pending = deferred<ReturnType<typeof balances>>();
  const queried: string[] = [];
  let signatures = 0;
  let unsubscribed = 0;
  const { app, port } = await listen({
    getBalances: async (address: string) => { queried.push(address); return pending.promise; },
    getBalancesSignature: () => { signatures++; return 'stable'; },
    subscribeBalanceChanges: () => () => { unsubscribed++; },
  });
  const stream = await openStream(port, 'stream', true);
  try {
    assert.deepEqual(queried, [addresses[0]]);
    await bounded(Promise.all([app.close(), stream.ended]));
    pending.resolve(balances(addresses[0]));
    await nextTurn();
    assert.deepEqual(queried, [addresses[0]], 'closed stream must not query the next address');
    assert.equal(signatures, 0, 'late result must not be processed');
    assert.equal(unsubscribed, 1);
    assert.ok(!stream.text().includes('balances_snapshot'));
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
    ['open SSE aliases drain before HTTP close', testOpenStreams],
    ['pending balance poll cannot continue after close', testPendingPoll],
    ['real SIGTERM with open SSE exits cleanly once', () => testSignalProcess('graceful')],
    ['real stuck cleanup exits nonzero within deadline', () => testSignalProcess('hung')],
    ['real cleanup rejection exits nonzero once', () => testSignalProcess('failed')],
    ['late completion cannot override timeout outcome', testLateCleanup],
  ];
  for (const [name, test] of cases) { await test(); console.log(`PASS ${name}`); }
  console.log(`shutdown regressions: ${cases.length}/${cases.length} passed`);
};
main().catch((error) => { console.error(error); process.exit(1); });
