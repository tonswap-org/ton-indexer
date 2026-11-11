import { Address, Cell, CellType, type Slice, loadAccount, loadDepthBalanceInfo, loadShardIdent } from '@ton/core';
import { blockHeaderTime } from './accountAnchor';
import type { ChainHead } from './dataSource';

export type ProofBlockId = { workchain: number; shard: string; seqno: number; rootHash: Buffer; fileHash: Buffer };
export const sameProofBlock = (a: ProofBlockId, b: ProofBlockId) => a.workchain === b.workchain && a.shard === b.shard
  && a.seqno === b.seqno && a.rootHash.equals(b.rootHash) && a.fileHash.equals(b.fileHash);
export const headProofBlock = (head: ChainHead): ProofBlockId => ({ ...head,
  rootHash: Buffer.from(head.rootHashHex, 'hex'), fileHash: Buffer.from(head.fileHashHex, 'hex') });

export function proofRoots(bytes: Buffer, count: number): Cell[] {
  const roots = Cell.fromBoc(bytes);
  if (roots.length !== count || roots.some(root => root.type !== CellType.MerkleProof || root.refs.length !== 1)) {
    throw new Error('Invalid lite Merkle proof roots.');
  }
  return roots.map(root => root.refs[0]);
}

/** Follow only the requested dictionary path. A pruned path is unavailable,
 * never evidence that the key is absent (Dictionary.load skips pruned branches). */
export function provenDictionaryValue(root: Cell, key: bigint, width: number): Slice | null {
  let cell = root, remaining = width;
  for (;;) {
    if (cell.type !== CellType.Ordinary) throw new Error('Requested dictionary path is pruned.');
    const slice = cell.beginParse();
    let length = 0, label = 0n;
    const sizeBits = Math.ceil(Math.log2(remaining + 1));
    if (!slice.loadBit()) {
      while (slice.loadBit()) { if (++length > remaining) throw new Error('Invalid dictionary label.'); }
      label = length ? slice.loadUintBig(length) : 0n;
    } else if (!slice.loadBit()) {
      length = sizeBits ? slice.loadUint(sizeBits) : 0;
      if (length > remaining) throw new Error('Invalid dictionary label.');
      label = length ? slice.loadUintBig(length) : 0n;
    } else {
      const bit = slice.loadBit();
      length = sizeBits ? slice.loadUint(sizeBits) : 0;
      if (length > remaining) throw new Error('Invalid dictionary label.');
      label = bit ? (1n << BigInt(length)) - 1n : 0n;
    }
    if ((key >> BigInt(remaining - length)) !== label) return null;
    remaining -= length;
    key &= (1n << BigInt(remaining)) - 1n;
    if (!remaining) return slice;
    const left = slice.loadRef(), right = slice.loadRef();
    remaining--;
    cell = (key >> BigInt(remaining)) === 0n ? left : right;
    key &= (1n << BigInt(remaining)) - 1n;
  }
}

function stateParts(root: Cell, expected: ProofBlockId) {
  const s = root.beginParse();
  if (s.loadUint(32) !== 0x9023afe2) throw new Error('Invalid proven shard state.');
  s.loadInt(32);
  const shard = loadShardIdent(s), seqno = s.loadUint(32);
  if (shard.shardPrefixBits > 60 || shard.workchainId !== expected.workchain || seqno !== expected.seqno
    || BigInt.asIntN(64, shard.shardPrefix | (1n << BigInt(63 - shard.shardPrefixBits))).toString() !== expected.shard) {
    throw new Error('Proven shard state identity mismatch.');
  }
  s.loadUint(32); const utime = s.loadUint(32);
  s.loadUintBig(64); s.loadUint(32); s.loadRef(); s.loadBit();
  const accounts = s.loadRef(); s.loadRef();
  const extras = s.loadBit() ? s.loadRef() : null;
  s.endParse();
  return { utime, accounts, extras };
}

export function boundState(block: Cell, state: Cell, expected: ProofBlockId) {
  const utime = blockHeaderTime(block, expected), update = block.refs[2];
  if (update?.type !== CellType.MerkleUpdate || !update.refs[1]?.hash(0).equals(state.hash(0))
    || update.refs[1].depth(0) !== state.depth(0)) throw new Error('State is not committed by the requested block.');
  const parts = stateParts(state, expected);
  if (parts.utime !== utime) throw new Error('Proven block/state time mismatch.');
  return parts;
}

function masterExtra(state: ReturnType<typeof stateParts>) {
  if (!state.extras) throw new Error('Masterchain state extra is unavailable.');
  const extra = state.extras.beginParse();
  if (extra.loadUint(16) !== 0xcc26) throw new Error('Invalid masterchain state extra.');
  return extra;
}

/** Original ConfigParams root, without dictionary reserialization. */
export function provenConfig(block: Cell, state: Cell, expected: ProofBlockId, expectedTime: number): Cell {
  if (expected.workchain !== -1 || expected.shard !== '-9223372036854775808') throw new Error('Config requires a masterchain block.');
  const parts = boundState(block, state, expected);
  if (parts.utime !== expectedTime) throw new Error('Config head time mismatch.');
  const extra = masterExtra(parts);
  if (extra.loadBit()) extra.loadRef();
  extra.loadUintBig(256);
  const config = extra.loadRef();
  if (config.type !== CellType.Ordinary) throw new Error('Config dictionary is pruned.');
  return config;
}

function bindShardToMasterchain(shard: ProofBlockId, proof: Buffer, head: ChainHead) {
  const master = headProofBlock(head);
  if (master.workchain !== -1 || master.shard !== '-9223372036854775808') throw new Error('Account requires a masterchain head.');
  if (sameProofBlock(shard, master)) return;
  const [block, state] = proofRoots(proof, 2);
  const parts = boundState(block, state, master);
  if (parts.utime !== head.utime) throw new Error('Masterchain proof time mismatch.');
  const extra = masterExtra(parts);
  if (!extra.loadBit()) throw new Error('Masterchain has no shard hashes.');
  const wc = provenDictionaryValue(extra.loadRef(), BigInt.asUintN(32, BigInt(shard.workchain)), 32);
  if (!wc) throw new Error('Workchain is absent from the selected masterchain state.');
  let tree = wc.loadRef(); wc.endParse();
  const tagged = BigInt.asUintN(64, BigInt(shard.shard));
  let prefix = 0n, depth = 0;
  for (;;) {
    const branch = tree.beginParse();
    if (!branch.loadBit()) {
      if ((prefix | (1n << BigInt(63 - depth))) !== tagged) throw new Error('Shard prefix differs from the selected masterchain state.');
      const tag = branch.loadUint(4);
      if (tag !== 0xa && tag !== 0xb) throw new Error('Unsupported shard descriptor.');
      const seqno = branch.loadUint(32); branch.loadUint(32); branch.skip(128);
      if (seqno !== shard.seqno || !branch.loadBuffer(32).equals(shard.rootHash)
        || !branch.loadBuffer(32).equals(shard.fileHash)) throw new Error('Shard block is not selected by the requested masterchain state.');
      return;
    }
    if (depth >= 60) throw new Error('Invalid shard tree depth.');
    const rightward = (tagged & (1n << BigInt(63 - depth))) !== 0n;
    const left = branch.loadRef(), right = branch.loadRef(); branch.endParse();
    if (rightward) prefix |= 1n << BigInt(63 - depth);
    tree = rightward ? right : left; depth++;
  }
}

export function provenShardAccount(response: { block: ProofBlockId; shardBlock: ProofBlockId; proof: Buffer; shardProof: Buffer; raw: Buffer },
  head: ChainHead, address: Address): Cell | null {
  if (!sameProofBlock(response.block, headProofBlock(head))) throw new Error('Account masterchain head mismatch.');
  if (response.shardBlock.workchain !== address.workChain) throw new Error('Account proof workchain mismatch.');
  const tagged = BigInt.asUintN(64, BigInt(response.shardBlock.shard));
  if (!tagged) throw new Error('Invalid shard identifier.');
  const mask = BigInt.asUintN(64, -((tagged & -tagged) << 1n));
  if ((address.hash.readBigUInt64BE() & mask) !== (tagged & mask)) throw new Error('Account is outside the proven shard.');
  bindShardToMasterchain(response.shardBlock, response.shardProof, head);
  const [block, root] = proofRoots(response.proof, 2);
  const { accounts, utime } = boundState(block, root, response.shardBlock);
  if (utime > head.utime || (address.workChain === -1 && utime !== head.utime)) throw new Error('Account proof time mismatch.');
  const map = accounts.beginParse();
  const leaf = map.loadBit() ? provenDictionaryValue(map.loadRef(), BigInt(`0x${address.hash.toString('hex')}`), 256) : null;
  if (!leaf) {
    if (response.raw.length) throw new Error('Account bytes supplied for a proven absent account.');
    return null;
  }
  loadDepthBalanceInfo(leaf);
  const original = leaf.asCell();
  if (original.bits.length !== 320 || original.refs.length !== 1) throw new Error('Invalid original ShardAccount envelope.');
  const roots = Cell.fromBoc(response.raw);
  if (roots.length !== 1 || roots[0].type !== CellType.Ordinary) throw new Error('Invalid original Account bytes.');
  const account = roots[0], reference = original.refs[0];
  if (!account.hash(0).equals(reference.hash(0)) || account.depth(0) !== reference.depth(0)) throw new Error('Account bytes differ from their proven hash/depth.');
  const pending = [account], seen = new Set<Cell>();
  while (pending.length) {
    const cell = pending.pop()!;
    if (seen.has(cell)) continue;
    seen.add(cell);
    if (cell.type !== CellType.Ordinary && cell.type !== CellType.Library) throw new Error('Original Account bytes contain an unresolved proof branch.');
    pending.push(...cell.refs);
  }
  const data = account.beginParse();
  if (!data.loadBit() || !loadAccount(data).addr.equals(address)) throw new Error('Proven account address mismatch.');
  data.endParse();
  // Retain the dictionary's exact 320 pointer bits. Expand only the already
  // committed Account reference; never rebuild ShardAccount from SDK summaries.
  const expanded = new Cell({ bits: original.bits, refs: [account] });
  if (!expanded.hash(0).equals(original.hash(0)) || expanded.depth(0) !== original.depth(0)) throw new Error('Account expansion changed its proven envelope.');
  return expanded;
}
