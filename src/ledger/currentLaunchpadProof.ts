import { Address, beginCell, Cell, contractAddress, storeStateInit, storeMessage, type Message, type ShardAccount } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { activeOrderAccount, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage } from '../runtime/physicalEvidence';
import { readCurrentT3Wallet, currentT3WalletAddress } from './currentT3State';
import { t3Attempt, t3PathRoot } from './currentT3Wire';
import { decodeLaunchChild, decodeLaunchFactory, decodeLaunchSale, launchChildAddress } from './currentLaunchpadState';

export type CurrentLaunchpadBinding = {
  manifest: RuntimeReleaseManifest;
  /** Current canonical discovery retains intent when original execution is
   * missing. These addresses never authenticate historical economics or cash. */
  discoveredChildren?: readonly string[];
};
export function currentLaunchpadBindingFromManifest(manifest: RuntimeReleaseManifest): CurrentLaunchpadBinding {
  need(manifest.contracts.SaleFactory && manifest.contracts.T3Hub && manifest.contracts.Governance && manifest.contracts.FeeRouter && manifest.contracts.DlmmPoolFactory);
  const t3 = manifest.tokens.find(t => t.symbol === 'T3');
  need(t3 && t3.root === manifest.contracts.T3Hub.address && t3.masterCodeHash === manifest.contracts.T3Hub.codeHash && t3.walletCodeHash === manifest.templates.T3Wallet);
  return { manifest };
}
export function need(value: unknown): asserts value { if (!value) throw Error('Current Launchpad original evidence mismatch'); }
export const raw = (a: Address | null | undefined) => a?.toRawString() ?? null;
export const maybe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
const cache = new WeakMap<OrderTransactionEvidence, { original: OrderTransactionEvidence; tx: CurrentLaunchpadTransaction }>();
export type CurrentLaunchpadTransaction = ReturnType<typeof verifyOrderTransaction> & { account: string };
export function verifyLaunchpadTransaction(e: OrderTransactionEvidence): CurrentLaunchpadTransaction {
  const prior = cache.get(e);
  if (prior && Object.keys(prior.original).every(key => prior.original[key as keyof OrderTransactionEvidence] === e[key as keyof OrderTransactionEvidence])) return prior.tx;
  const tx = { account: e.account, ...verifyOrderTransaction(e) }; cache.set(e, { original: { ...e }, tx }); return tx;
}
const hashes = new WeakMap<CurrentLaunchpadTransaction, { incoming: string | null; outgoing: Set<string> }>();
function messages(t: CurrentLaunchpadTransaction) {
  let v = hashes.get(t);
  if (!v) { v = { incoming: t.incoming ? canonicalPhysicalMessage(t.incoming).hash().toString('hex') : null,
    outgoing: new Set(t.outgoing.values().map(m => canonicalPhysicalMessage(m).hash().toString('hex'))) }; hashes.set(t, v); }
  return v;
}
export function linked(a: CurrentLaunchpadTransaction, b: CurrentLaunchpadTransaction) {
  const incoming = messages(b).incoming; return b.tx.lt > a.tx.lt && incoming !== null && messages(a).outgoing.has(incoming);
}
/** Select one exact emitted message, including its value and creation identity.
 * A holder may emit several same-query transfers to the same source wallet. */
export function receives(a: CurrentLaunchpadTransaction, outgoing: Message, b: CurrentLaunchpadTransaction) {
  return b.tx.lt > a.tx.lt && messages(b).incoming === beginCell().store(storeMessage(outgoing)).endCell().hash().toString('hex');
}
export function descendants(first: CurrentLaunchpadTransaction, txs: CurrentLaunchpadTransaction[]) {
  const reached = new Set([first.hash]);
  for (const t of txs) if (txs.some(a => reached.has(a.hash) && linked(a, t))) reached.add(t.hash);
  return reached;
}
export function launchpadFactory(t: CurrentLaunchpadTransaction, binding: CurrentLaunchpadBinding, after = false) {
  const m = binding.manifest, f = m.contracts.SaleFactory!; need(t.account === f.address);
  const state = decodeLaunchFactory(activeOrderAccount(after ? t.after : t.before, f.codeHash).data);
  const pins = [m.templates.SaleFixed, m.templates.SaleBonding, m.templates.SaleAuction, m.templates.LpVault, m.templates.VestingVault];
  need(raw(state.governance) === m.contracts.Governance!.address && raw(state.t3Master) === m.contracts.T3Hub!.address
    && raw(state.feeSink) === m.contracts.FeeRouter!.address && raw(state.dlmmFactory) === m.contracts.DlmmPoolFactory!.address
    && state.feeBps <= 500 && state.codes.size === 5 && pins.every((pin, slot) => state.codes.get(slot)?.code.hash().toString('hex') === pin));
  return state;
}
export function launchpadChild(t: CurrentLaunchpadTransaction, binding: CurrentLaunchpadBinding, after = false) {
  return launchpadChildState(t.account, after ? t.after : t.before, binding);
}
export function launchpadChildState(account: string, shard: ShardAccount, binding: CurrentLaunchpadBinding) {
  const state = shard.account?.storage.state; need(state?.type === 'active' && state.state.data);
  const child = decodeLaunchChild(state.state.data), id = child.identity, m = binding.manifest;
  const pins = [m.templates.SaleFixed, m.templates.SaleBonding, m.templates.SaleAuction, m.templates.LpVault, m.templates.VestingVault];
  const active = activeOrderAccount(shard, pins[id.role === 0 ? id.kind : id.role + 2]);
  need(raw(id.factory) === m.contracts.SaleFactory!.address && raw(launchChildAddress(id, active.code)) === account);
  if (child.config) {
    need(child.slots.size === (id.role === 2 ? 1 : 2));
    if (id.role !== 2) need(raw(child.slots.get(0)?.master) === m.contracts.T3Hub!.address && child.slots.get(0)?.budget.creditProtection);
    if (id.role === 0) { const sale = decodeLaunchSale(child); need(raw(sale.feeSink) === m.contracts.FeeRouter!.address); }
  }
  return child;
}
export function either(s: ReturnType<Cell['beginParse']>) {
  if (s.loadBit()) { const body = s.loadRef(); s.endParse(); return body; }
  return beginCell().storeSlice(s).endCell();
}
export function tokenTransfer(body: Cell, internal = false) {
  need(!body.isExotic); const s = body.beginParse(); need(s.loadUint(32) === (internal ? 0x178d4519 : 0x0f8a7ea5));
  const queryId = s.loadUintBig(64), amount = s.loadCoins(), owner = raw(s.loadAddress())!, response = raw(s.loadMaybeAddress());
  const custom = internal ? null : s.loadMaybeRef(), forward = s.loadCoins(), payload = either(s);
  return { queryId, amount, owner, response, custom, forward, payload };
}
export type LaunchpadToken = { root: string; walletCodeHash: string; family: 't3' | 'jetton-v21' | 'stablecoin' };
export function walletBalance(t: CurrentLaunchpadTransaction, token: LaunchpadToken, owner: string, binding: CurrentLaunchpadBinding, after = true): bigint {
  const state = (after ? t.after : t.before).account?.storage.state;
  if (!state || state.type === 'uninit') return 0n;
  let active = state.type === 'active' ? state.state : null;
  if (!active && state.type === 'frozen') { const init = t.tx.inMessage?.init;
    need(init && BigInt('0x' + beginCell().store(storeStateInit(init)).endCell().hash().toString('hex')) === state.stateHash); active = init;
  }
  need(active?.code && active.data && active.code.hash().toString('hex') === token.walletCodeHash && active.special === undefined && (!active.libraries || active.libraries.size === 0));
  let amount: bigint, expected: string;
  if (token.family === 't3') {
    need(active.splitDepth === undefined && token.root === binding.manifest.contracts.T3Hub!.address && token.walletCodeHash === binding.manifest.templates.T3Wallet);
    const d = readCurrentT3Wallet(active.data); need(d.owner === owner && d.master === token.root && d.proofCodeHash === binding.manifest.templates.T3RecoveryProof);
    amount = d.balance; expected = currentT3WalletAddress(Address.parse(owner), Address.parse(token.root), d.proofCodeHash, active.code);
  } else {
    const v21 = token.family === 'jetton-v21'; need(active.splitDepth === (v21 ? 8 : undefined));
    const s = active.data.beginParse(); if (!v21) s.loadUint(4); amount = s.loadCoins(); need(raw(s.loadAddress()) === owner && raw(s.loadAddress()) === token.root); s.endParse();
    const data = beginCell(); if (!v21) data.storeUint(0, 4); data.storeCoins(0).storeAddress(Address.parse(owner)).storeAddress(Address.parse(token.root));
    const init = { code: active.code, data: data.endCell(), ...(v21 ? { splitDepth: 8 } : {}) };
    if (v21) { const hash = beginCell().store(storeStateInit(init)).endCell().hash(); hash[0] = Address.parse(owner).hash[0]; expected = new Address(0, hash).toRawString(); }
    else expected = contractAddress(0, init).toRawString();
  }
  need(t.account === expected); return amount;
}
export function walletDelta(t: CurrentLaunchpadTransaction, token: LaunchpadToken, owner: string, amount: bigint, binding: CurrentLaunchpadBinding) {
  need(t.succeeded && walletBalance(t, token, owner, binding) - walletBalance(t, token, owner, binding, false) === amount);
}
export type LaunchpadCash = { root: string; from: string; to: string; amountRaw: string; debitTransaction: string; creditTransaction: string; sourceWallet: string; targetWallet: string };
/** A requested transfer and a successful holder transition are not cash. Both
 * wallet boundaries and the complete physical message identity are mandatory. */
export function physicalTransfer(source: CurrentLaunchpadTransaction, token: LaunchpadToken, owner: string, binding: CurrentLaunchpadBinding, txs: CurrentLaunchpadTransaction[]): LaunchpadCash | null {
  return maybe(() => {
    const incoming = source.tx.inMessage; need(incoming?.info.type === 'internal' && !incoming.info.bounced && raw(incoming.info.src) === owner);
    const r = tokenTransfer(incoming.body); walletDelta(source, token, owner, -r.amount, binding);
    const matches = txs.filter(target => maybe(() => {
      need(linked(source, target)); const m = target.tx.inMessage; need(m?.info.type === 'internal' && !m.info.bounced);
      if (token.family === 't3') { const s = m.body.beginParse(); need(s.loadUint(32) === 0x5433444c); const a = t3Attempt(s.loadRef()); s.endParse();
        need(!a.burn && a.originLt === source.tx.lt && a.attempt === 0n && a.owner === owner && a.recipient === r.owner && a.amount === r.amount
          && a.queryId === r.queryId && a.response === r.response && a.forwardValue === r.forward && a.customPayload === null && r.custom === null && either(a.forwardPayload.beginParse()).equals(r.payload));
      } else { const a = tokenTransfer(m.body, true); need(a.owner === owner && a.amount === r.amount && a.queryId === r.queryId && a.response === r.response && a.forward === r.forward && a.payload.equals(r.payload)); }
      walletDelta(target, token, r.owner, r.amount, binding); return true;
    }) === true);
    if (matches.length === 1) return { root: token.root, from: owner, to: r.owner, amountRaw: String(r.amount), debitTransaction: source.hash, creditTransaction: matches[0].hash, sourceWallet: source.account, targetWallet: matches[0].account };
    // Current protected retries retain the initial debit and immutable terms.
    need(matches.length === 0 && token.family === 't3');
    const sent = source.tx.outMessages.values().filter(m => m.info.type === 'internal' && m.body.bits.length === 32 && m.body.refs.length === 1 && m.body.beginParse().preloadUint(32) === 0x5433444c);
    need(sent.length === 1); const initial = t3Attempt(sent[0].body.refs[0]); need(initial.originLt === source.tx.lt && initial.attempt === 0n && initial.owner === owner && initial.recipient === r.owner && initial.amount === r.amount && !initial.burn
      && initial.queryId === r.queryId && initial.response === r.response && initial.forwardValue === r.forward && initial.customPayload === null && r.custom === null && either(initial.forwardPayload.beginParse()).equals(r.payload));
    const retries = txs.flatMap(retry => maybe(() => {
      need(retry.account === source.account && retry.tx.lt > source.tx.lt && retry.succeeded); const m = retry.tx.inMessage; need(m?.info.type === 'internal' && !m.info.bounced);
      const s = m.body.beginParse(); need(s.loadUint(32) === 0x54335759); const record = s.loadRef(), proof = s.loadRef(), to = raw(s.loadAddress()); s.endParse();
      const z = record.beginParse(); need(z.loadBit() && !z.loadBit()); const a = t3Attempt(z.loadRef()); z.endParse();
      const state = readCurrentT3Wallet(activeOrderAccount(retry.before, token.walletCodeHash).data);
      need(to === initial.recipient && a.id === initial.id && a.originLt === initial.originLt && a.cell.refs[0].equals(initial.cell.refs[0]) && t3PathRoot(a.id, record, proof) === state.root);
      walletDelta(retry, token, owner, 0n, binding);
      return txs.filter(target => maybe(() => {
        need(linked(retry, target)); const body = target.tx.inMessage?.body; need(body); const q = body.beginParse(); need(q.loadUint(32) === 0x5433444c); const next = t3Attempt(q.loadRef()); q.endParse();
        need(next.id === a.id && next.originLt === a.originLt && next.attempt === a.attempt + 1n && next.cell.refs[0].equals(a.cell.refs[0])); walletDelta(target, token, r.owner, r.amount, binding); return true;
      }) === true);
    }) ?? []);
    need(retries.length === 1); return { root: token.root, from: owner, to: r.owner, amountRaw: String(r.amount), debitTransaction: source.hash, creditTransaction: retries[0].hash, sourceWallet: source.account, targetWallet: retries[0].account };
  });
}
