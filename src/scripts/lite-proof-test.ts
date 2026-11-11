import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, CellType, Dictionary, beginCell, loadShardAccount, storeShardAccount, type DictionaryValue } from '@ton/core';
import { provenShardAccount, provenConfig, provenDictionaryValue, proofRoots } from '../data/liteProof';
import { createLiteChainSource } from '../data/liteClientSource';
import { FakeLiteEngine, proofBlock, proofMasterchain, merkleProof, multiProof } from './support/fakeLiteEngine';
import type { ChainHead } from '../data/dataSource';

const before = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/predecessor.boc')))[0];
const account = before.refs[0], address = loadShardAccount(before.beginParse()).account!.addr;
const config = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/config.boc')))[0];
const pruned = (cell: Cell) => beginCell().storeUint(CellType.PrunedBranch, 8).storeUint(1, 8)
  .storeBuffer(cell.hash(0)).storeUint(cell.depth(0), 16).endCell({ exotic: true });
const value: DictionaryValue<Cell> = {
  serialize: (cell, builder) => { builder.storeUint(0, 5).storeCoins(0).storeBit(false).storeSlice(cell.beginParse()); },
  parse: slice => slice.asCell(),
};
function pair(envelope: Cell | null = new Cell({ bits: before.bits, refs: [pruned(account)] }), key = address.hash, mapOverride?: Cell) {
  const accounts = Dictionary.empty(Dictionary.Keys.BigUint(256), value);
  if (envelope) accounts.set(BigInt(`0x${key.toString('hex')}`), envelope);
  const map = mapOverride ?? beginCell().storeDict(accounts).storeUint(0, 5).storeCoins(0).storeBit(false).endCell();
  const shard = proofBlock(70, 1000, 0, { accounts: map });
  const master = proofMasterchain(100, 1001, shard, config);
  const head: ChainHead = { workchain: -1, shard: master.id.shard, seqno: master.id.seqno, utime: 1001,
    rootHashHex: master.id.rootHash.toString('hex'), fileHashHex: master.id.fileHash.toString('hex') };
  return { shard, master, head, response: { block: master.id, shardBlock: shard.id, proof: shard.proof,
    shardProof: master.proof, raw: envelope ? account.toBoc() : Buffer.alloc(0) } };
}
let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`PASS ${name}`); }
async function main() {
  const good = pair();
  await check('original ShardAccount pointer bits and Account hash survive pruned expansion', () => {
    const proven = provenShardAccount(good.response, good.head, address)!;
    assert.ok(proven.equals(before));
    assert.ok(proven.bits.equals(before.bits));
    assert.ok(proven.refs[0].equals(account));
    assert.ok(provenShardAccount(pair(before).response, pair(before).head, address)!.equals(before));
  });
  await check('absent account requires actual dictionary absence; pruned path never means absence', () => {
    const empty = pair(null);
    assert.equal(provenShardAccount(empty.response, empty.head, address), null);
    assert.throws(() => provenShardAccount({ ...empty.response, raw: account.toBoc() }, empty.head, address));
    const neighbor = pair(undefined, Buffer.alloc(32, 3));
    assert.equal(provenShardAccount({ ...neighbor.response, raw: Buffer.alloc(0) }, neighbor.head, address), null);
    const dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Uint(8)).set(1, 7).set(200, 8);
    const root = beginCell().storeDictDirect(dict).endCell();
    const hidden = new Cell({ bits: root.bits, refs: [pruned(root.refs[0]), root.refs[1]] });
    assert.throws(() => provenDictionaryValue(hidden, 1n, 8), /pruned/);
    assert.equal(provenDictionaryValue(hidden, 200n, 8)!.loadUint(8), 8);
  });
  await check('tampered account, pointer, block, state, shard selector and masterchain head are rejected', () => {
    const wrongAccount = beginCell().storeBit(false).endCell();
    assert.throws(() => provenShardAccount({ ...good.response, raw: wrongAccount.toBoc() }, good.head, address));
    assert.throws(() => provenShardAccount({ ...good.response, shardProof: Buffer.alloc(0) }, good.head, address));
    assert.throws(() => provenShardAccount({ ...good.response, proof: multiProof(merkleProof(good.shard.cell), merkleProof(Cell.EMPTY)) }, good.head, address));
    const other = proofBlock(71, 1000);
    assert.throws(() => provenShardAccount({ ...good.response, shardBlock: other.id, proof: other.proof }, good.head, address));
    for (const changed of [{ utime: 1002 }, { seqno: 101 }, { rootHashHex: 'a'.repeat(64) }, { fileHashHex: 'b'.repeat(64) }])
      assert.throws(() => provenShardAccount(good.response, { ...good.head, ...changed }, address));
    assert.throws(() => provenShardAccount(good.response, good.head, Address.parse(`-1:${address.hash.toString('hex')}`)));
    const pointer = beginCell().storeRef(account).storeUint(123, 256).storeUint(456, 64).endCell();
    const altered = pair(pointer);
    assert.throws(() => provenShardAccount({ ...good.response, proof: altered.shard.proof }, good.head, address));
    const wrongDepth = beginCell().storeUint(CellType.PrunedBranch, 8).storeUint(1, 8).storeBuffer(account.hash(0))
      .storeUint(account.depth(0) + 1, 16).endCell({ exotic: true });
    const depthProof = pair(new Cell({ bits: before.bits, refs: [wrongDepth] }));
    assert.throws(() => provenShardAccount(depthProof.response, depthProof.head, address), /hash\/depth/);
  });
  await check('config retains original dictionary root and exact committed block/state/head time', () => {
    const [block, state] = proofRoots(good.master.proof, 2);
    assert.ok(provenConfig(block, state, good.master.id, good.head.utime).equals(config));
    assert.throws(() => provenConfig(block, state, good.master.id, good.head.utime + 1));
    assert.throws(() => provenConfig(block, good.shard.state, good.master.id, good.head.utime));
  });
  await check('actual ChainSource methods bind returned original account/config and reject mislabeled config head', async () => {
    let responseMode = '';
    const engine = new FakeLiteEngine(async request => {
      if (request.kind === 'liteServer.getAccountState') return { id: good.master.id, shardblk: good.shard.id,
        state: account.toBoc(), proof: good.shard.proof, shardProof: good.master.proof };
      if (request.kind === 'liteServer.lookupBlock') return { id: good.master.id, headerProof: good.master.headerProof };
      if (request.kind === 'liteServer.getBlock') return { id: good.master.id, data: good.master.cell.toBoc() };
      if (request.kind === 'liteServer.getConfigAll') return { id: good.master.id,
        stateProof: good.master.headerProof, configProof: merkleProof(responseMode === 'wrong-state' ? good.shard.state : good.master.state).toBoc() };
      throw Error(`unexpected query ${request.kind}`);
    });
    const source = createLiteChainSource({ network: 'testnet', logger: { info() {}, warn() {}, debug() {}, error() {} },
      peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => engine });
    try {
      const result = await source.getAccountState(address.toRawString(), { at: good.head });
      assert.ok(Cell.fromBase64(result.shardAccountBoc!).equals(before));
      assert.equal(result.provenAbsent, undefined);
      assert.equal(result.balance, loadShardAccount(before.beginParse()).account!.storage.balance.coins.toString());
      const configResult = await source.getConfig({ at: good.head });
      assert.deepEqual(configResult.head, good.head);
      assert.ok(Cell.fromBase64(configResult.configBoc).equals(config));
      await assert.rejects(source.getConfig({ at: { ...good.head, fileHashHex: 'c'.repeat(64) } }));
      await assert.rejects(source.getConfig({ at: { ...good.head, utime: 1002 } }));
      responseMode = 'wrong-state'; await assert.rejects(source.getConfig({ at: good.head }));
    } finally { await source.close(); }
  });
  await check('source marks only authenticated dictionary absence, never present uninitialized or unavailable/pruned state', async () => {
    const uninit = loadShardAccount(before.beginParse()); uninit.account!.storage.state = { type: 'uninit' };
    const uninitCell = beginCell().store(storeShardAccount(uninit)).endCell();
    const hidden = pair(null, address.hash, beginCell().storeBit(true).storeRef(pruned(Cell.EMPTY)).storeUint(0, 5).storeCoins(0).storeBit(false).endCell());
    for (const mode of ['absent','present-uninitialized','pruned','missing-proof','unavailable']) {
      const p = mode === 'present-uninitialized' ? pair(uninitCell) : mode === 'pruned' ? hidden : pair(null);
      const engine = new FakeLiteEngine(async request => {
        if (mode === 'unavailable') throw Error('source unavailable');
        if (request.kind === 'liteServer.getAccountState') return { id: p.master.id, shardblk: p.shard.id,
          state: mode === 'present-uninitialized' ? uninitCell.refs[0].toBoc() : Buffer.alloc(0),
          proof: mode === 'missing-proof' ? Buffer.alloc(0) : p.shard.proof, shardProof: p.master.proof };
        throw Error(`unexpected query ${request.kind}`);
      });
      const source = createLiteChainSource({ network: 'testnet', logger: { info() {}, warn() {}, debug() {}, error() {} },
        peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => engine });
      try {
        const read = source.getAccountState(address.toRawString(), { at: p.head, signal: AbortSignal.timeout(500) });
        if (mode === 'absent') {
          const result = await read; assert.equal(result.provenAbsent, true); assert.equal(result.shardAccountBoc, undefined);
          assert.equal(result.balance, '0'); assert.equal(result.codeBoc, null); assert.equal(result.dataBoc, null); assert.ok(result.anchor);
        } else if (mode === 'present-uninitialized') {
          const result = await read; assert.equal(result.provenAbsent, undefined); assert.equal(result.accountState, 'uninitialized');
          assert.ok(Cell.fromBase64(result.shardAccountBoc!).equals(uninitCell));
        } else await assert.rejects(read);
      } finally { await source.close(); }
    }
  });
  await check('config cancellation drains owned wire calls and leaves no completed config cache', async () => {
    const engine = new FakeLiteEngine(async request => {
      if (request.kind === 'liteServer.lookupBlock') return { id: good.master.id, headerProof: good.master.headerProof };
      return new Promise(() => {});
    });
    const source = createLiteChainSource({ network: 'testnet', logger: { info() {}, warn() {}, debug() {}, error() {} },
      peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => engine });
    try {
      await assert.rejects(source.getConfig({ at: good.head, signal: AbortSignal.timeout(30) }));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(engine.active, 0);
      const previous = engine.requests.length;
      await assert.rejects(source.getConfig({ at: good.head, signal: AbortSignal.timeout(30) }));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(engine.active, 0);
      assert.ok(engine.requests.length > previous);
    } finally { await source.close(); }
  });
  console.log(`Lite proof checks passed: ${checks}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
