import assert from 'node:assert/strict';
import { Address, beginCell, type TupleItem } from '@ton/core';
import Fastify from 'fastify';
import { readDlmmFarmSnapshot } from '../utils/dlmmFarming';
import { loadConfig } from '../config';
import { registerRoutes } from '../api/routes';

const pool = `0:${'1'.repeat(64)}`, owner = `0:${'2'.repeat(64)}`;
const int = (value: bigint | number): TupleItem => ({ type: 'int', value: BigInt(value) });
const address: TupleItem = { type: 'slice', cell: beginCell().storeAddress(Address.parse(owner)).endCell() };
let next = 4n, missing = false, malformed = false, version = 1n, ownerFails = false;
const calls: string[] = [];
async function get(method: string, args: TupleItem[]) {
  calls.push(method);
  if (method === 'farm_config') return { exitCode: 0, stack: [version, next, 15552000n, 1000000n, 0n].map(int) };
  if (method === 'farm_campaign') {
    assert.equal(args[0].type, 'int');
    return { exitCode: 0, stack: [int(missing ? 0 : 1), address, ...[-3, 0, 1000000, 2000000000, 2000003600, 9007199254740993n, 200000, malformed ? 200001 : 100000, 0, 0].map(int)] };
  }
  if (method === 'farm_user') {
    assert.equal(args[1].type, 'slice');
    if (ownerFails) return null;
    return { exitCode: 0, stack: [9007199254740993n, 100000n, 100000n, 19n].map(int) };
  }
  throw new Error('Unexpected getter: ' + method);
}
async function main() {
  const empty = await readDlmmFarmSnapshot(pool, { startId: '4' }, get);
  assert.deepEqual(empty.campaigns, []);
  const first = await readDlmmFarmSnapshot(pool, { owner, startId: '1', limit: 2 }, get);
  assert.equal(first.next_start_id, '3');
  assert.deepEqual(first.campaigns.map(c => c.id), ['1', '2']);
  assert.equal(first.campaigns[0].totalStaked, '9007199254740993');
  assert.equal(first.campaigns[0].user?.lastSettlementId, '19');
  assert.equal(first.campaigns[0].binId, -3);
  calls.length = 0;
  const guest = await readDlmmFarmSnapshot(pool, {}, get);
  assert.equal(guest.campaigns[0].user, null);
  assert.equal(calls.includes('farm_user'), false);
  next = 18446744073709551615n;
  const last = await readDlmmFarmSnapshot(pool, { limit: 1 }, get);
  assert.equal(last.start_id, '18446744073709551614');
  assert.equal(last.campaigns[0].id, '18446744073709551614');
  assert.equal(last.next_start_id, null);
  for (const options of [{ startId: '18446744073709551616' }, { startId: '1e2' }, { startId: '01' }, { limit: 65 }, { owner: 'bad' }]) {
    await assert.rejects(() => readDlmmFarmSnapshot(pool, options, get));
  }
  next = 4n; version = 0n;
  await assert.rejects(() => readDlmmFarmSnapshot(pool, {}, get), /Unsupported/);
  version = 1n; missing = true;
  await assert.rejects(() => readDlmmFarmSnapshot(pool, {}, get), /incomplete/);
  missing = false; malformed = true;
  await assert.rejects(() => readDlmmFarmSnapshot(pool, {}, get), /accounting/);
  malformed = false; ownerFails = true;
  await assert.rejects(() => readDlmmFarmSnapshot(pool, { owner }, get), /owner position/);
  ownerFails = false;
  await assert.rejects(() => readDlmmFarmSnapshot(pool, {}, async () => null), /configuration/);

  const app = Fastify({ logger: false });
  let requestCount = 0;
  registerRoutes(app, loadConfig(), { getFarmSnapshot: async (address: string, options: object) => {
    requestCount++; return readDlmmFarmSnapshot(address, options, get);
  } } as any);
  await app.ready();
  try {
    for (const suffix of ['?owner=bad', '?start_id=18446744073709551616', '?limit=65', '?limit=0', '?start_id=01']) {
      assert.equal((await app.inject(`/api/indexer/v1/pools/${pool}/farms${suffix}`)).statusCode, 400);
    }
    assert.equal(requestCount, 0);
    assert.equal((await app.inject(`/api/indexer/v1/farms/${pool}/snapshot`)).statusCode, 404);
    const response = await app.inject(`/api/indexer/v1/pools/${pool}/farms?owner=${owner}&start_id=1&limit=2`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().campaigns.length, 2);
    assert.equal(response.json().owner, owner);
  } finally { await app.close(); }
  console.log('Native DLMM farming snapshot and route tests passed.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
