import assert from 'node:assert/strict';
import { Address, beginCell, serializeTuple, type TupleItem } from '@ton/core';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

async function main() {
  const runtime = runtimeManifestFixture(), address = runtime.contracts.PerpsEngine!.address;
  const owner = beginCell().storeAddress(Address.parse(`0:${'1'.repeat(64)}`)).endCell();
  const body = beginCell().storeUint(0x50584f50, 32).storeUint(17, 64).endCell();
  const args: TupleItem[] = [{ type: 'slice', cell: owner }, { type: 'cell', cell: body },
    { type: 'int', value: 9007199254740993n }];
  let batches = 0, ordinary = 0, status = 5n;
  const source = fakeChainSource({
    read: async calls => {
      batches++;
      assert.deepEqual(calls.map(call => call.kind === 'getter' ? call.method : call.kind),
        ['get_request_check', 'get_min_value', 'get_min_forward']);
      assert(calls.every(call => call.address === address));
      assert(calls[0].kind === 'getter');
      assert(serializeTuple(calls[0].args).equals(serializeTuple(args)), 'Owner/body/deposit reach the current source unchanged');
      return { head: fixtureHead(123, Math.floor(Date.now() / 1000)), results: calls.map((call, i) =>
        ({ kind: 'getter' as const, address, exitCode: 0, stack: [{ type: 'int' as const, value: i ? BigInt(i * 100) : status }] })) };
    },
    head: async () => { ordinary++; return fixtureHead(); },
    runGetMethod: async () => { ordinary++; throw Error('No ordinary fallback'); },
  });
  const config = { ...loadConfig(), network: 'testnet' as const };
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(), []);
  const app = Fastify();
  registerRoutes(app, config, service, undefined, undefined, undefined, undefined, {}, {
    runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '',
  });
  const current = { calls: [
    { kind: 'getter', address, method: 'get_request_check', stack: [['tvm.Slice', owner.toBoc().toString('base64')],
      ['tvm.Cell', body.toBoc().toString('base64')], ['num', args[2].type === 'int' ? args[2].value.toString() : '']] },
    { kind: 'getter', address, method: 'get_min_value', stack: [['num', '1']] },
    { kind: 'getter', address, method: 'get_min_forward', stack: [['num', '1'], ['num', '0']] },
  ] };
  try {
    for (const outcome of [5n, 0n]) {
      status = outcome;
      const response = await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh', payload: current });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.json().release.manifestHash, runtime.manifestHash);
      assert.equal(response.json().readContext.head.seqno, 123);
      assert.deepEqual(response.json().results[0].stack, [['num', outcome.toString()]],
        'Current intake refusal remains a getter outcome, never an invented execution approval');
      assert.equal(response.json().results[0].gas_used, null);
      assert(!('admission' in response.json().results[0]));
    }
    assert.equal(batches, 2, 'Fresh intake results are not cached');
    for (const method of ['open_order_preflight', 'close_order_preflight']) {
      await assert.rejects(service.runGetMethod(address, method, []), /Retired Perps getter/);
      await assert.rejects(service.readFresh([{ kind: 'getter', address, method, args: [] }]));
      const rest = await app.inject({ method: 'POST', url: '/api/indexer/v1/runGetMethod', payload: { address, method, stack: [] } });
      assert.equal(rest.statusCode, 400); assert.equal(rest.json().code, 'invalid_method');
      const fresh = await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh',
        payload: { calls: [{ kind: 'getter', address, method, stack: [] }] } });
      assert.equal(fresh.statusCode, 400);
      for (const url of ['/jsonRPC', '/api/v2/jsonRPC']) {
        const rpc = await app.inject({ method: 'POST', url, payload: {
          jsonrpc: '2.0', id: 1, method: 'runGetMethod', params: { address, method, stack: [] },
        } });
        assert.equal(rpc.json().ok, false); assert.equal(rpc.json().code, 400);
      }
    }
    assert.equal(batches, 2); assert.equal(ordinary, 0, 'Retired methods never reach any getter source');
  } finally { await app.close(); }
  console.log('Current Perps intake/funding uses fresh reads; retired getters fail before all sources');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
