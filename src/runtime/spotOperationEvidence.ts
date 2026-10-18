import { Address, Cell, TupleReader, beginCell, contractAddress, loadMessage, storeStateInit } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { AccountStateResponse, ChainHead, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalOrderTerms, decodeOrderState, orderInitialData } from '../orders/state';
import { canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { SpotEvidenceError, type ParsedSpotOperationRequest } from './spotOperationRequest';

export const SPOT_EVIDENCE_LIMITS = Object.freeze({ accounts: 16, historyTransactions: 256, returnedTransactions: 256,
  newTransactions: 64, messageEdges: 1024, responseBytes: 8 * 1024 * 1024, gaps: 256 });
type PinnedAccount = { address: string; codeBoc: string; dataBoc: string };
type CommonEvidence = { schema: 'tonswap-spot-operation-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] }; pool: PinnedAccount;
  accounts: Array<{ address: string; shardAccountBoc: string }>; transactions: OrderTransactionEvidence[] };
export type CurrentSpotOperationEvidence = CommonEvidence & (
  { request: { kind: 'direct'; owner: string; bodyHash: string }; wallets: { pay: string; receive: string; poolPay: string; poolReceive: string } }
  | { request: { kind: 'order-create'; owner: string; nonce: string; termsHash: string }; factory: PinnedAccount; order: PinnedAccount }
  | { request: { kind: 'order-settlement'; owner: string; nonce: string; termsHash: string; fundingBodyHash: string | null };
    factory: PinnedAccount; order: PinnedAccount; absentAccounts: string[];
    wallets: { ownerPay: string; ownerReceive: string; orderPay: string; poolPay: string; poolReceive: string } });
const unavailable = () => new SpotEvidenceError(503, 'upstream_unavailable');
function pinnedAccount(address: string, state: AccountStateResponse, hash: string): PinnedAccount {
  if (!state.shardAccountBoc) throw unavailable();
  const active = activeOrderAccount(orderShard(state.shardAccountBoc, address).shard, hash);
  return { address, codeBoc: active.code.toBoc().toString('base64'), dataBoc: active.data.toBoc().toString('base64') };
}
const budgetWidths = [['senderGas', 32], ['walletBounceGas', 32], ['burnWalletGas', 32], ['smallPayloadCells', 16],
  ['largeWalletGas', 32], ['largeSenderGas', 32], ['rentSeconds', 32], ['rentBits', 32], ['rentCells', 16],
  ['initBits', 32], ['initCells', 16], ['initCopies', 8], ['transferBits', 16], ['transferCells', 8], ['transferCopies', 8]] as const;
export async function assertPoolIdentity(manifest: RuntimeReleaseManifest, source: ChainSource, head: ChainHead,
  market: RuntimeReleaseManifest['spotMarkets'][number], signal?: AbortSignal) {
  const x = manifest.tokens.find(token => token.symbol === market.symbol), t3 = manifest.tokens.find(token => token.symbol === 'T3');
  if (!x || !t3) throw unavailable();
  const budget = beginCell(); for (const [key, width] of budgetWidths) budget.storeUint(market.walletBudgetX[key], width);
  const id = beginCell().storeAddress(Address.parse(x.root)).storeUint(market.binSpacing, 16).storeUint(market.feePips, 32)
    .storeUint(market.xDecimals, 8).storeUint(market.walletGasX, 32).storeCoins(BigInt(market.walletGramX))
    .storeRef(budget.storeBit(market.walletBudgetX.creditProtection).endCell()).endCell();
  const result = await source.runGetMethod(market.pool, 'get_pool_info', [], { at: head, signal });
  if (!result || result.exitCode !== 0 || result.stack.length !== 14) throw unavailable();
  const s = new TupleReader(result.stack);
  if (!s.readCell().equals(id)) throw unavailable();
  for (const address of [manifest.contracts.DlmmPoolFactory?.address, manifest.contracts.FeeRouter?.address, manifest.contracts.Treasury?.address, t3.root])
    if (!address || s.readAddress().toRawString() !== address) throw unavailable();
  // Consume the current bounded getter shape. Readiness/amounts are observations,
  // never evidence that a prior swap paid its recipient.
  const flags = s.readBigNumber(), ready = s.readBigNumber(), activeBin = s.readBigNumber();
  if (flags < 0n || flags > 255n || ![0n, -1n].includes(ready) || activeBin < -2147483648n || activeBin > 2147483647n) throw unavailable();
  for (let i = 0; i < 3; i++) { const amount = s.readBigNumber(); if (amount < 0n || amount >= 1n << 120n) throw unavailable(); }
  for (const width of [16n, 16n, 8n]) { const count = s.readBigNumber(); if (count < 0n || count >= 1n << width) throw unavailable(); }
  if (s.remaining) throw unavailable();
}

/** Returns original physical facts and their current authenticated boundary.
 * The browser independently decides whether a swap delivered or an order was
 * initialized; events and mutable accounting never become settlement labels. */
export async function collectSpotOperationEvidence(manifest: RuntimeReleaseManifest, source: ChainSource,
  store: PhysicalEvidenceStore, parsed: ParsedSpotOperationRequest, signal?: AbortSignal): Promise<CurrentSpotOperationEvidence> {
  if (`ton:${source.network}` !== manifest.network) throw unavailable();
  signal?.throwIfAborted();
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const limits = SPOT_EVIDENCE_LIMITS, reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  const states = new Map<string, AccountStateResponse>(), histories = new Map<string, PhysicalBoundary[]>(), gaps: PhysicalGap[] = [];
  let remaining = limits.historyTransactions;
  const verified = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
  const checked = (row: PhysicalBoundary) => {
    let result = verified.get(row); if (!result) { result = verifyOrderTransaction(row.evidence); verified.set(row, result); }
    return result;
  };
  const rowId = (row: PhysicalBoundary) => { const tx = checked(row); return `${row.evidence.account}:${tx.tx.lt}:${tx.hash}`; };
  const messageHashes = new Map<Cell, string>();
  const messageHash = (cell: Cell) => {
    let hash = messageHashes.get(cell); if (!hash) { hash = canonicalPhysicalMessage(cell).hash().toString('hex'); messageHashes.set(cell, hash); }
    return hash;
  };
  const sameMessage = (a: Cell, b: Cell) => messageHash(a) === messageHash(b);
  const current = async (address: string) => {
    let state = states.get(address);
    if (!state) {
      if (states.size >= limits.accounts) throw unavailable();
      state = await reader.current(address); states.set(address, state);
    }
    return state;
  };
  const history = async (address: string, stop?: (row: PhysicalBoundary) => boolean) => {
    const cached = histories.get(address); if (cached) return cached;
    if (remaining <= 0) { gaps.push({ code: 'history_transaction_limit', account: address }); return []; }
    try {
      const collected = await reader.history(address, await current(address), remaining, stop);
      remaining -= collected.rows.length; histories.set(address, collected.rows); gaps.push(...collected.gaps);
      if (!collected.complete) gaps.push({ code: 'anchored_history_incomplete', account: address });
      return collected.rows;
    } catch (error) { if (signal?.aborted) throw error; gaps.push({ code: 'current_account_unavailable', account: address }); return []; }
  };
  const pool = pinnedAccount(parsed.market.pool, await current(parsed.market.pool), manifest.templates.DlmmPool);
  await assertPoolIdentity(manifest, source, head, parsed.market, signal);
  const common: CommonEvidence = { schema: 'tonswap-spot-operation-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    coverage: { complete: false, gaps }, pool, accounts: [], transactions: [] };
  const finish = (response: CurrentSpotOperationEvidence) => {
    signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
    const unique = [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()];
    response.coverage.gaps = unique.length <= limits.gaps ? unique : [...unique.slice(0, limits.gaps - 1), { code: 'coverage_gap_limit', account: pool.address }];
    response.coverage.complete = response.coverage.gaps.length === 0;
    response.accounts = [...states].map(([address, state]) => ({ address, shardAccountBoc: state.shardAccountBoc! }));
    if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) {
      response.coverage.complete = false;
      response.coverage.gaps = [...response.coverage.gaps.slice(0, limits.gaps - 1), { code: 'response_size_limit', account: pool.address }];
      while (response.transactions.length && Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) response.transactions.pop();
      if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) throw unavailable();
    }
    return response;
  };
  if (parsed.request.kind === 'direct') {
    // TypeScript does not narrow a union through a nested discriminant.
    const direct = parsed as Extract<ParsedSpotOperationRequest, { body: Cell }>, request = direct.request;
    const wallets = createJettonWalletReader({ source, tokens: manifest.tokens.map(token => ({ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash })) });
    const selected = await Promise.all([[request.payRoot, request.owner], [request.receiveRoot, request.owner],
      [request.payRoot, request.pool], [request.receiveRoot, request.pool]].map(([root, owner]) => wallets.wallet(root, owner, { at: head, signal })));
    if (selected.some(wallet => wallet.status === 'unavailable')) throw unavailable();
    const addresses = selected.map(wallet => wallet.wallet!);
    if (new Set(addresses).size !== 4 || addresses[0] !== request.sourceWallet) throw new SpotEvidenceError(400, 'bad_request');
    // A canonical unused receive wallet may never have existed. Genuine
    // dictionary absence has no original ShardAccount envelope to manufacture.
    // Every wallet reached by the physical graph still needs its actual history.
    await Promise.all([...new Set([request.owner, ...selected.filter(wallet => wallet.status === 'ok').map(wallet => wallet.wallet!)])].map(current));
    const response: CurrentSpotOperationEvidence = { ...common, request: { kind: 'direct', owner: request.owner, bodyHash: request.bodyHash },
      wallets: { pay: addresses[0], receive: addresses[1], poolPay: addresses[2], poolReceive: addresses[3] } };
    const isOrigin = (row: PhysicalBoundary) => {
      const message = checked(row).tx.inMessage;
      return message?.info.type === 'internal' && !message.info.bounced && message.info.src.toRawString() === request.owner
        && message.body.equals(direct.body) && message.info.value.coins.toString() === request.valueNano;
    };
    const sourceHistory = await history(request.sourceWallet, isOrigin), origin = sourceHistory.find(isOrigin);
    if (!origin) { gaps.push({ code: 'original_request_unobserved', account: request.sourceWallet }); return finish(response); }
    const originLt = checked(origin).tx.lt, allowed = new Set([request.owner, request.pool, ...addresses]);
    const queue: PhysicalBoundary[] = [origin], chosen = new Map<string, PhysicalBoundary>();
    let edges = 0;
    while (queue.length) {
      signal?.throwIfAborted(); const row = queue.shift()!, id = rowId(row); if (chosen.has(id)) continue;
      if (chosen.size >= limits.returnedTransactions) { gaps.push({ code: 'returned_transaction_limit', account: row.evidence.account }); break; }
      chosen.set(id, row);
      for (const cell of checked(row).outgoing.values()) {
        if (++edges > limits.messageEdges) { gaps.push({ code: 'message_edge_limit', account: row.evidence.account }); queue.length = 0; break; }
        if (edges % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
        const message = loadMessage(cell.beginParse()); if (message.info.type !== 'internal') continue;
        const address = message.info.dest.toRawString();
        if (!allowed.has(address)) { gaps.push({ code: 'related_account_outside_operation', account: address }); continue; }
        const candidates = await history(address, candidate => checked(candidate).tx.prevTransactionLt < originLt);
        const matches = candidates.filter(candidate => { const tx = checked(candidate); return tx.tx.lt > checked(row).tx.lt && tx.incoming && sameMessage(cell, tx.incoming); });
        if (matches.length === 1) queue.push(matches[0]);
        else gaps.push({ code: matches.length ? 'ambiguous_related_transaction' : 'related_transaction_unobserved', account: address, lt: message.info.createdLt.toString() });
      }
    }
    response.transactions = [...chosen.values()].map(row => row.evidence); return finish(response);
  }
  const creation = parsed as Exclude<ParsedSpotOperationRequest, { body: Cell }>, request = creation.request;
  const factoryPin = manifest.contracts.SpotOrderFactory!;
  const factory = pinnedAccount(request.factory, await current(request.factory), factoryPin.codeHash), f = orderCell(factory.dataBoc).beginParse();
  const orderCode = f.loadRef(); f.loadUintBig(64); f.endParse();
  if (orderCode.isExotic || orderCode.hash().toString('hex') !== manifest.templates.SpotOrder
    || contractAddress(0, { code: orderCode, data: orderInitialData(Address.parse(request.factory), Address.parse(request.owner), BigInt(request.nonce)) }).toRawString() !== request.order)
    throw new SpotEvidenceError(400, 'bad_request');
  const order = pinnedAccount(request.order, await current(request.order), manifest.templates.SpotOrder);
  const currentOrder = decodeOrderState(orderCell(order.dataBoc));
  if (currentOrder.factory.toRawString() !== request.factory || currentOrder.owner.toRawString() !== request.owner || currentOrder.nonce.toString() !== request.nonce) throw unavailable();
  let response: CurrentSpotOperationEvidence;
  const absent = new Set<string>();
  if (request.kind === 'order-settlement') {
    const t3 = manifest.tokens.find(token => token.symbol === 'T3')!, x = manifest.tokens.find(token => token.symbol === parsed.market.symbol)!;
    const receiveRoot = request.inputRoot === t3.root ? x.root : t3.root;
    const wallets = createJettonWalletReader({ source, tokens: manifest.tokens.map(token => ({ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash })) });
    const selected = await Promise.all([[request.inputRoot, request.owner], [receiveRoot, request.owner], [request.inputRoot, request.order],
      [request.inputRoot, request.pool], [receiveRoot, request.pool]].map(([root, owner]) => wallets.wallet(root, owner, { at: head, signal })));
    if (selected.some(wallet => wallet.status === 'unavailable')) throw unavailable();
    const [ownerPay, ownerReceive, orderPay, poolPay, poolReceive] = selected.map(wallet => wallet.wallet!);
    if (new Set([ownerPay, ownerReceive, orderPay, poolPay, poolReceive]).size !== 5
      || request.funding && request.funding.sourceWallet !== ownerPay) throw new SpotEvidenceError(400, 'bad_request');
    response = { ...common, request: { kind: 'order-settlement', owner: request.owner, nonce: request.nonce,
      termsHash: request.termsHash, fundingBodyHash: request.funding?.bodyHash ?? null }, factory, order,
      wallets: { ownerPay, ownerReceive, orderPay, poolPay, poolReceive }, absentAccounts: [] };
    await current(request.owner);
    for (const selectedWallet of selected) {
      if (selectedWallet.status === 'ok') { await current(selectedWallet.wallet); continue; }
      const address = selectedWallet.wallet!, state = await source.getAccountState(address, { at: head, signal });
      if (state.shardAccountBoc) { await current(address); continue; }
      if (state.provenAbsent === true && state.anchor && state.anchor.genUtime <= head.utime && state.accountState === 'uninitialized'
        && state.balance === '0' && state.codeBoc === null && state.dataBoc === null && state.lastTxLt === undefined && state.lastTxHash === undefined)
        absent.add(address);
      else gaps.push({ code: 'current_wallet_absence_unproven', account: address });
    }
    response.absentAccounts = [...absent];
  } else response = { ...common, request: { kind: 'order-create', owner: request.owner, nonce: request.nonce, termsHash: request.termsHash }, factory, order };
  const isInitialization = (row: PhysicalBoundary) => {
    const tx = checked(row), message = tx.tx.inMessage;
    if (!tx.succeeded || message?.info.type !== 'internal' || message.info.bounced || message.info.src.toRawString() !== request.factory
      || message.body.bits.length < 32 || message.body.beginParse().preloadUint(32) !== 0x4f494e49) return false;
    const before = tx.before.account?.storage.state;
    return !before || before.type === 'uninit' || before.type === 'active' && !!before.state.data && before.state.data.equals(orderInitialData(Address.parse(request.factory), Address.parse(request.owner), BigInt(request.nonce)));
  };
  const childHistory = await history(request.order, isInitialization), child = childHistory.find(isInitialization);
  if (!child) { gaps.push({ code: 'original_initialization_unobserved', account: request.order }); return finish(response); }
  const incoming = checked(child).incoming!;
  const emitsInitialization = (row: PhysicalBoundary) => checked(row).outgoing.values().some(cell => sameMessage(cell, incoming));
  const factoryHistory = await history(request.factory, emitsInitialization), origin = factoryHistory.find(emitsInitialization);
  if (!origin) { gaps.push({ code: 'original_creation_unobserved', account: request.factory }); return finish(response); }
  try {
    const tx = checked(origin), message = tx.tx.inMessage;
    if (!tx.succeeded || message?.info.type !== 'internal' || message.info.bounced || message.info.src.toRawString() !== request.owner) throw unavailable();
    const body = message.body.beginParse(); if (body.loadUint(32) !== 0x4f435254) throw unavailable();
    const query = body.loadUintBig(64); if (body.loadUintBig(64).toString() !== request.nonce || !body.loadRef().equals(creation.termsCell)) throw unavailable(); body.endParse();
    const actual = canonicalOrderTerms(creation.termsCell, Address.parse(request.owner), tx.tx.now), initialized = checked(child).tx.inMessage!.body.beginParse();
    if (initialized.loadUint(32) !== 0x4f494e49 || initialized.loadUintBig(64) !== query || !initialized.loadRef().equals(actual)) throw unavailable(); initialized.endParse();
    const c = checked(child), delivered = c.tx.inMessage!;
    const expectedInit = { code: orderCode, data: orderInitialData(Address.parse(request.factory), Address.parse(request.owner), BigInt(request.nonce)) };
    if (!delivered.init || !beginCell().store(storeStateInit(delivered.init)).endCell().equals(beginCell().store(storeStateInit(expectedInit)).endCell())
      || c.tx.lt <= tx.tx.lt) throw unavailable();
    const before = c.before.account?.storage.state;
    if (before?.type === 'active' && !activeOrderAccount(c.before, manifest.templates.SpotOrder).data.equals(expectedInit.data)) throw unavailable();
    const initializedOrder = decodeOrderState(activeOrderAccount(c.after, manifest.templates.SpotOrder).data);
    if (initializedOrder.factory.toRawString() !== request.factory || initializedOrder.owner.toRawString() !== request.owner
      || initializedOrder.nonce.toString() !== request.nonce || initializedOrder.state !== 1
      || initializedOrder.executedSlices !== 0 || initializedOrder.execId !== 0 || initializedOrder.closeReason !== 0
      || initializedOrder.attemptAt !== 0 || initializedOrder.lastExecutedAt !== 0 || initializedOrder.cancelRequested
      || initializedOrder.refundSeen || initializedOrder.refundKind !== 0 || initializedOrder.refusal !== 0
      || initializedOrder.inputWallet || initializedOrder.keeper || initializedOrder.prevKeeper
      || !initializedOrder.termsCell?.equals(actual) || !currentOrder.termsCell?.equals(actual)) throw unavailable();
    for (const shard of [tx.before, tx.after]) if (!activeOrderAccount(shard, factoryPin.codeHash).data.equals(orderCell(factory.dataBoc))) throw unavailable();
    response.transactions = [origin.evidence, child.evidence];
  } catch { gaps.push({ code: 'creation_request_mismatch', account: request.factory }); }
  if (request.kind === 'order-settlement' && response.request.kind === 'order-settlement') {
    const settlement = response as Extract<CurrentSpotOperationEvidence, { absentAccounts: string[] }>;
    // Include every original order and input-wallet state transition. Sparse
    // events and a closed getter are never a substitute for this whole history.
    const inputHistory = absent.has(settlement.wallets.orderPay) ? [] : await history(settlement.wallets.orderPay);
    const pending = [...childHistory, ...inputHistory, origin], chosen = new Map<string, PhysicalBoundary>();
    if (request.funding) {
      const funding = request.funding, parsedFunding = 'fundingBody' in creation ? creation.fundingBody : null;
      const exactFunding = (row: PhysicalBoundary) => checked(row).tx.lt.toString() === funding.lt && checked(row).hash === funding.hash;
      const fundingHistory = await history(funding.sourceWallet, exactFunding), funded = fundingHistory.find(exactFunding);
      const message = funded ? checked(funded).tx.inMessage : null;
      if (funded && message?.info.type === 'internal' && !message.info.bounced && message.info.src.toRawString() === request.owner
        && message.info.value.coins.toString() === funding.valueNano && parsedFunding && message.body.equals(parsedFunding)) pending.push(funded);
      else gaps.push({ code: 'original_funding_dispatch_unobserved', account: funding.sourceWallet, lt: funding.lt });
    }
    const allowed = new Set([request.owner, request.factory, request.order, request.pool, request.inputRoot,
      manifest.orderKeeper.address, ...Object.values(settlement.wallets)]);
    // Current peers and historical permissionless executors come only from
    // this pinned child's authenticated state, never request expansion fields.
    for (const keeper of [currentOrder.keeper, currentOrder.prevKeeper, creation.terms.executor]) if (keeper) allowed.add(keeper.toRawString());
    for (const row of childHistory) {
      try {
        const tx = checked(row), message = tx.tx.inMessage;
        if (!tx.succeeded || message?.info.type !== 'internal' || message.info.bounced || message.info.src.workChain !== 0) continue;
        const body = message.body.beginParse(), op = body.loadUint(32); body.loadUintBig(64);
        if (op === 0x4f455845) body.loadCoins(); else if (op !== 0x4f434c53) continue;
        body.endParse();
        const before = decodeOrderState(activeOrderAccount(tx.before, manifest.templates.SpotOrder).data);
        const after = decodeOrderState(activeOrderAccount(tx.after, manifest.templates.SpotOrder).data);
        if (![before, after].every(state => state.factory.toRawString() === request.factory
          && state.owner.toRawString() === request.owner && state.nonce.toString() === request.nonce
          && state.termsCell?.equals(currentOrder.termsCell!))) continue;
        const sender = message.info.src;
        if (op === 0x4f455845 && before.state === 1 && after.state === 2 && !before.cancelRequested
          && after.execId === before.execId + 1 && after.executedSlices === before.executedSlices
          && after.keeper?.equals(sender) && after.prevKeeper?.toRawString() === before.keeper?.toRawString()
          && (!creation.terms.executor || creation.terms.executor.equals(sender) || sender.toRawString() === request.owner)) allowed.add(sender.toRawString());
        if (op === 0x4f434c53 && before.state !== 3 && after.state === 3 && after.closeReason === 3
          && tx.tx.now >= creation.terms.expiresAt) allowed.add(sender.toRawString());
      } catch { /* An unrelated or malformed input grants no graph identity. */ }
    }
    if (allowed.size > limits.accounts) throw unavailable();
    const firstLt = pending.reduce((minimum, row) => checked(row).tx.lt < minimum ? checked(row).tx.lt : minimum, checked(origin).tx.lt);
    const unfundedAbsentRefund = (row: PhysicalBoundary, messageCell: Cell) => {
      try {
        const message = loadMessage(messageCell.beginParse());
        if (request.funding !== null || currentOrder.state !== 3 || currentOrder.executedSlices !== 0
          || row.evidence.account !== request.order || !checked(row).succeeded || message.info.type !== 'internal'
          || message.info.dest.toRawString() !== settlement.wallets.orderPay || !message.info.bounce || message.info.bounced) return false;
        for (const state of [checked(row).before, checked(row).after]) activeOrderAccount(state, manifest.templates.SpotOrder);
        const body = message.body.beginParse(); if (body.loadUint(32) !== 0x0f8a7ea5) return false; body.loadUintBig(64);
        if (body.loadCoins() !== creation.terms.amountIn || body.loadAddress().toRawString() !== request.owner
          || body.loadAddress().toRawString() !== request.owner || body.loadMaybeRef() || body.loadCoins() !== 0n) return false;
        if (body.loadBit()) { const payload = body.loadRef(); if (payload.bits.length || payload.refs.length || payload.isExotic) return false; } body.endParse();
        const bouncedBody = beginCell().storeUint(0xffffffff, 32)
          .storeBits(message.body.bits.substring(0, Math.min(256, message.body.bits.length))).endCell();
        return childHistory.filter(candidate => {
          const tx = checked(candidate), input = tx.tx.inMessage;
          return tx.tx.lt > checked(row).tx.lt && input?.info.type === 'internal' && input.info.bounced
            && input.info.src.toRawString() === settlement.wallets.orderPay && input.body.equals(bouncedBody);
        }).length === 1;
      } catch { return false; }
    };
    let edges = 0;
    while (pending.length) {
      signal?.throwIfAborted(); const row = pending.shift()!, id = rowId(row); if (chosen.has(id)) continue;
      if (chosen.size >= limits.returnedTransactions) { gaps.push({ code: 'returned_transaction_limit', account: row.evidence.account }); break; }
      chosen.set(id, row);
      for (const cell of checked(row).outgoing.values()) {
        if (++edges > limits.messageEdges) { gaps.push({ code: 'message_edge_limit', account: row.evidence.account }); pending.length = 0; break; }
        if (edges % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
        const message = loadMessage(cell.beginParse()); if (message.info.type !== 'internal') continue;
        const address = message.info.dest.toRawString();
        if (!allowed.has(address)) { gaps.push({ code: 'related_account_outside_operation', account: address }); continue; }
        if (absent.has(address)) {
          // Only a never-funded, zero-execution closed order may account for its
          // failed refund using proven current absence plus its original bounce.
          // This does not manufacture a failed wallet transaction or token credit.
          if (!unfundedAbsentRefund(row, cell)) gaps.push({ code: 'related_account_absent', account: address });
          continue;
        }
        const candidates = await history(address, candidate => checked(candidate).tx.prevTransactionLt < firstLt);
        const matches = candidates.filter(candidate => checked(candidate).tx.lt > checked(row).tx.lt
          && checked(candidate).incoming && sameMessage(cell, checked(candidate).incoming!));
        if (matches.length === 1) pending.push(matches[0]);
        else gaps.push({ code: matches.length ? 'ambiguous_related_transaction' : 'related_transaction_unobserved', account: address, lt: message.info.createdLt.toString() });
      }
    }
    settlement.transactions = [...chosen.values()].map(row => row.evidence);
  }
  return finish(response);
}
