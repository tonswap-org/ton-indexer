import assert from 'node:assert/strict';
import { Address, TupleItem, beginCell } from '@ton/core';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';

const raw = (digit: string) => `0:${digit.repeat(64)}`;
const manager = raw('1'), owner = raw('2'), pool = raw('3'), lastSender = raw('4');
const vault = raw('5'), governance = raw('6'), riskVault = raw('7'), volIndex = raw('8');
const seriesManager = raw('9'), oracle = raw('a'), automation = raw('b'), coverManager = raw('c');
const retiredPerpsEngine = raw('d'), controlMesh = raw('e'), riskController = raw('f');
const int = (value: bigint | number): TupleItem => ({ type: 'int', value: BigInt(value) });
const address = (value: string): TupleItem => ({
  type: 'slice',
  cell: beginCell().storeAddress(Address.parse(value)).endCell(),
});

const coverState: TupleItem[] = [
  int(1), int(1), int(0), int(0), int(0), int(500), address(lastSender), int(7),
  int(8), int(900), int(10), int(11), address(vault), address(governance), address(riskVault), int(12),
];
const coverPolicy: TupleItem[] = [
  int(1), address(owner), address(pool), int(-11), int(22), int(3_000), int(4_000),
  int(3_600), int(3), int(100), int(200), int(300), int(400), int(5), int(600),
  int(0xabc), int(2), address(riskVault), int(9),
];
const volConfig: TupleItem[] = [
  address(seriesManager), address(oracle), address(automation), address(coverManager), int(2_500), int(60), int(1_250),
];
const volState = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map(int);
const volRoute: TupleItem[] = [int(1), address(pool), int(555)];
const moduleScores = beginCell();
for (let index = 0; index < 12; index += 1) moduleScores.storeUint(index * 100, 32);
const riskControllerState: TupleItem[] = [
  address(governance), int(1), int(2), int(100), int(3), int(99), int(4), int(5), int(6),
  int(7_000), address(controlMesh), int(8), int(900), int(1), int(2), int(4), int(3),
  int(1_000), int(500), { type: 'cell', cell: moduleScores.endCell() },
];
const controlMeshState: TupleItem[] = [
  address(governance), int(1), int(0), int(9), int(100),
  ...Array.from({ length: 32 }, (_, index) => int(index + 5)),
];
controlMeshState[36] = int(2_000_000_000);

function sourceFor(retired = false): TonDataSource {
  return {
    network: 'localnet',
    async getMasterchainInfo() { return { seqno: 1 }; },
    async getAccountState() { return { balance: '0' }; },
    async getTransactions() { return []; },
    async runGetMethod(_address, method) {
      if (method === 'get_state') return { exitCode: 0, stack: coverState };
      if (method === 'registry_enabled') return { exitCode: 0, stack: [int(1)] };
      if (method === 'get_policy') {
        const stack = retired ? [...coverPolicy.slice(0, 6), ...coverPolicy.slice(7)] : coverPolicy;
        return { exitCode: 0, stack };
      }
      if (method === 'vol_index_config') {
        const stack = retired
          ? [...volConfig.slice(0, 3), address(retiredPerpsEngine), ...volConfig.slice(3)]
          : volConfig;
        return { exitCode: 0, stack };
      }
      if (method === 'vol_index_state' || method === 'vol_index_pool_state') {
        return { exitCode: 0, stack: volState };
      }
      if (method === 'vol_index_route') {
        return { exitCode: 0, stack: retired ? [int(1), int(42), ...volRoute.slice(1)] : volRoute };
      }
      if (method === 'get_control_state') return { exitCode: 0, stack: controlMeshState };
      if (method === 'get_risk_controller_state') return { exitCode: 0, stack: riskControllerState };
      return null;
    },
    async getJettonBalance() { return null; },
    async getJettonMetadata() { return null; },
    async close() {},
  };
}

const config = { ...loadConfig(), network: 'localnet' as const, responseCacheEnabled: false };
const service = (retired = false) => new IndexerService(
  config,
  new MemoryStore(config),
  sourceFor(retired),
  loadOpcodes(undefined),
  [],
);

async function main() {
  const current = service();
  const cover = await current.getCoverSnapshot(manager);
  assert.equal(cover.state?.governance, governance);
  assert.equal(cover.policies.length, 1);
  assert.deepEqual(cover.policies[0], {
    id: '1', owner, pool, lowerBound: '-11', upperBound: '22', payout: '3000',
    coveredNotional: '4000', windowSeconds: '3600', requiredObservations: '3',
    breachStart: '100', breachSeconds: '200', lastObservation: '300',
    lastHealthyObservation: '400', breachObservations: '5', lastVolatilityTimestamp: '600',
    lastVolatilityRequestHash: '2748', status: '2', riskVault, riskBucketId: '9',
  });

  const highPolicyId = (1n << 63n) + 17n;
  const requestedPolicyIds: bigint[] = [];
  const highSource = sourceFor();
  const baseGetter = highSource.runGetMethod.bind(highSource);
  highSource.runGetMethod = async (contract, method, args) => {
    if (method === 'get_state') {
      const stack = [...coverState];
      stack[0] = int(highPolicyId);
      return { exitCode: 0, stack };
    }
    if (method === 'get_policy') {
      const item = args?.[0];
      assert(item?.type === 'int');
      requestedPolicyIds.push(item.value);
      return { exitCode: 0, stack: coverPolicy };
    }
    return baseGetter(contract, method, args);
  };
  const highService = new IndexerService(config, new MemoryStore(config), highSource, loadOpcodes(undefined), []);
  const highCover = await highService.getCoverSnapshot(manager, { maxScan: 2 });
  assert.deepEqual(requestedPolicyIds, [highPolicyId, highPolicyId - 1n]);
  assert.deepEqual(highCover.policies.map((policy) => policy.id), [highPolicyId.toString(), (highPolicyId - 1n).toString()]);

  const vol = await current.getVolIndexSnapshot(volIndex, { sourcePool: pool, routeIds: [7] });
  assert.equal(vol.config?.coverManager, coverManager);
  assert.equal(vol.config?.minLiquidityBps, '2500');
  assert.equal(vol.state?.lastSampleTs, '110');
  assert.equal(vol.pool_state?.lastSamplePrice, '109');
  assert.deepEqual(vol.routes['7'], { exists: true, sourcePool: pool, coverPolicyId: '555' });
  await assert.rejects(current.getVolIndexSnapshot(volIndex, { routeIds: [0] }), /positive uint32/);
  await assert.rejects(current.getVolIndexSnapshot(volIndex, { routeIds: [1.5] }), /positive uint32/);
  await assert.rejects(current.getVolIndexSnapshot(volIndex, { routeIds: [0x1_0000_0000] }), /positive uint32/);
  await assert.rejects(current.getVolIndexSnapshot(volIndex, { routeIds: Array.from({ length: 65 }, (_, index) => index + 1) }), /at most 64/);

  const app = Fastify();
  registerRoutes(app, config, current);
  for (const value of ['garbage', '0', '-1', '1.5', '1,,2', '1,garbage', '4294967296']) {
    const response = await app.inject({
      url: `/api/indexer/v1/vol-index/${volIndex}/snapshot?route_ids=${encodeURIComponent(value)}`,
    });
    assert.equal(response.statusCode, 400, `Reject invalid route_ids=${value}`);
  }
  await app.close();

  const defi = await current.getDefiSnapshot({
    include: { activation: false, dlmmRegistry: false, reserveBalances: false, systemHealth: true,
      systemHealthDetailed: false, modules: false, governance: false, cover: false },
    contracts: { controlMesh, riskController },
  });
  const health = defi.sections.systemHealth;
  assert(health?.ok);
  assert.equal(health.data.riskControllerState?.totalGrossBudget, '7000');
  assert.equal(health.data.riskControllerState?.controlMesh, controlMesh);
  assert.equal(health.data.controlState?.perpsMarket3WeightMillibps, '25');
  assert.equal(health.data.controlState?.perpsMarket4FundingCapBps, '30');
  assert.equal(health.data.controlState?.insuranceBtcCover, '2000000000');

  const api = Fastify();
  registerRoutes(api, config, current);
  const response = await api.inject({
    method: 'POST',
    url: '/api/indexer/v1/defi/snapshot',
    payload: {
      include: { activation: false, dlmmRegistry: false, reserveBalances: false, systemHealth: true,
        systemHealthDetailed: false, modules: false, governance: false, cover: false },
      contracts: { controlMesh, riskController },
    },
  });
  assert.equal(response.statusCode, 200);
  const apiHealth = response.json().sections.systemHealth;
  assert.equal(apiHealth.data.riskControllerState.totalGrossBudget, '7000');
  assert.equal(apiHealth.data.controlState.perpsMarket4FundingCapBps, '30');
  assert.equal(apiHealth.data.controlState.insuranceBtcCover, '2000000000');
  await api.close();

  const unsupported = service(true);
  const retiredCover = await unsupported.getCoverSnapshot(manager);
  assert.deepEqual(retiredCover.policies, [], 'retired 18-field cover policy must not be shifted into current fields');
  const retiredVol = await unsupported.getVolIndexSnapshot(volIndex, { sourcePool: pool, routeIds: [7] });
  assert.equal(retiredVol.config, null, 'retired config with PerpsEngine slot must be rejected');
  assert.deepEqual(retiredVol.route_ids, [], 'retired route with marketId slot must be rejected');
  assert.deepEqual(retiredVol.routes, {});

  console.log('Current RiskController, four-market ControlMesh, uint64 Cover and VolIndex getter/API layouts map exactly; retired shifted tuples are rejected');
}

void main();
