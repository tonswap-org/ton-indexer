import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Address, beginCell, Cell, contractAddress, loadStateInit, TupleItem } from '@ton/core';
import { loadConfig } from '../config';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';

const address = (digit: string) => `0:${digit.repeat(64)}`;
const contract = address('1');
const owner = address('2');
const pool = address('3');
const other = address('4');
const integer = (value: number | bigint): TupleItem => ({ type: 'int', value: BigInt(value) });
const integers = (...values: Array<number | bigint>) => values.map(integer);
const addr = (value: string): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(Address.parse(value)).endCell() });
const result = (stack: TupleItem[], exitCode = 0) => ({ stack, exitCode });
const argInt = (args: TupleItem[]) => args[0]?.type === 'int' ? Number(args[0].value) : -1;
const argAddress = (item: TupleItem) => {
  assert.ok(item.type === 'slice' || item.type === 'cell');
  return item.cell.beginParse().loadAddress().toRawString();
};
type Getter = NonNullable<TonDataSource['runGetMethod']>;

function fixture(getter: Getter, cache = true, roots: Array<{ master: string; symbol?: string }> = [], overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const config = { ...loadConfig(), network: 'testnet' as const, responseCacheEnabled: cache, stateCacheTtlMs: 100_000, ...overrides };
  const calls: Array<{ target: string; method: string; args: TupleItem[] }> = [];
  const source: TonDataSource = {
    network: 'testnet',
    async getMasterchainInfo() { return { seqno: 1 }; },
    async getAccountState() { return { balance: '1000000001', lastTxLt: '1', lastTxHash: 'hash1' }; },
    async getTransactions() { return []; },
    async runGetMethod(target, method, args = []) {
      calls.push({ target, method, args });
      return getter(target, method, args);
    },
    async getJettonBalance() { return null; },
    async getJettonMetadata() { return null; },
    async close() {},
  };
  const store = new MemoryStore(config);
  const service = new IndexerService(config, store, source, loadOpcodes(), roots);
  return { service, calls, store, source };
}

test('getter caches distinguish values inside nested tuple arguments', async () => {
  const { service, calls } = fixture(async (_target, _method, args = []) => {
    const outer = args[0];
    assert.equal(outer.type, 'tuple');
    if (outer.type !== 'tuple') throw new Error('expected tuple');
    const nested = outer.items[0];
    assert.equal(nested.type, 'tuple');
    return result(nested.type === 'tuple' ? nested.items : []);
  });
  const args = (value: number): TupleItem[] => [{ type: 'tuple', items: [{ type: 'tuple', items: [integer(value)] }] }];
  const first = await service.runGetMethod(contract, 'get_position', args(10));
  const second = await service.runGetMethod(contract, 'get_position', args(20));
  assert.deepEqual(first.stack, [['num', '10']]);
  assert.deepEqual(second.stack, [['num', '20']]);
  assert.deepEqual(await service.runGetMethod(contract, 'get_position', args(10)), first);
  assert.equal(calls.length, 2);
});

test('getter collapses simultaneous identical calls and retries an unavailable result', async () => {
  let release!: (value: { stack: TupleItem[]; exitCode: number } | null) => void;
  let pending = new Promise<{ stack: TupleItem[]; exitCode: number } | null>((resolve) => { release = resolve; });
  const { service, calls } = fixture(async () => pending);
  const a = service.runGetMethod(contract, 'read', [integer(1)]);
  const b = service.runGetMethod(contract, 'read', [integer(1)]);
  release(null);
  const unavailable = await Promise.allSettled([a, b]);
  assert.ok(unavailable.every((entry) => entry.status === 'rejected' && /unavailable/.test(String(entry.reason))));
  assert.equal(calls.length, 1);
  pending = Promise.resolve(result(integers(42)));
  assert.deepEqual((await service.runGetMethod(contract, 'read', [integer(1)])).stack, [['num', '42']]);
  assert.equal(calls.length, 2);
});

test('cache-disabled getter re-fetches and serializes all TON tuple item kinds', async () => {
  const cell = beginCell().storeUint(5, 3).endCell();
  const { service, calls } = fixture(async () => result([
    integer(-3), { type: 'null' }, { type: 'nan' },
    { type: 'cell', cell }, { type: 'slice', cell }, { type: 'builder', cell },
    { type: 'tuple', items: [integer(7), { type: 'null' }] },
  ], 9), false);
  const response = await service.runGetMethod(contract, 'read');
  assert.equal(response.exit_code, 9);
  assert.equal(response.gas_used, 0);
  assert.equal(response.stack.length, 7);
  assert.deepEqual(response.stack.slice(0, 3), [['num', '-3'], ['null', null], ['nan', null]]);
  assert.deepEqual(response.stack.slice(3, 6).map((entry) => entry[0]), ['cell', 'slice', 'builder']);
  assert.deepEqual(response.stack[6], ['tuple', { elements: [
    { '@type': 'tvm.stackEntryNumber', number: { '@type': 'tvm.numberDecimal', number: '7' } },
    { '@type': 'tvm.stackEntryTuple', tuple: { '@type': 'tvm.tuple', elements: [] } },
  ] }]);
  await service.runGetMethod(contract, 'read');
  assert.equal(calls.length, 2);
});

test('perps snapshot derives bounded market IDs and preserves bigint financial values', async () => {
  const { service, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'engine_governance') return result([addr(owner)]);
    if (method === 'engine_enabled') return result(integers(-1));
    if (method === 'automation_state') return result([...integers(1, 2, 3, 4, 5, 6, 7, 8, 4, 10, 11), addr(other), ...integers(13, 14)]);
    if (method === 'market_state') {
      if (argInt(args) === 2) return result([], 11);
      const market = Array.from({ length: 48 }, (_, i) => integer(i));
      market[0] = integer(-1); market[1] = addr(pool); market[8] = integer(9007199254740993123n);
      return result(market);
    }
    return null;
  });
  const snapshot = await service.getPerpsSnapshot(contract, { maxMarkets: 3 });
  assert.deepEqual(snapshot.market_ids, [1, 3]);
  assert.deepEqual(snapshot.status, { governance: owner, enabled: true });
  assert.equal(snapshot.automation?.controlAuthority, other);
  assert.equal(snapshot.markets['1'].oiCap, '9007199254740993123');
  assert.equal(snapshot.markets['1'].pool, pool);
  assert.deepEqual(calls.filter((c) => c.method === 'market_state').map((c) => argInt(c.args)), [1, 2, 3]);
  const explicit = await service.getPerpsSnapshot(contract, { marketIds: [3, 3, NaN, -1, 1.9], maxMarkets: 2 });
  assert.deepEqual(explicit.market_ids, [3, 1]);
});

test('VolIndex normalizes pools, bounds routes and tolerates missing individual getters', async () => {
  const { service, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'vol_index_config') return result([addr(owner), addr(other), addr(contract), addr(pool), { type: 'null' }, ...integers(100, 120, 300)]);
    if (method === 'vol_index_state') return result(integers(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    if (method === 'vol_index_pool_state') {
      assert.equal(argAddress(args[0]), pool);
      return result(integers(11, 12, 13, 14, 15, 16, 17, 18, 19, 20));
    }
    if (method === 'vol_index_route' && argInt(args) === 2) return result([integer(-1), integer(5), addr(pool), integer(7)]);
    return null;
  });
  const snapshot = await service.getVolIndexSnapshot(contract, { sourcePool: Address.parse(pool).toString(), routeIds: [2, 2, 1, 0, NaN] });
  assert.equal(snapshot.pool, pool);
  assert.equal(snapshot.config?.coverManager, null);
  assert.equal(snapshot.state?.lastSampleTs, '10');
  assert.equal(snapshot.pool_state?.lastSampleTs, '20');
  assert.deepEqual(snapshot.route_ids, [2]);
  assert.deepEqual(snapshot.routes['2'], { exists: true, marketId: '5', sourcePool: pool, coverPolicyId: '7' });
  assert.equal(calls.filter((c) => c.method === 'vol_index_route').length, 2);
});

test('governance snapshot loads owner lock, sorts proposals and stops on consecutive misses', async () => {
  const { service, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'governance_lock') {
      assert.equal(argAddress(args[0]), owner);
      return result(integers(500, 600, 2, 400, 1000));
    }
    const id = argInt(args);
    if (id > 2) return result([], 11);
    return result([...integers(id, 1, 1, 10, 20, 30, 40, 50, 60, 70, 80, 90), addr(pool), ...integers(100, 110)]);
  });
  const options = { owner, maxScan: 6, maxConsecutiveMisses: 2 };
  const [a, b] = await Promise.all([service.getGovernanceSnapshot(contract, options), service.getGovernanceSnapshot(contract, options)]);
  assert.strictEqual(a, b);
  assert.equal(a.lock?.weight, '1000');
  assert.deepEqual(a.proposals.map((p) => p.id), ['2', '1']);
  assert.equal(a.proposals[0].target, pool);
  assert.equal(a.scanned, 4);
  const count = calls.length;
  assert.strictEqual(await service.getGovernanceSnapshot(contract, options), a);
  assert.equal(calls.length, count);
  await service.getGovernanceSnapshot(contract, { ...options, owner: null });
  assert.equal(calls.filter((c) => c.method === 'governance_lock').length, 1);
});

test('farm snapshot honors next ID, decodes rewards and shares completed and in-flight snapshots', async () => {
  const { service, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'governance') return result([addr(owner)]);
    if (method === 'registry_enabled') return result(integers(1));
    if (method === 'next_farm_id') return result(integers(3));
    if (method === 'get_farm' && argInt(args) === 1) return result([addr(pool), addr(owner), addr(other), addr(contract), addr(other), ...integers(99, 60, 20, 100, 160, 500, 1, 99, 4, 2)]);
    return result([{ type: 'null' }]);
  });
  const [a, b] = await Promise.all([service.getFarmSnapshot(contract), service.getFarmSnapshot(contract)]);
  assert.strictEqual(a, b);
  assert.equal(a.next_id, '3');
  assert.equal(a.scanned, 2);
  assert.equal(a.farm_count, 1);
  assert.equal(a.farms[0].rewardAmount, '99');
  assert.equal(a.farms[0].rewardRoot, contract);
  assert.equal(a.farms[0].resumeBacklog, '2');
  assert.deepEqual(calls.filter((c) => c.method === 'get_farm').map((c) => argInt(c.args)), [1, 2]);
  const count = calls.length;
  assert.strictEqual(await service.getFarmSnapshot(contract), a);
  assert.equal(calls.length, count);
});

test('empty farm registry avoids scanning non-existent IDs', async () => {
  const { service, calls } = fixture(async (_target, method) => method === 'next_farm_id' ? result(integers(1)) : null);
  const snapshot = await service.getFarmSnapshot(contract);
  assert.equal(snapshot.scanned, 0);
  assert.deepEqual(snapshot.farms, []);
  assert.ok(calls.every((c) => c.method !== 'get_farm'));
});

test('options snapshot distinguishes active, expired and exhausted series and respects empty-window probes', async () => {
  const { service, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'governance') return result([addr(owner)]);
    if (method === 'registry_enabled') return result(integers(1));
    const id = argInt(args);
    if (id > 2) return result(integers(0));
    const expiry = id === 1 ? 1 : Math.floor(Date.now() / 1000) + 3600;
    return result([integer(1), integer(10), integer(20), addr(pool), integer(expiry), integer(100), integer(30), integer(40), integer(id === 2 ? 150 : 25), integer(id === 0 ? 1 : 0), integer(0), addr(other), addr(contract), ...integers(50, 60, 70, 80, 90)]);
  });
  const options = { startId: 0, maxSeriesId: 20, windowSize: 2, maxEmptyWindows: 1, minProbeWindows: 4 };
  const [a, b] = await Promise.all([service.getOptionsSnapshot(contract, options), service.getOptionsSnapshot(contract, options)]);
  assert.strictEqual(a, b);
  assert.equal(a.scanned, 8);
  assert.deepEqual(a.series.map((s) => [s.seriesId, s.isActive, s.remainingNotional]), [['0', false, '75'], ['1', false, '75'], ['2', true, '0']]);
  assert.equal(a.series[0].underlyingPool, other);
  const count = calls.length;
  assert.strictEqual(await service.getOptionsSnapshot(contract, options), a);
  assert.equal(calls.length, count);
});

test('cover snapshot scans newest policies first and filters the requested owner', async () => {
  const { service, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'get_state') return result([...integers(3, 2, 1, 0, 0, 100), addr(other), ...integers(10, 20, 30, 40, 50), addr(pool), integer(0), addr(contract), integer(99)]);
    if (method === 'registry_enabled') return result(integers(-1));
    const id = argInt(args);
    return result([integer(1), addr(id === 2 ? other : owner), addr(pool), ...integers(10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 1), addr(contract), integer(99)]);
  });
  const options = { owner, maxScan: 3 };
  const [a, b] = await Promise.all([service.getCoverSnapshot(contract, options), service.getCoverSnapshot(contract, options)]);
  assert.strictEqual(a, b);
  assert.deepEqual(a.policies.map((p) => p.id), ['3', '1']);
  assert.equal(a.scanned, 3);
  assert.equal(a.policies[0].riskBucketId, '99');
  assert.equal(a.state?.vault, pool);
  assert.equal(a.enabled, true);
  const count = calls.length;
  assert.strictEqual(await service.getCoverSnapshot(contract, options), a);
  assert.equal(calls.length, count);
});

test('zero cover policies short-circuit scans while total source failure stays retryable', async () => {
  let available = false;
  const { service, calls } = fixture(async (_target, method) => available && method === 'get_state' ? result(integers(0)) : null);
  await assert.rejects(service.getCoverSnapshot(contract, { maxScan: 2 }), /unavailable/);
  available = true;
  const before = calls.length;
  const snapshot = await service.getCoverSnapshot(contract, { maxScan: 2 });
  assert.equal(snapshot.scanned, 0);
  assert.deepEqual(snapshot.policies, []);
  assert.ok(calls.slice(before).every((c) => c.method !== 'get_policy'));
});

test('snapshot endpoints report total source unavailability instead of invented empty financial data', async () => {
  const { service } = fixture(async () => { throw new Error('upstream offline'); });
  await assert.rejects(service.getPerpsSnapshot(contract), /unavailable/);
  await assert.rejects(service.getVolIndexSnapshot(contract), /unavailable/);
  await assert.rejects(service.getGovernanceSnapshot(contract, { maxScan: 2 }), /unavailable/);
  await assert.rejects(service.getFarmSnapshot(contract, { maxScan: 2 }), /unavailable/);
  await assert.rejects(service.getOptionsSnapshot(contract, { maxSeriesId: 2 }), /unavailable/);
});

test('DLMM resolution falls back from disabled registry pools and hides undeployed pools', async () => {
  const tokens = [address('5'), address('6'), address('7')];
  const { service, calls } = fixture(async (target, method, args = []) => {
    if (method === 'pool_for') return result([integer(1), addr(other), integer(1), integer(1)]);
    if (method === 'pool_record') {
      assert.equal(argAddress(args[0]), contract);
      const token = argAddress(args[1]);
      if (token === tokens[2]) return result(integers(0));
      return result([{ type: 'tuple', items: [integer(1), addr(token === tokens[0] ? pool : other), integer(2), integer(0)] }]);
    }
    if (method === 'active_price_q64') return target === other ? result([], 11) : result(integers(-10, 99));
    if (method === 'bin_state') {
      assert.equal(argInt(args), -10);
      return result(integers(9007199254740993123n, 88));
    }
    if (method === 'wallet_code_hash') return result(integers(12345));
    return null;
  });
  const request = { t3Root: contract, dlmmRegistry: owner, dlmmFactory: other, tokens: [...tokens].reverse().concat(tokens[0], 'invalid') };
  const [a, b] = await Promise.all([service.getDlmmPoolsSnapshot(request), service.getDlmmPoolsSnapshot(request)]);
  assert.strictEqual(a, b);
  assert.deepEqual(a.pools.map((p) => p.token), tokens);
  assert.deepEqual(a.pools[0], { token: tokens[0], pool, kind: 2, status: 0, activeBinId: -10, walletCodeHash: '12345', binReserves: { reserveT: '9007199254740993123', reserveX: '88' } });
  assert.equal(a.pools[1].pool, null);
  assert.equal(a.pools[2].pool, null);
  const count = calls.length;
  assert.strictEqual(await service.getDlmmPoolsSnapshot(request), a);
  assert.equal(calls.length, count);
  await assert.rejects(service.getDlmmPoolsSnapshot({ t3Root: 'invalid', tokens: [] }), /Invalid t3Root/);
});

test('DeFi aggregation preserves usable sections when other contracts are missing or unavailable', async () => {
  const { service, calls } = fixture(async (_target, method) => {
    if (method === 'activation_status') return result(integers(800, 1000, 1, 0, 0));
    if (method === 'registry_meta') return result([], 11);
    return null;
  });
  const request = { owner: 'invalid', contracts: { activationGate: contract, dlmmRegistry: pool, t3Hub: 'bad', voting: '', farmFactory: ' ', coverManager: other }, include: { systemHealthDetailed: true }, options: { cover: { maxScan: 2, maxMisses: 1 } } };
  const [a, b] = await Promise.all([service.getDefiSnapshot(request), service.getDefiSnapshot(request)]);
  assert.strictEqual(a, b);
  assert.equal(a.owner, null);
  assert.deepEqual(a.sections.activation, { ok: true, data: { burned: '800', target: '1000', ready: true, activated: false, activatedAt: '0' } });
  for (const key of ['dlmmRegistry', 'reserveBalances', 'systemHealth', 'systemHealthDetailed', 'governance', 'farms', 'cover'] as const) {
    const section = a.sections[key];
    assert.equal(section?.ok, false, key);
    assert.equal(section?.data, null, key);
  }
  assert.deepEqual(a.sections.modules, { ok: true, data: {} });
  const count = calls.length;
  assert.strictEqual(await service.getDefiSnapshot(request), a);
  assert.equal(calls.length, count);
  const none = await service.getDefiSnapshot({ contracts: {}, include: { activation: false, dlmmRegistry: false, reserveBalances: false, systemHealth: false, systemHealthDetailed: false, modules: false, governance: false, farms: false, cover: false } });
  assert.deepEqual(none.sections, {});
  assert.equal(calls.length, count);
});

test('DeFi health decodes anchor cells, reserves, fee routing and detailed automation without losing precision', async () => {
  const anchor = beginCell().storeUint(5000, 16).storeInt(60, 32).storeInt(100, 32).storeInt(200, 32)
    .storeUint(2, 8).storeUint(1000, 64).storeBit(true).storeBit(false)
    .storeInt(9007199254740993123n, 128).storeInt(10, 128).storeInt(20, 128)
    .storeInt(30, 32).storeUint(40, 64).storeUint(50, 64).storeUint(6, 32).storeInt(70, 64).endCell();
  const { service, calls } = fixture(async (_target, method, args = []) => {
    switch (method) {
      case 'registry_meta': return result([{ type: 'tuple', items: [addr(owner), ...integers(1, 0, 1)] }]);
      case 'pool_balances': return result(integers(9007199254740993123n, 100, 200));
      case 'get_control_state': return result([addr(owner), ...integers(1, 0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19)]);
      case 'risk_state': return result(integers(10, 20, 30, 40, 50, 60));
      case 'get_router_state': return result(Array.from({ length: 15 }, (_, i) => integer(i + 100)));
      case 'router_targets': return result(Array.from({ length: 9 }, () => addr(other)));
      case 'buyback_config': return result([addr(contract), addr(owner), addr(pool), addr(other), addr(owner), ...integers(55, 66)]);
      case 'anchor_config': return result([{ type: 'tuple', items: integers(5000, 60, 100, 200, 2) }]);
      case 'anchor_state': return result([{ type: 'cell', cell: anchor }]);
      case 'cluster_guard_config': return result([addr(owner), addr(other), ...integers(60, 70, 80)]);
      case 'enabled': case 'registry_enabled': return result(integers(1));
      case 'governance': return result([addr(owner)]);
      case 'bucket_state': {
        if (argInt(args) === 3) return result([], 11);
        return result([integer(1), addr(owner), addr(pool), addr(other), ...integers(4, 5, 6, 7, 8, 9, argInt(args) + 10, 11, 12, 13, 14, 15, 0, 17)]);
      }
      case 'config': return result([addr(pool)]);
      case 'job_config': return result(integers(20, 30, 40, 50));
      case 'module': return argInt(args) === 12 ? result([], 11) : result(integers(1, 2, 3, 4, 5, 6, 7));
      case 'job': return argInt(args) === 12 ? null : result([integer(1), integer(11), addr(other), ...integers(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14), addr(owner), ...integers(16, 17, 18, 19)]);
      default: return null;
    }
  });
  const snapshot = await service.getDefiSnapshot({
    owner,
    contracts: { dlmmRegistry: contract, t3Hub: contract, controlMesh: contract, riskVault: contract, feeRouter: contract, buybackExecutor: contract, anchorGuard: contract, clusterGuard: contract, automationRegistry: contract },
    include: { activation: false, governance: false, farms: false, cover: false, systemHealthDetailed: true, moduleGovernance: true },
    modules: [{ key: ' enabled ', address: contract, governanceGetter: 'governance' }, { key: 'absent', address: other, enabledGetter: 'unsupported' }, { key: 'bad', address: 'bad' }],
  });
  const health = snapshot.sections.systemHealth;
  assert.ok(health?.ok);
  assert.equal(health.data.controlState?.governance, owner);
  assert.equal(health.data.riskState?.registryVersion, '60');
  assert.equal(health.data.feeRouterState?.referralThrottleMask, '114');
  assert.equal(health.data.feeRouterTargets?.referralRegistry, other);
  assert.equal(health.data.buybackConfig?.swapForwardValue, '66');
  assert.equal(health.data.anchorGuardState?.price, '9007199254740993123');
  assert.equal(health.data.anchorGuardState?.quorumMet, false);
  assert.equal(health.data.anchorGuardConfig?.quorumBps, '5000');
  assert.equal(health.data.anchorGuardGovernance, owner);
  assert.equal(health.data.clusterGuardConfig?.slashThreshold, '80');
  assert.deepEqual(snapshot.sections.reserveBalances, { ok: true, data: { usdt: '9007199254740993123', usdc: '100', kusd: '200' } });
  assert.deepEqual(snapshot.sections.modules, { ok: true, data: { absent: null, enabled: { enabled: true, governance: owner } } });
  const detailed = snapshot.sections.systemHealthDetailed;
  assert.ok(detailed?.ok);
  assert.equal(detailed.data.riskBucketStates[1]?.automationJobId, '11');
  assert.equal(detailed.data.riskBucketStates[3], null);
  assert.equal(detailed.data.automationModules[11]?.totalProcessed, '7');
  assert.equal(detailed.data.automationModules[12], null);
  assert.equal(detailed.data.jobQueueConfig?.maxJobs, '20');
  assert.equal(detailed.data.jobQueueJobs[11]?.target, other);
  assert.equal(detailed.data.jobQueueJobs[12], null);
  assert.deepEqual(calls.filter((c) => c.method === 'module').map((c) => argInt(c.args)), [11, 12]);
});

test('DeFi delegates bounded governance, farm and cover scans and isolates malformed anchor data', async () => {
  const { service } = fixture(async (_target, method) => {
    if (method === 'governance_proposal') return result([], 11);
    if (method === 'governance_lock') return result(integers(50, 60, 1, 2, 100));
    if (method === 'next_farm_id') return result(integers(1));
    if (method === 'get_state') return result(integers(0));
    if (method === 'anchor_state') return result([{ type: 'cell', cell: beginCell().endCell() }]);
    if (method === 'governance') return result([addr(owner)]);
    if (method === 'registry_enabled') return result(integers(1));
    return null;
  });
  const snapshot = await service.getDefiSnapshot({
    owner, contracts: { voting: contract, farmFactory: pool, coverManager: other, anchorGuard: pool },
    include: { activation: false, dlmmRegistry: false, reserveBalances: false },
    options: { governance: { maxScan: 2, maxMisses: 1 }, farms: { maxScan: 1, maxMisses: 1 }, cover: { maxScan: 1, maxMisses: 1 } },
  });
  assert.ok(snapshot.sections.governance?.ok);
  assert.equal(snapshot.sections.governance.data.scanned, 1);
  assert.equal(snapshot.sections.governance.data.lock?.amount, '50');
  assert.ok(snapshot.sections.farms?.ok);
  assert.equal(snapshot.sections.farms.data.scanned, 0);
  assert.ok(snapshot.sections.cover?.ok);
  assert.equal(snapshot.sections.cover.data.scanned, 0);
  assert.ok(snapshot.sections.systemHealth?.ok);
  assert.equal(snapshot.sections.systemHealth.data.anchorGuardState, null);
});

test('jetton payload resolves alternate wallet getter and encodes an undeployed wallet state init', async () => {
  const walletCode = beginCell().storeUint(0xface, 16).endCell();
  const { service, source, calls } = fixture(async (_target, method, args = []) => {
    if (method === 'get_wallet_address') { assert.equal(argAddress(args[0]), owner); return result([addr(pool)]); }
    if (method === 'jetton_data') return result([integer(0), integer(0), { type: 'null' }, { type: 'null' }, { type: 'cell', cell: walletCode }]);
    return result([], 11);
  });
  source.getAccountState = async (target) => { assert.equal(target, pool); return { balance: '0', accountState: 'uninitialized' }; };
  const payload = await service.getJettonTransferPayload(contract, owner);
  assert.equal(payload.custom_payload, null);
  assert.ok(payload.state_init);
  const state = loadStateInit(Cell.fromBase64(payload.state_init).beginParse());
  assert.ok(state.code?.equals(walletCode));
  const data = state.data!.beginParse();
  assert.equal(data.loadCoins(), 0n);
  assert.equal(data.loadAddress().toRawString(), owner);
  assert.equal(data.loadAddress().toRawString(), contract);
  assert.equal(data.loadCoins(), 0n);
  assert.equal(data.loadCoins(), 0n);
  assert.equal(data.loadMaybeAddress(), null);
  assert.deepEqual(calls.map((c) => c.method), ['wallet_address', 'get_wallet_address', 'get_jetton_data', 'jetton_data']);
});

test('jetton payload derives fallback wallet address, skips active wallets and handles absent code', async () => {
  const walletCode = beginCell().storeUint(33, 8).endCell();
  const { service, source } = fixture(async (_target, method) => method === 'get_jetton_data'
    ? result([integer(0), integer(0), { type: 'null' }, { type: 'null' }, { type: 'cell', cell: walletCode }]) : null);
  let resolved = '';
  source.getAccountState = async (target) => { resolved = target; return { balance: '0', accountState: 'uninitialized' }; };
  const payload = await service.getJettonTransferPayload(contract, owner);
  assert.ok(payload.state_init);
  const state = loadStateInit(Cell.fromBase64(payload.state_init).beginParse());
  assert.equal(resolved, contractAddress(0, state).toRawString());
  source.getJettonBalance = async () => ({ wallet: other, balance: '1' });
  source.getAccountState = async () => ({ balance: '1', accountState: 'active' });
  assert.deepEqual(await service.getJettonTransferPayload(contract, owner), { custom_payload: null, state_init: null });
  const missing = fixture(async () => null);
  assert.deepEqual(await missing.service.getJettonTransferPayload(contract, owner), { custom_payload: null, state_init: null });
});

test('balance formatting preserves bigint precision, token decimals and order-independent change signatures', async () => {
  const zero = address('5');
  const malformed = address('6');
  const negative = address('7');
  const { service, source } = fixture(async () => null, true, [
    { master: contract, symbol: 'USDT' }, { master: pool, symbol: 'TS' }, { master: zero }, { master: malformed }, { master: negative },
  ]);
  let metadataCalls = 0;
  source.getAccountState = async () => ({ balance: '9007199254740993123', lastTxLt: '1', lastTxHash: 'hash' });
  source.getJettonBalance = async (_owner, master) => ({ wallet: owner, balance: master === contract ? '1000001' : master === pool ? '2000000000' : master === zero ? '0' : master === negative ? '-5' : 'invalid' });
  source.getJettonMetadata = async (master) => { metadataCalls++; return master === negative ? { decimals: 0 } : null; };
  const snapshot = await service.getBalances(owner);
  assert.equal(snapshot.ton, '9007199254.740993123');
  assert.deepEqual(snapshot.assets.map((a) => a.balance), ['9007199254.740993123', '1.000001', '2', '0', '-5']);
  assert.equal(snapshot.assets.find((a) => a.address === malformed)?.balance_raw, 'invalid');
  assert.ok(snapshot.assets.every((a) => a.address !== zero));
  assert.equal(metadataCalls, 4);
  assert.equal(service.getBalancesSignature(snapshot), service.getBalancesSignature({ ...snapshot, assets: [...snapshot.assets].reverse() }));
  await service.getBalances(owner);
  assert.equal(metadataCalls, 4);
});

test('balance subscriptions normalize addresses, emit only changes and release listeners', async () => {
  const { service, source } = fixture(async () => null);
  let balance = '5';
  source.getAccountState = async () => ({ balance, lastTxLt: '1', lastTxHash: 'hash', codeBoc: 'code', dataBoc: 'data', accountState: 'active' });
  source.getAccountStateLite = async () => ({ balance, lastTxLt: '2', lastTxHash: 'new', accountState: 'active' });
  const events: Array<{ address: string; seq: number }> = [];
  const stop = service.subscribeBalanceChanges([Address.parse(owner).toString()], (event) => events.push(event));
  await service.refreshAccountState(owner);
  await service.refreshAccountState(owner);
  await service.refreshAccountState(other);
  balance = '6';
  await service.refreshAccountState(owner, { lite: true });
  assert.deepEqual(events.map((e) => e.address), [owner, owner]);
  assert.ok(events[1].seq > events[0].seq);
  service.setMasterchainInfo(42);
  const state = await service.getState(owner);
  assert.equal(state.balance_raw, '6');
  assert.equal(state.code_boc, 'code');
  assert.equal(state.data_boc, 'data');
  assert.equal(state.last_confirmed_seqno, 42);
  assert.deepEqual(await service.getNativeState(owner), state);
  stop();
  balance = '7';
  await service.refreshAccountState(owner);
  assert.equal(events.length, 2);
});

test('transaction cursor pages preserve order, invalidate on insertion and tolerate unavailable history', async () => {
  const { service, source } = fixture(async () => null, true, [], { pageSize: 2, backfillPageBatch: 2 });
  let historyCalls = 0;
  source.getTransactions = async () => {
    historyCalls++;
    return [3, 2, 1].map((lt) => ({ lt: String(lt), hash: `hash${lt}`, utime: lt, success: true, outMessages: [] }));
  };
  const page = await service.getTransactions(owner, 1);
  assert.deepEqual(page.txs.map((tx: { lt: string }) => tx.lt), ['3', '2']);
  assert.equal(page.history_complete, true);
  const cursor = await service.getTransactionsByCursor(owner, '2', 'hash2');
  assert.deepEqual(cursor.txs.map((tx: { lt: string }) => tx.lt), ['2', '1']);
  assert.strictEqual(await service.getTransactionsByCursor(owner, '2', 'hash2'), cursor);
  assert.equal(historyCalls, 1);
  await service.updateWithNewTransactions(owner, service.classify(owner, [{ lt: '4', hash: 'hash4', utime: 4, success: true, outMessages: [] }]));
  const updated = await service.getTransactions(owner, 1);
  assert.deepEqual(updated.txs.map((tx: { lt: string }) => tx.lt), ['4', '3']);
  assert.equal(updated.total_txs, 4);
  const missing = await service.getTransactionsByCursor(owner, '0', 'missing');
  assert.deepEqual(missing.txs, []);
  const unavailable = fixture(async () => null);
  unavailable.source.getTransactions = async () => { throw new Error('source offline'); };
  const empty = await unavailable.service.getTransactionsByCursor(other, '1', 'hash');
  assert.deepEqual(empty.txs, []);
  assert.equal(empty.history_complete, false);
});

test('SCCP material uses explicit checkpoints or trusted configuration and normalizes jetton addresses', async () => {
  const { service, source } = fixture(async () => null, true, [], {
    soraRpcEndpoint: undefined, soraTonTrustedCheckpointSeqno: 77, soraTonTrustedCheckpointHash: `0x${'22'.repeat(32)}`,
  });
  const request = { jettonMaster: Address.parse(contract).toString(), messageIdHex: '11'.repeat(32) };
  await assert.rejects(service.getTonSccpBurnProofMaterial(request), /unavailable/);
  const block = { seqno: 77, workchain: -1, shard: '8000000000000000', rootHashHex: '22'.repeat(32), fileHashHex: '33'.repeat(32) };
  const proof = { trustedCheckpoint: block, targetMasterchain: block, targetShard: block, targetSignatures: { validatorListHashShort: 1, catchainSeqno: 2, signatures: [] }, checkpointBlockBoc: '', checkpointStateBoc: '', targetBlockBoc: '', targetStateBoc: '', shardBlockBoc: '', shardStateBoc: '', burnRecordPresent: true };
  const requests: Parameters<NonNullable<TonDataSource['getTonSccpBurnProofMaterial']>>[0][] = [];
  source.getTonSccpBurnProofMaterial = async (value) => { requests.push(value); return proof; };
  assert.strictEqual(await service.getTonSccpBurnProofMaterial(request), proof);
  assert.equal(requests[0].jettonMaster, contract);
  assert.equal(requests[0].trustedCheckpointSeqno, 77);
  assert.equal(requests[0].trustedCheckpointHashHex, `0x${'22'.repeat(32)}`);
  await service.getTonSccpBurnProofMaterial({ ...request, trustedCheckpointSeqno: 88, trustedCheckpointHashHex: '44'.repeat(32), targetSeqno: 100 });
  assert.equal(requests[1].trustedCheckpointSeqno, 88);
  assert.equal(requests[1].trustedCheckpointHashHex, '44'.repeat(32));
  assert.equal(requests[1].targetSeqno, 100);
});
