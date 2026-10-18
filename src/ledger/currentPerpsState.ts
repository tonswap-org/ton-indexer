import { Address, beginCell, Cell, Dictionary, type Slice } from '@ton/core';
import { validJettonWalletProfile } from '../config/runtimeManifest';
/** Current PxStorage only; immutable native peers are checked at every original boundary. */
export const PERPS_OP = {
  open: 0x50584f50, increase: 0x50584d44, addMargin: 0x5058414d,
  removeMargin: 0x5058524d, close: 0x5058434c, funding: 0x50584643,
  refresh: 0x50524653, expire: 0x5045584f, liquidate: 0x504c4951,
  resync: 0x50585253, settleRetry: 0x52565253, event: 0x50584556,
} as const;
export const perpsContractError = (message: string) => new Error('Current Perps ledger: ' + message);
const fail = (message: string): never => { throw perpsContractError(message); };
const ordinary = (c: Cell) => c.isExotic ? fail('Exotic Perps state') : c.beginParse();
const address = (s: Slice) => { const a = s.loadAddress(); return a.workChain === 0 ? a : fail('Perps requires a basechain identity'); };
const finish = <T>(s: Slice, value: T): T => { s.endParse(); return value; };
const uint = (v: bigint, bits: number) => v >= 0n && v < 1n << BigInt(bits) ? v : fail('Invalid Perps integer');
const marketId = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4 ? n : fail('Invalid Perps market');

export type NativePerpsTrade = {
  kind: 'open' | 'increase' | 'addMargin' | 'removeMargin' | 'close' | 'funding';
  queryId: bigint; marketId: number; deadline: number; gen?: bigint;
  size?: bigint; limit?: bigint; leverage?: number; amount?: bigint;
};
export function nativePerpsTradeBody(t: NativePerpsTrade) {
  const b = beginCell().storeUint(PERPS_OP[t.kind], 32).storeUint(uint(t.queryId, 64), 64)
    .storeUint(marketId(t.marketId), 32);
  if (!Number.isSafeInteger(t.deadline) || t.deadline <= 0 || t.deadline >= 2 ** 32) fail('Invalid Perps deadline');
  if (t.kind !== 'open') {
    if (!t.gen) fail('Existing positions require their exact generation');
    b.storeUint(uint(t.gen!, 64), 64).storeUint(t.deadline, 32);
  }
  if (t.kind === 'open' || t.kind === 'increase' || t.kind === 'close') {
    const size = t.size ?? 0n, limit = t.limit ?? 0n;
    if (size <= -(1n << 127n) || size >= 1n << 127n || (t.kind !== 'close' && size === 0n) || limit <= 0n) fail('Invalid Perps size or limit');
    b.storeInt(size, 128).storeCoins(uint(limit, 120));
  }
  if (t.kind === 'open') {
    if (!Number.isInteger(t.leverage) || t.leverage! < 1 || t.leverage! > 10_000) fail('First-release leverage cannot exceed 1x');
    b.storeUint(t.leverage!, 32).storeUint(t.deadline, 32);
  }
  if (t.kind === 'removeMargin') {
    if (!t.amount || t.amount <= 0n) fail('Margin removal requires a positive amount');
    b.storeCoins(uint(t.amount!, 120));
  }
  return b.endCell();
}
export const nativePerpsPositionKey = (owner: Address, id: number) => BigInt('0x' + beginCell().storeAddress(owner).storeUint(marketId(id), 32).endCell().hash().toString('hex'));
export function decodeNativePerpsPosition(c: Cell) {
  const s = ordinary(c), gen = s.loadUintBig(64), size = s.loadIntBig(128), margin = s.loadCoins(),
    entryNotional = s.loadCoins(), lastFundingIndex = s.loadIntBig(128), p = ordinary(s.loadRef());
  return finish(s, { gen, size, margin, entryNotional, lastFundingIndex,
    counterparty: finish(p, { reserved: p.loadCoins(), pendingFunding: p.loadCoins(), collectedLoss: p.loadCoins(), remainingEntitlement: p.loadCoins() }) });
}
export type NativePerpsPosition = ReturnType<typeof decodeNativePerpsPosition>;
export function decodeNativePerpsMarket(c: Cell) {
  const s = ordinary(c), pool = address(s), p = ordinary(s.loadRef()), t = ordinary(s.loadRef()), f = ordinary(s.loadRef());
  const params = finish(p, { depthUnit: p.loadCoins(), oiCap: p.loadCoins(), impactAlpha: p.loadIntBig(128), impactBeta: p.loadIntBig(128),
    maxLeverageBps: p.loadUint(32), maintenanceBps: p.loadUint(32), fundingCapBps: p.loadUint(32) });
  if (params.depthUnit <= 0n || params.oiCap > 22_500_000_000n || params.impactAlpha < 0n || params.impactAlpha > 10_000n
    || params.impactBeta < 0n || params.impactBeta > 10_000n || params.maxLeverageBps < 1 || params.maxLeverageBps > 10_000
    || params.maintenanceBps < 1 || params.maintenanceBps > 20_000 || params.fundingCapBps < 1 || params.fundingCapBps > 1000) fail('Invalid current Perps market parameters');
  return finish(s, { pool, params, totals: finish(t, { longOi: t.loadCoins(), shortOi: t.loadCoins(), pending: t.loadCoins() }),
    funding: finish(f, { index: f.loadIntBig(128), remainder: f.loadIntBig(64), rate: f.loadIntBig(64), accruedAt: f.loadUintBig(64), observedAt: f.loadUintBig(64), validUntil: f.loadUintBig(64) }) });
}
export function decodeNativePerpsPending(c: Cell) {
  const s = ordinary(c), entry = { owner: address(s), marketId: s.loadUint(32), queryId: s.loadUintBig(64), nonce: s.loadUintBig(64),
    requestedAt: s.loadUint(32), kind: s.loadUint(8), deposit: s.loadCoins(), kept: s.loadCoins() }, t = ordinary(s.loadRef()), reservation = s.loadMaybeRef();
  return finish(s, { ...entry, terms: finish(t, { gen: t.loadUintBig(64), deadline: t.loadUint(32), size: t.loadIntBig(128), limit: t.loadCoins(), leverage: t.loadUint(32) }), reservation });
}
export const currentPerpsSlotCodec = { serialize() { fail('Read-only Perps slot'); }, parse(s: Slice): FreshJettonSlot {
  const slot = finish(s, { master: address(s), wallet: s.loadMaybeAddress(), walletGas: s.loadUint(32), walletGram: s.loadCoins(), optional: s.loadBit(), budget: decodeJettonWalletBudget(s.loadRef()) });
  validateJettonWalletProfile(slot); return slot;
} };
export function decodeNativePerpsState(c: Cell) {
  const s = ordinary(c), governance = address(s), withdrawalsOnly = s.loadBit(), p = ordinary(s.loadRef()), j = ordinary(s.loadRef()), sweeps = s.loadRef(), b = ordinary(s.loadRef());
  const peers = finish(p, { feeSink: address(p), riskVault: address(p), treasury: address(p), riskBucketId: p.loadUint(16) });
  const ledger = finish(j, { slots: j.loadDict(Dictionary.Keys.Uint(8), currentPerpsSlotCodec), owed: j.loadMaybeRef(), recovery: j.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()) });
  const counters = { nextNonce: b.loadUintBig(64), feeBps: b.loadUint(16), pendingCount: b.loadUint(16), settleCount: b.loadUint(16), positionCount: b.loadUint(8),
    marginLiability: b.loadCoins(), pendingDeposits: b.loadCoins(), feesAccrued: b.loadCoins(), lossPending: b.loadCoins(), collectedLossHeld: b.loadCoins(), nativeKept: b.loadCoins() };
  const v = ordinary(b.loadRef()), marketCells = v.loadDict(Dictionary.Keys.Uint(32), Dictionary.Values.Cell()), prefixes = v.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Uint(32)); v.endParse();
  const book = finish(b, { ...counters, prefixes, markets: new Map([...marketCells].map(([id, cell]) => [marketId(id), decodeNativePerpsMarket(cell)])),
    positions: b.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), pendings: b.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), settlements: b.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()) });
  if (book.feeBps > 1000 || book.positionCount > 30 || book.pendingCount > 512 || book.settleCount > 542
    || book.positions.size !== book.positionCount || book.pendings.size !== book.pendingCount || book.settlements.size !== book.settleCount
    || [...book.markets.values()].reduce((n, m) => n + m.params.oiCap, 0n) > 22_500_000_000n) fail('Invalid Perps book bounds');
  return finish(s, { governance, withdrawalsOnly, peers, ledger, sweeps, book });
}
export type NativePerpsState = ReturnType<typeof decodeNativePerpsState>;
export type PerpsBinding = {
  engine: Address; engineHash: string; governance: Address; feeSink: Address; treasury: Address; riskVault: Address;
  t3Root: Address; t3MasterHash: string; t3WalletHash: string; poolHash: string; markets: Map<number, Address>;
};

type FreshJettonSlot = {
    master: Address;
    wallet: Address | null;
    walletGas: number;
    walletGram: bigint;
    optional: boolean;
    budget: Record<string, number | boolean>;
};
function decodeJettonWalletBudget(cell: Cell) {
    const s = ordinary(cell), p: Record<string, number | boolean> = {};
    for (const [key, width] of [['senderGas', 32], ['walletBounceGas', 32], ['burnWalletGas', 32], ['smallPayloadCells', 16], ['largeWalletGas', 32], ['largeSenderGas', 32], ['rentSeconds', 32], ['rentBits', 32], ['rentCells', 16], ['initBits', 32], ['initCells', 16], ['initCopies', 8], ['transferBits', 16], ['transferCells', 8], ['transferCopies', 8]] as const)
        p[key] = s.loadUint(width);
    p.creditProtection = s.loadBit();
    s.endParse();
    return p;
}
function validateJettonWalletProfile(p: FreshJettonSlot) { if (!validJettonWalletProfile(p.walletGas, p.walletGram.toString(), p.budget))
    fail('Invalid Perps wallet profile'); }

export function decodeNativePerpsTrade(body: Cell): NativePerpsTrade {
  const s = ordinary(body), op = s.loadUint(32), kind = (['open','increase','addMargin','removeMargin','close','funding'] as const).find(k => PERPS_OP[k] === op);
  if (!kind) return fail('Unknown current Perps command');
  const trade: NativePerpsTrade = { kind, queryId:s.loadUintBig(64), marketId:s.loadUint(32), deadline:0 };
  if (kind !== 'open') { trade.gen = s.loadUintBig(64); trade.deadline = s.loadUint(32); }
  if (kind === 'open' || kind === 'increase' || kind === 'close') { trade.size = s.loadIntBig(128); trade.limit = s.loadCoins(); }
  if (kind === 'open') { trade.leverage = s.loadUint(32); trade.deadline = s.loadUint(32); }
  if (kind === 'removeMargin') trade.amount = s.loadCoins();
  s.endParse(); if (!nativePerpsTradeBody(trade).equals(body)) return fail('Noncanonical current Perps command'); return trade;
}
