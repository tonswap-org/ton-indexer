import assert from 'node:assert/strict';
import { Address, beginCell, parseTuple, serializeTuple, type TupleItem } from '@ton/core';
import { loadConfig } from '../config';
import type { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';

type Result = { exitCode: number; stack: TupleItem[] } | null;
const address = `0:${'1'.repeat(64)}`;
const int = (value: bigint): TupleItem => ({ type: 'int', value });
const result = (value: bigint): Result => ({ exitCode: 0, stack: [int(value)] });
const clone = (args: TupleItem[]) => parseTuple(serializeTuple(args));
const make = (runGetMethod: TonDataSource['runGetMethod'], enabled = true, ttl = 100_000) => {
  const config = { ...loadConfig(), network: 'localnet' as const, responseCacheEnabled: enabled, stateCacheTtlMs: ttl };
  const source: TonDataSource = {
    network: 'localnet', runGetMethod,
    async getMasterchainInfo() { return { seqno: 1 }; },
    async getAccountState() { return { balance: '0' }; },
    async getTransactions() { return []; },
    async getJettonBalance() { return null; },
    async getJettonMetadata() { return null; },
    async close() {},
  };
  return { config, service: new IndexerService(config, new MemoryStore(config), source, loadOpcodes(undefined), []) };
};
const deferred = () => {
  let resolve!: (value: Result) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export async function runGetterFreshnessTests() {
  let cases = 0;
  // Argument count and names never imply a getter is constant. Even a state
  // cache TTL longer than a quote cannot retain a completed latest-head result.
  for (const [enabled, ttl] of [[true, 100_000], [true, 0], [false, 100_000]] as const) {
    let now = 1000n, calls = 0;
    const { service } = make(async () => { calls++; return result(now); }, enabled, ttl);
    for (const [method, args] of [
      ['perps_oracle_snapshot', []], ['arbitrary_time_getter', []], ['get_wallet_data', []],
      ['get_entry', [int(1n)]], ['getter_with_args', [int(2n)]]] as [string, TupleItem[]][]) {
      const first = await service.runGetMethod(address, method, args);
      now++;
      const second = await service.runGetMethod(address, method, args);
      assert.notDeepEqual(first.stack, second.stack, `Fresh latest-head ${method}, enabled=${enabled}, ttl=${ttl}`);
    }
    assert.equal(calls, 10);
    cases++;
  }

  // Two equivalent argument object graphs and address formats share only the
  // currently pending source operation; a call after settlement starts anew.
  {
    let calls = 0; const gate = deferred();
    const { service } = make(async () => { calls++; return gate.promise; });
    const args: TupleItem[] = [{ type: 'tuple', items: [int(-(1n << 100n)),
      { type: 'tuple', items: [{ type: 'null' }, { type: 'nan' },
        { type: 'cell', cell: beginCell().storeUint(7, 8).endCell() }] }] }];
    const first = service.runGetMethod(address, 'read', args);
    const same = service.runGetMethod(Address.parse(address).toString(), 'read', clone(args));
    assert.equal(calls, 1);
    gate.resolve(result(1n));
    assert.deepEqual(await first, await same);
    await service.runGetMethod(address, 'read', clone(args));
    assert.equal(calls, 2);
    cases++;
  }

  // Every value, nested value, type, cell byte, method and account forms part of
  // the identity. This catches the former nested tuple type-only collision.
  {
    let calls = 0; const gate = deferred();
    const { service } = make(async () => { calls++; return gate.promise; });
    const cell1 = beginCell().storeUint(1, 8).endCell(), cell2 = beginCell().storeUint(2, 8).endCell();
    const args: TupleItem[][] = [
      [{ type: 'tuple', items: [int(1n)] }], [{ type: 'tuple', items: [int(2n)] }],
      [{ type: 'tuple', items: [{ type: 'tuple', items: [int(1n)] }] }],
      [{ type: 'tuple', items: [{ type: 'tuple', items: [int(2n)] }] }],
      [{ type: 'cell', cell: cell1 }], [{ type: 'cell', cell: cell2 }],
      [{ type: 'slice', cell: cell1 }], [{ type: 'builder', cell: cell1 }],
      [{ type: 'null' }], [{ type: 'nan' }], [], [int(1n), int(2n)], [int(2n), int(1n)],
    ];
    const reads = args.map(value => service.runGetMethod(address, 'read', value));
    reads.push(service.runGetMethod(address, 'other_read', args[0]));
    reads.push(service.runGetMethod(`0:${'2'.repeat(64)}`, 'read', args[0]));
    assert.equal(calls, args.length + 2);
    gate.resolve(result(1n)); await Promise.all(reads); cases++;
  }

  // The key and provider arguments are one immutable snapshot even when a
  // caller mutates its nested array during a pending operation.
  {
    const gate = deferred(); let observed: TupleItem[] = [], calls = 0;
    const { service } = make(async (_address, _method, args) => { calls++; observed = args!; return gate.promise; });
    const nested = { type: 'tuple' as const, items: [int(1n)] }, args = [nested];
    const first = service.runGetMethod(address, 'read', args);
    nested.items[0] = int(2n); args.push({ type: 'tuple', items: [] });
    assert.deepEqual(observed, [{ type: 'tuple', items: [int(1n)] }]);
    const duplicate = service.runGetMethod(address, 'read', [{ type: 'tuple', items: [int(1n)] }]);
    assert.equal(calls, 1);
    gate.resolve(result(1n)); await Promise.all([first, duplicate]); cases++;
  }

  // Null, rejection and synchronous provider failure release ownership. A
  // subsequent success is retried only by a new caller, never automatically.
  for (const failure of ['null', 'reject', 'throw'] as const) {
    let calls = 0; const gate = deferred();
    const { service } = make(() => {
      calls++;
      if (calls > 1) return Promise.resolve(result(2n));
      if (failure === 'throw') throw Error('source failure');
      return gate.promise;
    });
    const first = service.runGetMethod(address, 'read');
    const shared = failure === 'throw' ? null : service.runGetMethod(address, 'read');
    const failed = Promise.all([assert.rejects(first, /unavailable/), ...(shared ? [assert.rejects(shared, /unavailable/)] : [])]);
    if (failure === 'reject') gate.reject(Error('source failure')); else gate.resolve(null);
    await failed; assert.equal(calls, 1);
    assert.equal((await service.runGetMethod(address, 'read')).exit_code, 0);
    assert.equal(calls, 2); cases++;
  }

  // A semantic VM outcome is returned once and is not cached or retried.
  {
    let calls = 0;
    const { service } = make(async () => ({ exitCode: ++calls === 1 ? 11 : 0, stack: [] }));
    assert.equal((await service.runGetMethod(address, 'read')).exit_code, 11);
    assert.equal((await service.runGetMethod(address, 'read')).exit_code, 0);
    assert.equal(calls, 2); cases++;
  }

  // Public JSON-RPC callers and internal perps snapshots converge on the same
  // source boundary. Completion does not make the next snapshot stale.
  {
    const gate = deferred(); let configCalls = 0;
    const configuration = Array.from({ length: 36 }, () => int(0n));
    const { service } = make(async (_address, method) => {
      if (method === 'engine_config') { configCalls++; return gate.promise; }
      if (method === 'engine_governance') return { exitCode: 0, stack: [{ type: 'slice', cell: beginCell().storeAddress(Address.parse(address)).endCell() }] };
      if (method === 'engine_enabled') return result(1n);
      if (method === 'automation_state') return { exitCode: 0, stack: Array.from({ length: 14 }, () => int(0n)) };
      return null;
    });
    const direct = service.runGetMethod(address, 'engine_config');
    const snapshot = service.getPerpsSnapshot(address, { marketIds: [1] });
    assert.equal(configCalls, 1);
    gate.resolve({ exitCode: 0, stack: configuration });
    await Promise.all([direct, snapshot]);
    await service.getPerpsSnapshot(address, { marketIds: [1] });
    assert.equal(configCalls, 2); cases++;
  }

  // The real public route also returns the new execution timestamp immediately
  // on a later request, while retaining its exact Toncenter response shape.
  {
    let now = 1000n, calls = 0;
    const { service, config } = make(async () => { calls++; return result(now); });
    const app = Fastify(); registerRoutes(app, config, service);
    try {
      const payload = { id: 1, jsonrpc: '2.0', method: 'runGetMethod', params: { address, method: 'perps_oracle_snapshot', stack: [] } };
      const first = await app.inject({ method: 'POST', url: '/jsonRPC', payload });
      now = 1015n;
      const second = await app.inject({ method: 'POST', url: '/jsonRPC', payload });
      assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
      assert.equal(first.json().result.stack[0][1], '1000'); assert.equal(second.json().result.stack[0][1], '1015');
      assert.equal(calls, 2); cases++;
    } finally { await app.close(); }
  }
  console.log(`getter freshness ${cases} cases ok`);
}
