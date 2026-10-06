import assert from 'node:assert/strict';
import { Address, beginCell, serializeTuple } from '@ton/core';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { PUBLIC_RPC_ZERO_STATES } from '../api/rpcNetwork';
import { loadConfig } from '../config';
import type { TonDataSource } from '../data/dataSource';
import { assertFreshReadBatch, type FreshReadBatch, type FreshReadCall } from '../data/freshRead';
import { LiteClientDataSource } from '../data/liteClientSource';
import { ResilientTonDataSource } from '../data/resilientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

const address = `0:${'1'.repeat(64)}`;
const cell = beginCell().storeUint(7, 8).endCell();
const boc = cell.toBoc().toString('base64');
const block = (seqno: number) => ({ workchain: -1, shard: '-9223372036854775808', seqno,
  rootHash: Buffer.alloc(32, seqno), fileHash: Buffer.alloc(32, seqno + 1) });
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
const stub = (readFresh?: TonDataSource['readFresh']): TonDataSource => ({ network: 'testnet', readFresh,
  async getMasterchainInfo() { return { seqno: 1 }; }, async getAccountState() { throw Error('ordinary state forbidden'); },
  async getTransactions() { return []; }, async runGetMethod() { throw Error('ordinary getter forbidden'); },
  async getJettonBalance() { return null; }, async getJettonMetadata() { return null; }, async close() {} });
const makeService = (source: TonDataSource) => {
  const config = { ...loadConfig(), network: 'testnet' as const };
  const store = new MemoryStore(config);
  store.setBalance(address, { ...state('999999999'), address, updatedAt: Date.now() });
  return new IndexerService(config, store, source, loadOpcodes(), []);
};

async function liteCases() {
  let heads = 0, ordinaryHeads = 0, cachedAccounts = 0, rawAccounts = 0;
  let wrongNetwork = false, wrongBlock = false, failedHead = false;
  let last = block(100);
  const client = {
    async getMasterchainInfo() { ordinaryHeads++; return { last: block(1) }; },
    async getMasterchainInfoExt() { heads++; if (failedHead) throw Error('head unavailable');
      last = block(100 + heads); return { last, init: zeroState(wrongNetwork ? 'mainnet' : 'testnet') }; },
    async getAccountState(_address: Address, at: ReturnType<typeof block>) {
      cachedAccounts++; return account(at, 999n);
    },
    async getAccountStateRaw(_address: Address, at: ReturnType<typeof block>) {
      rawAccounts++; return account(wrongBlock ? block(at.seqno + 1) : at, BigInt(at.seqno));
    },
    async runMethod(_address: Address, _method: string, _args: Buffer, at: ReturnType<typeof block>) {
      return { block: wrongBlock ? block(at.seqno + 1) : at, exitCode: 0,
        result: serializeTuple([{ type: 'int', value: BigInt(at.seqno) }]).toBoc().toString('base64') };
    }
  };
  function account(at: ReturnType<typeof block>, balance: bigint) {
    return { block: at, balance: { coins: balance }, lastTx: null, state: { storage: { state: { type: 'active', state: { code: cell, data: cell } } } } };
  }
  const source = Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource;
  await source.getAccountState(address); // Deliberately prime the ordinary cached old head.
  const first = await source.readFresh(calls);
  assert.equal(first.readContext.head.seqno, 101);
  assert.equal(first.results[0].kind === 'account' && first.results[0].state.balance, '101');
  assert.equal(first.results[1].kind === 'getter' && first.results[1].stack[0].type === 'int' && first.results[1].stack[0].value, 101n);
  assert.deepEqual([heads, ordinaryHeads, cachedAccounts, rawAccounts], [1, 1, 1, 1]);
  await source.readFresh(calls);
  assert.equal(heads, 2, 'A completed fresh head must not be reused');
  const pending = [source.readFresh(calls), source.readFresh(calls)];
  const concurrent = await Promise.all(pending);
  assert.deepEqual(concurrent.map(value => value.readContext.head.seqno), [103, 104], 'Fresh requests must not join an older head flight');
  wrongNetwork = true;
  await assert.rejects(source.readFresh(calls));
  wrongNetwork = false; wrongBlock = true;
  await assert.rejects(source.readFresh([calls[0]]));
  await assert.rejects(source.readFresh([calls[1]]));
  wrongBlock = false; failedHead = true;
  await assert.rejects(source.readFresh(calls));
  assert.equal(ordinaryHeads, 1, 'Fresh failures must not use the cached ordinary head');
}

async function httpCases() {
  let heads = 0, mismatch = false, missingStack = false;
  let coins: unknown = '101';
  let last: unknown = null;
  let accountState: unknown = { type: 'active', code: boc, data: boc };
  const encode = (value: ReturnType<typeof block>) => ({ ...value,
    rootHash: value.rootHash.toString('base64'), fileHash: value.fileHash.toString('base64') });
  const seen: number[] = [];
  const client = {
    async getLastBlock() { heads++; return { last: encode(block(100 + heads)),
      init: { rootHash: PUBLIC_RPC_ZERO_STATES.testnet.root_hash, fileHash: PUBLIC_RPC_ZERO_STATES.testnet.file_hash } }; },
    async getAccount(seqno: number) { seen.push(seqno); return { block: encode(block(mismatch ? seqno + 1 : seqno)),
      account: { balance: { coins }, state: accountState, last } }; },
    async getAccountLite(seqno: number) { return { account: { balance: { coins },
      state: { type: 'active', codeHash: cell.hash().toString('base64'), dataHash: cell.hash().toString('base64') }, last } }; },
    async runMethod(seqno: number) { seen.push(seqno); return { block: encode(block(mismatch ? seqno + 1 : seqno)), exitCode: 17,
      ...(missingStack ? {} : { result: [] }) }; }
  };
  const source = Reflect.construct(TonClient4DataSource, ['testnet', client, []]) as TonClient4DataSource;
  await source.getAccountState(address);
  const result = await source.readFresh(calls);
  assert.equal(heads, 2, 'Fresh HTTP read must acquire a new head after the ordinary cached head');
  assert.deepEqual(seen, [101, 102, 102]);
  assert.equal(result.results[1].kind === 'getter' && result.results[1].exitCode, 17, 'VM denial remains a truthful outcome');
  mismatch = true;
  await assert.rejects(source.readFresh([calls[0]]));
  await assert.rejects(source.readFresh([calls[1]]));
  mismatch = false;
  for (const malformed of [undefined, null, '', ' ', '-1', '01', '1.5', 0, 1.5, 0n]) {
    coins = malformed;
    await assert.rejects(source.readFresh([calls[0]]), 'Malformed atomic coins must not become a zero balance');
    await assert.rejects(source.getAccountState(address), 'Ordinary account reads must reject the same malformed balance');
    await assert.rejects(source.getAccountStateAtSeqno(address, 1), 'Archives must reject malformed balance');
    await assert.rejects(source.getAccountStateLite(address), 'Lite account reads must reject malformed balance');
  }
  coins = '0';
  assert.equal((await source.getAccountState(address)).balance, '0', 'An explicit atomic zero remains a valid balance');
  const zeroHash = Buffer.alloc(32).toString('base64');
  for (const malformed of [undefined, {}, { lt: '1' }, { hash: zeroHash }, { lt: '', hash: '' },
    { lt: '0', hash: '' }, { lt: '0', hash: Buffer.alloc(32, 1).toString('base64') }, { lt: '1', hash: zeroHash },
    { lt: '01', hash: zeroHash }, { lt: '-1', hash: zeroHash }, { lt: '18446744073709551616', hash: zeroHash },
    { lt: 0, hash: zeroHash }, { lt: '1', hash: 'invalid' }]) {
    last = malformed;
    await assert.rejects(source.readFresh([calls[0]]), 'A malformed transaction pointer cannot approve freshness');
    await assert.rejects(source.getAccountState(address), 'Ordinary reads must reject malformed pointers');
    await assert.rejects(source.getAccountStateLite(address), 'Lite reads must reject malformed pointers');
    await assert.rejects(source.getTransactions(address, 1), 'Malformed pointers cannot claim an empty history');
  }
  last = { lt: '0', hash: zeroHash };
  assert.equal((await source.readFresh([calls[0]])).results[0].kind, 'account', 'A complete zero chain pointer is valid');
  last = null;
  assert.equal((await source.getAccountState(address)).lastTxLt, undefined, 'Explicitly absent chain pointer remains absent');
  accountState = { type: 'uninit' };
  const unused = await source.readFresh([calls[0]]);
  assert.equal(unused.results[0].kind === 'account' && unused.results[0].state.accountState, 'uninitialized');
  assert.equal(unused.results[0].kind === 'account' && unused.results[0].state.codeBoc, null, 'Unused account has truthful null code');
  for (const malformed of [{ type: 'inactive' }, { type: 'uninitialized' }, 'active', { type: 'active' },
    { type: 'frozen', stateHash: '' }]) {
    accountState = malformed;
    await assert.rejects(source.getAccountState(address), 'Only the current HTTP account state shape is supported');
  }
  accountState = { type: 'active', code: boc, data: boc };
  missingStack = true;
  await assert.rejects(source.readFresh([calls[1]]), 'Missing current getter result must not become an empty stack');
}

async function serviceCases() {
  const service = makeService(stub(async () => batch()));
  const fresh = await service.readFresh(calls);
  assert.equal(fresh.results[0].kind === 'account' && fresh.results[0].balance_raw, '101', 'Persisted balance cannot approve fresh readiness');
  await assert.rejects(makeService(stub()).readFresh(calls), 'Missing fresh capability cannot enter ordinary getters');
  await assert.rejects(makeService(stub(async () => batch(Date.now() - 1000))).readFresh(calls), 'Old captured head cannot be called fresh');
  await assert.rejects(makeService(stub(async () => ({ ...batch(), network: 'mainnet' }))).readFresh(calls));
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

  const bad = stub(async () => { const value = batch();
    if (value.results[0].kind === 'account') value.results[0].state.codeBoc = null;
    return value; });
  const good = stub(async () => { const value = batch();
    if (value.results[0].kind === 'account') value.results[0].state.balance = '202';
    value.readContext.head.seqno = 202; return value; });
  const resilient = await new ResilientTonDataSource(bad, good).readFresh(calls);
  assert.equal(resilient.readContext.head.seqno, 202);
  assert.equal(resilient.results[0].kind === 'account' && resilient.results[0].state.balance, '202', 'Replace complete batch; never mix primary balance and fallback code');
  const otherNetwork = { ...good, network: 'mainnet' as const };
  await assert.rejects(new ResilientTonDataSource(bad, otherNetwork).readFresh(calls));
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
  await liteCases(); await httpCases(); await serviceCases(); await routeCases();
  console.log('fresh same-head account/getter reads ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
