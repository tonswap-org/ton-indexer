import assert from 'node:assert/strict';
import { Address, TupleItem, beginCell } from '@ton/core';
import { loadConfig } from '../config';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';

const engine = `0:${'1'.repeat(64)}`;
const governance = `0:${'2'.repeat(64)}`;
const int = (value: bigint): TupleItem => ({ type: 'int', value });
const address = (value: string): TupleItem => ({
  type: 'slice',
  cell: beginCell().storeAddress(Address.parse(value)).endCell(),
});

const makeSource = (configStack: TupleItem[]) => {
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
        return { exitCode: 0, stack: Array.from({ length: 14 }, () => int(0n)) };
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

const snapshotFor = async (configStack: TupleItem[]) => {
  const config = { ...loadConfig(), responseCacheEnabled: false };
  const { source, calls } = makeSource(configStack);
  const service = new IndexerService(
    config,
    new MemoryStore({ ...config, maxAddresses: 10 }),
    source,
    loadOpcodes(undefined),
    [],
  );
  return { snapshot: await service.getPerpsSnapshot(engine), calls };
};

const canonicalConfig = Array.from({ length: 36 }, () => int(0n));
canonicalConfig[9] = int(30n);

const run = async () => {
  const canonical = await snapshotFor(canonicalConfig);
  assert.equal(canonical.snapshot.status?.feeBps, '30');
  assert.ok(canonical.calls.includes('engine_config'));

  const truncated = await snapshotFor(canonicalConfig.slice(0, 35));
  assert.equal(truncated.snapshot.status?.feeBps, null);

  const extended = await snapshotFor([...canonicalConfig, int(0n)]);
  assert.equal(extended.snapshot.status?.feeBps, null);

  const wrongFeeType = [...canonicalConfig];
  wrongFeeType[9] = { type: 'null' };
  const wrongType = await snapshotFor(wrongFeeType);
  assert.equal(wrongType.snapshot.status?.feeBps, null);

  const outOfRangeFee = [...canonicalConfig];
  outOfRangeFee[9] = int(10_001n);
  const outOfRange = await snapshotFor(outOfRangeFee);
  assert.equal(outOfRange.snapshot.status?.feeBps, null);

  console.log('perps snapshot ok');
};

void run();
