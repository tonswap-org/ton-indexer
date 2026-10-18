import { beginCell, Cell, Dictionary, contractAddress, type Slice } from '@ton/core';
import { validJettonWalletProfile, type JettonWalletBudget } from '../config/runtimeManifest';
const ordinary = (cell: Cell) => { if (cell.isExotic)
    throw Error('Exotic T3 state'); return cell.beginParse(); };
const hash = (n: bigint) => n.toString(16).padStart(64, '0');
export type CurrentT3Slot = {
    master: string;
    wallet: string | null;
    walletGas: number;
    walletGram: string;
    optional: boolean;
    budget: JettonWalletBudget;
};
function budget(cell: Cell): JettonWalletBudget {
    const s = ordinary(cell), v = { senderGas: s.loadUint(32), walletBounceGas: s.loadUint(32), burnWalletGas: s.loadUint(32), smallPayloadCells: s.loadUint(16),
        largeWalletGas: s.loadUint(32), largeSenderGas: s.loadUint(32), rentSeconds: s.loadUint(32), rentBits: s.loadUint(32), rentCells: s.loadUint(16),
        initBits: s.loadUint(32), initCells: s.loadUint(16), initCopies: s.loadUint(8), transferBits: s.loadUint(16), transferCells: s.loadUint(8), transferCopies: s.loadUint(8), creditProtection: s.loadBit() };
    s.endParse();
    return v;
}
const readOnly = <T>(parse: (s: Slice) => T) => ({ parse, serialize: () => { throw Error('Read only T3 dictionary'); } });
const slotValue = readOnly<CurrentT3Slot>(s => {
    const v = { master: s.loadAddress().toRawString(), wallet: s.loadMaybeAddress()?.toRawString() ?? null, walletGas: s.loadUint(32), walletGram: s.loadCoins().toString(), optional: s.loadBit(), budget: budget(s.loadRef()) };
    s.endParse();
    if (!validJettonWalletProfile(v.walletGas, v.walletGram, v.budget))
        throw Error('Invalid reserve wallet profile');
    return v;
});
export function readCurrentT3Hub(data: string | Cell) {
    const cell = typeof data === 'string' ? Cell.fromBase64(data) : data, s = ordinary(cell);
    const configCell = s.loadRef(), ledgerCell = s.loadRef(), economyCell = s.loadRef(), treesCell = s.loadRef();
    s.endParse();
    const c = ordinary(configCell), governance = c.loadAddress().toRawString(), proofCodeHash = hash(c.loadUintBig(256)), amp = c.loadUint(16), rentBits = c.loadUint(32), rentCells = c.loadUint(32), walletCode = c.loadRef(), metadata = c.loadRef();
    const policies = c.loadDict(Dictionary.Keys.Uint(8), readOnly(p => { const v = { scale: p.loadUint(32), codeHash: hash(p.loadUintBig(256)), lockExit: p.loadUint(16), balanceExit: p.loadUint(16) }; p.endParse(); return v; }));
    c.endParse();
    if (walletCode.isExotic || metadata.isExotic || amp < 100 || amp > 250 || policies.size !== 3 || [0, 1, 2].some(i => !policies.has(i)))
        throw Error('Invalid T3 config');
    const l = ordinary(ledgerCell), slots = l.loadDict(Dictionary.Keys.Uint(8), slotValue);
    // Owed books are preserved by their exact Cell commitment; settlement never treats a book entry as a transfer.
    const owed = l.loadDict(Dictionary.Keys.Uint(8), readOnly(p => p.asCell()));
    l.endParse();
    const e = ordinary(economyCell), backing = [e.loadCoins(), e.loadCoins(), e.loadCoins()], pendingSlice = ordinary(e.loadRef()), pending = [pendingSlice.loadUintBig(256), pendingSlice.loadUintBig(256), pendingSlice.loadUintBig(256)];
    pendingSlice.endParse();
    const supply = e.loadCoins(), feeBps = e.loadUint(16), admitted = e.loadUint(3), frozen = e.loadUint(3), withdrawalsOnly = e.loadBit(), cl = ordinary(e.loadRef()), clears = [cl.loadUintBig(64), cl.loadUintBig(64), cl.loadUintBig(64)];
    cl.endParse();
    e.endParse();
    const t = ordinary(treesCell), trees = Array.from({ length: 4 }, () => { const v = ordinary(t.loadRef()), root = v.loadUintBig(256), initialized = v.loadBit(), lastKey = v.loadUintBig(64), lastLeaf = v.loadUintBig(256), frontier = v.loadMaybeRef(); v.endParse(); return { root, initialized, lastKey, lastLeaf, frontier }; });
    t.endParse();
    return { dataHash: cell.hash().toString('hex'), configHash: configCell.hash().toString('hex'), governance, proofCodeHash, amp, rentBits, rentCells, walletCode, walletCodeHash: walletCode.hash().toString('hex'), policies, slots, owed, backing, pending, supply, feeBps, admitted, frozen, withdrawalsOnly, clears, trees };
}
export function readCurrentT3Wallet(data: string | Cell) {
    const cell = typeof data === 'string' ? Cell.fromBase64(data) : data, s = ordinary(cell), c = ordinary(s.loadRef());
    const owner = c.loadAddress().toRawString(), master = c.loadAddress().toRawString(), proofCodeHash = hash(c.loadUintBig(256));
    c.endParse();
    const balance = s.loadCoins(), nextId = s.loadUintBig(65), root = s.loadUintBig(256), j = ordinary(s.loadRef()), failureCount = j.loadUintBig(64), failureRoot = j.loadUintBig(256), failureFrontier = j.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256));
    j.endParse();
    const frontier = s.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256)), protectedCredits = s.loadUintBig(256), acceptedTransfers = s.loadUintBig(256);
    s.endParse();
    return { dataHash: cell.hash().toString('hex'), owner, master, proofCodeHash, balance, nextId, root, failureCount, failureRoot, failureFrontier, frontier, protectedCredits, acceptedTransfers };
}
export function currentT3WalletAddress(owner: import('@ton/core').Address, master: import('@ton/core').Address, proofCodeHash: string, code: Cell) {
    const config = beginCell().storeAddress(owner).storeAddress(master).storeUint(BigInt(`0x${proofCodeHash}`), 256).endCell();
    let empty = beginCell().storeUint(0, 8).endCell().hash();
    for (let i = 0; i < 64; i++)
        empty = beginCell().storeUint(4, 8).storeBuffer(empty).storeBuffer(empty).endCell().hash();
    const data = beginCell().storeRef(config).storeCoins(0).storeUint(0, 65).storeBuffer(empty).storeRef(beginCell().storeUint(0, 64).storeUint(0, 256).storeDict(null).endCell()).storeDict(null).storeUint(0, 256).storeUint(0, 256).endCell();
    return contractAddress(0, { code, data }).toRawString();
}
