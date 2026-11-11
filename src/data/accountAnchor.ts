import { Address, Cell, CellType, loadShardIdent } from '@ton/core';
import { ChainReadError, type AccountAnchor, type ChainHead, type TonBlockIdExt } from './dataSource';

type Block = { workchain: number; shard: string; seqno: number; rootHash: Buffer; fileHash: Buffer };
type AccountProof = { block: Block; shardBlock: Block; proof: Buffer };
const asId = (block: Block): TonBlockIdExt => {
  if (!Number.isSafeInteger(block.workchain) || !Number.isSafeInteger(block.seqno) || block.seqno < 0
    || !Buffer.isBuffer(block.rootHash) || block.rootHash.length !== 32 || !Buffer.isBuffer(block.fileHash) || block.fileHash.length !== 32
    || !/^-?[0-9]+$/.test(block.shard)) throw new Error('Malformed account anchor block');
  return { workchain: block.workchain, shard: block.shard, seqno: block.seqno,
    rootHashHex: block.rootHash.toString('hex'), fileHashHex: block.fileHash.toString('hex') };
};
const equal = (left: TonBlockIdExt, right: TonBlockIdExt) => left.workchain === right.workchain && left.shard === right.shard
  && left.seqno === right.seqno && left.rootHashHex === right.rootHashHex && left.fileHashHex === right.fileHashHex;
function merkleRoot(cell: Cell): Cell {
  if (cell.type !== CellType.MerkleProof || cell.refs.length !== 1) throw new Error('Malformed anchor Merkle proof');
  return cell.refs[0];
}
function identity(shard: ReturnType<typeof loadShardIdent>, seqno: number, expected: Block): void {
  if (shard.shardPrefixBits > 60) throw new Error('Invalid shard prefix');
  const id = BigInt.asIntN(64, shard.shardPrefix | (1n << BigInt(63 - shard.shardPrefixBits))).toString();
  if (shard.workchainId !== expected.workchain || seqno !== expected.seqno || id !== expected.shard)
    throw new Error('Anchor shard identity mismatch');
}
export function blockHeaderTime(block: Cell, expected: Block): number {
  if (!block.hash(0).equals(expected.rootHash)) throw new Error('Anchor block hash mismatch');
  const root = block.beginParse();
  if (root.loadUint(32) !== 0x11ef55aa) throw new Error('Invalid anchor block');
  root.loadInt(32);
  const info = root.loadRef().beginParse();
  if (info.loadUint(32) !== 0x9bc7a987) throw new Error('Invalid anchor block info');
  info.loadUint(32); info.loadUint(8); info.loadUint(8);
  const seqno = info.loadUint(32); info.loadUint(32);
  identity(loadShardIdent(info), seqno, expected);
  return info.loadUint(32);
}

/** Bind account time to its requested masterchain context and authenticated
 * shard block/state commitments. Never substitute a server-clock timestamp. */
export async function readAccountAnchor(response: AccountProof, at: ChainHead,
  getHeader: (block: Block) => Promise<{ id: Block; headerProof: Buffer }>, address?: string): Promise<AccountAnchor> {
  try {
    if (!equal(asId(response.block), at)) throw new Error('Anchor masterchain context mismatch');
    const shardBlock = asId(response.shardBlock);
    if (address) {
      const account = Address.parse(address);
      if (account.workChain !== shardBlock.workchain) throw new Error('Anchor account workchain mismatch');
      const tagged = BigInt.asUintN(64, BigInt(shardBlock.shard));
      if (!tagged) throw new Error('Invalid tagged shard');
      const bit = tagged & -tagged;
      const mask = BigInt.asUintN(64, -(bit << 1n));
      if ((account.hash.readBigUInt64BE() & mask) !== (tagged & mask)) throw new Error('Anchor account is outside the shard');
    }
    if (shardBlock.workchain === -1 && !equal(shardBlock, at)) throw new Error('Masterchain account has another block');
    let genUtime: number | undefined;
    if (response.proof.length) {
      const roots = Cell.fromBoc(response.proof);
      if (roots.length !== 2) throw new Error('Expected block and state proofs');
      const block = merkleRoot(roots[0]);
      if (!block.hash(0).equals(response.shardBlock.rootHash)) throw new Error('Anchor proof belongs to another block');
      const state = merkleRoot(roots[1]);
      const update = block.refs[2];
      if (update?.type !== CellType.MerkleUpdate || !update.refs[1]?.hash(0).equals(state.hash(0)))
        throw new Error('Shard state is not committed by the anchor block');
      if (state.type === CellType.Ordinary) {
        const slice = state.beginParse();
        if (slice.loadUint(32) !== 0x9023afe2) throw new Error('Invalid anchor shard state');
        slice.loadInt(32);
        const shard = loadShardIdent(slice), seqno = slice.loadUint(32);
        slice.loadUint(32); identity(shard, seqno, response.shardBlock);
        genUtime = slice.loadUint(32);
      }
    }
    if (genUtime === undefined) {
      const header = await getHeader(response.shardBlock);
      if (!equal(asId(header.id), shardBlock)) throw new Error('Anchor header belongs to another block');
      const roots = Cell.fromBoc(header.headerProof);
      if (roots.length !== 1) throw new Error('Invalid anchor header proof');
      genUtime = blockHeaderTime(merkleRoot(roots[0]), response.shardBlock);
    }
    if (!Number.isSafeInteger(genUtime) || genUtime <= 0 || genUtime > at.utime
      || (shardBlock.workchain === -1 && genUtime !== at.utime)) throw new Error('Invalid anchor chain time');
    return { shardBlock, genUtime };
  } catch (cause) { throw new ChainReadError('upstream_unavailable', { cause }); }
}
