import assert from 'node:assert/strict';
import { Address, TupleItem, beginCell } from '@ton/core';
import { loadConfig } from '../config';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';

const engine = `0:${'1'.repeat(64)}`;
const governance = `0:${'2'.repeat(64)}`;
const int = (value: bigint): TupleItem => ({ type: 'int', value });
const address = (value: string): TupleItem => ({
  type: 'slice',
  cell: beginCell().storeAddress(Address.parse(value)).endCell(),
});

const makeSource = (configStack: TupleItem[], automationStack?: TupleItem[]) => {
  const calls: string[] = [];
  const source: TonDataSource = {
    network: 'localnet',
    async getMasterchainInfo() {
      return { seqno: 1 };
    },
    async getAccountState() {
      return { balance: '0' };
    },
    async getTransactions() {
      return [];
    },
    async runGetMethod(_address, method) {
      calls.push(method);
      if (method === 'engine_governance') {
        return { exitCode: 0, stack: [address(governance)] };
      }
      if (method === 'engine_enabled') {
        return { exitCode: 0, stack: [int(1n)] };
      }
      if (method === 'engine_config') {
        return { exitCode: 0, stack: configStack };
      }
      if (method === 'automation_state') {
        const current = Array.from({ length: 15 }, () => int(0n));
        current[14] = int(14n);
        return { exitCode: 0, stack: automationStack ?? current };
      }
      return null;
    },
    async getJettonBalance() {
      return null;
    },
    async getJettonMetadata() {
      return null;
    },
    async close() {
      return;
    },
  };
  return { source, calls };
};

const snapshotFor = async (configStack: TupleItem[], automationStack?: TupleItem[]) => {
  const config = { ...loadConfig(), responseCacheEnabled: false };
  const { source, calls } = makeSource(configStack, automationStack);
  const service = new IndexerService(
    config,
    new MemoryStore({ ...config, maxAddresses: 10 }),
    source,
    loadOpcodes(undefined),
    [],
  );
  return { snapshot: await service.getPerpsSnapshot(engine), calls };
};

const canonicalConfig = Array.from({ length: 33 }, () => int(0n));
canonicalConfig[9] = int(30n);

const testMarketConcurrency = async () => {
  const config = { ...loadConfig(), responseCacheEnabled: true };
  const { source } = makeSource(canonicalConfig);
  const originalGet = source.runGetMethod.bind(source);
  let releaseStatus!: () => void;
  const statusReady = new Promise<void>((resolve) => { releaseStatus = resolve; });
  const pendingMarkets = new Map<number, () => void>();
  const calls: number[] = [];
  source.runGetMethod = async (addr, method, args) => {
    if (method !== 'market_state') { await statusReady; return originalGet(addr, method, args); }
    const id = Number((args![0] as { value: bigint }).value);
    calls.push(id);
    await new Promise<void>((resolve) => pendingMarkets.set(id, resolve));
    const stack = Array.from({ length: 39 }, () => int(0n));
    stack[0] = int(1n);
    stack[37] = int(37n);
    stack[38] = int(38n);
    return { exitCode: 0, stack };
  };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(undefined), []);
  const ids = [1, 2, 3, 4, 5, 6];
  const first = service.getPerpsSnapshot(engine, { marketIds: ids });
  const shared = service.getPerpsSnapshot(engine, { marketIds: ids });
  assert.deepEqual(calls, [1, 2, 3, 4], 'Requested markets begin before metadata and use bounded concurrency');
  for (const done of pendingMarkets.values()) done();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ids, 'Concurrent identical snapshots share their wire reads');
  releaseStatus();
  for (const done of pendingMarkets.values()) done();
  const [a, b] = await Promise.all([first, shared]);
  assert.deepEqual(a.market_ids, ids);
  assert.deepEqual(b.market_ids, ids);
  assert.equal(a.markets['1'].lastFundingPayloadHash, '37');
  assert.equal(a.markets['1'].lastFundingPoolHash, '38');
  assert.equal(a.automation?.controlRequestHash, '14');
  assert.deepEqual(calls, ids);

  const app = Fastify();
  registerRoutes(app, config, service);
  for (const value of ['garbage', '0', '-1', '1.5', '1,,2', '1,garbage', '4294967296', '9007199254740993']) {
    const response = await app.inject({ url: `/api/indexer/v1/perps/${engine}/snapshot?market_ids=${encodeURIComponent(value)}` });
    assert.equal(response.statusCode, 400, `Reject ${value} instead of silently scanning every market`);
  }
  assert.equal((await app.inject({ url: `/api/indexer/v1/perps/${engine}/snapshot?market_ids=1,2&max_markets=1` })).statusCode, 400);
  await app.close();
};

const testFailedReadRecovery = async () => {
  const config = { ...loadConfig(), responseCacheEnabled: true };
  const { source } = makeSource(canonicalConfig);
  const originalGet = source.runGetMethod.bind(source);
  let failing = true;
  source.runGetMethod = async (addr, method, args) => {
    if (failing) throw new Error('Liteserver query deadline exceeded');
    return originalGet(addr, method, args);
  };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(undefined), []);
  await assert.rejects(service.getPerpsSnapshot(engine), /unavailable/);
  failing = false;
  assert.equal((await service.getPerpsSnapshot(engine)).status?.feeBps, '30', 'Rejected requests never poison the in-flight cache');
};

const testRetiredMarketTupleRejected = async () => {
  const config = { ...loadConfig(), responseCacheEnabled: false };
  const { source } = makeSource(canonicalConfig);
  const originalGet = source.runGetMethod.bind(source);
  source.runGetMethod = async (addr, method, args) => {
    if (method !== 'market_state') return originalGet(addr, method, args);
    return { exitCode: 0, stack: Array.from({ length: 40 }, () => int(0n)) };
  };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(undefined), []);
  const snapshot = await service.getPerpsSnapshot(engine, { marketIds: [1] });
  assert.deepEqual(snapshot.market_ids, []);
  assert.deepEqual(snapshot.markets, {});
};

const run = async () => {
  const canonical = await snapshotFor(canonicalConfig);
  assert.equal(canonical.snapshot.status?.feeBps, '30');
  assert.ok(canonical.calls.includes('engine_config'));

  const truncated = await snapshotFor(canonicalConfig.slice(0, 32));
  assert.equal(truncated.snapshot.status?.feeBps, null);

  const extended = await snapshotFor([...canonicalConfig, int(0n)]);
  assert.equal(extended.snapshot.status?.feeBps, null);

  const retiredClmmLinked = await snapshotFor([...canonicalConfig, int(0n), int(0n), int(0n)]);
  assert.equal(retiredClmmLinked.snapshot.status?.feeBps, null);

  const retiredAutomation = await snapshotFor(canonicalConfig, Array.from({ length: 14 }, () => int(0n)));
  assert.equal(retiredAutomation.snapshot.automation, null);

  const wrongFeeType = [...canonicalConfig];
  wrongFeeType[9] = { type: 'null' };
  const wrongType = await snapshotFor(wrongFeeType);
  assert.equal(wrongType.snapshot.status?.feeBps, null);

  const outOfRangeFee = [...canonicalConfig];
  outOfRangeFee[9] = int(10_001n);
  const outOfRange = await snapshotFor(outOfRangeFee);
  assert.equal(outOfRange.snapshot.status?.feeBps, null);

  await testMarketConcurrency();
  await testRetiredMarketTupleRejected();
  await testFailedReadRecovery();
  console.log('perps snapshot ok');
};

void run();
