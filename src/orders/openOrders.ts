import { activeOrderAccount, orderCell, orderShard, requireOrder, verifyOrderTransaction, type OrderTransactionEvidence } from './evidence';
import { discoveredTerms, discoverOrders, orderFactoryHistoryHash, orderHash, orderJson, type DiscoveredOrder, type FailedOrderInitialization, type OrderGap, type OrderRelease } from './discovery';
import { decodeOrderState } from './state';

export type OrderHead = { masterchainSeqno: number; unixTime: number; blockRootHash: string };
/** Supplied only by the authenticated chain adapter, at this exact immutable
 * masterchain boundary. A caller-provided label is not a chain proof. */
export type CurrentOrderAccount = { address: string; asOf: OrderHead; shardAccountBoc: string };
export type FactoryCoverage = { factoryAddress: string; codeHash: string; asOf: OrderHead; factoryHistoryHash: string; fromLt: string | null; toLt: string; toHash: string; historyComplete: boolean; boundaryComplete: boolean; complete: boolean; gaps: OrderGap[] };
export type OpenOrderItem = {
  address: string; codeHash: string; factory: string; owner: string; nonce: string; termsHash: string; terms: Record<string, unknown>;
  creationLt: string; creationTxHash: string; creation: DiscoveredOrder['creation']; observed: { lastTxLt: string; lastTxHash: string };
  stage: 'ACTIVE' | 'EXECUTING'; executedSlices: number; execId: number; lastExecutedAt: number; attemptAt: number;
  cancelRequested: boolean; refundSeen: boolean; refundKind: number; refusal: number;
  inputWallet: string | null; keeper: string | null; prevKeeper: string | null;
  soldInRaw: string; inFlightRaw: string; unexecutedInRaw: string;
  cash: { output: 'unverified'; inputRefund: 'unverified' };
};
export type OpenOrderSnapshot = {
  schema: 'tonswap-open-orders-v1'; releaseId: string; manifestHash: string; asOf: OrderHead;
  coverage: FactoryCoverage; orders: OpenOrderItem[]; snapshotId: string;
  failedInitializations: FailedOrderInitialization[];
};

/** Compute physical factory coverage from the exact authenticated current anchor
 * and a descending cursor-inclusive history. The provider owns chain proofs. */
export function orderFactoryCoverage(release: OrderRelease, head: OrderHead, current: CurrentOrderAccount,
  history: readonly OrderTransactionEvidence[]): FactoryCoverage {
  requireOrder(current.address === release.factory && orderJson(current.asOf) === orderJson(head), 'factory boundary mismatch');
  const shard = orderShard(current.shardAccountBoc, release.factory).shard;
  const factoryData = activeOrderAccount(shard, release.factoryCodeHash).data.beginParse();
  requireOrder(factoryData.loadRef().hash().toString('hex') === release.orderCodeHash, 'factory child code mismatch');
  factoryData.loadUintBig(64); factoryData.endParse();
  const toLt = shard.lastTransactionLt.toString(), toHash = shard.lastTransactionHash.toString(16).padStart(64, '0');
  let expectedLt = shard.lastTransactionLt, expectedHash = toHash, fromLt: string | null = null;
  let expectedState = orderCell(current.shardAccountBoc).hash().toString('hex');
  const gaps: OrderGap[] = []; let boundaryComplete = true;
  const seen = new Map<string, string>();
  for (const evidence of history) {
    try {
      requireOrder(evidence.account === release.factory, 'foreign factory history');
      const row = verifyOrderTransaction(evidence);
      const identity = orderHash({ before: orderCell(evidence.beforeShardAccountBoc).hash().toString('hex'),
        after: orderCell(evidence.afterShardAccountBoc).hash().toString('hex') });
      const prior = seen.get(row.hash);
      if (prior) { requireOrder(prior === identity, 'conflicting repeated factory boundary'); continue; }
      seen.set(row.hash, identity);
      requireOrder(row.tx.lt === expectedLt && row.hash === expectedHash && row.tx.now <= head.unixTime
        && orderCell(evidence.afterShardAccountBoc).hash().toString('hex') === expectedState, 'factory history gap');
      expectedState = orderCell(evidence.beforeShardAccountBoc).hash().toString('hex');
      fromLt = row.tx.lt.toString(); expectedLt = row.tx.prevTransactionLt; expectedHash = row.tx.prevTransactionHash.toString(16).padStart(64, '0');
    } catch { boundaryComplete = false; gaps.push({ code: 'factory_history_gap', account: release.factory, lt: expectedLt.toString() }); break; }
  }
  if (!history.length && expectedLt !== 0n) boundaryComplete = false;
  const historyComplete = boundaryComplete && expectedLt === 0n && expectedHash === '0'.repeat(64);
  if (!historyComplete && !gaps.length) gaps.push({ code: 'factory_history_incomplete', account: release.factory, lt: expectedLt.toString() });
  return { factoryAddress: release.factory, codeHash: release.factoryCodeHash, asOf: { ...head }, factoryHistoryHash: orderFactoryHistoryHash(history), fromLt, toLt, toHash, historyComplete, boundaryComplete, complete: historyComplete && boundaryComplete && gaps.length === 0, gaps };
}

function fresh(head: OrderHead, now: number) {
  requireOrder(Number.isSafeInteger(head.masterchainSeqno) && head.masterchainSeqno >= 0 && Number.isSafeInteger(head.unixTime) && head.unixTime >= 0
    && Number.isSafeInteger(now) && /^[a-f0-9]{64}$/.test(head.blockRootHash), 'invalid current head');
  requireOrder(head.unixTime * 1000 <= now + 5000 && now - head.unixTime * 1000 <= 30_000, 'stale current head');
}
const address = (value: { toRawString(): string } | null) => value?.toRawString() ?? null;
function termJson(order: DiscoveredOrder): Record<string, unknown> {
  const t = discoveredTerms(order);
  return { ...t, inputMaster: address(t.inputMaster), pool: address(t.pool), recipient: address(t.recipient), executor: address(t.executor),
    amountIn: t.amountIn.toString(), minOutTotal: t.minOutTotal.toString(), tipPerSlice: t.tipPerSlice.toString(), walletGram: t.walletGram.toString() };
}
function snapshotDigest(snapshot: Omit<OpenOrderSnapshot, 'snapshotId'>): string { return orderHash(snapshot); }

/** Builds an immutable release/head publication. Persist its exact JSON as one
 * generation; never append refreshed rows to an already published cursor. */
export type OrderSnapshotEvidence = { factoryCurrent: CurrentOrderAccount; factoryHistory: readonly OrderTransactionEvidence[];
  childHistory: readonly OrderTransactionEvidence[]; accounts: readonly CurrentOrderAccount[] };
export function buildOpenOrderSnapshot(release: OrderRelease, head: OrderHead, evidence: OrderSnapshotEvidence,
  now = Date.now()): OpenOrderSnapshot {
  fresh(head, now);
  // Discovery and coverage MUST consume this one physical history. A caller cannot
  // combine complete coverage with a subset of the accepted child creations.
  const coverage = orderFactoryCoverage(release, head, evidence.factoryCurrent, evidence.factoryHistory);
  const discovery = discoverOrders(release, evidence.factoryHistory, evidence.childHistory);
  const accounts = evidence.accounts;
  const gaps = [...coverage.gaps, ...discovery.gaps], orders: OpenOrderItem[] = [], byAddress = new Map<string, CurrentOrderAccount>();
  for (const account of accounts) { requireOrder(!byAddress.has(account.address), 'duplicate current account'); byAddress.set(account.address, account); }
  const seen = new Set<string>();
  for (const order of discovery.orders) {
    requireOrder(orderJson(order.release) === orderJson(release) && !seen.has(order.address), 'discovery release or duplicate mismatch'); seen.add(order.address);
    try {
      const current = byAddress.get(order.address);
      requireOrder(current && orderJson(current.asOf) === orderJson(head), 'current order state missing');
      const shard = orderShard(current.shardAccountBoc, order.address).shard, state = decodeOrderState(activeOrderAccount(shard, release.orderCodeHash).data);
      requireOrder(shard.lastTransactionLt >= BigInt(order.creation.childLt), 'order state predates creation');
      if (shard.lastTransactionLt === BigInt(order.creation.childLt)) requireOrder(shard.lastTransactionHash.toString(16).padStart(64, '0') === order.creation.childHash, 'creation boundary mismatch');
      requireOrder(state.factory.toRawString() === release.factory && state.owner.toRawString() === order.owner && state.nonce.toString() === order.nonce && state.termsHash === order.termsHash, 'current immutable order mismatch');
      requireOrder(state.state !== 0, 'initialized child lost state');
      if (state.state === 3) continue;
      orders.push({ address: order.address, codeHash: release.orderCodeHash, factory: release.factory, owner: order.owner, nonce: order.nonce, termsHash: order.termsHash,
        terms: termJson(order), creationLt: order.creation.factoryLt, creationTxHash: order.creation.factoryHash, creation: order.creation, observed: { lastTxLt: shard.lastTransactionLt.toString(), lastTxHash: shard.lastTransactionHash.toString(16).padStart(64, '0') },
        stage: state.state === 1 ? 'ACTIVE' : 'EXECUTING', executedSlices: state.executedSlices, execId: state.execId, lastExecutedAt: state.lastExecutedAt, attemptAt: state.attemptAt,
        cancelRequested: state.cancelRequested, refundSeen: state.refundSeen, refundKind: state.refundKind, refusal: state.refusal,
        inputWallet: address(state.inputWallet), keeper: address(state.keeper), prevKeeper: address(state.prevKeeper),
        soldInRaw: state.soldIn.toString(), inFlightRaw: state.inFlight.toString(), unexecutedInRaw: state.unexecutedIn.toString(), cash: { output: 'unverified', inputRefund: 'unverified' } });
    } catch { gaps.push({ code: 'current_order_unavailable', account: order.address }); }
  }
  orders.sort((a, b) => a.address.localeCompare(b.address));
  const content: Omit<OpenOrderSnapshot, 'snapshotId'> = { schema: 'tonswap-open-orders-v1', releaseId: release.releaseId, manifestHash: release.manifestHash,
    asOf: { ...head }, failedInitializations: discovery.failedInitializations, coverage: { ...coverage, gaps, complete: coverage.historyComplete && coverage.boundaryComplete && gaps.length === 0 }, orders };
  return JSON.parse(JSON.stringify({ ...content, snapshotId: snapshotDigest(content) })) as OpenOrderSnapshot;
}

export function pageOpenOrders(snapshot: OpenOrderSnapshot, release: OrderRelease, options: { cursor?: string; limit?: number; now?: number } = {}) {
  const { snapshotId, ...content } = snapshot;
  requireOrder(snapshot.schema === 'tonswap-open-orders-v1' && snapshotId === snapshotDigest(content), 'snapshot changed');
  requireOrder(snapshot.manifestHash === release.manifestHash && snapshot.releaseId === release.releaseId, 'cursor release mismatch');
  fresh(snapshot.asOf, options.now ?? Date.now());
  const limit = options.limit ?? 50; requireOrder(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid page limit');
  let offset = 0;
  if (options.cursor) {
    requireOrder(options.cursor.length <= 1024, 'invalid cursor');
    const bytes = Buffer.from(options.cursor, 'base64url'); requireOrder(bytes.toString('base64url') === options.cursor, 'noncanonical cursor');
    const value = JSON.parse(bytes.toString('utf8'));
    requireOrder(orderJson(value) === bytes.toString('utf8') && Object.keys(value).sort().join() === 'limit,offset,snapshotId'
      && value.snapshotId === snapshotId && value.limit === limit && Number.isSafeInteger(value.offset) && value.offset > 0 && value.offset < snapshot.orders.length && value.offset % limit === 0, 'cursor snapshot mismatch');
    offset = value.offset;
  }
  const end = Math.min(offset + limit, snapshot.orders.length);
  const nextCursor = end < snapshot.orders.length ? Buffer.from(orderJson({ snapshotId, offset: end, limit })).toString('base64url') : null;
  return { headers: { 'x-tonswap-release': release.manifestHash, 'cache-control': 'no-store' },
    body: { ...content, snapshotId, orders: snapshot.orders.slice(offset, end), nextCursor } };
}
