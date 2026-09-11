import { createHash } from 'node:crypto';
import { Address, Cell, CellType, loadShardAccount, loadTransaction } from '@ton/core';
import { Executor, type IExecutor } from '@ton/sandbox';
import type { AccountStateResponse, TransactionCursor } from './dataSource';

export const MAX_HISTORICAL_REPLAY_TRANSACTIONS = 32;
export type ReplayBlockId = {
  workchain: number; shard: string; seqno: number; rootHash: Buffer; fileHash: Buffer;
};

export function verifiedReplayBlock(bytes: Buffer, id: ReplayBlockId): Cell {
  const roots = Cell.fromBoc(bytes);
  if (roots.length !== 1 || !roots[0].hash().equals(id.rootHash) ||
      !createHash('sha256').update(bytes).digest().equals(id.fileHash)) {
    throw new Error('Historical replay block hash mismatch.');
  }
  return roots[0];
}

export function replayBlockContext(block: Cell) {
  const s = block.beginParse();
  if (s.loadUint(32) !== 0x11ef55aa) throw new Error('Historical replay block tag.');
  s.loadInt(32);
  const info = s.loadRef().beginParse();
  s.loadRef(); s.loadRef();
  const extra = s.loadRef().beginParse();
  if (info.loadUint(32) !== 0x9bc7a987) throw new Error('Historical replay block info.');
  info.loadUint(32);
  if (!info.loadBoolean()) throw new Error('Historical replay requires a shard block.');
  const master = info.loadRef().beginParse();
  master.loadUintBig(64);
  const masterRef: ReplayBlockId = {
    workchain: -1, shard: '-9223372036854775808', seqno: master.loadUint(32),
    rootHash: master.loadBuffer(32), fileHash: master.loadBuffer(32),
  };
  if (extra.loadUint(32) !== 0x4a33f6fd) throw new Error('Historical replay block extra.');
  extra.loadRef(); extra.loadRef(); extra.loadRef();
  return { masterRef, randomSeed: extra.loadBuffer(32) };
}

export function cellTreeContains(root: Cell, hash: Buffer): boolean {
  const pending = [root], seen = new Set<string>();
  while (pending.length) {
    const cell = pending.pop()!;
    const key = cell.hash().toString('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    if (cell.hash().equals(hash)) return true;
    pending.push(...cell.refs);
  }
  return false;
}

export type HistoricalReplayStep = { transaction: Cell; block: Cell; config: Cell };

/** Reconstruct an unavailable intermediate account only when the complete TVM
 * transaction and Account hashes equal the original chain commitments. Missing
 * libraries/context and unsupported execution remain unavailable, never estimates. */
export async function replayHistoricalAccount(input: {
  address: Address;
  cursor: TransactionCursor;
  predecessor: Cell;
  steps: HistoricalReplayStep[];
}, executor?: IExecutor): Promise<AccountStateResponse> {
  if (!input.steps.length || input.steps.length > MAX_HISTORICAL_REPLAY_TRANSACTIONS) {
    throw new Error('Historical replay transaction bound.');
  }
  const expectedHash = /^[0-9a-f]{64}$/i.test(input.cursor.hash)
    ? Buffer.from(input.cursor.hash, 'hex') : Buffer.from(input.cursor.hash, 'base64');
  const final = input.steps[input.steps.length - 1].transaction;
  if (expectedHash.length !== 32 || !final.hash().equals(expectedHash) ||
      loadTransaction(final.beginParse()).lt.toString() !== input.cursor.lt) {
    throw new Error('Historical replay requested cursor mismatch.');
  }
  let shardAccount = input.predecessor;
  const engine = executor ?? await Executor.create();
  for (const step of input.steps) {
    const before = loadShardAccount(shardAccount.beginParse());
    const tx = loadTransaction(step.transaction.beginParse());
    if (!before.account?.addr.equals(input.address) ||
        tx.address !== BigInt(`0x${input.address.hash.toString('hex')}`) ||
        tx.prevTransactionLt !== before.lastTransactionLt ||
        tx.prevTransactionHash !== before.lastTransactionHash ||
        !tx.stateUpdate.oldHash.equals(shardAccount.refs[0].hash()) ||
        tx.description.type !== 'generic' || tx.inMessage?.info.type !== 'internal' ||
        !tx.inMessage.info.dest.equals(input.address) ||
        !cellTreeContains(step.block, step.transaction.hash())) {
      throw new Error('Historical replay original account/transaction binding mismatch.');
    }
    // Library references require an additional authenticated archive input. Do
    // not silently supply current libraries or sandbox defaults.
    const pending = [shardAccount], seen = new Set<string>();
    while (pending.length) {
      const cell = pending.pop()!, key = cell.hash().toString('hex');
      if (seen.has(key)) continue;
      seen.add(key);
      if (cell.type === CellType.Library) throw new Error('Historical replay library unavailable.');
      pending.push(...cell.refs);
    }
    const result = await engine.runTransaction({
      config: step.config.toBoc().toString('base64'), libs: null,
      verbosity: 'short', shardAccount: shardAccount.toBoc().toString('base64'),
      // Preserve the original message Cell, including wire layout and StateInit.
      message: step.transaction.refs[0].refs[0], now: tx.now, lt: tx.lt,
      randomSeed: replayBlockContext(step.block).randomSeed,
      ignoreChksig: false, debugEnabled: false,
    });
    if (!result.result.success) throw new Error('Historical replay execution unavailable.');
    const replayed = Cell.fromBase64(result.result.transaction);
    const after = Cell.fromBase64(result.result.shardAccount);
    const parsedAfter = loadShardAccount(after.beginParse());
    if (!replayed.equals(step.transaction) ||
        !after.refs[0]?.hash().equals(tx.stateUpdate.newHash) ||
        parsedAfter.lastTransactionLt !== tx.lt ||
        parsedAfter.lastTransactionHash !== BigInt(`0x${step.transaction.hash().toString('hex')}`) ||
        !parsedAfter.account?.addr.equals(input.address)) {
      throw new Error('Historical replay transaction/after-state commitment mismatch.');
    }
    shardAccount = after;
  }
  const state = loadShardAccount(shardAccount.beginParse());
  const account = state.account!;
  const active = account.storage.state.type === 'active' ? account.storage.state.state : null;
  return {
    balance: account.storage.balance.coins.toString(), lastTxLt: input.cursor.lt,
    lastTxHash: final.hash().toString('base64'),
    accountState: active ? 'active' : account.storage.state.type === 'frozen' ? 'frozen' : 'uninitialized',
    codeBoc: active?.code?.toBoc().toString('base64') ?? null,
    dataBoc: active?.data?.toBoc().toString('base64') ?? null,
  };
}
