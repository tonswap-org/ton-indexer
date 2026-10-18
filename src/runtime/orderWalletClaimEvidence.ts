import { Address, Cell, beginCell, contractAddress, loadMessage, storeStateInit } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { AccountStateResponse, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { reconstructCurrentT3WalletClaims, type CurrentT3WalletClaimsResult, type CurrentT3WalletClaim } from '../ledger/currentT3Receipts';
import { readCurrentT3Wallet, currentT3WalletAddress } from '../ledger/currentT3State';
import { canonicalLedgerHash } from '../ledger/normalize';
import { findTransactionState } from '../ledger/archive';
import { t3Attempt, t3Delivery } from '../ledger/currentT3Wire';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalOrderTerms, decodeOrderState, orderInitialData } from '../orders/state';
import { boundaryState, boundaryTransaction, canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { readSpotOperationRequest, SpotEvidenceError, type ParsedOrderSettlementSpotOperationRequest } from './spotOperationRequest';

export const ORDER_WALLET_CLAIM_LIMITS = Object.freeze({ history: 10_000, candidates: 32, failures: 32,
  responseBytes: 8 * 1024 * 1024, newTransactions: 64 });
export function readOrderWalletClaimRequest(value: unknown, manifest: RuntimeReleaseManifest): ParsedOrderSettlementSpotOperationRequest {
  const parsed = readSpotOperationRequest(value, manifest);
  if (parsed.request.kind !== 'order-settlement' || parsed.request.inputRoot !== manifest.contracts.T3Hub?.address)
    throw new SpotEvidenceError(400, 'bad_request');
  return parsed as ParsedOrderSettlementSpotOperationRequest;
}
type Claims = Omit<Extract<CurrentT3WalletClaimsResult, { status: 'ok' }>, 'status' | 'wallet' | 'owner' | 'records'> & {
  records: Array<CurrentT3WalletClaim & { transferTransaction: OrderTransactionEvidence }>;
};
export type CurrentOrderWalletClaimEvidence = {
  schema: 'tonswap-order-wallet-claim-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'order-settlement'; owner: string; order: string; nonce: string; termsHash: string; fundingBodyHash: string | null };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  order: { address: string; codeBoc: string; dataBoc: string };
  wallet: { address: string; codeBoc: string; dataBoc: string }; claims: Claims;
};
const unavailable = () => new SpotEvidenceError(503, 'upstream_unavailable');
const sameMessage = (a: Cell, b: Cell) => canonicalPhysicalMessage(a).equals(canonicalPhysicalMessage(b));
function pinned(account: string, state: AccountStateResponse, codeHash: string) {
  if (!state.shardAccountBoc) throw unavailable();
  const active = activeOrderAccount(orderShard(state.shardAccountBoc, account).shard, codeHash);
  return { address: account, codeBoc: active.code.toBoc().toString('base64'), dataBoc: active.data.toBoc().toString('base64') };
}

/** Original order ownership, funding and failed transfer history authenticate
 * these current membership witnesses. Recovery does not require a successful
 * destination credit and never establishes that the order has paid its owner. */
export async function collectOrderWalletClaimEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readOrderWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentOrderWalletClaimEvidence> {
  const { request, termsCell, terms, fundingBody } = parsed, limits = ORDER_WALLET_CLAIM_LIMITS;
  if (`ton:${source.network}` !== manifest.network) throw unavailable();
  signal?.throwIfAborted();
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  let remainingHistory = limits.history;
  const history = async (account: string, state: AccountStateResponse, stop?: (row: PhysicalBoundary) => boolean) => {
    if (remainingHistory <= 0) return { rows: [] as PhysicalBoundary[], gaps: [{ code: 'archive_history_limit', account }], complete: false };
    const result = await reader.history(account, state, remainingHistory, stop);
    remainingHistory -= result.rows.length;
    return result;
  };
  const hub = manifest.contracts.T3Hub!, token = manifest.tokens.find(t => t.root === hub.address);
  if (!token || token.masterCodeHash !== hub.codeHash || token.walletCodeHash !== manifest.templates.T3Wallet) throw unavailable();
  const binding = { hub: hub.address, walletCodeHash: manifest.templates.T3Wallet, proofCodeHash: manifest.templates.T3RecoveryProof };
  const walletReader = createJettonWalletReader({ source, tokens: [{ master: hub.address, masterCodeHash: hub.codeHash, walletCodeHash: binding.walletCodeHash }] });
  const selected = await walletReader.wallet(hub.address, request.order, { at: head, signal });
  if (selected.status !== 'ok') throw unavailable();
  const factoryState = await reader.current(request.factory), factory = pinned(request.factory, factoryState, manifest.contracts.SpotOrderFactory!.codeHash);
  const fs = orderCell(factory.dataBoc).beginParse(), orderCode = fs.loadRef(); fs.loadUintBig(64); fs.endParse();
  const initial = { code: orderCode, data: orderInitialData(Address.parse(request.factory), Address.parse(request.owner), BigInt(request.nonce)) };
  if (orderCode.isExotic || orderCode.hash().toString('hex') !== manifest.templates.SpotOrder || contractAddress(0, initial).toRawString() !== request.order)
    throw new SpotEvidenceError(400, 'bad_request');
  const orderState = await reader.current(request.order), order = pinned(request.order, orderState, manifest.templates.SpotOrder);
  const currentOrder = decodeOrderState(orderCell(order.dataBoc));
  if (currentOrder.owner.toRawString() !== request.owner || currentOrder.factory.toRawString() !== request.factory || String(currentOrder.nonce) !== request.nonce) throw unavailable();
  const walletState = await reader.current(selected.wallet), wallet = pinned(selected.wallet, walletState, binding.walletCodeHash);
  const currentWallet = readCurrentT3Wallet(wallet.dataBoc);
  const ownerWallet = { wallet: currentT3WalletAddress(Address.parse(request.owner), Address.parse(binding.hub), binding.proofCodeHash, orderCell(wallet.codeBoc)) };
  if (request.funding && request.funding.sourceWallet !== ownerWallet.wallet) throw new SpotEvidenceError(400, 'bad_request');
  if (currentWallet.owner !== request.order || currentWallet.master !== binding.hub || currentWallet.proofCodeHash !== binding.proofCodeHash
    || currentT3WalletAddress(Address.parse(request.order), Address.parse(binding.hub), binding.proofCodeHash, orderCell(wallet.codeBoc)) !== wallet.address) throw unavailable();
  const hex = (n: bigint) => n.toString(16).padStart(64, '0');
  const response: CurrentOrderWalletClaimEvidence = { schema: 'tonswap-order-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    request: { kind: 'order-settlement', owner: request.owner, order: request.order, nonce: request.nonce, termsHash: request.termsHash, fundingBodyHash: request.funding?.bodyHash ?? null },
    coverage: { complete: false, gaps: [] }, order, wallet,
    claims: { root: hex(currentWallet.root), count: String(currentWallet.nextId), records: [], failureRoot: hex(currentWallet.failureRoot), failureCount: String(currentWallet.failureCount), failures: [] } };
  const gaps = response.coverage.gaps;
  const finish = () => {
    signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
    response.coverage.gaps = [...new Map(gaps.map(g => [JSON.stringify(g), g])).values()];
    response.coverage.complete = response.coverage.gaps.length === 0;
    if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) {
      response.coverage.complete = false; response.coverage.gaps.push({ code: 'response_size_limit', account: wallet.address });
      response.claims.records = []; response.claims.failures = [];
      if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) throw unavailable();
    }
    return response;
  };
  if (currentOrder.state !== 3) { gaps.push({ code: 'order_not_closed', account: request.order }); return finish(); }
  if (!request.funding || !fundingBody) { gaps.push({ code: 'original_funding_dispatch_unobserved', account: ownerWallet.wallet }); return finish(); }
  const orderHistory = await history(request.order, orderState), walletHistory = await history(wallet.address, walletState);
  gaps.push(...orderHistory.gaps, ...walletHistory.gaps);
  if (!orderHistory.complete || !walletHistory.complete) {
    if (!orderHistory.complete) gaps.push({ code: 'order_history_incomplete', account: request.order });
    if (!walletHistory.complete) gaps.push({ code: 'wallet_history_incomplete', account: wallet.address });
    return finish();
  }
  const checked = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
  const tx = (row: PhysicalBoundary) => { let v = checked.get(row); if (!v) { v = verifyOrderTransaction(row.evidence); checked.set(row, v); } return v; };
  const child = orderHistory.rows.find(row => {
    const c = tx(row), m = c.tx.inMessage;
    return c.succeeded && m?.info.type === 'internal' && !m.info.bounced && m.info.src.toRawString() === request.factory
      && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x4f494e49
      && (!c.before.account || c.before.account.storage.state.type === 'uninit'
        || c.before.account.storage.state.type === 'active' && !!c.before.account.storage.state.state.data?.equals(initial.data));
  });
  if (!child) { gaps.push({ code: 'original_initialization_unobserved', account: request.order }); return finish(); }
  const emits = (row: PhysicalBoundary) => [...tx(row).outgoing.values()].some(message => sameMessage(message, tx(child).incoming!));
  const factoryHistory = await history(request.factory, factoryState, emits), origin = factoryHistory.rows.find(emits);
  gaps.push(...factoryHistory.gaps);
  if (!origin || !factoryHistory.complete) { gaps.push({ code: 'original_creation_unobserved', account: request.factory }); return finish(); }
  try {
    const f = tx(origin), c = tx(child), message = f.tx.inMessage;
    if (!f.succeeded || message?.info.type !== 'internal' || message.info.bounced || message.info.src.toRawString() !== request.owner) throw unavailable();
    const b = message.body.beginParse(); if (b.loadUint(32) !== 0x4f435254) throw unavailable();
    const query = b.loadUintBig(64); if (String(b.loadUintBig(64)) !== request.nonce || !b.loadRef().equals(termsCell)) throw unavailable(); b.endParse();
    const actual = canonicalOrderTerms(termsCell, Address.parse(request.owner), f.tx.now), init = c.tx.inMessage!;
    const ib = init.body.beginParse(); if (ib.loadUint(32) !== 0x4f494e49 || ib.loadUintBig(64) !== query || !ib.loadRef().equals(actual)) throw unavailable(); ib.endParse();
    if (!init.init || !beginCell().store(storeStateInit(init.init)).endCell().equals(beginCell().store(storeStateInit(initial)).endCell()) || c.tx.lt <= f.tx.lt) throw unavailable();
    const initialized = decodeOrderState(activeOrderAccount(c.after, manifest.templates.SpotOrder).data);
    if (initialized.state !== 1 || initialized.execId || initialized.executedSlices || initialized.closeReason || initialized.attemptAt || initialized.lastExecutedAt
      || initialized.cancelRequested || initialized.refundSeen || initialized.refundKind || initialized.refusal || initialized.inputWallet || initialized.keeper || initialized.prevKeeper) throw unavailable();
    for (const boundary of [f.before, f.after]) if (!activeOrderAccount(boundary, manifest.contracts.SpotOrderFactory!.codeHash).data.equals(orderCell(factory.dataBoc))) throw unavailable();
    for (const row of orderHistory.rows) for (const boundary of [tx(row).before, tx(row).after]) {
      if (!boundary.account || boundary.account.storage.state.type === 'uninit') continue;
      const active = activeOrderAccount(boundary, manifest.templates.SpotOrder), state = decodeOrderState(active.data);
      if (state.factory.toRawString() !== request.factory || state.owner.toRawString() !== request.owner || String(state.nonce) !== request.nonce
        || (state.state === 0 ? !active.data.equals(initial.data) : !state.termsCell?.equals(actual))) throw unavailable();
    }
    if (!currentOrder.termsCell?.equals(actual)) throw unavailable();
  } catch { gaps.push({ code: 'creation_request_mismatch', account: request.factory }); return finish(); }
  const funding = request.funding;
  try {
    // Funding is authenticated by its complete emitted message in the anchored
    // input-wallet history. Later recipient-wallet state is irrelevant to a
    // recovery and may legitimately be frozen.
    let funded = await store.evidenceBoundary(ownerWallet.wallet, funding.lt, funding.hash);
    if (!funded) {
      const cursor = { lt: funding.lt, hash: Buffer.from(funding.hash, 'hex').toString('base64') };
      const located = await findTransactionState(source, ownerWallet.wallet, cursor, head.seqno, { signal });
      if (!located) throw unavailable();
      const state = located.state.replayBoundary ? located.state : await source.getAccountStateAtTransaction(ownerWallet.wallet, cursor, located.seqno, { signal });
      if (!state.replayBoundary) throw unavailable();
      const evidence = { account: ownerWallet.wallet, ...state.replayBoundary };
      verifyOrderTransaction(evidence); funded = { evidence, seqno: located.seqno };
    }
    const f = tx(funded), m = f.tx.inMessage;
    if (String(f.tx.lt) !== funding.lt || f.hash !== funding.hash || funded.seqno > head.seqno || f.tx.now > head.utime) throw unavailable();
    if (!f.succeeded || m?.info.type !== 'internal' || m.info.bounced || m.info.src.toRawString() !== request.owner
      || m.info.value.coins.toString() !== funding.valueNano || !m.body.equals(fundingBody)) throw unavailable();
    const before = readCurrentT3Wallet(activeOrderAccount(f.before, binding.walletCodeHash).data), after = readCurrentT3Wallet(activeOrderAccount(f.after, binding.walletCodeHash).data);
    if (before.owner !== request.owner || after.owner !== request.owner || before.master !== binding.hub || after.master !== binding.hub
      || before.proofCodeHash !== binding.proofCodeHash || after.proofCodeHash !== binding.proofCodeHash || before.balance - after.balance !== terms.amountIn) throw unavailable();
    const credits = walletHistory.rows.filter(row => tx(row).incoming && [...f.outgoing.values()].some(raw => sameMessage(raw, tx(row).incoming!)));
    if (credits.length !== 1) throw unavailable();
    const credit = tx(credits[0]); if (!credit.succeeded || credit.tx.lt <= f.tx.lt) throw unavailable();
    const delivery = t3Delivery(boundaryTransaction(credits[0]).inMessage);
    if (!delivery || delivery.burn || delivery.owner !== request.owner || delivery.recipient !== request.order || delivery.amount !== terms.amountIn || delivery.attempt !== 0n || delivery.originLt !== f.tx.lt) throw unavailable();
    const beforeCredit = credit.before.account?.storage.state.type === 'active' ? readCurrentT3Wallet(activeOrderAccount(credit.before, binding.walletCodeHash).data) : null;
    const afterCredit = readCurrentT3Wallet(activeOrderAccount(credit.after, binding.walletCodeHash).data);
    if (afterCredit.owner !== request.order || afterCredit.master !== binding.hub || afterCredit.proofCodeHash !== binding.proofCodeHash
      || afterCredit.balance - (beforeCredit?.balance ?? 0n) !== terms.amountIn || beforeCredit && (beforeCredit.owner !== request.order || beforeCredit.master !== binding.hub || beforeCredit.proofCodeHash !== binding.proofCodeHash)) throw unavailable();
  } catch { gaps.push({ code: 'original_funding_dispatch_unobserved', account: ownerWallet.wallet, lt: funding.lt }); return finish(); }
  const states = new Map<string, ReturnType<typeof boundaryState>>(), key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const row of walletHistory.rows) for (const boc of [row.evidence.beforeShardAccountBoc, row.evidence.afterShardAccountBoc]) {
    const snapshot = boundaryState(wallet.address, boc, row.seqno), k = key(wallet.address, snapshot.state.lastTxLt!, snapshot.state.lastTxHash!), prior = states.get(k);
    if (prior && prior.state.shardAccountBoc !== snapshot.state.shardAccountBoc) throw unavailable();
    if (!prior || snapshot.seqno < prior.seqno) states.set(k, snapshot);
  }
  const claims = await reconstructCurrentT3WalletClaims({ binding, wallet: wallet.address, owner: request.order, transactions: walletHistory.rows.map(boundaryTransaction),
    currentState: { seqno: head.seqno, state: walletState }, stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null, maxTransactions: limits.history, signal });
  if (claims.status !== 'ok') { gaps.push({ code: 'wallet_claim_history_unavailable', account: wallet.address }); return finish(); }
  const records: Claims['records'] = [];
  for (const record of claims.records) {
    signal?.throwIfAborted();
    const attempt = t3Attempt(orderCell(record.recordBoc).refs[0]);
    if (record.burn || record.owner !== request.order || record.cancelled || !record.failed && !claims.failures.some(f => f.attemptHash === attempt.cell.hash().toString('hex'))) continue;
    const original = walletHistory.rows.find(row => String(tx(row).tx.lt) === record.originLt);
    if (!original) { gaps.push({ code: 'original_order_transfer_unobserved', account: wallet.address, lt: record.originLt }); continue; }
    const o = tx(original), incoming = o.tx.inMessage;
    const emitters = orderHistory.rows.filter(row => tx(row).succeeded && o.incoming && [...tx(row).outgoing.values()].some(raw => sameMessage(raw, o.incoming!)));
    if (!o.succeeded || incoming?.info.type !== 'internal' || incoming.info.bounced || incoming.info.src.toRawString() !== request.order || emitters.length !== 1 || tx(emitters[0]).tx.lt >= o.tx.lt) {
      gaps.push({ code: 'original_order_transfer_unobserved', account: wallet.address, lt: record.originLt }); continue;
    }
    const initialAttempt = boundaryTransaction(original).outMessages.map(t3Delivery).find(a => a && a.id === attempt.id && a.originLt === attempt.originLt && a.attempt === 0n);
    // Transfers may be redirected by a later authorized retry, but the original
    // request's amount and complete WalletDetails are immutable.
    if (!initialAttempt || initialAttempt.owner !== request.order || initialAttempt.burn || initialAttempt.amount !== attempt.amount
      || !initialAttempt.cell.refs[0].refs[0].equals(attempt.cell.refs[0].refs[0])) {
      gaps.push({ code: 'original_order_transfer_unobserved', account: wallet.address, lt: record.originLt }); continue;
    }
    try {
      const body = incoming.body.beginParse();
      if (body.loadUint(32) !== 0x0f8a7ea5 || body.loadUintBig(64) !== initialAttempt.queryId || body.loadCoins() !== initialAttempt.amount
        || body.loadAddress().toRawString() !== initialAttempt.recipient || (body.loadMaybeAddress()?.toRawString() ?? null) !== initialAttempt.response) throw unavailable();
      const custom = body.loadMaybeRef();
      if ((custom === null) !== (initialAttempt.customPayload === null) || custom && !custom.equals(initialAttempt.customPayload!)
        || body.loadCoins() !== initialAttempt.forwardValue || !beginCell().storeSlice(body).endCell().equals(initialAttempt.forwardPayload)) throw unavailable();
      if (body.loadBit()) { body.loadRef(); body.endParse(); }
      const before = readCurrentT3Wallet(activeOrderAccount(o.before, binding.walletCodeHash).data);
      const after = readCurrentT3Wallet(activeOrderAccount(o.after, binding.walletCodeHash).data);
      for (const state of [before, after]) if (state.owner !== request.order || state.master !== binding.hub || state.proofCodeHash !== binding.proofCodeHash) throw unavailable();
      if (before.balance - after.balance !== initialAttempt.amount) throw unavailable();
    } catch { gaps.push({ code: 'original_order_transfer_unobserved', account: wallet.address, lt: record.originLt }); continue; }
    records.push({ ...record, transferTransaction: original.evidence });
  }
  if (records.length > limits.candidates) { gaps.push({ code: 'wallet_claim_candidate_limit', account: wallet.address }); return finish(); }
  const hashes = new Set(records.map(r => orderCell(r.recordBoc).refs[0].hash().toString('hex'))), failures = claims.failures.filter(f => hashes.has(f.attemptHash));
  if (failures.length > limits.failures) { gaps.push({ code: 'wallet_failure_candidate_limit', account: wallet.address }); return finish(); }
  if (gaps.length) return finish();
  response.claims = { root: claims.root, count: claims.count, records, failureRoot: claims.failureRoot, failureCount: claims.failureCount, failures };
  return finish();
}
