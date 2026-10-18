import { Cell, loadMessage } from '@ton/core';
import type { ChainHead, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { activeOrderAccount, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';

export const PRODUCT_EVIDENCE_LIMITS = Object.freeze({ accounts: 16, history: 256, transactions: 256, newTransactions: 64,
  edges: 1024, gaps: 256, bytes: 8 * 1024 * 1024 });
export class ProductEvidenceError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: 'bad_request' | 'release_mismatch' | 'upstream_unavailable') {
    super(status === 400 ? 'The original operation request is invalid.' : status === 409
      ? 'The operation belongs to another release.' : 'Current original operation evidence is unavailable.');
  }
}
export function requireProduct(ok: unknown): asserts ok { if (!ok) throw new ProductEvidenceError(400, 'bad_request'); }
export function productUint(value: unknown, bits: number, positive = false): bigint {
  requireProduct(typeof value === 'string' && /^(0|[1-9][0-9]{0,36})$/.test(value));
  const n = BigInt(value); requireProduct(n < 1n << BigInt(bits) && (!positive || n > 0n)); return n;
}
export function productAddress(value: unknown): string {
  requireProduct(typeof value === 'string' && /^0:[0-9a-f]{64}$/.test(value) && value !== `0:${'0'.repeat(64)}`); return value;
}
export function productCell(boc: unknown, hash: unknown): Cell {
  requireProduct(typeof boc === 'string' && boc.length > 0 && boc.length <= 128 * 1024
    && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));
  const bytes = Buffer.from(boc, 'base64'); requireProduct(bytes.toString('base64') === boc);
  const roots = Cell.fromBoc(bytes); requireProduct(roots.length === 1 && !roots[0].isExotic);
  const root = roots[0]; requireProduct(root.hash().toString('hex') === hash);
  requireProduct([false, true].some(idx => [false, true].some(crc32 => root.toBoc({ idx, crc32 }).equals(bytes))));
  const pending = [root], visited = new Set<string>();
  while (pending.length) { const cell = pending.pop()!, id = cell.hash().toString('hex'); if (visited.has(id)) continue;
    visited.add(id); requireProduct(!cell.isExotic && visited.size <= 128); pending.push(...cell.refs); }
  return root;
}
export type ProductDispatch = { lt: string; hash: string; valueNano: string };
export function productDispatch(value: unknown): ProductDispatch {
  requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const v = value as Record<string, unknown>;
  requireProduct(Object.keys(v).sort().join() === ['lt', 'hash', 'valueNano'].sort().join());
  productUint(v.lt, 64, true); productUint(v.valueNano, 120, true);
  requireProduct(typeof v.hash === 'string' && /^[0-9a-f]{64}$/.test(v.hash)); return v as ProductDispatch;
}
export type ProductPhysicalGraph = { coverage: { complete: boolean; gaps: PhysicalGap[] }; transactions: OrderTransactionEvidence[] };

/** Transport original physical boundaries only. Current product code pins and
 * the exact resolved owner dispatch restrict the graph; browser verification
 * still decides business acceptance and actual independent token delivery. */
export async function collectProductPhysicalGraph(source: ChainSource, store: PhysicalEvidenceStore, head: ChainHead,
  input: { owner: string; target: string; body: Cell; dispatch: ProductDispatch; pins: ReadonlyMap<string, string>;
    completeAccounts: readonly string[]; reader?: ReturnType<typeof createPhysicalEvidenceReader>;
    onCausal?: (row: PhysicalBoundary) => void }, signal?: AbortSignal): Promise<ProductPhysicalGraph> {
  const limits = PRODUCT_EVIDENCE_LIMITS, reader = input.reader ?? createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  const gaps: PhysicalGap[] = [], histories = new Map<string, PhysicalBoundary[]>(), selected = new Map<string, PhysicalBoundary>();
  let remaining = limits.history - 1, edges = 0;
  const checked = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
  const tx = (row: PhysicalBoundary) => { let result = checked.get(row); if (!result) { result = verifyOrderTransaction(row.evidence); checked.set(row, result); } return result; };
  const messageHashes = new Map<Cell, string>();
  const messageHash = (cell: Cell) => {
    let hash = messageHashes.get(cell); if (!hash) { hash = canonicalPhysicalMessage(cell).hash().toString('hex'); messageHashes.set(cell, hash); } return hash;
  };
  const key = (row: PhysicalBoundary) => `${row.evidence.account}:${tx(row).tx.lt}:${tx(row).hash}`;
  const add = (row: PhysicalBoundary) => {
    if (selected.has(key(row))) return true;
    if (selected.size >= limits.transactions) { gaps.push({ code: 'returned_transaction_limit', account: row.evidence.account }); return false; }
    selected.set(key(row), row); return true;
  };
  const history = async (account: string) => {
    if (histories.has(account)) return histories.get(account)!;
    if (histories.size >= limits.accounts) { gaps.push({ code: 'related_account_limit', account }); return []; }
    histories.set(account, []);
    if (remaining <= 0) { gaps.push({ code: 'history_transaction_limit', account }); return []; }
    try {
      const state = await reader.current(account), pin = input.pins.get(account);
      if (pin) activeOrderAccount(orderShard(state.shardAccountBoc!, account).shard, pin);
      // Product/source-wallet histories are complete from initialization. A
      // causal recipient/GRAM-return account only needs its uninterrupted
      // current-to-dispatch interval; unrelated older owner activity is not a
      // prerequisite for proving the exact message delivery.
      const result = await reader.history(account, state, remaining, input.completeAccounts.includes(account) ? undefined
        : row => tx(row).tx.prevTransactionLt < BigInt(input.dispatch.lt)); remaining -= result.rows.length;
      gaps.push(...result.gaps); if (!result.complete) gaps.push({ code: 'complete_history_unavailable', account });
      if (pin) for (const row of result.rows) for (const shard of [tx(row).before, tx(row).after]) {
        if (shard.account?.storage.state.type === 'active') activeOrderAccount(shard, pin);
      }
      histories.set(account, result.rows); return result.rows;
    } catch (error) { if (signal?.aborted) throw error; gaps.push({ code: 'current_or_historical_account_unavailable', account }); return []; }
  };
  const finish = () => {
    signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
    const unique = [...new Map(gaps.map(g => [JSON.stringify(g), g])).values()];
    return { coverage: { complete: unique.length === 0, gaps: unique.length <= limits.gaps ? unique
      : [...unique.slice(0, limits.gaps - 1), { code: 'coverage_gap_limit', account: input.target }] }, transactions: [...selected.values()].map(row => row.evidence) };
  };
  let dispatch: PhysicalBoundary;
  try { dispatch = await reader.exact(input.owner, input.dispatch.lt, input.dispatch.hash); }
  catch (error) { if (signal?.aborted) throw error; gaps.push({ code: 'original_owner_dispatch_unavailable', account: input.owner, lt: input.dispatch.lt }); return finish(); }
  const sent = [...tx(dispatch).outgoing.values()].filter(cell => {
    const message = loadMessage(cell.beginParse()); return message.info.type === 'internal' && !message.info.bounced
      && message.info.src.toRawString() === input.owner && message.info.dest.toRawString() === input.target
      && message.info.value.coins.toString() === input.dispatch.valueNano && message.body.equals(input.body);
  });
  if (!tx(dispatch).succeeded || sent.length !== 1) { gaps.push({ code: 'original_owner_dispatch_mismatch', account: input.owner, lt: input.dispatch.lt }); return finish(); }
  add(dispatch);
  for (const account of new Set(input.completeAccounts)) for (const row of await history(account)) add(row);
  const targetHistory = await history(input.target), exactMessage = messageHash(sent[0]);
  const origins = targetHistory.filter(row => tx(row).tx.lt > tx(dispatch).tx.lt && tx(row).incoming
    && messageHash(tx(row).incoming!) === exactMessage);
  if (origins.length !== 1) { gaps.push({ code: origins.length ? 'ambiguous_original_request' : 'original_request_unobserved', account: input.target }); return finish(); }
  const queue = [origins[0]], followed = new Set<string>();
  while (queue.length) {
    signal?.throwIfAborted(); const row = queue.shift()!, id = key(row); if (followed.has(id)) continue;
    followed.add(id); if (!add(row)) break;
    input.onCausal?.(row);
    for (const raw of tx(row).outgoing.values()) {
      if (++edges > limits.edges) { gaps.push({ code: 'message_edge_limit', account: row.evidence.account }); queue.length = 0; break; }
      if (edges % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
      const message = loadMessage(raw.beginParse()); if (message.info.type !== 'internal') continue;
      const account = message.info.dest.toRawString();
      if (message.info.dest.workChain !== 0) { gaps.push({ code: 'related_workchain_unavailable', account }); continue; }
      const wanted = messageHash(raw), matches = (await history(account)).filter(candidate => tx(candidate).tx.lt > tx(row).tx.lt
        && tx(candidate).incoming && messageHash(tx(candidate).incoming!) === wanted);
      if (matches.length === 1) queue.push(matches[0]); else gaps.push({ code: matches.length ? 'ambiguous_related_transaction' : 'related_transaction_unobserved', account, lt: message.info.createdLt.toString() });
    }
  }
  return finish();
}
export function boundProductResponse<T extends ProductPhysicalGraph>(response: T, account: string): T {
  const limits = PRODUCT_EVIDENCE_LIMITS;
  if (Buffer.byteLength(JSON.stringify(response)) > limits.bytes) {
    response.coverage.complete = false; response.coverage.gaps = [...response.coverage.gaps.slice(0, limits.gaps - 1), { code: 'response_size_limit', account }];
    while (response.transactions.length && Buffer.byteLength(JSON.stringify(response)) > limits.bytes) response.transactions.pop();
    if (Buffer.byteLength(JSON.stringify(response)) > limits.bytes) throw new ProductEvidenceError(503, 'upstream_unavailable');
  }
  return response;
}
