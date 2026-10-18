import { Cell, CellType } from '@ton/core';
import { ChainReadError, type ChainHead, type ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { orderShard } from '../orders/evidence';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';

export const ACCOUNT_STORAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Reject partial source proofs in this endpoint. A retained original account
 * plus the complete authenticated configuration lets the client independently
 * price its actual storage interval without server-side rounding or defaults. */
function fullBoc(boc: string) {
  if (boc.length > ACCOUNT_STORAGE_MAX_BYTES) throw new ChainReadError('upstream_unavailable');
  const roots = Cell.fromBoc(Buffer.from(boc, 'base64'));
  if (roots.length !== 1 || roots[0].isExotic) throw new ChainReadError('upstream_unavailable');
  const visited = new Set<Cell>(), pending = [roots[0]];
  while (pending.length) {
    const cell = pending.pop()!; if (visited.has(cell)) continue; visited.add(cell);
    if (visited.size > 100_000 || [CellType.PrunedBranch, CellType.MerkleProof, CellType.MerkleUpdate].includes(cell.type))
      throw new ChainReadError('upstream_unavailable');
    pending.push(...cell.refs);
  }
  return roots[0];
}
export async function readAccountStorage(manifest: RuntimeReleaseManifest, source: ChainSource, address: string, head: ChainHead, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (`ton:${source.network}` !== manifest.network) throw new ChainReadError('upstream_unavailable');
  const [state, config] = await Promise.all([source.getAccountState(address, { at: head, signal }), source.getConfig({ at: head, signal })]);
  signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
  if ((['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex', 'utime'] as const).some(key => config.head[key] !== head[key])
    || !state.shardAccountBoc || state.accountState !== 'active' || !state.anchor || !Number.isSafeInteger(state.anchor.genUtime)
    || state.anchor.genUtime <= 0 || state.anchor.genUtime > head.utime)
    throw new ChainReadError('upstream_unavailable');
  fullBoc(state.shardAccountBoc); fullBoc(config.configBoc);
  const shard = orderShard(state.shardAccountBoc, address).shard, actual = shard.account?.storage;
  if (!actual || actual.state.type !== 'active' || !state.lastTxHash || state.lastTxLt !== shard.lastTransactionLt.toString()
    || Buffer.from(state.lastTxHash, /^[0-9a-f]{64}$/i.test(state.lastTxHash) ? 'hex' : 'base64').toString('hex') !== shard.lastTransactionHash.toString(16).padStart(64, '0')
    || state.balance !== actual.balance.coins.toString()) throw new ChainReadError('upstream_unavailable');
  const result = { schema: 'tonswap-account-storage-v1' as const, releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    account: { address, shardAccountBoc: state.shardAccountBoc }, configBoc: config.configBoc };
  if (Buffer.byteLength(JSON.stringify(result)) > ACCOUNT_STORAGE_MAX_BYTES) throw new ChainReadError('upstream_unavailable');
  return result;
}
