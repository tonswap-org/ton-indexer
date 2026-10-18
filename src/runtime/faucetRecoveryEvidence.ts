import { Address, beginCell, Cell, Dictionary, loadMessage, type ShardAccount } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { currentT3ReceiptWitness, SparseT3Tree } from '../ledger/currentT3Receipts';
import { t3PathRoot } from '../ledger/currentT3Wire';
import { activeOrderAccount, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { ProductEvidenceError } from './productEvidence';
import { readFaucetOperationRequest } from './faucetOperationEvidence';

export const FAUCET_RECOVERY_LIMITS = Object.freeze({ history: 10000, newTransactions: 64, witnesses: 32, transactions: 256, bytes: 8 * 1024 * 1024 });
export const readFaucetRecoveryRequest = readFaucetOperationRequest;
export type CurrentFaucetRecoveryEvidence = {
  schema: 'tonswap-faucet-recovery-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: 'claim'; owner: string; bodyHash: string };
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  faucet: { address: string; shardAccountBoc: string } | null;
  sourceWallet: { address: string; shardAccountBoc: string } | null;
  receipts: { root: string; initialized: boolean; lastKey: string; count: string; records: Array<{ key: string; recordBoc: string | null; proofBoc: string }> } | null;
  sourceFailure: { sourceLt: string; sourceHash: string; targetWallet: string; targetLt: string; targetHash: string; commandBoc: string; wire: string; amountRaw: string } | null;
  transactions: OrderTransactionEvidence[];
};
export function boundFaucetRecoveryEvidence(response: CurrentFaucetRecoveryEvidence): CurrentFaucetRecoveryEvidence {
  if (response.transactions.length > FAUCET_RECOVERY_LIMITS.transactions) {
    response.coverage.complete = false; response.coverage.gaps.push({ code: 'returned_transaction_limit', account: response.faucet?.address ?? '' });
    response.transactions = response.transactions.slice(0, FAUCET_RECOVERY_LIMITS.transactions);
  }
  return response;
}
const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');
function check(value: unknown): asserts value { if (!value) throw unavailable(); }
const hex = (n: bigint) => n.toString(16).padStart(64, '0');
const cell = (c: Cell) => { check(!c.isExotic); return c.beginParse(); };
const emptyRoot = currentT3ReceiptWitness(new Map(), 0n).root;
function receipt(c: Cell) {
  const s = cell(c), key = s.loadUintBig(64), item = cell(s.loadRef()); s.endParse();
  const incoming = item.loadBit(), slot = item.loadUint(8), amount = item.loadCoins(), claimed = item.loadBit(), body = item.loadRef(); item.endParse();
  check(slot < 3 && amount > 0n); return { key, incoming, slot, amount, claimed, body };
}
function claimedReceipt(c: Cell) {
  const r = receipt(c); check(!r.claimed);
  return beginCell().storeUint(r.key, 64).storeRef(beginCell().storeBit(r.incoming).storeUint(r.slot, 8).storeCoins(r.amount).storeBit(true).storeRef(r.body)).endCell();
}
function state(shard: ShardAccount, codeHash: string) {
  const data = activeOrderAccount(shard, codeHash).data, s = cell(data), config = s.loadRef(), c = cell(config);
  const cooldown = c.loadUint(32), grants = [c.loadCoins(), c.loadCoins(), c.loadCoins()]; const supplyBase = c.loadUintBig(120); c.loadCoins(); c.endParse();
  const managed = cell(s.loadRef()), slots = managed.loadDict(Dictionary.Keys.Uint(8), { serialize() { throw unavailable(); }, parse(p) {
    const master = p.loadAddress().toRawString(), wallet = p.loadMaybeAddress()?.toRawString() ?? null;
    p.loadUint(32); p.loadCoins(); p.loadBit(); const budget = p.loadRef(); p.endParse();
    const b = cell(budget); b.skip(32 * 8 + 16 * 4 + 8 * 3); const creditProtection = b.loadBit(); b.endParse();
    return { master, wallet, creditProtection };
  } });
  managed.loadMaybeRef(); const recovery = managed.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()); managed.endParse();
  const available = [s.loadCoins(), s.loadCoins(), s.loadCoins()]; s.loadCoins(); const nextWire = s.loadUintBig(65), count = s.loadUint(16);
  const claimers = s.loadDict(Dictionary.Keys.Address(), { serialize() { throw unavailable(); }, parse(p) { return { last: [p.loadUint(32), p.loadUint(32), p.loadUint(32)], wire: [p.loadUintBig(64), p.loadUintBig(64), p.loadUintBig(64)] }; } }); s.endParse();
  check(slots.size === 3 && count === claimers.size && cooldown > 0 && grants.every(n => n > 0n));
  const trees = [0, 1, 2].map(slot => {
    const value = recovery.get(slot); if (!value) return { root: emptyRoot, initialized: false, lastKey: 0n };
    const r = cell(value); r.loadUintBig(256); r.loadUintBig(256); r.loadCoins(); const tree = r.loadMaybeRef(); r.loadUintBig(256); r.endParse();
    if (!tree) return { root: emptyRoot, initialized: false, lastKey: 0n };
    const t = cell(tree), root = t.loadUintBig(256), initialized = t.loadBit(), lastKey = t.loadUintBig(64); t.loadUintBig(256); t.loadMaybeRef(); t.endParse();
    return { root, initialized, lastKey };
  });
  return { data, config, supplyBase, slots, trees, grants, available, nextWire, claimers };
}
function command(c: Cell) {
  const s = cell(c); check(s.loadUint(32) === 0x0f8a7ea5); const wire = s.loadUintBig(64), amount = s.loadCoins(), owner = s.loadAddress().toRawString(), excess = s.loadMaybeAddress();
  check(excess?.toRawString() === owner && !s.loadMaybeRef() && s.loadCoins() === 0n); const p = s.loadBit() ? cell(s.loadRef()) : s; p.endParse(); if (p !== s) s.endParse();
  return { wire, amount, owner };
}
/** Reconstruct every holder receipt transition from the complete original
 * history. A receipt witness authorizes inventory/cooldown recovery only; it
 * never proves a physical grant. Frozen intervals retain their native cells. */
export async function collectFaucetRecoveryEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readFaucetRecoveryRequest>, signal?: AbortSignal): Promise<CurrentFaucetRecoveryEvidence> {
  const { request: p } = parsed; signal?.throwIfAborted(); if (`ton:${source.network}` !== manifest.network) throw unavailable();
  const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: FAUCET_RECOVERY_LIMITS.newTransactions });
  const response: CurrentFaucetRecoveryEvidence = { schema: 'tonswap-faucet-recovery-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex }, request: { kind: 'claim', owner: p.owner, bodyHash: p.bodyHash },
    coverage: { complete: false, gaps: [] }, faucet: null, sourceWallet: null, receipts: null, sourceFailure: null, transactions: [] };
  const gaps = response.coverage.gaps, selected = new Map<string, OrderTransactionEvidence>();
  const add = (r: PhysicalBoundary) => {
    if (selected.has(r.evidence.transactionBoc)) return;
    if (selected.size >= FAUCET_RECOVERY_LIMITS.transactions) { if (!gaps.some(g => g.code === 'returned_transaction_limit')) gaps.push({ code: 'returned_transaction_limit', account: p.faucet }); return; }
    selected.set(r.evidence.transactionBoc, r.evidence);
  };
  const finish = () => {
    signal?.throwIfAborted(); assertFreshHeadTime(head.utime); response.transactions = [...selected.values()]; response.coverage.complete = gaps.length === 0;
    if (Buffer.byteLength(JSON.stringify(response)) > FAUCET_RECOVERY_LIMITS.bytes) {
      response.coverage.complete = false; gaps.push({ code: 'response_size_limit', account: p.faucet }); response.transactions = []; response.receipts = null; response.sourceFailure = null;
      if (Buffer.byteLength(JSON.stringify(response)) > FAUCET_RECOVERY_LIMITS.bytes) throw unavailable();
    } return boundFaucetRecoveryEvidence(response);
  };
  try {
    const token = manifest.tokens.find(t => t.symbol === ['T3', 'USDT', 'TS'][p.asset]); check(token);
    // Only a release-pinned protected T3 source has this native failure protocol.
    check(p.asset === 0 && token.root === manifest.contracts.T3Hub?.address && token.walletCodeHash === manifest.templates.T3Wallet);
    const current = await reader.current(p.faucet), codeHash = manifest.contracts.TestnetFaucet!.codeHash;
    const now = state(orderShard(current.shardAccountBoc!, p.faucet).shard, codeHash), slot = now.slots.get(p.asset);
    check(now.supplyBase.toString() === manifest.supplyBase);
    check(slot?.master === token.root && slot.wallet && slot.creditProtection);
    response.faucet = { address: p.faucet, shardAccountBoc: current.shardAccountBoc! };
    const identity = await createJettonWalletReader({ source, tokens: [{ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash }] }).identity(token.root, p.faucet, { at: head, signal }); check(identity.wallet === slot.wallet);
    const sourceState = await reader.current(slot.wallet); response.sourceWallet = { address: slot.wallet, shardAccountBoc: sourceState.shardAccountBoc! };
    const history = await reader.history(p.faucet, current, FAUCET_RECOVERY_LIMITS.history);
    gaps.push(...history.gaps); if (!history.complete) { gaps.push({ code: 'holder_history_incomplete', account: p.faucet }); return finish(); }
    const walletHistory = await reader.history(slot.wallet, sourceState, FAUCET_RECOVERY_LIMITS.history - history.rows.length);
    gaps.push(...walletHistory.gaps); if (!walletHistory.complete) { gaps.push({ code: 'source_history_incomplete', account: slot.wallet }); return finish(); }
    const checked = new Map<PhysicalBoundary, ReturnType<typeof verifyOrderTransaction>>();
    const tx = (r: PhysicalBoundary) => { let v = checked.get(r); if (!v) { v = verifyOrderTransaction(r.evidence); checked.set(r, v); } return v; };
    const linked = (a: PhysicalBoundary, b: PhysicalBoundary) => !!tx(b).incoming && tx(a).tx.lt < tx(b).tx.lt
      && [...tx(a).outgoing.values()].some(m => canonicalPhysicalMessage(m).equals(canonicalPhysicalMessage(tx(b).incoming!)));
    const origin = await reader.exact(p.owner, p.dispatch.lt, p.dispatch.hash), sent = [...tx(origin).outgoing.values()].filter(raw => {
      const m = loadMessage(raw.beginParse()); return m.info.type === 'internal' && !m.info.bounced && m.info.src.toRawString() === p.owner
        && m.info.dest.toRawString() === p.faucet && m.info.value.coins.toString() === p.dispatch.valueNano && m.body.equals(parsed.body);
    }); check(tx(origin).succeeded && sent.length === 1); add(origin);
    const claims = history.rows.filter(r => linked(origin, r) && tx(r).tx.inMessage?.body.equals(parsed.body)); check(claims.length === 1 && tx(claims[0]).succeeded);
    const claim = claims[0], before = state(tx(claim).before, codeHash), after = state(tx(claim).after, codeHash), amount = before.grants[p.asset], wire = before.nextWire;
    check(before.config.equals(now.config) && after.config.equals(now.config) && after.nextWire === wire + 1n && before.available[p.asset] - after.available[p.asset] === amount
      && after.claimers.get(Address.parse(p.owner))?.wire[p.asset] === wire && after.claimers.get(Address.parse(p.owner))?.last[p.asset] === tx(claim).tx.now);
    add(claim);
    const transfers = walletHistory.rows.filter(r => linked(claim, r) && (() => { try { const m = tx(r).tx.inMessage; if (m?.info.type !== 'internal' || m.info.bounced || m.info.src.toRawString() !== p.faucet) return false;
      const c = command(m.body); return c.wire === wire && c.amount === amount && c.owner === p.owner; } catch { return false; } })()); check(transfers.length === 1);
    const failure = transfers[0]; add(failure); check(!tx(failure).succeeded);
    const bounces = history.rows.filter(r => linked(failure, r) && tx(r).tx.inMessage?.info.type === 'internal' && (tx(r).tx.inMessage!.info as { bounced?: boolean }).bounced); const outgoing = tx(failure).tx.outMessages.values().filter(m => m.info.type === 'internal');
    check(bounces.length === 1 && !tx(bounces[0]).succeeded || bounces.length === 0 && outgoing.length === 0);
    const target = bounces[0] ?? failure; add(target);
    const records = [new Map<bigint, Cell>(), new Map<bigint, Cell>(), new Map<bigint, Cell>()], trees = [new SparseT3Tree(), new SparseT3Tree(), new SparseT3Tree()], lastKeys = [0n, 0n, 0n];
    const put = (slot: number, key: bigint, record: Cell) => { records[slot].set(key, record); trees[slot].set(key, record); if (key > lastKeys[slot]) lastKeys[slot] = key; };
    const checkRoots = (s: ReturnType<typeof state>) => {
      check(s.config.equals(now.config));
      for (let i = 0; i < 3; i++) { const count = records[i].size, tree = s.trees[i];
        check(trees[i].root === tree.root && tree.initialized === (count > 0) && tree.lastKey === lastKeys[i]);
      }
    };
    for (const [i, row] of [...history.rows].reverse().entries()) {
      if (i % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted(); }
      const t = tx(row);
      if (t.before.account?.storage.state.type === 'active') checkRoots(state(t.before, codeHash));
      let changed = false;
      if (t.succeeded) {
        for (const m of t.tx.outMessages.values()) if (m.info.type === 'external-out' && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x4a524543) {
          const s = cell(m.body); s.loadUint(32); const rec = s.loadRef(); s.endParse(); const r = receipt(rec); check(!r.claimed && !records[r.slot].has(r.key)); put(r.slot, r.key, rec); changed = true;
        }
        const m = t.tx.inMessage;
        if (m?.info.type === 'internal' && !m.info.bounced && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x4a52434d) {
          const s = cell(m.body); s.loadUint(32); const prior = s.loadRef(), proof = s.loadRef(); s.endParse(); const r = receipt(prior);
          check(records[r.slot].get(r.key)?.equals(prior) && t3PathRoot(r.key, prior, proof) === trees[r.slot].root);
          put(r.slot, r.key, claimedReceipt(prior)); changed = true;
        }
      }
      if (t.after.account?.storage.state.type === 'active') checkRoots(state(t.after, codeHash)); else check(!changed);
    }
    checkRoots(now);
    const key = tx(failure).tx.lt, selectedReceipt = records[p.asset].get(key) ?? null, tree = now.trees[p.asset], proof = { proof: trees[p.asset].proof(key) };
    if (selectedReceipt) { const r = receipt(selectedReceipt); check(!r.incoming && r.slot === p.asset && r.amount === amount && r.body.equals(tx(failure).tx.inMessage!.body)); }
    response.receipts = { root: hex(tree.root), initialized: tree.initialized, lastKey: String(tree.lastKey), count: String(records[p.asset].size),
      records: [{ key: String(key), recordBoc: selectedReceipt?.toBoc().toString('base64') ?? null, proofBoc: proof.proof.toBoc().toString('base64') }] };
    response.sourceFailure = { sourceLt: String(key), sourceHash: tx(failure).hash, targetWallet: target.evidence.account, targetLt: String(tx(target).tx.lt), targetHash: tx(target).hash,
      commandBoc: tx(failure).tx.inMessage!.body.toBoc().toString('base64'), wire: String(wire), amountRaw: String(amount) };
    // Original successful receipt/cooldown transitions are useful independently
    // of the sparse proof, and remain separate from grant delivery evidence.
    for (const row of history.rows) if (tx(row).succeeded && tx(row).tx.lt > key && tx(row).tx.inMessage?.body.bits.length! >= 32) {
      const op = tx(row).tx.inMessage!.body.beginParse().preloadUint(32); if ([0x4a52434d, 0x46435253].includes(op)) add(row);
    }
  } catch (error) { signal?.throwIfAborted(); gaps.push({ code: 'faucet_recovery_unavailable', account: p.faucet }); }
  return finish();
}
