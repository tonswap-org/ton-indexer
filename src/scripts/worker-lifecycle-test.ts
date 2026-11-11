import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { BackfillWorker } from '../workers/backfillWorker';
import { BlockFollower } from '../workers/blockFollower';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import type { TonDataSource, RawTransaction } from '../data/dataSource';

const address = `0:${'1'.repeat(64)}`;
const raw = (lt: number): RawTransaction => ({ lt: String(lt), hash: `hash-${lt}`, utime: lt, success: true, status: 'success', outMessages: [] });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const opcodes = loadOpcodes();
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
function setup() {
  const config = { ...loadConfig(), pageSize: 2, backfillPageBatch: 1, backfillConcurrency: 1,
    backfillMaxPagesPerAddress: 10, watchlistRefreshMs: 10, blockPollMs: 10 };
  const store = new MemoryStore(config);
  store.addTransactions(address, [classifyTransaction(address, raw(10), opcodes)]);
  return { config, store };
}

test('backfill continues full pages until history is exhausted, without duplicate requests', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { config, store } = setup();
  const cursors: string[] = [], recorded: number[] = [];
  const source = { getTransactions: async (_address: string, limit: number, lt: string) => {
    assert.equal(limit, 2); cursors.push(lt);
    if (lt === '10') return [raw(10), raw(9)];
    if (lt === '9') return [raw(9), raw(8)];
    return [raw(8)];
  } } as unknown as TonDataSource;
  const worker = new BackfillWorker(config, store, source, opcodes, quiet,
    { recordBackfillBatch: (n: number) => recorded.push(n) } as any,
    { observeTransactions: (txs: RawTransaction[]) => assert(txs.length > 0) } as any);
  t.after(() => worker.stop());
  worker.enqueue(address); worker.enqueue(address);
  assert.deepEqual(worker.getStats(), { pending: 1, inflight: 0 });
  worker.start(); worker.start();
  t.mock.timers.tick(10); await flush();
  assert.deepEqual(worker.getStats(), { pending: 1, inflight: 0 }, 'A full page must schedule its continuation after leaving inFlight');
  t.mock.timers.tick(10); await flush();
  t.mock.timers.tick(10); await flush();
  assert.deepEqual(cursors, ['10', '9', '8']);
  assert.deepEqual(recorded, [2, 2, 1]);
  assert.deepEqual(store.get(address)!.txs.map(tx => tx.lt), ['10', '9', '8']);
  assert.equal(store.get(address)!.stats.historyComplete, true);
  assert.equal(store.get(address)!.stats.lastBackfillLt, '8');
  assert.deepEqual(worker.getStats(), { pending: 0, inflight: 0 });
})

test('backfill can restart after stop and releases failed work for a later retry', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { config, store } = setup();
  let calls = 0;
  const errors: string[] = [];
  const source = { getTransactions: async () => { if (++calls === 1) throw new Error('transport unavailable'); return []; } } as unknown as TonDataSource;
  const worker = new BackfillWorker(config, store, source, opcodes, { ...quiet, error: msg => errors.push(msg) });
  t.after(() => worker.stop());
  worker.start(); worker.stop(); worker.enqueue(address); worker.start();
  t.mock.timers.tick(10); await flush();
  assert.equal(calls, 1, 'Restart must register a fresh timer');
  assert.deepEqual(errors, ['backfill failed']);
  assert.deepEqual(worker.getStats(), { pending: 0, inflight: 0 });
  worker.enqueue(address); t.mock.timers.tick(10); await flush();
  assert.equal(calls, 2); assert.equal(store.get(address)!.stats.historyComplete, true);
})

test('backfill skips missing, empty, completed and capped entries without RPC', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { config, store } = setup();
  config.backfillMaxPagesPerAddress = 1;
  store.getOrCreate('empty'); store.markHistoryComplete('complete');
  let calls = 0;
  const source = { getTransactions: async () => { calls++; return []; } } as unknown as TonDataSource;
  const worker = new BackfillWorker(config, store, source, opcodes, quiet);
  t.after(() => worker.stop());
  for (const value of ['missing', 'empty', 'complete', address]) worker.enqueue(value);
  worker.start();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(10); await flush(); }
  assert.equal(calls, 0); assert.deepEqual(worker.getStats(), { pending: 0, inflight: 0 });
})

test('block follower can restart after stop without duplicate active timers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { config } = setup();
  const store = new MemoryStore(config);
  let requests = 0;
  const heads: number[] = [];
  const source = { getMasterchainInfo: async () => ({ seqno: ++requests, timestamp: requests }) } as unknown as TonDataSource;
  const service = { setMasterchainInfo: (seqno: number) => heads.push(seqno) } as any;
  const worker = new BlockFollower(config, store, source, opcodes, quiet, service);
  t.after(() => worker.stop());
  worker.start(); worker.start(); await flush(); assert.equal(requests, 1);
  worker.stop(); t.mock.timers.tick(20); await flush(); assert.equal(requests, 1);
  worker.start(); await flush(); assert.equal(requests, 2);
  t.mock.timers.tick(10); await flush(); assert.equal(requests, 3);
  assert.deepEqual(heads, [1, 2, 3]);
})
