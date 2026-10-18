import { Address, Cell, Dictionary } from '@ton/core';
import type { OrderTransactionEvidence } from '../orders/evidence';
import { activeOrderAccount } from '../orders/evidence';
import { decodeLaunchSale, decodeLaunchLp, decodeLaunchVesting, launchChildAddress, LAUNCH_OP } from './currentLaunchpadState';
import { verifyLaunchpadArchiveClaim, verifyLaunchpadHolderClaim } from './currentLaunchpadRecovery';
import { verifyCurrentLaunchpadLiquidity } from './currentLaunchpadLiquidity';
import { currentLaunchpadBindingFromManifest, descendants, launchpadChild, launchpadFactory, linked, receives, maybe, need, physicalTransfer, raw, tokenTransfer, verifyLaunchpadTransaction,
  type CurrentLaunchpadBinding, type CurrentLaunchpadTransaction as Tx, type LaunchpadCash, type LaunchpadToken } from './currentLaunchpadProof';

export const CURRENT_LAUNCHPAD_USER_OPS = new Set<number>([...Object.values(LAUNCH_OP), 0x434c4d41, 0x4a52434d]);
export type CurrentLaunchpadEconomics = {
  kind: string; outcome: 'unresolved' | 'accepted' | 'delivered' | 'refunded'; owner: string; factory: string; child: string;
  creator: string | null; nonce: string | null; model: number | null; role: number | null; queryId: string; requestBodyHash: string;
  dispatch: { lt: string; hash: string }; projectRoot: string | null;
  contributionRaw: string; allocationAcquiredRaw: string; allocationRetiredRaw: string; contributionRetiredRaw: string;
  inventorySuppliedRaw: string; feeAllocatedRaw: string; lpFundingAllocatedRaw: string; creatorProceedsAllocatedRaw: string;
  recoveredAccountingRaw: string; owedRetiredRaw: string; recoveryBeneficiary: string | null;
  lpShares: { owner: string; pool: string; binId: number; beforeRaw: string; afterRaw: string; deltaRaw: string }[];
  aggregateOwed: boolean; paidIn: Record<string, string>; paidOut: Record<string, string>; pendingOut: Record<string, string>;
  cash: LaunchpadCash[]; evidenceHashes: string[]; issues: string[];
};
export type CurrentLaunchpadOperation = { economics: CurrentLaunchpadEconomics };
type Child = ReturnType<typeof launchpadChild>;
const one = <T>(rows: T[]) => rows.length === 1 ? rows[0] : null;
const sum = (values: Record<string, string>, root: string, amount: bigint) => { values[root] = String(BigInt(values[root] ?? '0') + amount); };
function token(root: string, at: Tx, b: CurrentLaunchpadBinding, txs: Tx[], evidenceHashes: string[]): LaunchpadToken {
  const m = b.manifest;
  if (root === m.contracts.T3Hub!.address) return { root, family: 't3', walletCodeHash: m.templates.T3Wallet };
  const known = m.tokens.find(t => t.root === root);
  const pins = known ? [{ master: known.masterCodeHash, wallet: known.walletCodeHash }]
    : [{ master: m.templates.JettonV21Minter, wallet: m.templates.JettonV21Wallet }, { master: m.vendor.stablecoin.minter.codeHash, wallet: m.vendor.stablecoin.wallet.codeHash }];
  const observed = txs.filter(t => t.account === root && t.tx.lt <= at.tx.lt);
  const proves = (t: Tx, pin: typeof pins[number]) => [t.after, t.before].some(state => maybe(() => { activeOrderAccount(state, pin.master); return true; }) === true);
  const matched = pins.filter(pin => observed.some(t => proves(t, pin)));
  need(matched.length === 1);
  const pin = matched[0], family = pin.master === m.templates.JettonV21Minter && pin.wallet === m.templates.JettonV21Wallet ? 'jetton-v21'
    : pin.master === m.vendor.stablecoin.minter.codeHash && pin.wallet === m.vendor.stablecoin.wallet.codeHash ? 'stablecoin' : null;
  need(family); const master = observed.filter(t => proves(t, pin)).at(-1); need(master);
  if (!evidenceHashes.includes(master.hash)) evidenceHashes.push(master.hash);
  return { root, family, walletCodeHash: pin.wallet };
}
function owed(c: Child, slot: number, owner: string) {
  if (!c.owed) return 0n;
  const slots = Dictionary.loadDirect(Dictionary.Keys.Uint(8), { serialize() { throw Error('Read only'); }, parse(s) {
    s.loadCoins(); s.loadUint(16); const entries = s.loadDict(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)); s.loadMaybeRef(); s.endParse(); return entries;
  } }, c.owed);
  return slots.get(slot)?.get(Address.parse(owner)) ?? 0n;
}
/** The execution-time price has raw T3/token units at 1e18 precision. Bonding
 * buys the greatest affordable cumulative-cost increment, including rounding. */
export function currentLaunchpadQuote(sale: ReturnType<typeof decodeLaunchSale>, payment: bigint, at: number) {
  const p = sale.pricing, scale = 10n ** 18n;
  if (p.kind !== 1) {
    const price = p.kind === 0 ? p.price : (() => { need(p.decayInterval > 0); const drop = BigInt(Math.floor(Math.max(0, at - sale.terms.startTime) / p.decayInterval)) * p.tickSize; return p.startPrice - drop > p.reservePrice ? p.startPrice - drop : p.reservePrice; })();
    need(price > 0n); return payment * scale / price;
  }
  need(p.slopeDenominator > 0n);
  const cost = (sold: bigint) => { const d = 2n * p.slopeDenominator * scale; return (sold * (2n * p.slopeDenominator * p.basePrice + p.slopeNumerator * sold) + d - 1n) / d; };
  const start = cost(sale.sold); let low = 0n, high = sale.terms.caps.saleSupply - sale.sold; need(high >= 0n);
  while (low < high) { const mid = low + (high - low + 1n) / 2n; if (cost(sale.sold + mid) - start <= payment) low = mid; else high = mid - 1n; }
  return low;
}
function initial(owner: Tx, child: string, state: Child | null, kind: string, queryId: bigint, bodyHash: string, b: CurrentLaunchpadBinding): CurrentLaunchpadEconomics {
  return { kind, outcome: 'unresolved', owner: owner.account, factory: b.manifest.contracts.SaleFactory!.address, child,
    creator: state ? raw(state.identity.creator)! : null, nonce: state ? String(state.identity.nonce) : null, model: state?.identity.kind ?? null, role: state?.identity.role ?? null, queryId: String(queryId),
    requestBodyHash: bodyHash, dispatch: { lt: String(owner.tx.lt), hash: owner.hash }, projectRoot: null,
    contributionRaw: '0', allocationAcquiredRaw: '0', allocationRetiredRaw: '0', contributionRetiredRaw: '0', inventorySuppliedRaw: '0', feeAllocatedRaw: '0', lpFundingAllocatedRaw: '0', creatorProceedsAllocatedRaw: '0',
    recoveredAccountingRaw: '0', owedRetiredRaw: '0', recoveryBeneficiary: null, lpShares: [],
    aggregateOwed: false, paidIn: {}, paidOut: {}, pendingOut: {}, cash: [], evidenceHashes: [], issues: [] };
}

/** Infer the selected owner's commands from original messages. The browser's
 * saved request, repeated query IDs and event text never select the operation. */
export function decodeCurrentLaunchpadOperations(owner: string, binding: CurrentLaunchpadBinding, evidence: readonly OrderTransactionEvidence[]): CurrentLaunchpadOperation[] {
  currentLaunchpadBindingFromManifest(binding.manifest);
  need(evidence.length <= 10000);
  const txs = evidence.map(verifyLaunchpadTransaction).sort((a, b) => a.tx.lt < b.tx.lt ? -1 : a.tx.lt > b.tx.lt ? 1 : a.hash.localeCompare(b.hash));
  need(new Set(txs.map(t => `${t.account}:${t.tx.lt}`)).size === txs.length && new Set(txs.map(t => t.hash)).size === txs.length);
  const result: CurrentLaunchpadOperation[] = [];
  for (const origin of txs.filter(t => t.account === owner && t.succeeded)) for (const message of origin.tx.outMessages.values()) {
    if (message.info.type !== 'internal' || message.info.bounced || message.body.isExotic || message.body.bits.length < 32) continue;
    const destination = raw(message.info.dest);
    const first = one(txs.filter(t => t.account === destination && receives(origin, message, t)));
    const op = message.body.beginParse().preloadUint(32), funding = op === 0x0f8a7ea5;
    const transfer = funding ? maybe(() => tokenTransfer(message.body)) : null;
    let executed = first, child = first ? maybe(() => launchpadChild(first, binding)) : null, kind = '', query = 0n;
    if (funding && transfer) {
      const known = txs.filter(t => t.account === transfer.owner).flatMap(t => [maybe(() => launchpadChild(t, binding)), maybe(() => launchpadChild(t, binding, true))]).find(Boolean) ?? null;
      const contribute = transfer.payload.bits.length >= 32 && transfer.payload.beginParse().preloadUint(32) === LAUNCH_OP.CONTRIBUTE;
      if (!contribute && !known && !binding.discoveredChildren?.includes(transfer.owner)) continue;
      const reached = first ? descendants(first, txs) : new Set<string>();
      const candidates = txs.filter(t => t.account === transfer.owner && maybe(() => launchpadChild(t, binding)) !== null && reached.has(t.hash));
      executed = candidates[0] ?? null; child = executed ? maybe(() => launchpadChild(executed!, binding)) : known;
      kind = child?.identity.role === 2 ? 'vest-supply' : contribute ? 'contribute' : 'supply'; query = transfer.queryId;
    } else {
      const names: Record<number, string> = { [LAUNCH_OP.CLAIM]: 'claim', [LAUNCH_OP.FINALIZE]: 'finalize', [LAUNCH_OP.CANCEL]: 'cancel', [LAUNCH_OP.OWED]: 'owed',
        [LAUNCH_OP.LP_SEED]: 'lp-seed', [LAUNCH_OP.LP_RELEASE]: 'lp-release', [LAUNCH_OP.VEST_CLAIM]: 'vest-claim', [LAUNCH_OP.VEST_RETURN]: 'vest-return', 0x434c4d41: 'archive-claim', 0x4a52434d: 'holder-claim' };
      kind = names[op]; if (!kind) continue;
      const parsed = maybe(() => { const s = message.body.beginParse(); s.loadUint(32); return op === 0x4a52434d ? 0n : s.loadUintBig(64); });
      if (parsed === null) continue; query = parsed;
    }
    const e = initial(origin, transfer?.owner ?? destination!, child, kind, query, message.body.hash().toString('hex'), binding);
    const reached = descendants(origin, txs); e.evidenceHashes = [...reached]; result.push({ economics: e });
    try {
      need(first && executed && first.succeeded && executed.succeeded && child?.config);
      const before = child, after = launchpadChild(executed, binding, true); need(before.config && after.config?.equals(before.config));
      const factory = txs.filter(t => t.account === binding.manifest.contracts.SaleFactory!.address && t.tx.lt < executed.tx.lt).at(-1);
      need(factory); const factoryState = launchpadFactory(factory, binding, true); e.evidenceHashes.push(factory.hash);
      const sale = raw(launchChildAddress({ ...before.identity, role: 0 }, factoryState.codes.get(before.identity.kind)!.code));
      const lp = raw(launchChildAddress({ ...before.identity, role: 1 }, factoryState.codes.get(3)!.code));
      const vest = raw(launchChildAddress({ ...before.identity, role: 2 }, factoryState.codes.get(4)!.code));
      if (before.identity.role === 0) { const state = decodeLaunchSale(before); need(raw(state.lpVault) === lp && (!state.vestingVault || raw(state.vestingVault) === vest)); }
      else if (before.identity.role === 1) { const state = decodeLaunchLp(before); need(raw(state.sale) === sale && raw(state.dlmmFactory) === binding.manifest.contracts.DlmmPoolFactory!.address); }
      else need(raw(decodeLaunchVesting(before).sale) === sale);
      const tokens = new Map<string, LaunchpadToken>();
      for (const slot of before.slots.values()) tokens.set(raw(slot.master)!, token(raw(slot.master)!, executed, binding, txs, e.evidenceHashes));
      const project = before.identity.role === 2 ? raw(before.slots.get(0)?.master) : raw(before.slots.get(1)?.master); e.projectRoot = project;
      const addCash = (cash: LaunchpadCash) => {
        const existing = e.cash.find(c => c.root === cash.root && c.debitTransaction === cash.debitTransaction);
        if (existing) { need(JSON.stringify(existing) === JSON.stringify(cash)); return; } e.cash.push(cash);
        if (cash.from === owner) sum(e.paidIn, cash.root, BigInt(cash.amountRaw));
        if (cash.to === owner) sum(e.paidOut, cash.root, BigInt(cash.amountRaw));
        for (const hash of [cash.debitTransaction, cash.creditTransaction]) if (!e.evidenceHashes.includes(hash)) e.evidenceHashes.push(hash);
      };
      let payoutComplete = true, proveLpShares = false, refundAmount: bigint | null = null;
      if (funding) {
        need(transfer && transfer.custom === null && transfer.response === owner);
        const slot = [...before.slots.values()].find(s => raw(s.wallet) !== null && txs.some(t => t.account === raw(s.wallet) && linked(first, t) && linked(t, executed)));
        need(slot); const pin = tokens.get(raw(slot.master)!)!, cash = physicalTransfer(first, pin, owner, binding, txs); need(cash && cash.to === executed.account); addCash(cash);
        const notification = executed.tx.inMessage; need(notification?.info.type === 'internal' && !notification.info.bounced && raw(notification.info.src) === cash.targetWallet);
        const credit = notification.body.beginParse(); need(credit.loadUint(32) === 0x7362d09c && credit.loadUintBig(64) === transfer.queryId && credit.loadCoins() === transfer.amount && raw(credit.loadAddress()) === owner);
        const payload = credit.loadBit() ? (() => { const p = credit.loadRef(); credit.endParse(); return p; })() : Cell.EMPTY.asBuilder().storeSlice(credit).endCell(); need(payload.equals(transfer.payload));
        if (kind === 'contribute') {
          need(before.identity.role === 0 && pin.family === 't3');
          const a = decodeLaunchSale(before), z = decodeLaunchSale(after), old = a.entries.get(Address.parse(owner)), next = z.entries.get(Address.parse(owner));
          const p = transfer.payload.beginParse(); need(p.loadUint(32) === LAUNCH_OP.CONTRIBUTE); const minimum = p.loadCoins(); p.endParse();
          const acquired = (next?.tokens ?? 0n) - (old?.tokens ?? 0n), paid = (next?.paid ?? 0n) - (old?.paid ?? 0n);
          if (paid === transfer.amount) { need(acquired >= minimum && acquired === currentLaunchpadQuote(a, paid, executed.tx.now) && z.raised - a.raised === paid && z.sold - a.sold === acquired); e.contributionRaw = String(paid); e.allocationAcquiredRaw = String(acquired); }
          else { need(paid === 0n && acquired === 0n); refundAmount = transfer.amount; e.issues.push('launchpad_contribution_refund'); }
        } else {
          const growth = kind === 'vest-supply' ? decodeLaunchVesting(after).deposited - decodeLaunchVesting(before).deposited : decodeLaunchSale(after).inventory - decodeLaunchSale(before).inventory;
          need(growth === transfer.amount); e.inventorySuppliedRaw = String(growth);
        }
      } else if (kind === 'claim') {
        const a = decodeLaunchSale(before), z = decodeLaunchSale(after), entry = a.entries.get(Address.parse(owner)); need(entry && !z.entries.has(Address.parse(owner)) && [2, 3].includes(a.phase));
        e.allocationRetiredRaw = String(entry.tokens); e.contributionRetiredRaw = String(entry.paid);
        need(a.phase === 2 ? a.tokDue - z.tokDue === entry.tokens : a.t3Due - z.t3Due === entry.paid);
        if (a.phase === 3) refundAmount = entry.paid;
      } else if (kind === 'finalize' || kind === 'cancel') {
        const a = decodeLaunchSale(before), z = decodeLaunchSale(after); need(z.phase >= 2 && (a.phase === 1 || a.phase === z.phase));
        if (a.phase === 1 && z.phase === 2) { const fee = a.raised * BigInt(a.feeBps) / 10000n, net = a.raised - fee; e.feeAllocatedRaw = String(fee); e.lpFundingAllocatedRaw = String(net / 2n); e.creatorProceedsAllocatedRaw = String(net - net / 2n); need(z.tokDue === a.sold); }
        else if (a.phase === 1 && z.phase === 3) need(z.t3Due === a.raised);
      } else if (kind === 'owed') {
        const s = message.body.beginParse(); s.skip(96); const slot = s.loadUint(8), beneficiary = raw(s.loadAddress())!; s.endParse(); const amount = owed(before, slot, beneficiary);
        need(before.slots.has(slot) && amount > 0n && owed(after, slot, beneficiary) === 0n); e.aggregateOwed = true; e.owedRetiredRaw = String(amount); e.recoveryBeneficiary = beneficiary;
      } else if (kind === 'archive-claim') {
        const claim = verifyLaunchpadArchiveClaim(message.body, executed.account, before, after);
        e.aggregateOwed = true; e.owedRetiredRaw = claim.amountRaw; e.recoveryBeneficiary = claim.beneficiary;
      } else if (kind === 'holder-claim') {
        const claim = verifyLaunchpadHolderClaim(executed, before, after);
        e.aggregateOwed = true; e.recoveredAccountingRaw = claim.amountRaw; e.recoveryBeneficiary = claim.beneficiary; e.queryId = claim.queryId;
      } else if (kind === 'vest-claim' || kind === 'vest-return') {
        const a = decodeLaunchVesting(before), z = decodeLaunchVesting(after); need(kind === 'vest-claim' ? z.claimed > a.claimed : z.returned > a.returned);
      } else if (kind === 'lp-seed') {
        const a = decodeLaunchLp(before), z = decodeLaunchLp(after); need(a.armedAt > 0 && a.t3Bal + a.tokenBal > 0n && z.t3Bal === 0n && z.tokenBal === 0n);
        proveLpShares = true;
      } else if (kind === 'lp-release') {
        const s = message.body.beginParse(); s.skip(96); s.loadCoins(); s.loadCoins(); proveLpShares = s.loadBit(); s.endParse();
      } else { e.issues.push('launchpad_recovery_economics_unresolved'); }
      if (proveLpShares) {
        const liquidity = verifyCurrentLaunchpadLiquidity(executed, binding, txs, tokens);
        if (liquidity.status === 'unavailable') e.issues.push('launchpad_lp_share_boundary_required');
        else {
          e.lpShares = liquidity.shares; for (const cash of liquidity.cash) addCash(cash);
          // Seed commands are counted by the direct holder transfer loop below;
          // removal commands originate at the pool and have a distinct cash leg.
          if (kind === 'lp-release') for (const [root, amount] of Object.entries(liquidity.pendingOut)) sum(e.pendingOut, root, BigInt(amount));
          e.evidenceHashes.push(...liquidity.evidenceHashes);
          if (liquidity.status !== 'confirmed') payoutComplete = false;
        }
      }
      // Every original emitted transfer remains pending until its independently
      // authenticated source debit and destination credit are both present.
      for (const outgoing of executed.tx.outMessages.values()) {
        if (outgoing.info.type !== 'internal') continue;
        const request = maybe(() => tokenTransfer(outgoing.body)); if (!request) continue;
        const wallet = raw(outgoing.info.dest)!, slot = [...before.slots.values()].find(s => raw(s.wallet) === wallet); need(slot);
        const root = raw(slot.master)!, source = one(txs.filter(t => t.account === wallet && receives(executed, outgoing, t))), cash = source ? physicalTransfer(source, tokens.get(root)!, executed.account, binding, txs) : null;
        if (cash) addCash(cash); else { payoutComplete = false; sum(e.pendingOut, root, request.amount); }
      }
      const refund = refundAmount !== null;
      if (refund) need(e.cash.some(c => c.to === owner && c.root === binding.manifest.contracts.T3Hub!.address && BigInt(c.amountRaw) === refundAmount) || !payoutComplete);
      e.outcome = payoutComplete && !e.issues.some(i => i.endsWith('_required') || i.endsWith('_unresolved')) ? (refund ? 'refunded' : 'delivered') : 'accepted';
    } catch { e.outcome = 'unresolved'; e.issues.push('launchpad_current_evidence_incomplete'); }
  }
  return result;
}
