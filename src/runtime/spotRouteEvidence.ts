import { Cell, Dictionary, loadMessage, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { AccountStateResponse, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { assertPoolIdentity, SPOT_EVIDENCE_LIMITS } from './spotEvidenceIdentity';
import { SpotEvidenceError, type ParsedRouteSpotOperationRequest } from './spotOperationRequest';

type PinnedAccount = { address: string; codeBoc: string; dataBoc: string };
export type CurrentSpotRouteEvidence = {
  schema: 'tonswap-spot-route-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'route'; owner: string; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  pools: { first: PinnedAccount; second: PinnedAccount }; coordinator: PinnedAccount;
  wallets: { pay: string; receive: string; pool1Pay: string; pool1T3: string; coordinatorT3: string;
    pool2T3: string; pool2Receive: string; refundT3: string };
  accounts: Array<{ address: string; shardAccountBoc: string }>;
  transactions: OrderTransactionEvidence[];
};
const unavailable = () => new SpotEvidenceError(503, 'upstream_unavailable');
export type SpotRouteEvidenceLimits = { -readonly [K in keyof typeof SPOT_EVIDENCE_LIMITS]: number };
/** Internal lower-only work budget. HTTP requests never supply these values. */
function routeLimits(overrides: Partial<SpotRouteEvidenceLimits>) {
  const limits: SpotRouteEvidenceLimits = { ...SPOT_EVIDENCE_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value! <= 0) throw unavailable();
    const name = key as keyof SpotRouteEvidenceLimits;
    limits[name] = Math.min(value!, SPOT_EVIDENCE_LIMITS[name]);
  }
  return limits;
}
const slotCodec = { serialize() { throw Error('read only'); }, parse(s: Slice) {
  const slot = { master: s.loadAddress().toRawString(), wallet: s.loadMaybeAddress()?.toRawString() ?? null,
    gas: s.loadUint(32), gram: s.loadCoins(), optional: s.loadBit(), budget: s.loadRef() }; s.endParse(); return slot;
} };
function poolWalletIdentity(data: Cell, expected: string[][]) {
  const s = data.beginParse();
  s.loadUint(8); s.loadUint(16); s.loadUint(32); s.loadUint(8); s.loadInt(32);
  s.loadCoins(); s.loadUint(16); s.loadUint(16); s.loadUint(8);
  const jetton = s.loadRef().beginParse(); s.loadRef(); s.loadRef(); s.loadRef(); s.endParse();
  const slots = jetton.loadDict(Dictionary.Keys.Uint(8), slotCodec);
  if (slots.size !== 2) throw unavailable();
  for (const [index, [root, wallet]] of expected.entries()) {
    const slot = slots.get(index);
    if (!slot || slot.master !== root || slot.wallet !== wallet || slot.optional !== (index === 1)) throw unavailable();
  }
}
function coordinatorIdentity(data: Cell, manifest: RuntimeReleaseManifest, wallet: string) {
  const s = data.beginParse();
  if (s.loadAddress().toRawString() !== manifest.contracts.Governance?.address
    || s.loadAddress().toRawString() !== manifest.contracts.Treasury?.address) throw unavailable();
  const fixed = s.loadRef().beginParse(); s.loadRef(); s.endParse();
  const slots = fixed.loadDict(Dictionary.Keys.Uint(8), slotCodec); fixed.loadMaybeRef(); fixed.loadMaybeRef(); fixed.endParse();
  const slot = slots.get(0);
  if (slots.size !== 1 || !slot || slot.master !== manifest.contracts.T3Hub?.address || slot.wallet !== wallet || slot.optional) throw unavailable();
}

/** A bounded original causal graph, never a swap result. Pool economics, actual
 * token debits/credits and the distinction between final B and refunded T3 must
 * still be independently verified by the consumer. */
export async function collectSpotRouteEvidence(manifest: RuntimeReleaseManifest, source: ChainSource,
  store: PhysicalEvidenceStore, parsed: ParsedRouteSpotOperationRequest, signal?: AbortSignal,
  budget: Partial<SpotRouteEvidenceLimits> = {}): Promise<CurrentSpotRouteEvidence> {
  const limits = routeLimits(budget);
  if (`ton:${source.network}` !== manifest.network) throw unavailable();
  signal?.throwIfAborted();
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: limits.newTransactions });
  const request = parsed.request, states = new Map<string, AccountStateResponse>(), gaps: PhysicalGap[] = [];
  const histories = new Map<string, PhysicalBoundary[]>(), verified = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
  let remaining = limits.historyTransactions;
  const checked = (row: PhysicalBoundary) => {
    let tx = verified.get(row); if (!tx) { tx = verifyOrderTransaction(row.evidence); verified.set(row, tx); } return tx;
  };
  const id = (row: PhysicalBoundary) => `${row.evidence.account}:${checked(row).tx.lt}:${checked(row).hash}`;
  const hashes = new Map<Cell, string>();
  const messageHash = (cell: Cell) => {
    let hash = hashes.get(cell); if (!hash) { hash = canonicalPhysicalMessage(cell).hash().toString('hex'); hashes.set(cell, hash); } return hash;
  };
  const sameMessage = (a: Cell, b: Cell) => messageHash(a) === messageHash(b);
  const current = async (address: string) => {
    const cached = states.get(address); if (cached) return cached;
    if (states.size >= limits.accounts) throw unavailable();
    const state = await reader.current(address); states.set(address, state); return state;
  };
  const pinned = async (address: string, codeHash: string): Promise<PinnedAccount> => {
    const state = await current(address), active = activeOrderAccount(orderShard(state.shardAccountBoc!, address).shard, codeHash);
    return { address, codeBoc: active.code.toBoc().toString('base64'), dataBoc: active.data.toBoc().toString('base64') };
  };
  const history = async (address: string, stop: (row: PhysicalBoundary) => boolean) => {
    const cached = histories.get(address); if (cached) return cached;
    if (remaining <= 0) { gaps.push({ code: 'history_transaction_limit', account: address }); return []; }
    try {
      const result = await reader.history(address, await current(address), remaining, stop);
      remaining -= result.rows.length; histories.set(address, result.rows); gaps.push(...result.gaps);
      if (!result.complete) gaps.push({ code: 'anchored_history_incomplete', account: address });
      return result.rows;
    } catch (error) { if (signal?.aborted) throw error; gaps.push({ code: 'current_account_unavailable', account: address }); return []; }
  };
  const coordinatorPin = manifest.contracts.SwapCoordinator;
  if (!coordinatorPin || coordinatorPin.address !== request.coordinator) throw unavailable();
  const first = await pinned(request.pool, manifest.templates.DlmmPool), second = await pinned(request.pool2, manifest.templates.DlmmPool);
  const coordinator = await pinned(request.coordinator, coordinatorPin.codeHash);
  await Promise.all([parsed.market, parsed.market2].map(market => assertPoolIdentity(manifest, source, head, market, signal)));
  const walletReader = createJettonWalletReader({ source, tokens: [parsed.payToken, parsed.intermediateToken, parsed.receiveToken]
    .map(token => ({ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash })) });
  const t3 = parsed.intermediateToken.root, pairs = [
    [request.payRoot, request.owner], [request.receiveRoot, request.owner], [request.payRoot, request.pool],
    [t3, request.pool], [t3, request.coordinator], [t3, request.pool2], [request.receiveRoot, request.pool2], [t3, request.owner],
  ];
  const selected = await Promise.all(pairs.map(([root, owner]) => walletReader.identity(root, owner, { at: head, signal })));
  const addresses = selected.map(wallet => wallet.wallet);
  const allowed = new Set([request.owner, request.pool, request.pool2, request.coordinator, ...addresses,
    request.payRoot, request.receiveRoot, t3]);
  if (new Set(addresses).size !== 8 || allowed.size !== 15 || addresses[0] !== request.sourceWallet)
    throw new SpotEvidenceError(400, 'bad_request');
  const [pay, receive, pool1Pay, pool1T3, coordinatorT3, pool2T3, pool2Receive, refundT3] = addresses;
  poolWalletIdentity(orderCell(first.dataBoc), [[t3, pool1T3], [request.payRoot, pool1Pay]]);
  poolWalletIdentity(orderCell(second.dataBoc), [[t3, pool2T3], [request.receiveRoot, pool2Receive]]);
  coordinatorIdentity(orderCell(coordinator.dataBoc), manifest, coordinatorT3);
  // Retain original master envelopes as well as the same-head canonical getter
  // identities. An unused, proven absent wallet needs no invented envelope.
  for (const token of [parsed.payToken, parsed.intermediateToken, parsed.receiveToken]) await pinned(token.root, token.masterCodeHash);
  for (const address of [request.owner, ...addresses]) {
    try {
      if (address !== request.owner) {
        const state = await source.getAccountState(address, { at: head, signal });
        if (!state.shardAccountBoc && state.provenAbsent === true && state.anchor && state.anchor.genUtime <= head.utime
          && state.accountState === 'uninitialized' && state.balance === '0' && state.codeBoc === null && state.dataBoc === null
          && state.lastTxLt === undefined && state.lastTxHash === undefined) continue;
      }
      await current(address);
    }
    catch (error) { if (signal?.aborted) throw error; gaps.push({ code: 'current_account_unavailable', account: address }); }
  }
  const response: CurrentSpotRouteEvidence = {
    schema: 'tonswap-spot-route-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    request: { kind: 'route', owner: request.owner, bodyHash: request.bodyHash }, coverage: { complete: false, gaps },
    pools: { first, second }, coordinator, wallets: { pay, receive, pool1Pay, pool1T3, coordinatorT3, pool2T3, pool2Receive, refundT3 },
    accounts: [], transactions: [],
  };
  const finish = () => {
    signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
    const unique = [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()];
    response.coverage.gaps = unique.length <= limits.gaps ? unique : [...unique.slice(0, limits.gaps - 1), { code: 'coverage_gap_limit', account: request.pool }];
    response.coverage.complete = response.coverage.gaps.length === 0;
    response.accounts = [...states].map(([address, state]) => ({ address, shardAccountBoc: state.shardAccountBoc! }));
    if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) {
      response.coverage.complete = false;
      response.coverage.gaps = [...response.coverage.gaps.slice(0, limits.gaps - 1), { code: 'response_size_limit', account: request.pool }];
      while (response.transactions.length && Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) response.transactions.pop();
      if (Buffer.byteLength(JSON.stringify(response)) > limits.responseBytes) throw unavailable();
    }
    return response;
  };
  const exact = (row: PhysicalBoundary) => checked(row).tx.lt.toString() === request.dispatch.lt && checked(row).hash === request.dispatch.hash;
  const sourceHistory = await history(pay, exact), origin = sourceHistory.find(exact);
  if (!origin) { gaps.push({ code: 'original_request_unobserved', account: pay, lt: request.dispatch.lt }); return finish(); }
  const original = checked(origin), incoming = original.tx.inMessage;
  if (incoming?.info.type !== 'internal' || incoming.info.bounced || incoming.info.src.toRawString() !== request.owner
    || incoming.info.value.coins.toString() !== request.valueNano || !incoming.body.equals(parsed.body)) {
    gaps.push({ code: 'original_request_mismatch', account: pay, lt: request.dispatch.lt }); return finish();
  }
  // An exact first-hop cursor alone does not identify an owner dispatch. Retain
  // the original owner transaction with the identical full outgoing message.
  const emits = (row: PhysicalBoundary) => checked(row).succeeded && checked(row).tx.lt < original.tx.lt
    && [...checked(row).outgoing.values()].filter(cell => sameMessage(cell, original.incoming!)).length === 1;
  const ownerHistory = await history(request.owner, emits), ownerDispatch = ownerHistory.find(emits);
  if (!ownerDispatch) { gaps.push({ code: 'original_owner_dispatch_unobserved', account: request.owner }); return finish(); }
  const chosen = new Map<string, PhysicalBoundary>([[id(ownerDispatch), ownerDispatch]]), queue = [origin];
  let edges = 0;
  while (queue.length) {
    signal?.throwIfAborted(); const row = queue.shift()!, key = id(row); if (chosen.has(key)) continue;
    if (chosen.size >= limits.returnedTransactions) { gaps.push({ code: 'returned_transaction_limit', account: row.evidence.account }); break; }
    chosen.set(key, row);
    for (const cell of checked(row).outgoing.values()) {
      if (++edges > limits.messageEdges) { gaps.push({ code: 'message_edge_limit', account: row.evidence.account }); queue.length = 0; break; }
      if (edges % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
      const message = loadMessage(cell.beginParse()); if (message.info.type !== 'internal') continue;
      const address = message.info.dest.toRawString();
      if (!allowed.has(address)) { gaps.push({ code: 'related_account_outside_operation', account: address }); continue; }
      const candidates = await history(address, candidate => checked(candidate).tx.prevTransactionLt < original.tx.lt);
      const matches = candidates.filter(candidate => { const tx = checked(candidate); return tx.tx.lt > checked(row).tx.lt && tx.incoming && sameMessage(cell, tx.incoming); });
      if (matches.length === 1) queue.push(matches[0]);
      else gaps.push({ code: matches.length ? 'ambiguous_related_transaction' : 'related_transaction_unobserved', account: address, lt: message.info.createdLt.toString() });
    }
  }
  response.transactions = [...chosen.values()].map(row => row.evidence);
  return finish();
}
