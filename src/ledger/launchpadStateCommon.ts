import { Cell, type Slice } from '@ton/core';

export const end = (slice: Slice) => {
  if (slice.remainingBits || slice.remainingRefs) throw Error('Trailing Launchpad storage');
};
export const address = (slice: Slice) => slice.loadAddress().toRawString();
export const maybeAddress = (slice: Slice) => slice.loadMaybeAddress()?.toRawString() ?? null;
export const raw = (slice: Slice) => slice.loadCoins().toString();
export const hash = (cell: Cell) => cell.hash().toString('hex');
export const hex = (value: bigint) => value.toString(16).padStart(64, '0');
export const flag = (slice: Slice) => {
  const value = slice.loadUint(8);
  if (value > 1) throw Error('Invalid Launchpad flag');
  return value as 0 | 1;
};
export function readLaunchpadRouting(cell: Cell) {
  const s = cell.beginParse(), tokenRoot = address(s), wallet = address(s), walletCode = s.loadRef(); end(s);
  if (!walletCode.bits.length && !walletCode.refs.length) throw Error('Launchpad wallet code unavailable');
  return { tokenRoot, wallet, walletCodeBoc: walletCode.toBoc().toString('base64'), walletCodeHash: hash(walletCode) };
}
export function readLaunchpadRegistry(cell: Cell) {
  const s = cell.beginParse(), governance = maybeAddress(s), enabled = flag(s), withdrawalsOnly = flag(s);
  let node = s.loadRef(); end(s);
  const entries = new Map<number, string | null>();
  while (node.bits.length || node.refs.length) {
    const n = node.beginParse(), key = n.loadUint(32), value = maybeAddress(n);
    n.loadMaybeRef(); const next = n.loadMaybeRef(); end(n);
    if (entries.has(key)) throw Error('Duplicate Launchpad registry key');
    entries.set(key, value); node = next ?? Cell.EMPTY;
  }
  return { governance, enabled, withdrawalsOnly, owner: entries.get(0x4f574e52) ?? null, factory: entries.get(0x46414354) ?? null };
}
/** Current configured envelope shared by all three models. No bootstrap or
 * superseded routing/header formats are admitted. */
export function readLaunchpadEnvelope(dataBoc: string) {
  const roots = Cell.fromBoc(Buffer.from(dataBoc, 'base64'));
  if (roots.length !== 1) throw Error('Launchpad state requires one root');
  const data = roots[0], s = data.beginParse();
  if (s.remainingRefs !== 4) throw Error('Launchpad root reference layout');
  const registry = readLaunchpadRegistry(s.loadRef()), routing = s.loadRef().beginParse();
  const paymentRouting = readLaunchpadRouting(routing.loadRef()), saleRouting = readLaunchpadRouting(routing.loadRef()); end(routing);
  const configCell = s.loadRef(), stateCell = s.loadRef();
  const saleId = s.loadUintBig(64).toString(), deploymentSalt = s.loadUint(32), t3Root = address(s), t3WalletCodeHash = hex(s.loadUintBig(256));
  const headerFeeRecipient = maybeAddress(s), headerFeeBps = s.loadUint(16); end(s);
  return { dataHash: hash(data), registry, paymentRouting, saleRouting, configCell, stateCell, saleId, deploymentSalt,
    t3Root, t3WalletCodeHash, headerFeeRecipient, headerFeeBps };
}
export type LaunchpadFill = { tokenAmountRaw: string; paymentAmountRaw: string; hash: string; previousHash: string | null };
/** Current LIFO fill list, preserving every original cell identity. */
export function readLaunchpadFills(cell: Cell) {
  const fills: LaunchpadFill[] = [];
  let current = cell;
  while (current.bits.length || current.refs.length) {
    const s = current.beginParse(), tokenAmountRaw = raw(s), paymentAmountRaw = raw(s);
    if (!BigInt(tokenAmountRaw) || !BigInt(paymentAmountRaw) || s.remainingRefs > 1) throw Error('Invalid Launchpad fill');
    const previous = s.remainingRefs ? s.loadRef() : null; end(s);
    if (previous && !previous.bits.length && !previous.refs.length) throw Error('Noncanonical empty fill predecessor');
    fills.push({ tokenAmountRaw, paymentAmountRaw, hash: hash(current), previousHash: previous ? hash(previous) : null });
    current = previous ?? Cell.EMPTY;
  }
  return { fillsBoc: cell.toBoc().toString('base64'), fillsHash: hash(cell), fills };
}

export function readLaunchpadReferralTerms(cell: Cell) {
  const s = cell.beginParse(), feePaidRaw = raw(s), referrer = maybeAddress(s); end(s);
  return { feePaidRaw, referrer };
}
