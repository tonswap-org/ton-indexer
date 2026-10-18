import { Address, beginCell, Cell, CellType, loadDepthBalanceInfo, loadShardAccount, loadTransaction } from '@ton/core';
import type { RecoveryProofAnchor, RecoveryProofHistory } from './dataSource';
import { boundState, headProofBlock, provenDictionaryValue, provenShardAccount, proofRoots } from './liteProof';

const ensure = (ok: unknown, text = 'Invalid original recovery proof.') => { if (!ok) throw new Error(text); };
export function recoveryEnvelope(tree: Cell): Cell {
  return beginCell().storeUint(3, 8).storeBuffer(tree.hash(0)).storeUint(tree.depth(0), 16).storeRef(tree).endCell({ exotic: true });
}
export function validateRecoveryProofAnchor(a: RecoveryProofAnchor) {
  ensure(a && Object.keys(a).sort().join() === ['account','head','shardBlock','masterchainProofBoc','accountProofBoc','accountBoc','shardAccountBoc'].sort().join());
  const address = Address.parse(a.account); ensure(address.workChain === 0);
  const raw = { block: headProofBlock(a.head), shardBlock: headProofBlock({ ...a.shardBlock, utime: 0 }),
    shardProof: Buffer.from(a.masterchainProofBoc, 'base64'), proof: Buffer.from(a.accountProofBoc, 'base64'), raw: Buffer.from(a.accountBoc, 'base64') };
  const exact = provenShardAccount(raw, a.head, address);
  ensure(exact && exact.equals(Cell.fromBase64(a.shardAccountBoc)));
  const [masterBlock, masterState] = proofRoots(raw.shardProof, 2), [shardBlock, shardState] = proofRoots(raw.proof, 2);
  const { accounts } = boundState(shardBlock, shardState, raw.shardBlock), s = accounts.beginParse();
  ensure(s.loadBit()); const root = s.loadRef();
  const shard = loadShardAccount(exact!.beginParse()); ensure(shard.lastTransactionLt > 0n && shard.lastTransactionHash > 0n);
  return { bundle: recoveryEnvelope(beginCell().storeRef(masterBlock).storeRef(masterState).storeRef(shardBlock).storeRef(shardState).endCell()),
    root, key: BigInt('0x' + address.hash.toString('hex')), lt: shard.lastTransactionLt, hash: shard.lastTransactionHash };
}
/** The exact native prev_blocks path, including its augmented leaf. No list of
 * remembered block hashes substitutes for this original state commitment. */
export function validateRecoveryProofHistory(h: RecoveryProofHistory): Cell {
  ensure(h && Object.keys(h).sort().join() === ['head','anchor','blockBoc','stateBoc'].sort().join());
  ensure(h.anchor.seqno < h.head.seqno && h.anchor.workchain === -1 && h.head.workchain === -1);
  const block = Cell.fromBase64(h.blockBoc), state = Cell.fromBase64(h.stateBoc);
  const { extras } = boundState(block, state, headProofBlock(h.head)); ensure(extras);
  const e = extras!.beginParse(); ensure(e.loadUint(16) === 0xcc26);
  e.loadMaybeRef(); e.skip(256); e.loadRef();
  const info = e.loadRef().beginParse(); ensure(info.loadUint(16) <= 1); info.skip(32 + 32 + 1); ensure(info.loadBit());
  const leaf = provenDictionaryValue(info.loadRef(), BigInt(h.anchor.seqno), 32); ensure(leaf);
  leaf!.skip(1 + 64); leaf!.loadBit(); leaf!.skip(64);
  ensure(leaf!.loadUint(32) === h.anchor.seqno && leaf!.loadBuffer(32).toString('hex') === h.anchor.rootHashHex
    && leaf!.loadBuffer(32).toString('hex') === h.anchor.fileHashHex); leaf!.endParse();
  return recoveryEnvelope(beginCell().storeRef(block).storeRef(state).endCell());
}
export type RecoveryCursor = { hash: bigint; key: bigint; bits: number; lt: bigint };
/** Native dictionaryWalk advances at most 64 original edges per transaction. */
export function recoveryAccountChunk(root: Cell, key: bigint, bits: number) {
  let node = root, n = bits, selected = key;
  ensure(n > 0 && n <= 256);
  for (let i = 0; i < 64; i++) {
    ensure(node.type === CellType.Ordinary, 'Recovery account path is pruned.');
    const s = node.beginParse(), width = Math.ceil(Math.log2(n + 1)); let length = 0, prefix = 0n;
    if (!s.loadBit()) { while (s.loadBit()) { ensure(++length <= n); } prefix = length ? s.loadUintBig(length) : 0n; }
    else if (!s.loadBit()) { length = width ? s.loadUint(width) : 0; ensure(length <= n); prefix = length ? s.loadUintBig(length) : 0n; }
    else { const bit = s.loadBit(); length = width ? s.loadUint(width) : 0; ensure(length <= n); prefix = bit ? (1n << BigInt(length)) - 1n : 0n; }
    ensure(prefix === selected >> BigInt(n - length)); n -= length;
    if (!n) {
      loadDepthBalanceInfo(s); s.loadRef(); const hash = s.loadUintBig(256), lt = s.loadUintBig(64); s.endParse();
      return { proof: recoveryEnvelope(root), next: { hash, lt, key: 0n, bits: 0 }, done: true };
    }
    selected &= (1n << BigInt(n)) - 1n;
    const left = s.loadRef(), right = s.loadRef(); n--; node = (selected >> BigInt(n)) === 0n ? left : right;
    selected &= (1n << BigInt(n)) - 1n;
  }
  return { proof: recoveryEnvelope(root), next: { hash: BigInt('0x' + node.hash(0).toString('hex')), key: selected, bits: n, lt: 0n }, done: false };
}
/** Find a persisted native cursor only along the same authenticated account path. */
export function recoveryAccountPath(anchor: RecoveryProofAnchor, cursor: RecoveryCursor) {
  const p = validateRecoveryProofAnchor(anchor); let node = p.root, key = p.key, bits = 256;
  for (let chunk = 0; chunk < 5; chunk++) {
    if (BigInt('0x' + node.hash(0).toString('hex')) === cursor.hash && key === cursor.key && bits === cursor.bits && cursor.lt === 0n) return recoveryAccountChunk(node, key, bits);
    const result = recoveryAccountChunk(node, key, bits); ensure(!result.done, 'Recovery account cursor is not on the committed path.');
    const wanted = result.next.hash; let found: Cell | undefined;
    const queue = [node], seen = new Set<Cell>();
    while (queue.length) { const c = queue.pop()!; if (seen.has(c)) continue; seen.add(c); if (BigInt('0x' + c.hash(0).toString('hex')) === wanted) { found = c; break; } if (!c.isExotic) queue.push(...c.refs); }
    ensure(found); node = found!; key = result.next.key; bits = result.next.bits;
  }
  throw new Error('Recovery account cursor exceeds the native path bound.');
}
export function recoveryTransactionChunk(account: string, originals: readonly string[], cursor: RecoveryCursor, target: { lt: bigint; hash: bigint }) {
  ensure(originals.length > 0 && originals.length <= 4 && cursor.bits === 0 && cursor.key === 0n && target.lt > 0n);
  const address = Address.parse(account); let hash = cursor.hash, lt = cursor.lt;
  const cells: Cell[] = []; let final: ReturnType<typeof loadTransaction> | undefined;
  for (const boc of originals) {
    const cell = Cell.fromBase64(boc); ensure(!cell.isExotic);
    const tx = loadTransaction(cell.beginParse()); ensure(tx.address === BigInt('0x' + address.hash.toString('hex'))
      && tx.lt === lt && BigInt('0x' + cell.hash().toString('hex')) === hash && lt >= target.lt);
    cells.push(cell); final = tx; hash = tx.prevTransactionHash; lt = tx.prevTransactionLt;
  }
  ensure(final); const done = final!.lt === target.lt;
  ensure(done ? BigInt('0x' + cells.at(-1)!.hash().toString('hex')) === target.hash : lt >= target.lt && (lt !== target.lt || hash === target.hash));
  let suffix: Cell | null = null;
  for (let i = cells.length - 1; i >= 0; i--) suffix = beginCell().storeRef(recoveryEnvelope(cells[i])).storeMaybeRef(suffix).endCell();
  return { proof: suffix!, done, next: { hash, lt, key: 0n, bits: 0 } };
}
