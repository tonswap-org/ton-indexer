import { Address, beginCell, Cell, contractAddress, loadMessage, storeStateInit } from '@ton/core';
import { createHash } from 'node:crypto';
import { activeOrderAccount, digest, orderCell, requireOrder, verifyOrderTransaction, type OrderTransactionEvidence } from './evidence';
import { canonicalOrderTerms, decodeOrderState, orderInitialData, parseOrderTerms } from './state';

export const orderJson = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(orderJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + orderJson((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
};
export const orderHash = (value: unknown): string => createHash('sha256').update(orderJson(value)).digest('hex');
export type OrderRelease = { releaseId: string; manifestHash: string; network: string; factory: string; factoryCodeHash: string; orderCodeHash: string };
/** Call only after the service's sole current-manifest validator. Independently
 * bind the order subset to the complete canonical manifest; no manual pins. */
export function bindOrderRelease(manifest: { [key: string]: unknown }): OrderRelease {
  const { manifestHash, ...content } = manifest;
  const contracts = manifest.contracts as Record<string, { address: string; codeHash: string }>, templates = manifest.templates as Record<string, string>;
  const factory = contracts?.SpotOrderFactory;
  requireOrder(manifest.schema === 'tonswap-release-v1' && typeof manifestHash === 'string' && /^[a-f0-9]{64}$/.test(manifestHash) && orderHash(content) === manifestHash, 'release hash mismatch');
  requireOrder(typeof manifest.releaseId === 'string' && manifest.releaseId.length > 0 && ['ton:localnet', 'ton:testnet', 'ton:mainnet'].includes(String(manifest.network)), 'release identity missing');
  requireOrder(factory && /^0:[a-f0-9]{64}$/.test(factory.address) && /^[a-f0-9]{64}$/.test(factory.codeHash) && /^[a-f0-9]{64}$/.test(templates?.SpotOrder), 'current order release pins missing');
  return Object.freeze({ releaseId: manifest.releaseId, manifestHash, network: String(manifest.network), factory: factory.address, factoryCodeHash: factory.codeHash, orderCodeHash: templates.SpotOrder });
}
export type DiscoveredOrder = {
  release: OrderRelease; address: string; owner: string; nonce: string; termsBoc: string; termsHash: string;
  creation: { factoryLt: string; factoryHash: string; messageHash: string; childLt: string; childHash: string };
};
export type OrderGap = { code: string; account: string; lt?: string };
export type FailedOrderInitialization = { address: string; owner: string; nonce: string; creation: DiscoveredOrder['creation'] };
export type OrderDiscovery = {
  factoryHistoryHash: string; orders: DiscoveredOrder[]; gaps: OrderGap[];
  failedInitializations: FailedOrderInitialization[];
};

/** Bind the exact original input records, independent of archive page order.
 * Invalid BOCs remain hashable and are separately reported as evidence gaps. */
export function orderFactoryHistoryHash(evidence: readonly OrderTransactionEvidence[]): string {
  return orderHash(evidence.map(e => orderHash({ account: e.account, transactionBoc: e.transactionBoc,
    beforeShardAccountBoc: e.beforeShardAccountBoc, afterShardAccountBoc: e.afterShardAccountBoc })).sort());
}

/** Authenticate a request and its actual delivery before classifying its result. */
function authenticateOrderAttempt(release: OrderRelease, factoryEvidence: OrderTransactionEvidence, childEvidence: OrderTransactionEvidence) {
  requireOrder(factoryEvidence.account === release.factory, 'wrong factory');
  const f = verifyOrderTransaction(factoryEvidence);
  requireOrder(f.succeeded, 'factory transaction failed');
  const before = activeOrderAccount(f.before, release.factoryCodeHash), after = activeOrderAccount(f.after, release.factoryCodeHash);
  requireOrder(before.data.equals(after.data), 'factory immutable state changed');
  const fs = before.data.beginParse(), orderCode = fs.loadRef(); fs.loadUintBig(64); fs.endParse();
  requireOrder(digest(orderCode) === release.orderCodeHash, 'factory child code mismatch');
  const incoming = f.tx.inMessage;
  requireOrder(incoming?.info.type === 'internal' && !incoming.info.bounced && incoming.info.src.workChain === 0, 'owner request missing');
  const request = incoming.body.beginParse(); requireOrder(request.loadUint(32) === 0x4f435254, 'not current OCRT');
  const queryId = request.loadUintBig(64), nonce = request.loadUintBig(64), requestedTerms = request.loadRef(); request.endParse();
  const owner = incoming.info.src, canonicalTerms = canonicalOrderTerms(requestedTerms, owner, f.tx.now);
  const init = { code: orderCode, data: orderInitialData(Address.parse(release.factory), owner, nonce) };
  const address = contractAddress(0, init).toRawString();
  requireOrder(childEvidence.account === address, 'child address mismatch');
  const matches = [...f.outgoing.values()].filter(raw => {
    const m = loadMessage(raw.beginParse());
    return m.info.type === 'internal' && m.info.dest.toRawString() === address && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x4f494e49;
  });
  requireOrder(matches.length === 1, 'unique emitted initialization missing');
  const emitted = matches[0], message = loadMessage(emitted.beginParse());
  requireOrder(message.info.type === 'internal' && message.info.src.toRawString() === release.factory && !message.info.bounced && message.init, 'factory initialization malformed');
  requireOrder(beginCell().store(storeStateInit(message.init)).endCell().equals(beginCell().store(storeStateInit(init)).endCell()), 'child StateInit mismatch');
  const body = message.body.beginParse(); requireOrder(body.loadUint(32) === 0x4f494e49 && body.loadUintBig(64) === queryId, 'OINI request mismatch');
  requireOrder(body.loadRef().equals(canonicalTerms), 'canonical terms mismatch'); body.endParse();
  const c = verifyOrderTransaction(childEvidence);
  requireOrder(c.incoming?.equals(emitted), 'child did not receive exact factory message');
  // @ton/core represents a pruned account reference as account=undefined. It
  // must never become proof that initialization did not create an order.
  for (const boc of [childEvidence.beforeShardAccountBoc, childEvidence.afterShardAccountBoc]) {
    requireOrder(!orderCell(boc).refs[0].isExotic, 'child account boundary is pruned');
  }
  return { release, f, c, owner, nonce, canonicalTerms, init, address,
    creation: { factoryLt: f.tx.lt.toString(), factoryHash: f.hash, messageHash: digest(emitted), childLt: c.tx.lt.toString(), childHash: c.hash } };
}
type OrderAttempt = ReturnType<typeof authenticateOrderAttempt>;

function attemptBoundary(attempt: OrderAttempt, shard: OrderAttempt['c']['before']) {
  if (!shard.account || shard.account.storage.state.type === 'uninit') return null;
  const { data } = activeOrderAccount(shard, attempt.release.orderCodeHash), state = decodeOrderState(data);
  requireOrder(state.factory.toRawString() === attempt.release.factory && state.owner.equals(attempt.owner)
    && state.nonce === attempt.nonce, 'child immutable identity mismatch');
  if (state.state === 0) requireOrder(data.equals(attempt.init.data), 'child StateInit data mismatch');
  return { data, state };
}

function initializedOrder(attempt: OrderAttempt): DiscoveredOrder {
  const { release, c, address, owner, nonce, canonicalTerms, creation } = attempt;
  const before = attemptBoundary(attempt, c.before), after = attemptBoundary(attempt, c.after);
  requireOrder(!before || before.state.state === 0, 'child was already initialized');
  requireOrder(c.succeeded && after && after.state.termsCell?.equals(canonicalTerms), 'child initialization did not succeed');
  const state = after.state;
  requireOrder(state.state === 1 && state.executedSlices === 0 && state.execId === 0 && state.closeReason === 0 && state.attemptAt === 0 && state.lastExecutedAt === 0
    && !state.cancelRequested && !state.refundSeen && state.refundKind === 0 && state.refusal === 0 && !state.inputWallet && !state.keeper && !state.prevKeeper, 'not initial child state');
  return { release, address, owner: owner.toRawString(), nonce: nonce.toString(), termsBoc: canonicalTerms.toBoc().toString('base64'), termsHash: digest(canonicalTerms),
    creation };
}

/** Authenticate one first initialization. Use discoverOrders to resolve retries
 * and duplicates against the original immutable creation. */
export function discoverOrder(release: OrderRelease, factoryEvidence: OrderTransactionEvidence, childEvidence: OrderTransactionEvidence): DiscoveredOrder {
  return initializedOrder(authenticateOrderAttempt(release, factoryEvidence, childEvidence));
}

type VerifiedRow = { evidence: OrderTransactionEvidence; verified: ReturnType<typeof verifyOrderTransaction>; identity: string };
function verifiedRows(evidence: readonly OrderTransactionEvidence[], gaps: OrderGap[], code: string, account?: string): VerifiedRow[] {
  const rows = new Map<string, VerifiedRow>(), conflicting = new Set<string>();
  for (const e of evidence) try {
    requireOrder(account === undefined || e.account === account, 'foreign history account');
    const verified = verifyOrderTransaction(e), hash = verified.hash;
    const identity = orderHash({ account: e.account, before: digest(orderCell(e.beforeShardAccountBoc)), after: digest(orderCell(e.afterShardAccountBoc)) });
    const previous = rows.get(hash);
    if (conflicting.has(hash) || (previous && previous.identity !== identity)) {
      rows.delete(hash); conflicting.add(hash);
      requireOrder(false, 'conflicting repeated transaction boundaries');
    }
    if (!previous) rows.set(hash, { evidence: e, verified, identity });
  } catch { gaps.push({ code, account: e.account }); }
  return [...rows.values()];
}

/** Missing related history remains an explicit discovery gap, never absence. */
export function discoverOrders(release: OrderRelease, factory: readonly OrderTransactionEvidence[], children: readonly OrderTransactionEvidence[]): OrderDiscovery {
  const orders = new Map<string, DiscoveredOrder>(), gaps: OrderGap[] = [], failedInitializations: FailedOrderInitialization[] = [];
  const childMessages = new Map<string, OrderTransactionEvidence[]>();
  for (const { evidence, verified } of verifiedRows(children, gaps, 'child_evidence_invalid')) {
    if (verified.incoming) {
      const key = digest(verified.incoming), rows = childMessages.get(key) ?? [];
      rows.push(evidence); childMessages.set(key, rows);
    }
  }
  const ordered = verifiedRows(factory, gaps, 'factory_evidence_invalid', release.factory).sort((a, b) => {
    const x = a.verified.tx.lt, y = b.verified.tx.lt; return x < y ? -1 : x > y ? 1 : 0;
  });
  const attempts: OrderAttempt[] = [];
  for (const { evidence: e, verified: f } of ordered) {
    const lt = f.tx.lt.toString();
    try {
      const m = f.tx.inMessage;
      if (!m || m.body.bits.length < 32 || m.body.beginParse().preloadUint(32) !== 0x4f435254 || !f.succeeded) continue;
      const init = [...f.outgoing.values()].filter(raw => { const m = loadMessage(raw.beginParse()); return m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x4f494e49; });
      requireOrder(init.length === 1, 'initialization missing');
      const matched = childMessages.get(digest(init[0])) ?? [];
      requireOrder(matched.length === 1, 'child history missing or ambiguous');
      attempts.push(authenticateOrderAttempt(release, e, matched[0]));
    } catch { gaps.push({ code: 'creation_unresolved', account: e.account, lt }); }
  }
  // Child execution order determines the first accepted terms, regardless of
  // how archive pages or cross-account deliveries were supplied.
  attempts.sort((a, b) => a.c.tx.lt < b.c.tx.lt ? -1 : a.c.tx.lt > b.c.tx.lt ? 1 : a.address.localeCompare(b.address));
  for (const attempt of attempts) try {
    const { c, address, owner, nonce, creation } = attempt;
    const before = attemptBoundary(attempt, c.before), after = attemptBoundary(attempt, c.after);
    const previous = orders.get(address);
    if (before && before.state.state !== 0) {
      requireOrder(previous && before.state.termsHash === previous.termsHash && after && after.data.equals(before.data), 'unbound or changed duplicate initialization');
      const firstLt = BigInt(previous.creation.childLt);
      requireOrder(c.before.lastTransactionLt >= firstLt && (c.before.lastTransactionLt !== firstLt ||
        c.before.lastTransactionHash.toString(16).padStart(64, '0') === previous.creation.childHash), 'duplicate predates first initialization');
      continue;
    }
    if (!c.succeeded && (!after || after.state.state === 0)) {
      requireOrder(!previous, 'previously initialized child lost state');
      failedInitializations.push({ address, owner: owner.toRawString(), nonce: nonce.toString(), creation });
      continue;
    }
    const found = initializedOrder(attempt);
    requireOrder(!previous, 'child was initialized more than once');
    orders.set(address, found);
  } catch {
    gaps.push({ code: 'creation_unresolved', account: release.factory, lt: attempt.creation.factoryLt });
  }
  return { factoryHistoryHash: orderFactoryHistoryHash(factory), orders: [...orders.values()], gaps, failedInitializations };
}

export function discoveredTerms(order: DiscoveredOrder) {
  const cell = orderCell(order.termsBoc); requireOrder(digest(cell) === order.termsHash, 'discovered terms changed');
  return parseOrderTerms(cell);
}
