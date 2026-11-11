import { Address, beginCell, Cell, contractAddress, Dictionary, type DictionaryValue, type Slice } from '@ton/core';
import { validJettonWalletProfile } from '../config/runtimeManifest';
/** Current native Options layout. No previous factory/position layouts are accepted. */
const fail = (message: string): never => { throw Error(message); };
const ordinary = (c: Cell) => { if (c.isExotic)
    fail('Exotic Options state'); return c.beginParse(); };
const addr = (s: Slice) => { const a = s.loadAddress(); if (a.workChain !== 0)
    fail('Options peer must be basechain'); return a; };
const optionalAddr = (s: Slice) => { const a = s.loadMaybeAddress(); if (a && a.workChain !== 0)
    fail('Options peer must be basechain'); return a; };
const codec = <T>(parse: (s: Slice) => T): DictionaryValue<T> => ({ serialize() { fail('Read-only Options state'); }, parse });
const finished = <T>(s: Slice, value: T): T => { s.endParse(); return value; };
const OPTION_OP = { SERIES_CREATE: 0x4f534352 };
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
    fail('Invalid Options wallet profile'); }
export type NativeOptionTemplate = {
    kind: number;
    basePool: Address;
    quotePool: Address | null;
    tenor: number;
    strikeBps: number;
    collateralBps: number;
    premiumBps: number;
};
export type NativeOptionCreation = Omit<NativeOptionTemplate, 'tenor'> & {
    seriesId: bigint;
    expiry: number;
    maxNotional: bigint;
    writer: Address;
};
export type NativeOptionPosition = {
    buyer: Address;
    notional: bigint;
    net: bigint;
    fee: bigint;
    lock: bigint;
    released: boolean;
};
export type NativeOptionSeries = {
    writer: Address;
    child: Address;
    kind: number;
    expiry: number;
    maxNotional: bigint;
    premiumBps: number;
    collateralBps: number;
    requiredReserve: bigint;
    creation: NativeOptionCreation;
    creationCell: Cell;
    funded: bigint;
    fundIntent: bigint;
    withdrawnBacking: bigint;
    locked: bigint;
    pendingLock: bigint;
    pendingNotional: bigint;
    openNotional: bigint;
    purged: boolean;
    recordCount: number;
    positions: Dictionary<bigint, NativeOptionPosition>;
};
export type NativeOptionIntent = {
    queryId: bigint;
    kind: number;
    owner: Address;
    amount: bigint;
    kept: bigint;
    createdAt: number;
    askedAt: number;
    seriesId: bigint;
    notional: bigint;
};
export type NativeOptionEscrow = {
    owner: Address;
    queryId: bigint;
    net: bigint;
    fee: bigint;
    locked: bigint;
    kept: bigint;
};
export type NativeOptionWriter = {
    owner: Address;
    expiry: number;
    released: bigint;
    amounts: {
        funded: bigint;
        available: bigint;
        locked: bigint;
        premium: bigint;
    };
    pending: {
        queryId: bigint;
        backing: bigint;
        premium: bigint;
        kept: bigint;
    } | null;
};
export type NativeOptionChildPosition = {
    owner: Address;
    notional: bigint;
    net: bigint;
    lock: bigint;
    payout: bigint;
    shoutFloor: bigint;
    lastShoutAt: number;
    outcome: number;
};
const templateCodec = codec<NativeOptionTemplate>(s => finished(s, { kind: s.loadUint(16), basePool: addr(s), quotePool: optionalAddr(s), tenor: s.loadUint(32), strikeBps: s.loadUint(32), collateralBps: s.loadUint(32), premiumBps: s.loadUint(32) }));
export function decodeOptionCreation(c: Cell): NativeOptionCreation {
    const s = ordinary(c);
    if (s.loadUint(32) !== OPTION_OP.SERIES_CREATE)
        fail('Expected OSCR creation');
    const result = { seriesId: s.loadUintBig(64), kind: s.loadUint(16), expiry: s.loadUint(32), maxNotional: s.loadCoins(), premiumBps: s.loadUint(32), collateralBps: s.loadUint(32), strikeBps: s.loadUint(32), writer: addr(s) };
    const p = ordinary(s.loadRef());
    s.endParse();
    return finished(p, { ...result, basePool: addr(p), quotePool: optionalAddr(p) });
}
const positionCodec = codec<NativeOptionPosition>(s => finished(s, { buyer: addr(s), notional: s.loadCoins(), net: s.loadCoins(), fee: s.loadCoins(), lock: s.loadCoins(), released: s.loadBit() }));
const seriesCodec = codec<NativeOptionSeries>(s => {
    const t = ordinary(s.loadRef()), terms = { writer: addr(t), child: addr(t), kind: t.loadUint(16), expiry: t.loadUint(32), maxNotional: t.loadCoins(), premiumBps: t.loadUint(32), collateralBps: t.loadUint(32), requiredReserve: t.loadCoins(), creationCell: t.loadRef() };
    t.endParse();
    const creation = decodeOptionCreation(terms.creationCell);
    const state = { funded: s.loadCoins(), fundIntent: s.loadUintBig(64), withdrawnBacking: s.loadCoins(), locked: s.loadCoins(), pendingLock: s.loadCoins(), pendingNotional: s.loadCoins(), openNotional: s.loadCoins(), purged: s.loadBit(), recordCount: s.loadUint(16), positions: s.loadDict(Dictionary.Keys.BigUint(64), positionCodec) };
    return finished(s, { ...terms, creation, ...state });
});
const pendingCodec = codec(s => finished(s, { seriesId: s.loadUintBig(64), buyer: addr(s), notional: s.loadCoins(), net: s.loadCoins(), fee: s.loadCoins(), lock: s.loadCoins() }));
export const optionIntentCodec = codec<NativeOptionIntent>(s => finished(s, { queryId: s.loadUintBig(64), kind: s.loadUint(8), owner: addr(s), amount: s.loadCoins(), kept: s.loadCoins(), createdAt: s.loadUint(32), askedAt: s.loadUint(32), seriesId: s.loadUintBig(64), notional: s.loadCoins() }));
export const optionEscrowCodec = codec<NativeOptionEscrow>(s => finished(s, { owner: addr(s), queryId: s.loadUintBig(64), net: s.loadCoins(), fee: s.loadCoins(), locked: s.loadCoins(), kept: s.loadCoins() }));
export const optionWriterCodec = codec<NativeOptionWriter>(s => {
    const owner = addr(s), expiry = s.loadUint(32), released = s.loadCoins(), a = ordinary(s.loadRef()), p = s.loadMaybeRef();
    s.endParse();
    const amounts = finished(a, { funded: a.loadCoins(), available: a.loadCoins(), locked: a.loadCoins(), premium: a.loadCoins() });
    const q = p ? ordinary(p) : null;
    return { owner, expiry, released, amounts, pending: q ? finished(q, { queryId: q.loadUintBig(64), backing: q.loadCoins(), premium: q.loadCoins(), kept: q.loadCoins() }) : null };
});
const childPositionCodec = codec<NativeOptionChildPosition>(s => { const owner = addr(s), a = ordinary(s.loadRef()); const amounts = finished(a, { notional: a.loadCoins(), net: a.loadCoins(), lock: a.loadCoins(), payout: a.loadCoins() }); return finished(s, { owner, ...amounts, shoutFloor: s.loadUintBig(128), lastShoutAt: s.loadUint(32), outcome: s.loadUint(2) }); });
export function decodeOptionFactory(c: Cell) {
    const s = ordinary(c), governance = addr(s), closed = s.loadBit(), peers = ordinary(s.loadRef()), p = ordinary(s.loadRef());
    const vault = addr(peers), manager = optionalAddr(peers), shoutCode = peers.loadRef(), outperfCode = peers.loadRef();
    peers.endParse();
    const policy = finished(p, { used: p.loadCoins(), cap: p.loadCoins(), feeBps: p.loadUint(16), bumpActivate: p.loadUint(16), bumpDeactivate: p.loadUint(16), pauseThreshold: p.loadUint(16), bumpPercent: p.loadUint(16), bumpActive: p.loadBit(), fundedTotal: p.loadCoins(), lockedTotal: p.loadCoins(), pendingNotional: p.loadCoins(), seriesCount: p.loadUint(16), recordCount: p.loadUint(16), shoutCollateral: p.loadUint(32), outperfCollateral: p.loadUint(32) });
    return finished(s, { governance, closed, vault, manager, shoutCode, outperfCode, policy, series: s.loadDict(Dictionary.Keys.BigUint(64), seriesCodec), pending: s.loadDict(Dictionary.Keys.BigUint(64), pendingCodec) });
}
export function decodeOptionManager(c: Cell) {
    const s = ordinary(c);
    return finished(s, { governance: addr(s), factory: addr(s), nextSeriesId: s.loadUintBig(64), templateCount: s.loadUint(16), seriesCount: s.loadUint(16), templates: s.loadDict(Dictionary.Keys.Uint(32), templateCodec), series: s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()) });
}
const slotCodec = codec<FreshJettonSlot>(s => { const slot = finished(s, { master: addr(s), wallet: optionalAddr(s), walletGas: s.loadUint(32), walletGram: s.loadCoins(), optional: s.loadBit(), budget: decodeJettonWalletBudget(s.loadRef()) }); validateJettonWalletProfile(slot); return slot; });
export function decodeOptionVault(c: Cell) {
    const s = ordinary(c), governance = addr(s), closed = s.loadBit(), p = ordinary(s.loadRef()), m = ordinary(s.loadRef());
    const feeSink = addr(p), treasury = addr(p), factory = optionalAddr(p);
    p.endParse();
    const slots = m.loadDict(Dictionary.Keys.Uint(8), slotCodec), owed = m.loadMaybeRef(), recovery = m.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
    m.endParse();
    const sweeps = s.loadRef(), b = ordinary(s.loadRef());
    s.endParse();
    const nextIntentId = b.loadUintBig(65), intentCount = b.loadUint(16), escrowCount = b.loadUint(16), writerCount = b.loadUint(16), t = ordinary(b.loadRef());
    const totals = finished(t, { writer: t.loadCoins(), escrow: t.loadCoins(), intent: t.loadCoins(), fees: t.loadCoins(), nativeHeld: t.loadCoins(), pendingBuys: t.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Uint(16)) });
    const book = finished(b, { nextIntentId, intentCount, escrowCount, writerCount, totals, writers: b.loadDict(Dictionary.Keys.BigUint(64), optionWriterCodec), escrows: b.loadDict(Dictionary.Keys.BigUint(128), optionEscrowCodec), intents: b.loadDict(Dictionary.Keys.BigUint(64), optionIntentCodec) });
    return { governance, closed, feeSink, treasury, factory, slots, owed, recovery, sweeps, book };
}
export function decodeOptionChild(c: Cell) {
    const s = ordinary(c), factory = addr(s), seriesId = s.loadUintBig(64), termsCell = s.loadMaybeRef(), o = ordinary(s.loadRef());
    const t = termsCell ? ordinary(termsCell) : null;
    const terms = t ? { writer: addr(t), expiry: t.loadUint(32), maxNotional: t.loadCoins(), strikeBps: t.loadUint(32), collateralBps: t.loadUint(32), cooldown: t.loadUint(32), floorWindow: t.loadUint(32), pools: t.loadRef() } : null;
    let pools: {
        basePool: Address;
        quotePool: Address | null;
    } | null = null;
    if (t && terms) {
        t.endParse();
        const p = ordinary(terms.pools);
        pools = finished(p, { basePool: addr(p), quotePool: optionalAddr(p) });
    }
    const oracle = finished(o, { initial: o.loadUintBig(128), quoteInitial: o.loadUintBig(128), strike: o.loadUintBig(128), answered0: o.loadBit(), medium0: o.loadUintBig(128), long0: o.loadUintBig(128), answered1: o.loadBit(), medium1: o.loadUintBig(128), long1: o.loadUintBig(128), state: o.loadUint(2), window: o.loadUint(16), decidedAt: o.loadUintBig(64) });
    return finished(s, { factory, seriesId, terms: terms && pools ? { ...terms, ...pools } : null, oracle, positionCount: s.loadUint(16), openNotional: s.loadCoins(), positions: s.loadDict(Dictionary.Keys.BigUint(64), childPositionCodec) });
}
export const optionChildAddress = (factory: Address, seriesId: bigint, code: Cell) => {
    const oracle = beginCell().storeUint(0, 384).storeBit(false).storeUint(0, 256).storeBit(false).storeUint(0, 256).storeUint(0, 82).endCell();
    const data = beginCell().storeAddress(factory).storeUint(seriesId, 64).storeMaybeRef(null).storeRef(oracle).storeUint(0, 16).storeCoins(0).storeDict(null).endCell();
    return contractAddress(0, { code, data });
};
