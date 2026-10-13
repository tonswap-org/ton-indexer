import assert from 'node:assert/strict';
import { Address, beginCell, serializeTuple } from '@ton/core';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { PUBLIC_RPC_ZERO_STATES } from '../api/rpcNetwork';
import { loadConfig } from '../config';
import type { ChainSource } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';

import { assertFreshReadBatch, type FreshReadBatch, type FreshReadCall } from '../data/freshRead';
import { createLiteChainSource } from '../data/liteClientSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

const address = `0:${'1'.repeat(64)}`;
const cell = beginCell().storeUint(7, 8).endCell();
const boc = cell.toBoc().toString('base64');
const zeroState = (network: 'testnet' | 'mainnet') => ({ workchain: -1,
  rootHash: Buffer.from(PUBLIC_RPC_ZERO_STATES[network].root_hash, 'base64'),
  fileHash: Buffer.from(PUBLIC_RPC_ZERO_STATES[network].file_hash, 'base64') });
const calls: FreshReadCall[] = [{ kind: 'account', address },
  { kind: 'getter', address, method: 'get_wallet_data', args: [] }];
const logger = { info() {}, debug() {}, error() {}, warn() {} };
const state = (balance = '101') => ({ balance, accountState: 'active' as const, codeBoc: boc, dataBoc: boc });
const batch = (queriedAt = Date.now()): FreshReadBatch => ({ network: 'testnet',
  readContext: { source: 'lite', queriedAt, head: { workchain: -1, shard: '-9223372036854775808', seqno: 101,
    rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) } },
  results: [{ kind: 'account', address, state: state() }, { kind: 'getter', address, exitCode: 0, stack: [] }] });
const stub = (readBatch?: () => Promise<FreshReadBatch>): ChainSource => fakeChainSource({ network: 'testnet',
  ...(readBatch ? { read: async () => { const batch = await readBatch();
    return { head: { ...batch.readContext.head, utime: 1_700_000_101 }, results: batch.results }; } } : {}) });
const makeService = (source: ChainSource) => {
  const config = { ...loadConfig(), network: 'testnet' as const };
  const store = new MemoryStore(config);
  store.setBalance(address, { ...state('999999999'), address, updatedAt: Date.now() });
  return new IndexerService(config, store, source, loadOpcodes(), []);
};

async function liteCases() {
  let wrongBlock = false;
  const master = proofBlock(101, 1_700_000_101, -1), shard = proofBlock(80, 1_700_000_100);
  const engine = new FakeLiteEngine(async request => {
    if (request.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(master);
    if (request.kind === 'liteServer.getAccountState') return { id: wrongBlock ? proofBlock(100, 1_700_000_100, -1).id : request.id,
      shardblk: shard.id, state: Buffer.alloc(0), proof: shard.proof, shardProof: Buffer.alloc(0) };
    if (request.kind === 'liteServer.runSmcMethod') return { id: wrongBlock ? proofBlock(100, 1_700_000_100, -1).id : request.id,
      shardblk: shard.id, exitCode: 17, result: serializeTuple([{ type: 'int', value: BigInt(request.id.seqno) }]).toBoc() };
    throw Error('unexpected wire request');
  });
  const create = (peer: FakeLiteEngine) => createLiteChainSource({ network: 'testnet', logger,
    peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => peer });
  const source = create(engine);
  try {
    const first = await source.read(calls);
    assert.equal(first.head.seqno, 101);
    assert.equal(first.head.utime, 1_700_000_101, 'Canonical block time is retained separately from request time');
    assert.equal(first.results[0].kind === 'account' && first.results[0].state.balance, '0');
    assert.equal(first.results[1].kind === 'getter' && first.results[1].stack[0].type === 'int' && first.results[1].stack[0].value, 101n);
    assert.equal(first.results[1].kind === 'getter' && first.results[1].exitCode, 17, 'VM denial is a result, never transport fallback');
    const concurrent = await Promise.all([source.read(calls), source.read(calls)]);
    assert.deepEqual(concurrent.map(value => value.head.seqno), [101, 101]);
    assert.equal(engine.requests.filter(row => row.request.kind === 'liteServer.getMasterchainInfoExt').length, 1,
      'The mandated one-second process head is shared; every account/getter is pinned to that exact block');
    wrongBlock = true;
    await assert.rejects(source.read([calls[0]]));
    await assert.rejects(source.read([calls[1]]));
  } finally { await source.close(); }
  for (const handler of [async () => ({ ...masterAnswer(master), init: zeroState('mainnet') }),
    async () => { throw Error('head unavailable'); }]) {
    const unavailable = create(new FakeLiteEngine(handler));
    try { await assert.rejects(unavailable.read(calls)); } finally { await unavailable.close(); }
  }
}

async function serviceCases() {
  const service = makeService(stub(async () => batch()));
  const fresh = await service.readFresh(calls);
  assert.equal(fresh.results[0].kind === 'account' && fresh.results[0].balance_raw, '101', 'Persisted balance cannot approve fresh readiness');
  await assert.rejects(makeService(stub()).readFresh(calls), 'Missing fresh capability cannot enter ordinary getters');
  assert.throws(() => assertFreshReadBatch(batch(Date.now() - 1000), calls, 'testnet', Date.now()), 'Old captured metadata cannot be called fresh');
  await assert.rejects(makeService(fakeChainSource({ ...stub(async () => batch()), network: 'mainnet' })).readFresh(calls));
  assert.throws(() => assertFreshReadBatch({ ...batch(), network: 'mainnet' }, calls, 'testnet', Date.now()));
  const incomplete = batch();
  if (incomplete.results[0].kind === 'account') incomplete.results[0].state.codeBoc = null;
  await assert.rejects(makeService(stub(async () => incomplete)).readFresh(calls));
  for (const pointer of [{ lastTxLt: '', lastTxHash: '' }, { lastTxLt: '0' },
    { lastTxLt: '1', lastTxHash: Buffer.alloc(32).toString('base64') }]) {
    const malformed = batch();
    if (malformed.results[0].kind === 'account') Object.assign(malformed.results[0].state, pointer);
    await assert.rejects(makeService(stub(async () => malformed)).readFresh(calls), 'Falsey or partial pointers cannot pass normalized fresh validation');
  }
  await assert.rejects(service.readFresh([{ kind: 'getter', address, method: 'open_order_preflight', args: [] }]));

  const differentOrder = batch(); differentOrder.results.reverse();
  assert.throws(() => assertFreshReadBatch(differentOrder, calls, 'testnet', Date.now()));
}

async function routeCases() {
  const runtime = runtimeManifestFixture();
  const metadata = { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' };
  const app = Fastify({ logger: false });
  registerRoutes(app, { network: 'testnet' }, makeService(stub(async () => batch())), undefined, undefined, undefined, undefined, {}, metadata);
  const body = { calls: [{ kind: 'account', address: Address.parse(address).toString() }, { kind: 'getter', address, method: 'get_wallet_data', stack: [] }] };
  try {
    const response = await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh', payload: body });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json().release, { releaseId: runtime.releaseId, manifestHash: runtime.manifestHash });
    assert.equal(response.json().results[0].address, address);
    assert.equal(response.json().results[0].balance_raw, '101');
    assert.equal(response.json().results[0].code_boc, boc);
    for (const payload of [{ calls: [] }, { calls: Array(33).fill(body.calls[0]) }, { ...body, fresh: false },
      { calls: [{ kind: 'getter', address, method: 'open_order_preflight', stack: [] }] },
      { calls: [{ kind: 'getter', address, method: 'valid', stack: [['unsupported', null]] }] }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/indexer/v1/readFresh', payload })).statusCode, 400);
    }
  } finally { await app.close(); }
  const wrong = Fastify({ logger: false });
  registerRoutes(wrong, { network: 'mainnet' }, makeService(stub(async () => { throw Error('wrong manifest must fail before source'); })),
    undefined, undefined, undefined, undefined, {}, metadata);
  try {
    const response = await wrong.inject({ method: 'POST', url: '/api/indexer/v1/readFresh', payload: body });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'fresh_read_unavailable');
  } finally { await wrong.close(); }
}

async function main() {
  await liteCases(); await serviceCases(); await routeCases();
  console.log('fresh same-head account/getter reads ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
