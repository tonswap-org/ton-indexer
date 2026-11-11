import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { activeOrderAccount, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryHash, boundaryState, createPhysicalEvidenceReader, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { PRODUCT_EVIDENCE_LIMITS, ProductEvidenceError, productAddress, productUint, requireProduct } from './productEvidence';
import { launchCheck, readLaunchFactory } from './launchpadEvidenceState';

type Cursor = { lt: string; hash: string };
export type CurrentLaunchpadSalesRequest = { factory: string; limit: number; cursor: Cursor | null };
export function readLaunchpadSalesRequest(value: unknown, manifest: RuntimeReleaseManifest): CurrentLaunchpadSalesRequest {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value));
    const v = value as Record<string, unknown>;
    requireProduct(Object.keys(v).every(key => ['factory', 'limit', 'cursorLt', 'cursorHash'].includes(key)));
    const factory = productAddress(v.factory);
    if (factory !== manifest.contracts.SaleFactory?.address) throw new ProductEvidenceError(409, 'release_mismatch');
    requireProduct(typeof v.limit === 'string' && /^[1-9][0-9]?$/.test(v.limit));
    const limit = Number(v.limit); requireProduct(limit <= 50);
    requireProduct((v.cursorLt === undefined) === (v.cursorHash === undefined));
    let cursor: Cursor | null = null;
    if (v.cursorLt !== undefined) {
      productUint(v.cursorLt, 64, true);
      requireProduct(typeof v.cursorHash === 'string' && /^[0-9a-f]{64}$/.test(v.cursorHash));
      cursor = { lt: v.cursorLt as string, hash: v.cursorHash };
    }
    return { factory, limit, cursor };
  } catch (error) { if (error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400, 'bad_request'); }
}
export type CurrentLaunchpadSalesEvidence = {
  schema: 'tonswap-launchpad-sales-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: CurrentLaunchpadSalesRequest; coverage: { complete: boolean; gaps: PhysicalGap[] };
  transactions: OrderTransactionEvidence[]; nextCursor: Cursor | null;
};

/** A cursor names the first original transaction in the next page. Completeness
 * covers this linked page only; a zero predecessor is the sole history-end fact. */
export async function collectLaunchpadSalesEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  request: CurrentLaunchpadSalesRequest, signal?: AbortSignal): Promise<CurrentLaunchpadSalesEvidence> {
  signal?.throwIfAborted(); launchCheck(`ton:${source.network}` === manifest.network);
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: PRODUCT_EVIDENCE_LIMITS.newTransactions });
  const current = await reader.current(request.factory), pin = manifest.contracts.SaleFactory!.codeHash;
  readLaunchFactory(activeOrderAccount(orderShard(current.shardAccountBoc!, request.factory).shard, pin).data, manifest);
  let state = current;
  if (request.cursor) {
    const latest = orderShard(current.shardAccountBoc!, request.factory).shard;
    launchCheck(BigInt(request.cursor.lt) <= latest.lastTransactionLt
      && (BigInt(request.cursor.lt) !== latest.lastTransactionLt || request.cursor.hash === boundaryHash(latest.lastTransactionHash)));
    const boundary = await reader.exact(request.factory, request.cursor.lt, request.cursor.hash);
    state = boundaryState(request.factory, boundary.evidence.afterShardAccountBoc, boundary.seqno).state;
  }
  const initial = orderShard(state.shardAccountBoc!, request.factory).shard;
  let count = 0;
  const page = await reader.history(request.factory, state, request.limit, () => ++count === request.limit);
  const gaps = [...page.gaps], transactions: OrderTransactionEvidence[] = [];
  let nextCursor: Cursor | null = initial.lastTransactionLt > 0n
    ? { lt: initial.lastTransactionLt.toString(), hash: boundaryHash(initial.lastTransactionHash) } : null;
  if (initial.lastTransactionLt === 0n && initial.lastTransactionHash !== 0n) throw new ProductEvidenceError(503, 'upstream_unavailable');
  for (const row of page.rows) {
    try {
      const checked = verifyOrderTransaction(row.evidence);
      for (const shard of [checked.before, checked.after]) if (shard.account?.storage.state.type === 'active')
        readLaunchFactory(activeOrderAccount(shard, pin).data, manifest);
      if (checked.tx.prevTransactionLt === 0n && checked.tx.prevTransactionHash !== 0n) throw Error('Invalid history end');
      transactions.push(row.evidence);
      nextCursor = checked.tx.prevTransactionLt === 0n ? null
        : { lt: checked.tx.prevTransactionLt.toString(), hash: boundaryHash(checked.tx.prevTransactionHash) };
    } catch (error) {
      if (signal?.aborted) throw error;
      gaps.push({ code: 'factory_history_identity_unavailable', account: request.factory }); break;
    }
  }
  if (!page.complete && gaps.length === 0) gaps.push({ code: 'factory_page_unavailable', account: request.factory });
  const result: CurrentLaunchpadSalesEvidence = { schema: 'tonswap-launchpad-sales-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex }, request,
    coverage: { complete: gaps.length === 0, gaps }, transactions, nextCursor };
  if (Buffer.byteLength(JSON.stringify(result)) > PRODUCT_EVIDENCE_LIMITS.bytes) {
    result.transactions = []; result.coverage = { complete: false, gaps: [{ code: 'response_byte_limit', account: request.factory }] };
    result.nextCursor = initial.lastTransactionLt > 0n ? { lt: initial.lastTransactionLt.toString(), hash: boundaryHash(initial.lastTransactionHash) } : null;
  }
  assertFreshHeadTime(head.utime); signal?.throwIfAborted(); return result;
}
