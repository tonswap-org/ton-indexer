import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { beginCell, Cell, CellType, Dictionary, loadTransaction, storeShardIdent } from '@ton/core';
import { topologicalSort } from '@ton/core/dist/boc/cell/utils/topologicalSort';
import { getRefsDescriptor, getBitsDescriptor } from '@ton/core/dist/boc/cell/descriptor';
import { bitsToPaddedBuffer } from '@ton/core/dist/boc/utils/paddedBits';
import type { LiteEngine } from 'ton-lite-client';
import type { TLFunction } from 'ton-tl';
import type { LiteQueryOptions } from '../../data/boundedLiteEngine';
import { ChainReadError } from '../../data/dataSource';
import { PUBLIC_RPC_ZERO_STATES } from '../../api/rpcNetwork';
import type { ProofBlockId } from '../../data/liteProof';

export class FakeLiteEngine extends EventEmitter implements LiteEngine {
  ready = true;
  closed = false;
  active = 0;
  maximumActive = 0;
  requests: Array<{ request: any; options: LiteQueryOptions }> = [];
  constructor(public handler: (request: any, options: LiteQueryOptions) => Promise<unknown> = async () => { throw new Error('unexpected lite query'); }) { super(); }
  async query<REQ, RES>(_f: TLFunction<REQ, RES>, request: REQ, options: LiteQueryOptions = {}): Promise<RES> {
    this.requests.push({ request, options }); this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      return await new Promise<RES>((resolve, reject) => {
        const abort = () => { cleanup(); reject(options.signal?.reason ?? new ChainReadError('upstream_timeout')); };
        const cleanup = () => options.signal?.removeEventListener('abort', abort);
        if (options.signal?.aborted) { abort(); return; }
        options.signal?.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => this.handler(request, options)).then(value => { cleanup(); resolve(value as RES); }, error => { cleanup(); reject(error); });
      });
    } finally { this.active--; }
  }
  isReady() { return this.ready && !this.closed; }
  isClosed() { return this.closed; }
  close() { this.closed = true; this.ready = false; this.emit('close'); }
}

export function merkleProof(root: Cell): Cell {
  return beginCell().storeUint(CellType.MerkleProof, 8).storeBuffer(root.hash(0)).storeUint(root.depth(0), 16).storeRef(root).endCell({ exotic: true });
}
/** Test-only multi-root BOC; original release/capture fixtures are never rewritten. */
export function multiProof(...roots: Cell[]): Buffer {
  const wrapper = roots.reduce((builder, root) => builder.storeRef(root), beginCell()).endCell();
  const sorted = topologicalSort(wrapper).slice(1);
  const word = (value: number, bytes: number) => { const buffer = Buffer.alloc(bytes); buffer.writeUIntBE(value, 0, bytes); return buffer; };
  const records = sorted.map(({ cell, refs }) => Buffer.concat([
    Buffer.from([getRefsDescriptor([...cell.refs], cell.mask.value, cell.type), getBitsDescriptor(cell.bits)]),
    bitsToPaddedBuffer(cell.bits), ...refs.map(index => word(index - 1, 2)),
  ]));
  const bytes = Buffer.concat(records);
  return Buffer.concat([Buffer.from('b5ee9c720204', 'hex'), word(sorted.length, 2), word(roots.length, 2), word(0, 2), word(bytes.length, 4),
    ...roots.map(root => word(sorted.findIndex(row => row.cell.equals(root)), 2)), bytes]);
}

/** A one-account/one-transaction native augmented dictionary for synthetic tests. */
export function transactionAccountBlocks(transaction: Cell): Cell {
  const tx = loadTransaction(transaction.beginParse());
  // Both dictionaries use explicit long labels; augmentation is zero fees.
  const txs = beginCell().storeUint(2, 2).storeUint(64, 7).storeUint(tx.lt, 64)
    .storeCoins(0).storeBit(false).storeRef(transaction).endCell();
  const update = beginCell().storeUint(0x72, 8).storeBuffer(tx.stateUpdate.oldHash).storeBuffer(tx.stateUpdate.newHash).endCell();
  const leaf = beginCell().storeUint(2, 2).storeUint(256, 9).storeUint(tx.address, 256)
    .storeCoins(0).storeBit(false).storeUint(5, 4).storeUint(tx.address, 256)
    .storeSlice(txs.beginParse()).storeRef(update).endCell();
  return beginCell().storeBit(true).storeRef(leaf).storeCoins(0).storeBit(false).endCell();
}

export function proofBlock(seqno: number, utime: number, workchain = 0, options: {
  accounts?: Cell; extras?: Cell; masterRef?: ProofBlockId; transaction?: Cell; randomSeed?: Buffer;
} = {}) {
  const shard = { workchainId: workchain, shardPrefixBits: 0, shardPrefix: 0n };
  const state = beginCell().storeUint(0x9023afe2, 32).storeInt(-3, 32).store(storeShardIdent(shard))
    .storeUint(seqno, 32).storeUint(0, 32).storeUint(utime, 32).storeUint(0, 64).storeUint(0, 32)
    .storeRef(Cell.EMPTY).storeBit(false).storeRef(options.accounts ?? beginCell().storeBit(false).storeUint(0, 5).storeCoins(0).storeBit(false).endCell())
    .storeRef(Cell.EMPTY).storeMaybeRef(options.extras).endCell();
  const update = beginCell().storeUint(CellType.MerkleUpdate, 8).storeBuffer(state.hash(0)).storeBuffer(state.hash(0))
    .storeUint(state.depth(0), 16).storeUint(state.depth(0), 16).storeRef(state).storeRef(state).endCell({ exotic: true });
  const info = beginCell().storeUint(0x9bc7a987, 32).storeUint(0, 32).storeUint(workchain === -1 ? 0 : 128, 8).storeUint(0, 8)
    .storeUint(seqno, 32).storeUint(0, 32).store(storeShardIdent(shard)).storeUint(utime, 32);
  if (options.masterRef) info.storeRef(beginCell().storeUint(0, 64).storeUint(options.masterRef.seqno, 32)
    .storeBuffer(options.masterRef.rootHash).storeBuffer(options.masterRef.fileHash).endCell());
  const extra = options.transaction ? beginCell().storeUint(0x4a33f6fd, 32).storeRef(Cell.EMPTY).storeRef(Cell.EMPTY)
    .storeRef(transactionAccountBlocks(options.transaction)).storeBuffer(options.randomSeed ?? Buffer.alloc(32)).endCell() : Cell.EMPTY;
  const cell = beginCell().storeUint(0x11ef55aa, 32).storeInt(-3, 32).storeRef(info).storeRef(Cell.EMPTY).storeRef(update).storeRef(extra).endCell();
  const id = { kind: 'tonNode.blockIdExt' as const, workchain, shard: '-9223372036854775808', seqno,
    rootHash: cell.hash(), fileHash: createHash('sha256').update(cell.toBoc()).digest() };
  return { cell, state, id, headerProof: merkleProof(cell).toBoc(), proof: multiProof(merkleProof(cell), merkleProof(state)) };
}
/** Synthetic, cryptographically linked MC→shard proof; never release evidence. */
export function proofMasterchain(seqno: number, utime: number, shard: ReturnType<typeof proofBlock>, config = Cell.EMPTY) {
  const desc = beginCell().storeBit(false).storeUint(0xa, 4).storeUint(shard.id.seqno, 32).storeUint(seqno, 32)
    .storeUint(0, 64).storeUint(1, 64).storeBuffer(shard.id.rootHash).storeBuffer(shard.id.fileHash)
    .storeUint(0, 8).storeUint(0, 32).storeUint(0, 64).storeUint(0, 32).storeUint(utime, 32).storeBit(false)
    .storeRef(beginCell().storeCoins(0).storeBit(false).storeCoins(0).storeBit(false).endCell()).endCell();
  const shards = Dictionary.empty(Dictionary.Keys.Int(32), Dictionary.Values.Cell()).set(shard.id.workchain, desc);
  const extras = beginCell().storeUint(0xcc26, 16).storeDict(shards).storeUint(0, 256).storeRef(config)
    .storeRef(Cell.EMPTY).storeCoins(0).storeBit(false).endCell();
  return proofBlock(seqno, utime, -1, { extras });
}
export const masterAnswer = (block: ReturnType<typeof proofBlock>) => ({ kind: 'liteServer.masterchainInfoExt', mode: 0, version: 0, capabilities: '0',
  last: block.id, lastUtime: blockHeaderUtime(block), now: blockHeaderUtime(block), stateRootHash: Buffer.alloc(32),
  init: { kind: 'tonNode.zeroStateIdExt', workchain: -1, rootHash: Buffer.from(PUBLIC_RPC_ZERO_STATES.testnet.root_hash, 'base64'),
    fileHash: Buffer.from(PUBLIC_RPC_ZERO_STATES.testnet.file_hash, 'base64') } });
function blockHeaderUtime(block: ReturnType<typeof proofBlock>): number {
  const info = block.cell.refs[0].beginParse(); info.skip(32 + 32 + 8 + 8 + 32 + 32 + 2 + 6 + 32 + 64); return info.loadUint(32);
}
