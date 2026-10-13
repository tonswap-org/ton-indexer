import { FakeLiteEngine } from './support/fakeLiteEngine';
import { fixtureChainSource, type FixtureChainSource } from './support/chainFixture';
import assert from 'node:assert/strict';
import { Address, Cell, beginCell, loadTransaction } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import fastify from 'fastify';
import {RawTransaction} from '../data/dataSource';
import { decodeOriginalTransaction, assertOriginalTransactionPage, readOriginalTransactionEvidence, originalTransactionToToncenter } from '../data/transactionEvidence';
import { createLiteChainSource } from '../data/liteClientSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadConfig } from '../config';
import { loadOpcodes } from '../utils/opcodes';
import { registerRoutes } from '../api/routes';

export async function runTransactionEvidenceTests() {
  let checks = 0;
  const test = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); checks++; console.log('PASS transaction evidence:', name);
  };
  const chain = await Blockchain.create();
  const owner = await chain.treasury('original-evidence-owner', { balance: 10n ** 25n });
  const recipient = await chain.treasury('original-evidence-recipient');
  for (let index = 0; index < 54; index++) {
    await owner.send({ to: recipient.address, value: index === 0 ? 9007199254740993125n : 10000000n,
      body: beginCell().storeUint(0x11112222, 32).storeUint(index, 64).endCell() });
  }
  const emitted = await chain.getTransactions(owner.address, { limit: 100 });
  const page = emitted.map((tx) => decodeOriginalTransaction(tx.raw, owner.address));
  assert.ok(page.length > 50);
  const head = page[0];
  const cursor = { lt: head.lt, hash: head.hash };
  let calls: Array<{ lt: string; hash: string; limit: number }> = [];
  let accountReads = 0;
  const makeSource = (read = async (_address: string, limit: number, lt?: string, hash?: string) => {
    calls.push({ lt: lt!, hash: hash!, limit });
    const start = page.findIndex((row) => row.lt === lt && row.hash === hash);
    return start < 0 ? [] : page.slice(start, start + Math.min(limit, 7));
  }): FixtureChainSource => (fixtureChainSource({
    network: 'testnet', getTransactions: read,
    async getAccountState() { accountReads++; return { balance: '0', accountState: 'active', lastTxLt: head.lt, lastTxHash: head.hash }; },
    async head() { return { seqno: 1 }; }, async runGetMethod() { return null; },
    async walletBalance() { return null; }, async jettonMetadata() { return null; }, async close() {},
  }));
  await test('50 original transactions span provider pages, linked from the actual account head', async () => {
    const read = await readOriginalTransactionEvidence(makeSource(), owner.address.toRawString(), 50);
    assert.equal(accountReads, 1); assert.equal(read.length, 50); assert.equal(calls.length, 8);
    assert.deepEqual(read.map((tx) => tx.hash), page.slice(0, 50).map((tx) => tx.hash));
    read.forEach((row, index) => assert.equal(row.rawBoc, emitted[index].raw.toBoc().toString('base64')));
    calls.slice(1).forEach((call, index) => assert.equal(call.hash, page[(index + 1) * 7].hash));
  });
  await test('explicit inclusive cursors bypass current head and accept canonical numeric aliases', async () => {
    const before = accountReads;
    const read = await readOriginalTransactionEvidence(makeSource(), owner.address.toString(), 3, { lt: `00${page[9].lt}`, hash: page[9].hash });
    assert.deepEqual(read.map((row) => row.hash), page.slice(9, 12).map((row) => row.hash)); assert.equal(accountReads, before);
  });
  await test('an authentic genesis predecessor ends a short full-history response', async () => {
    const last = page[page.length - 1]; assert.equal(last.prevTransactionLt, '0');
    const read = await readOriginalTransactionEvidence(makeSource(), owner.address.toRawString(), 50, last);
    assert.equal(read.length, 1);
  });
  await test('missing original BOC fails even when every summary claims success', async () => {
    await assert.rejects(readOriginalTransactionEvidence(makeSource(async () => [{ ...head, rawBoc: undefined }]), owner.address.toRawString(), 1, cursor), /Original transaction BOC/);
  });
  await test('wrong account, workchain endpoint, malformed BOC, trailing cell data and false metadata fail', () => {
    assert.throws(() => decodeOriginalTransaction(emitted[0].raw, recipient.address), /different account/);
    assert.throws(() => decodeOriginalTransaction(emitted[0].raw, new Address(-1, owner.address.hash)), /destination|source/);
    assert.throws(() => assertOriginalTransactionPage([{ ...head, rawBoc: 'invalid' }], owner.address, cursor));
    const trailing = beginCell().storeSlice(emitted[0].raw.beginParse()).storeUint(1, 1).endCell();
    assert.throws(() => decodeOriginalTransaction(trailing, owner.address));
    for (const change of [{ lt: (BigInt(head.lt) + 1n).toString() }, { hash: Buffer.alloc(32, 7).toString('base64') }, { prevTransactionLt: '1' }, { prevTransactionHash: Buffer.alloc(32, 8).toString('base64') }]) {
      assert.throws(() => assertOriginalTransactionPage([{ ...head, ...change }], owner.address, cursor), /metadata/);
    }
  });
  await test('empty, disconnected, reordered, duplicated and cursor-excluding pages fail closed', async () => {
    for (const wrong of [[], [page[1]], [page[0], page[2]], [page[1], page[0]], [page[0], page[0]]]) {
      await assert.rejects(readOriginalTransactionEvidence(makeSource(async () => wrong), owner.address.toRawString(), 2, cursor), /exact cursor-inclusive linked/);
    }
    let n = 0;
    await assert.rejects(readOriginalTransactionEvidence(makeSource(async () => ++n === 1 ? [head] : [head]), owner.address.toRawString(), 2, cursor), /exact cursor-inclusive linked/);
    assert.equal(n, 2);
  });
  await test('oversized pages, missing head anchors, and invalid limits are rejected', async () => {
    await assert.rejects(readOriginalTransactionEvidence(makeSource(async () => page.slice(0, 2)), owner.address.toRawString(), 1, cursor), /exceeded/);
    for (const state of [{ balance: '0', accountState: 'active' as const }, { balance: '0', lastTxLt: head.lt }]) {
      await assert.rejects(readOriginalTransactionEvidence({ ...makeSource(), async getAccountState() { return state; } }, owner.address.toRawString(), 1), /anchor/);
    }
    for (const limit of [0, 51, 1.5]) await assert.rejects(readOriginalTransactionEvidence(makeSource(), owner.address.toRawString(), limit, cursor), /limit/);
    await assert.rejects(readOriginalTransactionEvidence(makeSource(), owner.address.toRawString(), 1, cursor, Date.now() - 1), /deadline/);
  });
  await test('an account with no transaction history returns an empty result without source scanning', async () => {
    const source = { ...makeSource(async () => { throw Error('must not scan'); }), async getAccountState() { return { balance: '0', accountState: 'uninitialized' as const }; } };
    assert.deepEqual(await readOriginalTransactionEvidence(source, recipient.address.toRawString(), 50), []);
  });
  await test('actual phase outcomes replace false source status; atomic fields retain exact precision', () => {
    const actual = assertOriginalTransactionPage([{ ...head, status: 'failed', success: false, utime: 0 }], owner.address, cursor)[0];
    assert.equal(actual.status, 'success'); assert.equal(actual.utime, emitted[0].now);
    const high = page.find((row) => row.outMessages.some((message) => message.value === '9007199254740993125'))!;
    assert.ok(high); const mapped = originalTransactionToToncenter(high);
    assert.equal(mapped.out_msgs.find((message) => message.value === '9007199254740993125')?.value, '9007199254740993125');
    assert.equal(mapped.data, high.rawBoc); assert.equal(mapped.description.compute_ph?.success, true);
  });
  await test('non-bouncing native funding is credited despite skipped execution on an uninitialized account', async () => {
    const uninitialized = Address.parseRaw(`0:${'7'.repeat(64)}`);
    const result = await owner.send({ to: uninitialized, value: 10000000n, bounce: false });
    const failed = result.transactions.find((tx) => tx.address === BigInt(`0x${uninitialized.hash.toString('hex')}`))!;
    const decoded = decodeOriginalTransaction(failed.raw, uninitialized);
    const mapped = originalTransactionToToncenter(decoded);
    assert.equal(decoded.status, 'success'); assert.equal(mapped.description.compute_ph?.type, 'skipped');
    assert.equal(mapped.description.action, undefined);
    assert.equal(mapped.description.aborted, 'aborted' in failed.description ? failed.description.aborted : undefined);
  });
  await test('Lite source retains the original provider cell and binds its block workchain', async () => {
    let wrong = false;
    const engine = new FakeLiteEngine(async request => {
      assert.equal(request.kind, 'liteServer.getTransactions');
      assert.equal(request.account.workchain, owner.address.workChain);
      assert.ok(request.account.id.equals(owner.address.hash));
      assert.equal(request.lt, head.lt); assert.equal(request.hash.toString('base64'), head.hash);
      return { ids: [{ workchain: wrong ? -1 : 0 }], transactions: emitted[0].raw.toBoc() };
    });
    const source = createLiteChainSource({ network: 'testnet', logger: { info() {}, debug() {}, warn() {}, error() {} },
      peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => engine });
    try {
      const read = await source.getTransactions(owner.address.toRawString(), 1, head.lt, head.hash);
      assert.equal(read[0].rawBoc, head.rawBoc);
      wrong = true;
      await assert.rejects(source.getTransactions(owner.address.toRawString(), 1, head.lt, head.hash),
        (error: any) => error.code === 'upstream_unavailable' && /workchain/.test(error.cause?.message));
    } finally { await source.close(); }
  });
  await test('real service plus both HTTP routes return decodable BOCs, honor cap, and never read summary caches', async () => {
    const config = { ...loadConfig(), network: 'testnet' as const, initialHistoryTimeoutMs: 10000 };
    const service = new IndexerService(config, new MemoryStore(config), makeSource(), loadOpcodes(), []);
    service.getTransactions = async () => { throw Error('summary cache is not evidence'); };
    service.getTransactionsByCursor = async () => { throw Error('summary cursor is not evidence'); };
    const app = fastify({ logger: false }); registerRoutes(app, config, service); await app.ready();
    try {
      for (const url of ['/jsonRPC', '/api/v2/jsonRPC']) {
        const response = await app.inject({ method: 'POST', url, payload: { id: 'original', jsonrpc: '2.0', method: 'getTransactions', params: { address: owner.address.toRawString(), limit: 999 } } });
        const body = response.json(); assert.equal(body.id, 'original'); assert.equal(body.ok, true); assert.equal(body.result.length, 50);
        body.result.forEach((row: any, index: number) => {
          const cell = Cell.fromBase64(row.data); const tx = loadTransaction(cell.beginParse());
          assert.ok(cell.equals(emitted[index].raw)); assert.equal(tx.lt.toString(), row.transaction_id.lt); assert.equal(tx.hash().toString('base64'), row.transaction_id.hash);
        });
      }
    } finally { await app.close(); }
  });
  await test('HTTP evidence failure cannot return ok:true summary rows', async () => {
    const config = loadConfig();
    const service = new IndexerService(config, new MemoryStore(config), makeSource(async () => [{ ...head, rawBoc: undefined }]), loadOpcodes(), []);
    const app = fastify({ logger: false }); registerRoutes(app, config, service); await app.ready();
    try {
      const response = await app.inject({ method: 'POST', url: '/jsonRPC', payload: { id: 1, method: 'getTransactions', params: { address: owner.address.toRawString(), lt: head.lt, hash: head.hash } } });
      assert.equal(response.json().ok, false); assert.equal(response.json().result, undefined);
    } finally { await app.close(); }
  });
  console.log(`${checks} original transaction evidence checks passed (authentic local sandbox transactions; no live-chain success claim).`);
}

if (require.main === module) runTransactionEvidenceTests().catch((error) => { console.error(error); process.exitCode = 1; });
