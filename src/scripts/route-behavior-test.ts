import assert from 'node:assert/strict';
import test from 'node:test';
import fastify from 'fastify';
import { beginCell } from '@ton/core';
import { registerRoutes } from '../api/routes';

const address = `0:${'1'.repeat(64)}`, other = `0:${'2'.repeat(64)}`;
const hash = Buffer.alloc(32, 7).toString('base64');
const token = 'a'.repeat(32);
function appFor(t: any, service: Record<string, any>, extras: any = {}) {
  const app = fastify({ logger: false });
  registerRoutes(app, { network: 'testnet', pageSize: 2, adminToken: token }, service as any,
    extras.metrics, extras.snapshots, extras.debug, undefined, { Example: address });
  t.after(() => app.close());
  return app;
}

test('snapshot routes normalize public query options and reject invalid addresses before dispatch', async t => {
  const rows: Array<[string, string, string, Record<string, unknown>]> = [
    ['perps', 'getPerpsSnapshot', 'market_ids=2,invalid,0,3&max_markets=8', { marketIds: [2, 3], maxMarkets: 8 }],
    ['vol-index', 'getVolIndexSnapshot', `pool=${other}&route_ids=2,invalid,0,3`, { sourcePool: other, routeIds: [2, 3] }],
    ['governance', 'getGovernanceSnapshot', `owner=${other}&max_scan=8&max_misses=2`, { owner: other, maxScan: 8, maxConsecutiveMisses: 2 }],
    ['farms', 'getFarmSnapshot', 'max_scan=8&max_misses=2', { maxScan: 8, maxConsecutiveMisses: 2 }],
    ['options', 'getOptionsSnapshot', 'start_id=0&max_series_id=12&window_size=4&max_empty_windows=2&min_probe_windows=0', { startId: 0, maxSeriesId: 12, windowSize: 4, maxEmptyWindows: 2, minProbeWindows: 0 }],
    ['cover', 'getCoverSnapshot', `owner=${other}&max_scan=8&max_misses=2`, { owner: other, maxScan: 8, maxConsecutiveMisses: 2 }],
  ];
  const calls: any[] = [], service: Record<string, any> = {};
  for (const [route, method] of rows) service[method] = async (addr: string, options: unknown) => { calls.push([method, addr, options]); return { kind: route, synced_at: 10 }; };
  const app = appFor(t, service);
  for (const [route, method, query, expected] of rows) {
    const response = await app.inject(`/api/indexer/v1/${route}/${address}/snapshot?${query}`);
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { kind: route, synced_at: 10 });
    assert.deepEqual(calls.at(-1), [method, address, expected]);
    assert.equal((await app.inject(`/api/indexer/v1/${route}/invalid/snapshot`)).statusCode, 400);
    service[method] = async () => { throw Error('secret RPC token must not leak'); };
    const failed = await app.inject(`/api/indexer/v1/${route}/${address}/snapshot`);
    assert.equal(failed.statusCode, 400); assert.equal(failed.json().code, 'bad_request'); assert(!failed.body.includes('secret'));
  }
  for (const route of ['governance', 'cover']) assert.equal((await app.inject(`/api/indexer/v1/${route}/${address}/snapshot?owner=invalid`)).statusCode, 400);
  assert.equal((await app.inject(`/api/indexer/v1/vol-index/${address}/snapshot?pool=invalid`)).statusCode, 400);
});

test('getter requests decode integer and cell stack types exactly, without numeric truncation', async t => {
  const received: any[] = [];
  const app = appFor(t, { runGetMethod: async (_address: string, _method: string, args: any[]) => { received.push(args); return { stack: [], exit_code: 0, gas_used: 0 }; } });
  const cell = beginCell().storeUint(123, 32).endCell(), boc = cell.toBoc().toString('base64url');
  const response = await app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod', payload: { address, method: 'read_value', stack: [
    ['int', '-0xFF'], ['num', '9007199254740993'], ['int', 42], ['null'], ['cell', boc], ['slice', boc], ['builder', boc] ] } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(received[0].slice(0, 4), [{ type: 'int', value: -255n }, { type: 'int', value: 9007199254740993n }, { type: 'int', value: 42n }, { type: 'null' }]);
  for (const [index, kind] of ['cell', 'slice', 'builder'].entries()) { assert.equal(received[0][index+4].type, kind); assert(received[0][index+4].cell.hash().equals(cell.hash())); }
  for (const stack of [[['num', 1.5]], [['num', Number.MAX_SAFE_INTEGER + 1]], [['int', '1.5']], [['cell', 'x']], [['cell', 1]], [['cell', 'abcd']], [['unknown', 1]], [[12, '3']], [null], Array(17).fill(['null'])]) {
    const rejected = await app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod', payload: { address, method: 'read_value', stack } });
    assert.equal(rejected.statusCode, 400, `Invalid stack was accepted: ${JSON.stringify(stack)}`); assert.equal(rejected.json().code, 'invalid_stack');
  }
  assert.equal(received.length, 1, 'Invalid inputs must never reach the getter');
});

test('batch getter validation isolates malformed entries and does not turn them into server errors', async t => {
  const app = appFor(t, { runGetMethod: async (_address: string, method: string) => {
    if (method === 'fail') throw Error('private failure');
    return { stack: [['num', '7']], exit_code: 0, gas_used: 0 };
  } });
  const response = await app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethods', payload: { calls: [
    null, { address: 7, method: 'good' }, { address, method: 7 }, { address, method: 'bad name' },
    { address, method: 'good', stack: 'invalid' }, { address, method: 'fail' }, { address, method: 'good' } ] } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().results.map((r: any) => r.code ?? r.ok), ['invalid_address', 'invalid_address', 'invalid_method', 'invalid_method', 'invalid_stack', 'bad_request', true]);
  assert(!response.body.includes('private'));
  for (const payload of [{ address: 3, method: 'good' }, { address, method: 3 }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod', payload })).statusCode, 400);
  }
});

test('account APIs dispatch exact addresses and sanitize service failures', async t => {
  const calls: any[] = [], service: Record<string, any> = {};
  for (const method of ['getBalance', 'getBalances', 'getState', 'getJettonTransferPayload']) service[method] = async (...args: any[]) => { calls.push([method, ...args]); return { balance: '9007199254740993' }; };
  const app = appFor(t, service);
  for (const [suffix, method] of [['balance', 'getBalance'], ['balances', 'getBalances'], ['assets', 'getBalances'], ['state', 'getState']]) {
    assert.equal((await app.inject(`/api/indexer/v1/accounts/${address}/${suffix}`)).json().balance, '9007199254740993');
    assert.deepEqual(calls.at(-1), [method, address]);
    assert.equal((await app.inject(`/api/indexer/v1/accounts/invalid/${suffix}`)).statusCode, 400);
  }
  assert.equal((await app.inject(`/api/indexer/v1/jettons/${address}/transfer/${other}/payload`)).statusCode, 200);
  assert.deepEqual(calls.at(-1), ['getJettonTransferPayload', address, other]);
  assert.equal((await app.inject(`/api/indexer/v1/jettons/${address}/transfer/invalid/payload`)).statusCode, 400);
  for (const method of Object.keys(service)) service[method] = async () => { throw Error('private credential'); };
  for (const suffix of ['balance', 'balances', 'assets', 'state']) {
    const response = await app.inject(`/api/indexer/v1/accounts/${address}/${suffix}`);
    assert.equal(response.statusCode, 400); assert(!response.body.includes('credential'));
  }
});

test('Toncenter compatibility deduplicates overlapping cursors and preserves transaction outcomes', async t => {
  const rows = [
    { lt: '9', hash, utime: 3, status: 'success', inMessage: { source: address, destination: other, value: '5', body: 'boc' }, outMessages: [{ destination: other }] },
    { lt: '8', hash, utime: 2, status: 'failed', reason: 'contract rejected' },
    { lt: '7', hash, utime: 1, status: 'pending' },
  ];
  const cursors: string[] = [];
  const app = appFor(t, { getTransactionsByCursor: async (_who: string, lt: string) => { cursors.push(lt); return { page_size: 2, txs: lt === '9' ? rows.slice(0, 2) : rows.slice(1) }; },
    getState: async () => ({ account_state: 'active', last_tx_lt: '9', last_tx_hash: hash, last_confirmed_seqno: 4, last_seen_utime: 123, code_boc: 'code', data_boc: 'data' }),
    getBalances: async () => ({ ton_raw: '9007199254740993' }) });
  const rpc = (method: string, params: object) => app.inject({ method: 'POST', url: '/jsonRPC', payload: { id: 'client-id', jsonrpc: '2.0', method, params } });
  const response = (await rpc('getTransactions', { address, limit: 3, lt: '9', hash })).json();
  assert.equal(response.id, 'client-id'); assert.equal(response.ok, true); assert.deepEqual(cursors, ['9', '8']);
  assert.deepEqual(response.result.map((r: any) => r.transaction_id.lt), ['9', '8', '7']);
  assert.equal(response.result[0].in_msg.msg_data.body, 'boc'); assert.equal(response.result[0].description.compute_ph.success, true);
  assert.equal(response.result[1].description.compute_ph.reason, 'contract rejected'); assert.equal(response.result[2].description, undefined);
  const info = (await rpc('getAddressInformation', { address })).json().result;
  assert.equal(info.balance, '9007199254740993'); assert.equal(info.code, 'code'); assert.equal(info.block_id.seqno, 4); assert.equal(info.sync_utime, 123);
  assert.equal((await rpc('getAddressBalance', { address })).json().result, '9007199254740993');
});

test('DeFi/DLMM requests validate identities and retain explicit options; proof query preserves checkpoint binding', async t => {
  const calls: any[] = [];
  const service: Record<string, any> = {};
  for (const method of ['getDefiSnapshot', 'getDlmmPoolsSnapshot', 'getTonSccpBurnProofMaterial']) service[method] = async (request: unknown) => { calls.push([method, request]); return { synced_at: 123 }; };
  const app = appFor(t, service);
  const defi = { owner: other, contracts: { voting: address }, include: { governance: true }, options: { maxScan: 2 }, modules: [{ key: 'test', address }] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/defi/snapshot', payload: defi })).statusCode, 200);
  assert.deepEqual(calls.at(-1), ['getDefiSnapshot', defi]);
  for (const payload of [{ ...defi, owner: 'bad' }, { ...defi, modules: [{ key: 'bad', address: 'bad' }] }, { ...defi, modules: Array(65).fill({ key: 'test', address }) }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/defi/snapshot', payload })).statusCode, 400);
  }
  const dlmm = { t3Root: address, dlmmRegistry: other, dlmmFactory: null, tokens: [address, other] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/dlmm/pools/snapshot', payload: dlmm })).statusCode, 200);
  assert.deepEqual(calls.at(-1), ['getDlmmPoolsSnapshot', dlmm]);
  for (const payload of [{ ...dlmm, t3Root: 'bad' }, { ...dlmm, dlmmRegistry: 'bad' }, { ...dlmm, tokens: ['bad'] }, { ...dlmm, tokens: [] }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/dlmm/pools/snapshot', payload })).statusCode, 400);
  }
  const hex = `0x${'1'.repeat(64)}`;
  const proofQuery = new URLSearchParams({ jetton_master: address, message_id: hex, trusted_checkpoint_seqno: '10', trusted_checkpoint_hash: hex, target_seqno: '11' });
  assert.equal((await app.inject(`/api/indexer/v1/sccp/ton/burn-proof-material?${proofQuery}`)).statusCode, 200);
  assert.deepEqual(calls.at(-1), ['getTonSccpBurnProofMaterial', { jettonMaster: address, messageIdHex: hex, trustedCheckpointSeqno: 10, trustedCheckpointHashHex: hex, targetSeqno: 11 }]);
  proofQuery.delete('trusted_checkpoint_hash');
  assert.equal((await app.inject(`/api/indexer/v1/sccp/ton/burn-proof-material?${proofQuery}`)).statusCode, 400);
});

test('metrics, docs and protected snapshot controls return their defined public responses', async t => {
  let saves = 0;
  const app = appFor(t, {}, { metrics: { getMetrics: () => ({ requests: 12 }), getPrometheus: () => 'requests_total 12\n' },
    snapshots: { save: () => { saves++; return { entries: 2 }; }, load: () => ({ entries: 2 }) }, debug: { getStatus: (limit: number) => ({ limit }) } });
  assert.deepEqual((await app.inject('/api/indexer/v1/metrics')).json(), { requests: 12 });
  assert.match((await app.inject('/api/indexer/v1/metrics/prometheus')).body, /requests_total 12/);
  assert.equal((await app.inject('/api/indexer/v1/openapi.json')).json().openapi, '3.0.3');
  assert.equal((await app.inject('/api/indexer/v1/docs')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/snapshot/save' })).statusCode, 401); assert.equal(saves, 0);
  const headers = { authorization: `Bearer ${token}` };
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/indexer/v1/snapshot/save', headers })).json(), { ok: true, entries: 2 });
  assert.equal(saves, 1);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/indexer/v1/debug?limit=12', headers })).json(), { limit: 12 });
});
