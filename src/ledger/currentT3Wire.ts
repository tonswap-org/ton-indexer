import { beginCell, Cell } from '@ton/core';
import type { RawMessage } from '../data/dataSource';
import { businessBodyCell } from './wire';
export const T3_WALLET_DELIVERY = 0x5433444c, T3_WALLET_BURN = 0x54335742, T3_WALLET_MINT = 0x5433574d, T3_HUB_RECEIPT = 0x5433484c, T3_HUB_PAYOUT = 0x54334850;
export const T3_MINT = 0x54334d4e, T3_PAIR = 0x5433504d, T3_SWAP = 0x54335357, T3_REDEEM = 0x54335244;
const slice = (c: Cell) => {
    if (c.isExotic)
        throw Error('Exotic T3 wire');
    return c.beginParse();
};
const parse = <T>(message: RawMessage | undefined, op: number, read: (s: ReturnType<Cell['beginParse']>) => T): T | null => {
    try {
        const c = businessBodyCell(message);
        if (!c)
            return null;
        const s = slice(c);
        if (s.loadUint(32) !== op)
            return null;
        const result = read(s);
        s.endParse();
        return result;
    }
    catch {
        return null;
    }
};
export function t3Attempt(cell: Cell) {
    const s = slice(cell), id = s.loadUintBig(64), originLt = s.loadUintBig(64), attempt = s.loadUintBig(64), t = slice(s.loadRef());
    s.endParse();
    const owner = t.loadAddress().toRawString(), recipient = t.loadAddress().toRawString(), burn = t.loadBit(), amount = t.loadCoins(), d = slice(t.loadRef());
    t.endParse();
    const queryId = d.loadUintBig(64), response = d.loadMaybeAddress()?.toRawString() ?? null, forwardValue = d.loadCoins(), forwardPayload = d.loadRef(), customPayload = d.loadMaybeRef();
    d.endParse();
    return { cell, id, originLt, attempt, owner, recipient, burn, amount, queryId, response, forwardValue, forwardPayload, customPayload };
}
/** Transfer retries may redirect only the recipient; burn terms cannot change. */
export function t3SameRequest(a: ReturnType<typeof t3Attempt>, b: ReturnType<typeof t3Attempt>) {
    return a.id === b.id && a.originLt === b.originLt && a.owner === b.owner && a.burn === b.burn && a.amount === b.amount && (!a.burn || a.recipient === b.recipient) && a.cell.refs[0].refs[0].equals(b.cell.refs[0].refs[0]);
}
export function t3Delivery(m?: RawMessage) { return parse(m, T3_WALLET_DELIVERY, s => t3Attempt(s.loadRef())); }
export function t3Burn(m?: RawMessage) { return parse(m, T3_WALLET_BURN, s => t3Attempt(s.loadRef())); }
export function t3Identity(c: Cell) { const s = slice(c), v = { domain: s.loadUint(2), slot: s.loadUint(2), key: s.loadUintBig(64), output: s.loadUint(2), attempt: s.loadUintBig(64) }; s.endParse(); return v; }
export function t3Mint(m?: RawMessage) { return parse(m, T3_WALLET_MINT, s => { const queryId = s.loadUintBig(64), amount = s.loadCoins(), identity = t3Identity(s.loadRef()), response = s.loadMaybeAddress()?.toRawString() ?? null; return { queryId, amount, identity, response }; }); }
export function t3PayoutIdentity(c: Cell) {
    try {
        const s = slice(c);
        if (s.loadUint(32) !== T3_HUB_PAYOUT)
            return null;
        const v = t3Identity(s.loadRef());
        s.endParse();
        return v;
    }
    catch {
        return null;
    }
}
export function t3Intent(c: Cell) {
    try {
        const s = slice(c), op = s.loadUint(32);
        if (![T3_MINT, T3_PAIR, T3_SWAP, T3_REDEEM].includes(op))
            return null;
        const single = op === T3_REDEEM ? s.loadBit() : false, output = op === T3_REDEEM || op === T3_SWAP ? s.loadUint(2) : 0, strict = op === T3_REDEEM || op === T3_SWAP ? s.loadBit() : false, minOut = s.loadCoins(), recipient = s.loadAddress().toRawString();
        s.endParse();
        if (output > 2)
            return null;
        return { op, single, output, strict, minOut, recipient };
    }
    catch {
        return null;
    }
}
function payout(c: Cell) {
    const s = slice(c), owner = s.loadAddress().toRawString(), recipient = s.loadAddress().toRawString(), queryId = s.loadUintBig(64), l = slice(s.loadRef());
    s.endParse();
    const legs = Array.from({ length: 3 }, () => { const x = slice(l.loadRef()), v = { amount: x.loadCoins(), attempt: x.loadUintBig(64), sentLt: x.loadUintBig(64), status: x.loadUint(1), recipient: x.loadAddress().toRawString() }; x.endParse(); return v; });
    l.endParse();
    return { owner, recipient, queryId, legs };
}
export function t3Credit(cell: Cell) { const c = slice(cell), credit = { certified: c.loadBit(), owner: c.loadAddress().toRawString(), queryId: c.loadUintBig(64), amount: c.loadCoins(), intent: c.loadRef(), evidence: c.loadMaybeRef() }; c.endParse(); return credit; }
export const CURRENT_T3_OPS = new Set([T3_WALLET_DELIVERY, T3_WALLET_BURN, T3_WALLET_MINT, T3_HUB_RECEIPT, T3_HUB_PAYOUT, T3_MINT, T3_PAIR, T3_SWAP, T3_REDEEM, 0x5433574b, 0x54335759, 0x54335758, 0x54334841, 0x54334846, 0x54334842, 0x5433484d, 0x54334852, 0x54335046, 0x54334643, 0x54335246, 0x54334343, 0x54334e43]);
export function t3Receipt(slot: number, cell: Cell) {
    const r = slice(cell), key = r.loadUintBig(64), s = slice(r.loadRef());
    r.endParse();
    if (slot === 3) {
        const attempt = t3Attempt(s.loadRef()), p = s.loadMaybeRef();
        s.endParse();
        return { slot, key, cell, kind: 'burn' as const, attempt, payout: p ? payout(p) : null };
    }
    if (slot < 0 || slot > 2)
        throw Error('Invalid T3 receipt slot');
    const phase = s.loadUint(3), linkedSlot = s.loadUint(2), linkedKey = s.loadUintBig(64), c = slice(s.loadRef()), m = s.loadMaybeRef(), p = s.loadMaybeRef(), staged = s.loadMaybeRef();
    s.endParse();
    const credit = { certified: c.loadBit(), owner: c.loadAddress().toRawString(), queryId: c.loadUintBig(64), amount: c.loadCoins(), intent: c.loadRef(), evidence: c.loadMaybeRef() };
    c.endParse();
    let mint: null | {
        amount: bigint;
        recipient: string;
        attempt: bigint;
        sentLt: bigint;
        status: number;
    } = null;
    if (m) {
        const x = slice(m);
        mint = { amount: x.loadCoins(), recipient: x.loadAddress().toRawString(), attempt: x.loadUintBig(64), sentLt: x.loadUintBig(64), status: x.loadUint(1) };
        x.endParse();
    }
    if (phase > 4)
        throw Error('Invalid T3 receipt phase');
    return { slot, key, cell, kind: 'credit' as const, phase, linkedSlot, linkedKey, credit, mint, payout: p ? payout(p) : null, staged };
}
export function t3ReceiptLog(m?: RawMessage) { return parse(m, T3_HUB_RECEIPT, s => t3Receipt(s.loadUint(2), s.loadRef())); }
export const t3Leaf = (c: Cell) => beginCell().storeUint(3, 8).storeRef(c).endCell().hash();
const pair = (a: Buffer, b: Buffer) => beginCell().storeUint(4, 8).storeBuffer(a).storeBuffer(b).endCell().hash();
export function t3PathRoot(key: bigint, record: Cell, path: Cell, packed = false) {
    let h = t3Leaf(record), s = slice(path);
    for (let i = 0; i < 64; i++) {
        if (packed && s.remainingBits === 0) {
            s = slice(s.loadRef());
        }
        const sibling = s.loadBuffer(32);
        h = ((key >> BigInt(i)) & 1n) === 0n ? pair(h, sibling) : pair(sibling, h);
        if (!packed) {
            const tail = s.loadMaybeRef();
            s.endParse();
            if ((tail === null) !== (i === 63))
                throw Error('Invalid T3 path');
            if (tail)
                s = slice(tail);
        }
    }
    s.endParse();
    return BigInt('0x' + h.toString('hex'));
}
