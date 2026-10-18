import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadShardAccount, loadTransaction, storeMessage, type Message } from '@ton/core';
import { Executor, TreasuryContract } from '@ton/sandbox';
import { createLiteChainSource } from '../data/liteClientSource';
import { FakeLiteEngine, proofBlock, proofMasterchain, merkleProof, transactionAccountBlocks } from './support/fakeLiteEngine';
import { replayHistoricalAccount } from '../data/historicalReplay';

// Synthetic native-TVM replay regression, not captured chain/deployment evidence.
const config = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/config.boc')))[0];
const empty = beginCell().storeRef(beginCell().storeBit(false).endCell()).storeUint(0, 256).storeUint(0, 64).endCell();
const treasury = TreasuryContract.create(0, 1789n), address = treasury.address;
const seed = Buffer.alloc(32, 19), now = 1_800_000_000;
const sender = Address.parse(`0:${'4'.repeat(64)}`);
const blockFor = (tx: Cell) => {
  const master = beginCell().storeUint(0, 64).storeUint(1, 32).storeBuffer(Buffer.alloc(32, 1)).storeBuffer(Buffer.alloc(32, 2)).endCell();
  const info = beginCell().storeUint(0x9bc7a987, 32).storeUint(0, 32).storeBit(true).storeRef(master).endCell();
  const extra = beginCell().storeUint(0x4a33f6fd, 32).storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).storeRef(transactionAccountBlocks(tx)).storeBuffer(seed).endCell();
  return beginCell().storeUint(0x11ef55aa, 32).storeInt(-3, 32).storeRef(info).storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).storeRef(extra).endCell();
};
let checks = 0;
async function main() {
  const executor = await Executor.create();
  async function execute(before: Cell, lt: bigint, deploy: boolean) {
    const message: Message = { info: { type: 'internal', ihrDisabled: true, bounce: false, bounced: false,
      src: sender, dest: address, value: { coins: 2_000_000_000n }, ihrFee: 0n, forwardFee: 0n, createdLt: lt - 1n, createdAt: now },
      ...(deploy ? { init: treasury.init } : {}), body: Cell.EMPTY };
    const original = await executor.runTransaction({ config: config.toBoc().toString('base64'), libs: null, verbosity: 'short',
      shardAccount: before.toBoc().toString('base64'), message: beginCell().store(storeMessage(message)).endCell(), now, lt,
      randomSeed: seed, ignoreChksig: false, debugEnabled: false });
    if (!original.result.success) throw Error(original.result.error);
    const tx = Cell.fromBase64(original.result.transaction), after = Cell.fromBase64(original.result.shardAccount);
    const step = { transaction: tx, block: blockFor(tx), config };
    const input = { address, cursor: { lt: loadTransaction(tx.beginParse()).lt.toString(), hash: tx.hash().toString('hex') }, predecessor: before, steps: [step] };
    const replay = await replayHistoricalAccount(input, executor);
    assert.ok(Cell.fromBase64(replay.shardAccountBoc!).equals(after));
    assert.ok(Cell.fromBase64(replay.replayBoundary!.beforeShardAccountBoc).equals(before));
    assert.ok(Cell.fromBase64(replay.replayBoundary!.transactionBoc).equals(tx));
    assert.equal(replay.replayBoundary!.afterShardAccountBoc, replay.shardAccountBoc);
    return { after, replay, input };
  }
  const direct = await execute(empty, 1_000_000n, true);
  assert.equal(direct.replay.accountState, 'active'); checks++; console.log('PASS absent account deploy reproduces exact native transaction and retained boundary');
  const funded = await execute(empty, 2_000_000n, false);
  assert.equal(funded.replay.accountState, 'uninitialized');
  const initialized = await execute(funded.after, 3_000_000n, true);
  assert.equal(initialized.replay.accountState, 'active'); checks++; console.log('PASS existing uninitialized predecessor deploy preserves original funding pointer and exact boundary');
  const forged = beginCell().storeRef(empty.refs[0]).storeUint(1, 256).storeUint(1, 64).endCell();
  await assert.rejects(replayHistoricalAccount({ ...direct.input, predecessor: forged }, executor), /binding mismatch/);
  const malformed = beginCell().storeRef(beginCell().storeBit(false).storeBit(false).endCell()).storeUint(0, 256).storeUint(0, 64).endCell();
  await assert.rejects(replayHistoricalAccount({ ...direct.input, predecessor: malformed }, executor), /binding mismatch/);
  assert.equal(loadShardAccount(empty.beginParse()).account, undefined); checks++; console.log('PASS absent genesis cannot hide a nonzero predecessor or malformed Account-none root');
  async function sourceBoundary(example: Awaited<ReturnType<typeof execute>>, before: Cell | null) {
    const accounts = (envelope: Cell | null) => {
      const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), {
        serialize: (cell: Cell, builder: import('@ton/core').Builder) => { builder.storeUint(0, 5).storeCoins(0).storeBit(false).storeSlice(cell.beginParse()); },
        parse: (slice: import('@ton/core').Slice) => slice.asCell(),
      });
      if (envelope) dict.set(BigInt(`0x${address.hash.toString('hex')}`), envelope);
      return beginCell().storeDict(dict).storeUint(0, 5).storeCoins(0).storeBit(false).endCell();
    };
    const beforeShard = proofBlock(70, now - 1, 0, { accounts: accounts(before) });
    const beforeMaster = proofMasterchain(100, now - 1, beforeShard, config);
    const tx = example.input.steps[0].transaction;
    const afterShard = proofBlock(71, now, 0, { accounts: accounts(example.after), masterRef: beforeMaster.id,
      transaction: tx, randomSeed: seed });
    const afterMaster = proofMasterchain(101, now, afterShard, config);
    let mode = '';
    const engine = new FakeLiteEngine(async request => {
      if (request.kind === 'liteServer.lookupBlock') {
        const master = request.id.seqno === 100 ? beforeMaster : afterMaster;
        return { id: master.id, headerProof: master.headerProof };
      }
      if (request.kind === 'liteServer.getAccountState') {
        const previous = request.id.seqno === 100;
        const shard = previous ? beforeShard : afterShard, master = previous ? beforeMaster : afterMaster;
        return { id: master.id, shardblk: shard.id, proof: shard.proof, shardProof: master.proof,
          state: previous ? before?.refs[0].toBoc() ?? Buffer.alloc(0) : example.after.refs[0].toBoc() };
      }
      if (request.kind === 'liteServer.getTransactions') return { ids: [mode === 'unbound-block' ? beforeShard.id : afterShard.id], transactions: tx.toBoc() };
      if (request.kind === 'liteServer.getBlock') {
        const block = request.id.workchain === -1 ? beforeMaster : afterShard;
        return { id: block.id, data: block.cell.toBoc() };
      }
      if (request.kind === 'liteServer.getConfigAll') return { id: beforeMaster.id, stateProof: beforeMaster.headerProof,
        configProof: merkleProof(beforeMaster.state).toBoc() };
      throw Error(`unexpected source replay query ${request.kind}`);
    });
    const source = createLiteChainSource({ network: 'testnet', logger: { info() {}, warn() {}, debug() {}, error() {} },
      peers: [{ host: '127.0.0.1', port: 1, publicKey: Buffer.alloc(32) }], engineFactory: () => engine });
    try {
      const replay = await source.getAccountStateAtTransaction(address.toRawString(), example.input.cursor, 101);
      assert.ok(Cell.fromBase64(replay.shardAccountBoc!).equals(example.after));
      assert.ok(Cell.fromBase64(replay.replayBoundary!.beforeShardAccountBoc).equals(before ?? empty));
      assert.equal(replay.anchor!.shardBlock.rootHashHex, afterShard.id.rootHash.toString('hex'));
      assert.equal(replay.anchor!.genUtime, now);
      mode = 'unbound-block';
      await assert.rejects(source.getAccountStateAtTransaction(address.toRawString(), example.input.cursor, 101));
    } finally { await source.close(); }
  }
  await sourceBoundary(direct, null);
  await sourceBoundary(initialized, funded.after);
  checks++; console.log('PASS actual ChainSource returns final-block genesis boundaries only through complete synthetic MC/shard/config/account proof chain');
  console.log(`Historical genesis checks passed: ${checks}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
