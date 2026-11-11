import { Address, Cell, Dictionary, beginCell, contractAddress } from '@ton/core';
import { decodeOptionVault, decodeOptionFactory, decodeOptionChild, optionChildAddress, type NativeOptionIntent } from './currentOptionsState';
import { activeOrderAccount, orderCell as currentT3Cell, verifyOrderTransaction, type OrderTransactionEvidence as CurrentT3TransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage } from '../runtime/physicalEvidence';
import { readCurrentT3Wallet } from './currentT3State';
import { t3Attempt, t3PathRoot } from './currentT3Wire';
/** Current native business proof, independently checked from original account
 * cells. Request-shaped input is inferred from owner transactions by the ledger.
 * Neither an event nor a released right is proof of token delivery. */
export type OptionsBinding = {
    factory: Address;
    factoryHash: string;
    vault: Address;
    vaultHash: string;
    manager: Address;
    managerHash: string;
    governance: Address;
    feeSink: Address;
    treasury: Address;
    shoutHash: string;
    outperfHash: string;
    t3Root: Address;
    t3MasterHash: string;
    t3WalletHash: string;
};
const OPTION_OP = { EVENT: 0x4f564556, FUND: 0x4f564644, BUY: 0x4f564259, EXERCISE: 0x46455843, EARLY_EXERCISE: 0x4f464558 };
const T3_OP = { T3_WALLET_DELIVERY: 0x5433444c, T3_WALLET_RETRY: 0x54335759 };
const verifiedTransactions = new WeakMap<CurrentT3TransactionEvidence, {
    original: CurrentT3TransactionEvidence;
    value: ReturnType<typeof verifyOrderTransaction> & {
        account: string;
    };
}>();
export function verifyCurrentOptionTransaction(e: CurrentT3TransactionEvidence) {
    const cached = verifiedTransactions.get(e);
    if (cached && cached.original.account === e.account && cached.original.transactionBoc === e.transactionBoc && cached.original.beforeShardAccountBoc === e.beforeShardAccountBoc && cached.original.afterShardAccountBoc === e.afterShardAccountBoc)
        return cached.value;
    const value = { account: e.account, ...verifyOrderTransaction(e) };
    verifiedTransactions.set(e, { original: { ...e }, value });
    return value;
}
const verifyCurrentT3Transaction = verifyCurrentOptionTransaction;
type CurrentT3Transaction = ReturnType<typeof verifyCurrentT3Transaction>;
function currentT3ActiveState(s: CurrentT3Transaction['after'], pin: string) { return { ...activeOrderAccount(s, pin), splitDepth: null }; }
const messageHashes = new WeakMap<object, {
    incoming: string | null;
    outgoing: Set<string>;
}>();
function cachedMessages(t: CurrentT3Transaction) { let value = messageHashes.get(t); if (!value) {
    value = { incoming: t.incoming ? canonicalPhysicalMessage(t.incoming).hash().toString('hex') : null, outgoing: new Set(t.outgoing.values().map(c => canonicalPhysicalMessage(c).hash().toString('hex'))) };
    messageHashes.set(t, value);
} return value; }
function verifyCurrentT3MessageLink(a: CurrentT3Transaction, b: CurrentT3Transaction) { if (b.tx.lt <= a.tx.lt)
    return false; const incoming = cachedMessages(b).incoming; return incoming !== null && cachedMessages(a).outgoing.has(incoming); }
function walletState(c: Cell) { const s = readCurrentT3Wallet(c); return { ...s, owner: Address.parse(s.owner), master: Address.parse(s.master), proofCodeHash: BigInt('0x' + s.proofCodeHash), count: s.nextId }; }
function walletInitialData(owner: Address, master: Address, proofCodeHash: bigint) {
    let h = beginCell().storeUint(0, 8).endCell().hash();
    for (let i = 0; i < 64; i++)
        h = beginCell().storeUint(4, 8).storeBuffer(h).storeBuffer(h).endCell().hash();
    return beginCell().storeRef(beginCell().storeAddress(owner).storeAddress(master).storeUint(proofCodeHash, 256)).storeCoins(0).storeUint(0, 65).storeBuffer(h).storeRef(beginCell().storeUint(0, 64).storeUint(0, 256).storeDict(null)).storeDict(null).storeUint(0, 256).storeUint(0, 256).endCell();
}
function walletAttempt(c: Cell) { const a = t3Attempt(c); return { ...a, owner: Address.parse(a.owner), recipient: Address.parse(a.recipient), details: { queryId: a.queryId, response: a.response ? Address.parse(a.response) : null, forwardValue: a.forwardValue, forwardPayload: a.forwardPayload, customPayload: a.customPayload } }; }
function attemptCell(a: ReturnType<typeof walletAttempt>) { return a.cell; }
function walletRecord(c: Cell) { const s = c.beginParse(); check(!c.isExotic, 'wallet record'); const failed = s.loadBit(), cancelled = s.loadBit(), attempt = walletAttempt(s.loadRef()); s.endParse(); return { failed, cancelled, attempt }; }
function walletWitness(c: Cell, id: bigint, p: Cell, root: bigint) { return t3PathRoot(id, c, p) === root; }
function decodeTransfer(c: Cell) { check(!c.isExotic, 'transfer body'); const s = c.beginParse(); check(s.loadUint(32) === 0x0f8a7ea5, 'TEP74 transfer'); const query = s.loadUintBig(64), amount = s.loadCoins(), owner = s.loadAddress().toRawString(), response = s.loadMaybeAddress()?.toRawString() ?? null, custom = s.loadMaybeRef(), forwardValue = s.loadCoins(), payload = either(s); return { query, amount, owner, response, custom, forwardValue, payload }; }
export type NativeOptionDispatch = {
    lt: string;
    hash: string;
    valueNano: string;
};
export type NativeOptionEvidenceRequest = {
    network: 'testnet' | 'mainnet' | 'localnet';
    releaseId: string;
    manifestHash: string;
    kind: 'buy' | 'fund' | 'withdraw' | 'payout' | 'owed';
    owner: string;
    factory: string;
    vault: string;
    series: string | null;
    seriesId: string;
    queryId: string;
    amountRaw: string;
    notionalRaw: string | null;
    tokenId: string | null;
    sourceWallet: string | null;
    bodyBoc: string;
    bodyHash: string;
    valueNano: string;
    createdAt: number;
    dispatch: NativeOptionDispatch;
};
export type NativeOptionTransferOrigin = {
    wallet: string;
    transactionHash: string;
    lt: string;
    attemptBoc: string;
};
export type NativeOptionEffect = {
    status: 'accepted' | 'delivered' | 'refunded' | 'rejected';
    requestBodyHash: string;
    transactionHash: string;
    amountRaw: string;
    positionId?: string;
    txId: string;
    stage?: 'refund';
    transferOrigins?: NativeOptionTransferOrigin[];
};
export type NativeOptionEvidence = NativeOptionEffect | {
    status: 'pending' | 'unavailable';
    transferOrigins?: NativeOptionTransferOrigin[];
};
export type NativeOptionProofBinding = {
    options: OptionsBinding;
    releaseId: string;
    manifestHash: string;
    network: NativeOptionEvidenceRequest['network'];
    walletCodeHash: string;
    proofCodeHash: string;
};
export function currentOptionsBindingFromManifest(m: import('../config/runtimeManifest').RuntimeReleaseManifest): NativeOptionProofBinding {
    const pin = (name: keyof typeof m.contracts) => { const p = m.contracts[name]; if (!p)
        throw Error(`Missing Options peer ${name}`); return { address: Address.parse(p.address), hash: p.codeHash }; };
    const f = pin('OptionFactory'), v = pin('OptionVault'), manager = pin('OptionSeriesManager'), hub = pin('T3Hub'), token = m.tokens.find(t => t.symbol === 'T3');
    check(token && token.root === hub.address.toRawString() && token.masterCodeHash === hub.hash && token.walletCodeHash === m.templates.T3Wallet, 'release T3 identity');
    return { network: m.network.slice(4) as NativeOptionEvidenceRequest['network'], releaseId: m.releaseId, manifestHash: m.manifestHash, walletCodeHash: token.walletCodeHash, proofCodeHash: m.templates.T3RecoveryProof,
        options: { factory: f.address, factoryHash: f.hash, vault: v.address, vaultHash: v.hash, manager: manager.address, managerHash: manager.hash, governance: pin('Governance').address, feeSink: pin('FeeRouter').address, treasury: pin('Treasury').address, shoutHash: m.templates.ShoutOption, outperfHash: m.templates.OutperformanceOption, t3Root: hub.address, t3MasterHash: hub.hash, t3WalletHash: token.walletCodeHash } };
}
const raw = (a: Address | null | undefined) => a?.toRawString() ?? null;
const hash = (c: Cell) => c.hash().toString('hex');
const exact = (v: unknown, keys: readonly string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function check(v: unknown, detail: string): asserts v { if (!v)
    throw Error(`Native Options evidence: ${detail}`); }
function integer(v: unknown, bits = 120) { check(typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v) && BigInt(v) < 1n << BigInt(bits), 'integer'); return BigInt(v); }
function address(v: string) { const a = Address.parse(v); check(a.workChain === 0 && raw(a) === v, 'canonical account'); return a; }
const one = <T>(xs: T[]) => xs.length === 1 ? xs[0] : null;
const maybe = <T>(fn: () => T) => { try {
    return fn();
}
catch {
    return null;
} };
function input(t: CurrentT3Transaction, from?: string) { const m = t.tx.inMessage; check(m?.info.type === 'internal' && !m.info.bounced && (!from || raw(m.info.src) === from), 'incoming message'); return m; }
function either(s: ReturnType<Cell['beginParse']>) { if (s.loadBit()) {
    const c = s.loadRef();
    s.endParse();
    return c;
} return beginCell().storeSlice(s).endCell(); }
export function decodeNativeOptionEvent(body: Cell) {
    check(!body.isExotic, 'event cell');
    const s = body.beginParse();
    check(s.loadUint(32) === OPTION_OP.EVENT, 'OV_EVENT');
    const event = { queryId: s.loadUintBig(64), kind: s.loadUint(8), seriesId: s.loadUintBig(64), tokenId: s.loadUintBig(64), intentId: s.loadUintBig(64), amount: s.loadCoins(), party: s.loadAddress() };
    s.endParse();
    check(event.kind >= 1 && event.kind <= 7 && event.seriesId > 0n, 'event shape');
    return event;
}
function vaultState(t: CurrentT3Transaction, b: NativeOptionProofBinding, after = true) {
    check(t.account === raw(b.options.vault) && t.succeeded, 'vault transaction');
    const active = currentT3ActiveState(after ? t.after : t.before, b.options.vaultHash), s = decodeOptionVault(active.data), o = b.options;
    check(active.splitDepth === null && s.governance.equals(o.governance) && s.factory?.equals(o.factory) && s.feeSink.equals(o.feeSink) && s.treasury.equals(o.treasury) && s.slots.size === 1 && s.slots.get(0)?.master.equals(o.t3Root), 'vault identity');
    return s;
}
function factoryState(t: CurrentT3Transaction, b: NativeOptionProofBinding, after = true) {
    check(t.account === raw(b.options.factory) && t.succeeded, 'factory transaction');
    currentT3ActiveState(t.before, b.options.factoryHash);
    const s = decodeOptionFactory(currentT3ActiveState(after ? t.after : t.before, b.options.factoryHash).data), o = b.options;
    check(s.governance.equals(o.governance) && s.vault.equals(o.vault) && s.manager?.equals(o.manager) && hash(s.shoutCode) === o.shoutHash && hash(s.outperfCode) === o.outperfHash, 'factory identity');
    return s;
}
function balance(t: CurrentT3Transaction, b: NativeOptionProofBinding, owner: string, after: boolean) {
    const shard = after ? t.after : t.before;
    if (!shard.account || shard.account.storage.state.type === 'uninit')
        return 0n;
    const a = currentT3ActiveState(shard, b.walletCodeHash), s = walletState(a.data);
    check(a.splitDepth === null && s.owner.equals(address(owner)) && s.master.equals(b.options.t3Root) && s.proofCodeHash === BigInt('0x' + b.proofCodeHash), 'T3 wallet pin');
    check(raw(contractAddress(0, { code: a.code, data: walletInitialData(address(owner), b.options.t3Root, s.proofCodeHash) })) === t.account, 'canonical T3 wallet');
    return s.balance;
}
function delta(t: CurrentT3Transaction, b: NativeOptionProofBinding, owner: string, amount: bigint) {
    check(t.succeeded && t.after.account?.storage.state.type === 'active', 'wallet execution');
    check(balance(t, b, owner, true) - balance(t, b, owner, false) === amount, 'physical T3 balance delta');
}
function delivery(source: CurrentT3Transaction, target: CurrentT3Transaction, request: ReturnType<typeof decodeTransfer>, b: NativeOptionProofBinding, from: string, to: string) {
    check(verifyCurrentT3MessageLink(source, target), 'token message link');
    const s = input(target, source.account).body.beginParse();
    check(s.loadUint(32) === T3_OP.T3_WALLET_DELIVERY, 'current T3 delivery');
    const a = walletAttempt(s.loadRef());
    s.endParse();
    check(!a.burn && a.originLt === source.tx.lt && a.attempt === 0n && raw(a.owner) === from && raw(a.recipient) === to && a.amount === request.amount && a.details.queryId === request.query && raw(a.details.response) === request.response && a.details.forwardValue === request.forwardValue && a.details.customPayload === null && either(a.details.forwardPayload.beginParse()).equals(request.payload), 'exact T3 attempt');
    delta(source, b, from, -request.amount);
    delta(target, b, to, request.amount);
}
function reaches(source: CurrentT3Transaction, target: CurrentT3Transaction, txs: CurrentT3Transaction[]) {
    const reached = new Set([source.hash]);
    for (const t of [...txs].sort((a, b) => a.tx.lt < b.tx.lt ? -1 : 1))
        if (!reached.has(t.hash) && txs.some(s => reached.has(s.hash) && s.tx.lt < t.tx.lt && verifyCurrentT3MessageLink(s, t)))
            reached.add(t.hash);
    return reached.has(target.hash);
}
function eventRows(txs: CurrentT3Transaction[], p: NativeOptionEvidenceRequest, b: NativeOptionProofBinding) {
    return txs.filter(t => t.account === p.vault && t.succeeded).flatMap(t => t.tx.outMessages.values().flatMap(m => {
        if (m.info.type !== 'external-out' || raw(m.info.src) !== p.vault)
            return [];
        const e = maybe(() => decodeNativeOptionEvent(m.body));
        if (!e || e.queryId !== BigInt(p.queryId) || e.seriesId !== BigInt(p.seriesId) || raw(e.party) !== p.owner)
            return [];
        vaultState(t, b, false);
        vaultState(t, b);
        return [{ t, e }];
    }));
}
function intentMatches(i: NativeOptionIntent | undefined, p: NativeOptionEvidenceRequest) { return !!i && i.kind === (p.kind === 'fund' ? 1 : 2) && i.owner.equals(address(p.owner)) && i.queryId === BigInt(p.queryId) && i.seriesId === BigInt(p.seriesId) && i.amount === BigInt(p.amountRaw) && i.notional === BigInt(p.notionalRaw ?? '0'); }
function effect(p: NativeOptionEvidenceRequest, t: CurrentT3Transaction, status: NativeOptionEffect['status'], amount: bigint, positionId?: bigint): NativeOptionEffect {
    return { status, requestBodyHash: p.bodyHash, transactionHash: t.hash, amountRaw: amount.toString(), txId: `${t.tx.lt}:${t.hash}`, ...(positionId ? { positionId: positionId.toString() } : {}) };
}
function pay(event: ReturnType<typeof eventRows>[number], p: NativeOptionEvidenceRequest, b: NativeOptionProofBinding, txs: CurrentT3Transaction[], status: 'delivered' | 'refunded') {
    if (event.e.amount === 0n)
        return effect(p, event.t, status, 0n, event.e.tokenId);
    const wallet = raw(vaultState(event.t, b).slots.get(0)?.wallet);
    check(wallet, 'vault T3 wallet');
    const sources = txs.filter(t => t.account === wallet && t.succeeded && verifyCurrentT3MessageLink(event.t, t)).filter(t => maybe(() => {
        const req = decodeTransfer(input(t, p.vault).body);
        return req.query === event.e.queryId && req.amount === event.e.amount && req.owner === p.owner && req.response === p.owner && req.custom === null && req.forwardValue === 0n && (p.kind === 'owed' ? req.payload.equals(beginCell().storeUint(0x4a434c52, 32).endCell()) : req.payload.bits.length === 0 && req.payload.refs.length === 0);
    }) === true);
    const source = one(sources);
    if (!source)
        return { status: 'pending' } as const;
    const request = decodeTransfer(input(source, p.vault).body);
    const target = one(txs.filter(t => maybe(() => { delivery(source, t, request, b, p.vault, p.owner); return true; }) === true));
    if (target)
        return effect(p, target, status, event.e.amount, event.e.tokenId);
    // A retry preserves the original debit, identity and terms. Only the native
    // wallet's authenticated failed-record proof permits a new delivery attempt.
    delta(source, b, p.vault, -request.amount);
    const outgoing = one(source.tx.outMessages.values().filter(m => m.info.type === 'internal' && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === T3_OP.T3_WALLET_DELIVERY));
    if (!outgoing)
        return { status: 'pending' } as const;
    const initial = walletAttempt(outgoing.body.refs[0]);
    check(initial.originLt === source.tx.lt && initial.attempt === 0n && !initial.burn && raw(initial.owner) === p.vault && raw(initial.recipient) === p.owner && initial.amount === request.amount && initial.details.queryId === request.query && raw(initial.details.response) === request.response && initial.details.forwardValue === request.forwardValue && initial.details.customPayload === null && either(initial.details.forwardPayload.beginParse()).equals(request.payload), 'original recovery attempt');
    const initialTerms = attemptCell(initial).refs[0];
    const retried = txs.filter(t => t.account === source.account && t.succeeded && t.tx.lt > source.tx.lt).flatMap(retry => {
        const recipient = maybe(() => {
            const s = input(retry).body.beginParse();
            check(s.loadUint(32) === T3_OP.T3_WALLET_RETRY, 'wallet retry');
            const record = s.loadRef(), proof = s.loadRef(), to = s.loadAddress();
            s.endParse();
            const r = walletRecord(record), a = r.attempt, state = walletState(currentT3ActiveState(retry.before, b.walletCodeHash).data);
            delta(retry, b, p.vault, 0n);
            check(r.failed && !r.cancelled && a.id === initial.id && a.originLt === initial.originLt && attemptCell(a).refs[0].equals(initialTerms) && to.equals(initial.recipient) && a.id < state.count && walletWitness(record, a.id, proof, state.root), 'authenticated fixed recovery');
            return one(txs.filter(t => maybe(() => {
                check(verifyCurrentT3MessageLink(retry, t), 'retry delivery link');
                const s = input(t, retry.account).body.beginParse();
                check(s.loadUint(32) === T3_OP.T3_WALLET_DELIVERY, 'retry delivery');
                const next = walletAttempt(s.loadRef());
                s.endParse();
                check(next.id === a.id && next.originLt === a.originLt && next.attempt === a.attempt + 1n && attemptCell(next).refs[0].equals(initialTerms), 'same retry terms');
                delta(t, b, p.owner, request.amount);
                return true;
            }) === true));
        });
        return recipient ? [recipient] : [];
    });
    const recovered = one(retried);
    return recovered ? effect(p, recovered, status, event.e.amount, event.e.tokenId) : { status: 'pending' as const, transferOrigins: [{ wallet: source.account, transactionHash: source.hash, lt: source.tx.lt.toString(), attemptBoc: attemptCell(initial).toBoc().toString('base64') }] };
}
export function inspectNativeOptionEvidence(p: NativeOptionEvidenceRequest, b: NativeOptionProofBinding, evidence: readonly CurrentT3TransactionEvidence[]): NativeOptionEvidence {
    try {
        check(exact(p, ['network', 'releaseId', 'manifestHash', 'kind', 'owner', 'factory', 'vault', 'series', 'seriesId', 'queryId', 'amountRaw', 'notionalRaw', 'tokenId', 'sourceWallet', 'bodyBoc', 'bodyHash', 'valueNano', 'createdAt', 'dispatch']) && exact(p.dispatch, ['lt', 'hash', 'valueNano']), 'request shape');
        check(p.network === b.network && p.releaseId === b.releaseId && p.manifestHash === b.manifestHash && p.factory === raw(b.options.factory) && p.vault === raw(b.options.vault) && digest(p.bodyHash) && digest(b.walletCodeHash) && digest(b.proofCodeHash), 'release identity');
        address(p.owner);
        address(p.vault);
        address(p.factory);
        if (p.series)
            address(p.series);
        if (p.sourceWallet)
            address(p.sourceWallet);
        check(['buy', 'fund', 'withdraw', 'payout', 'owed'].includes(p.kind) && (p.kind === 'owed' ? p.seriesId === '0' : integer(p.seriesId, 64) > 0n) && (p.kind === 'payout' ? integer(p.amountRaw) >= 0n : integer(p.amountRaw) > 0n) && integer(p.queryId, 64) >= 0n && integer(p.valueNano) > 0n && Number.isSafeInteger(p.createdAt) && p.createdAt > 0, 'request identity');
        check(p.dispatch && integer(p.dispatch.lt, 64) > 0n && digest(p.dispatch.hash) && integer(p.dispatch.valueNano) > 0n && BigInt(p.dispatch.valueNano) <= BigInt(p.valueNano), 'dispatch');
        if (p.notionalRaw !== null)
            integer(p.notionalRaw);
        if (p.tokenId !== null)
            check(integer(p.tokenId, 64) > 0n, 'token identity');
        const body = currentT3Cell(p.bodyBoc);
        check(hash(body) === p.bodyHash && evidence.length <= 256, 'original body');
        const txs = evidence.map(verifyCurrentT3Transaction);
        check(new Set(txs.map(t => t.hash)).size === txs.length, 'duplicate transactions');
        const destination = p.kind === 'withdraw' || p.kind === 'owed' ? p.vault : p.kind === 'payout' ? p.factory : p.sourceWallet;
        check(destination, 'source wallet');
        const dispatched = one(txs.filter(t => t.account === p.owner && t.tx.lt.toString() === p.dispatch.lt && t.hash === p.dispatch.hash));
        if (!dispatched)
            return { status: 'pending' };
        check(dispatched.succeeded, 'owner wallet execution');
        const first = one(txs.filter(t => t.account === destination && verifyCurrentT3MessageLink(dispatched, t) && maybe(() => { const m = input(t, p.owner); return m.info.type === 'internal' && m.body.equals(body) && m.info.value.coins.toString() === p.dispatch.valueNano; }) === true));
        if (!first)
            return { status: 'pending' };
        if (!first.succeeded)
            return { status: 'pending' };
        const events = eventRows(txs, p, b), seriesId = BigInt(p.seriesId);
        if (p.kind === 'owed') {
            check(p.series === null && p.seriesId === '0' && p.sourceWallet === null && p.notionalRaw === null && p.tokenId === null, 'owed scope');
            const s = body.beginParse();
            check(s.loadUint(32) === 0x434c4d4a && s.loadUintBig(64) === BigInt(p.queryId) && s.loadUint(8) === 0 && raw(s.loadAddress()) === p.owner, 'original owed claim');
            s.endParse();
            const owed = (state: ReturnType<typeof vaultState>) => state.owed ? Dictionary.loadDirect(Dictionary.Keys.Uint(8), { serialize() { throw Error('read only'); }, parse(s) { const total = s.loadCoins(), count = s.loadUint(16), entries = s.loadDict(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)), archive = s.loadMaybeRef(); s.endParse(); return { total, count, entries, archive }; } }, state.owed).get(0) : undefined;
            const before = owed(vaultState(first, b, false)), after = owed(vaultState(first, b)), amount = before?.entries.get(address(p.owner));
            check(before && after && amount !== undefined && amount >= BigInt(p.amountRaw) && !after.entries.has(address(p.owner)) && after.total === before.total - amount && after.count === before.count - 1 && ((!before.archive && !after.archive) || before.archive?.equals(after.archive!)), 'exact owed reduction');
            const paid = pay({ t: first, e: { kind: 6, queryId: BigInt(p.queryId), seriesId: 0n, tokenId: 0n, intentId: 0n, amount, party: address(p.owner) } }, p, b, txs, 'delivered');
            return paid.status === 'pending' ? { ...effect(p, first, 'accepted', amount), ...('transferOrigins' in paid ? { transferOrigins: paid.transferOrigins } : {}) } : paid;
        }
        if (p.kind === 'payout') {
            check(p.sourceWallet === null && p.notionalRaw === null && p.tokenId !== null, 'exercise scope');
            const tokenId = BigInt(p.tokenId), s = body.beginParse(), op = s.loadUint(32);
            check(op === OPTION_OP.EXERCISE || op === OPTION_OP.EARLY_EXERCISE, 'exercise body');
            if (op === OPTION_OP.EARLY_EXERCISE)
                s.loadUintBig(64);
            check(s.loadUintBig(64) === seriesId && s.loadUintBig(64) === tokenId, 'exercise position');
            const minimum = op === OPTION_OP.EARLY_EXERCISE ? s.loadCoins() : 0n;
            s.endParse();
            check(minimum === BigInt(p.amountRaw), 'exercise minimum');
            const originalFactory = factoryState(first, b, false), series = originalFactory.series.get(seriesId), position = series?.positions.get(tokenId);
            check(series && position && !position.released && position.buyer.equals(address(p.owner)) && (p.series === null || p.series === raw(series.child)) && optionChildAddress(b.options.factory, seriesId, series.kind === 1 ? originalFactory.shoutCode : originalFactory.outperfCode).equals(series.child), 'original live position');
            const paid = one(events.filter(x => [4, 5].includes(x.e.kind) && x.e.tokenId === tokenId && x.e.intentId === tokenId && x.t.tx.lt > first.tx.lt && maybe(() => {
                const before = vaultState(x.t, b, false).book.escrows.get(seriesId << 64n | tokenId), after = vaultState(x.t, b).book.escrows.get(seriesId << 64n | tokenId);
                check(before && !after && before.owner.equals(address(p.owner)) && before.queryId === BigInt(p.queryId) && before.net === position.net && before.fee === position.fee && before.locked === position.lock, 'position escrow');
                check(x.e.kind === 5 ? x.e.amount === before.net + before.fee : x.e.amount <= before.locked && x.e.amount >= minimum, 'bounded payout');
                const settled = one(txs.filter(t => t.account === p.factory && t.succeeded && verifyCurrentT3MessageLink(t, x.t)));
                check(settled, 'factory settlement');
                const fp = factoryState(settled, b, false).series.get(seriesId)?.positions.get(tokenId), fa = factoryState(settled, b).series.get(seriesId)?.positions.get(tokenId);
                check(fp && !fp.released && fa?.released && fp.buyer.equals(position.buyer) && fp.notional === position.notional && fp.net === position.net && fp.fee === position.fee && fp.lock === position.lock, 'factory position release');
                const child = one(txs.filter(t => t.account === raw(series.child) && t.succeeded && reaches(first, t, txs) && verifyCurrentT3MessageLink(t, settled)));
                check(child, 'exercise causal graph');
                currentT3ActiveState(child.before, series.kind === 1 ? b.options.shoutHash : b.options.outperfHash);
                const state = decodeOptionChild(currentT3ActiveState(child.after, series.kind === 1 ? b.options.shoutHash : b.options.outperfHash).data), cp = state.positions.get(tokenId);
                check(state.factory.equals(b.options.factory) && state.seriesId === seriesId && cp?.owner.equals(position.buyer) && cp.notional === position.notional && cp.net === position.net && cp.lock === position.lock && cp.outcome === (x.e.kind === 5 ? 2 : 1) && cp.payout === (x.e.kind === 5 ? 0n : x.e.amount), 'child settlement identity');
                return true;
            }) === true));
            if (paid) {
                const cash = pay(paid, p, b, txs, paid.e.kind === 5 ? 'refunded' : 'delivered');
                return cash.status === 'pending' ? { ...effect(p, paid.t, 'accepted', paid.e.amount, tokenId), ...('transferOrigins' in cash ? { transferOrigins: cash.transferOrigins } : {}) } : cash;
            }
            const refused = one(txs.filter(t => t.account === p.factory && t.succeeded && reaches(first, t, txs) && maybe(() => {
                const s = input(t, raw(series.child)!).body.beginParse();
                check(s.loadUint(32) === 0x4f585352 && s.loadUintBig(64) === seriesId && s.loadUintBig(64) === tokenId && raw(s.loadAddress()) === p.owner && s.loadUint(2) === 0 && raw(s.loadAddress()) === p.owner && s.loadCoins() === 0n, 'exact refused exercise');
                s.endParse();
                const before = factoryState(t, b, false).series.get(seriesId)?.positions.get(tokenId), after = factoryState(t, b).series.get(seriesId)?.positions.get(tokenId);
                check(before && !before.released && after && !after.released && before.buyer.equals(position.buyer) && after.buyer.equals(position.buyer) && before.notional === position.notional && after.notional === position.notional && before.net === after.net && before.fee === after.fee && before.lock === after.lock, 'refusal preserves position');
                const child = one(txs.filter(c => c.account === raw(series.child) && c.succeeded && reaches(first, c, txs) && verifyCurrentT3MessageLink(c, t)));
                check(child, 'refusal child graph');
                for (const boundary of [child.before, child.after]) {
                    const c = decodeOptionChild(currentT3ActiveState(boundary, series.kind === 1 ? b.options.shoutHash : b.options.outperfHash).data), cp = c.positions.get(tokenId);
                    check(c.factory.equals(b.options.factory) && c.seriesId === seriesId && cp?.owner.equals(position.buyer) && cp.outcome === 0 && cp.notional === position.notional && cp.net === position.net && cp.lock === position.lock, 'refused child position');
                }
                return true;
            }) === true));
            return refused ? effect(p, refused, 'rejected', 0n, tokenId) : { status: 'pending' };
        }
        if (p.kind === 'withdraw') {
            check(p.sourceWallet === null && p.notionalRaw === null && p.tokenId === null, 'withdraw scope');
            const s = body.beginParse();
            check(s.loadUint(32) === 0x4f535757 && s.loadUintBig(64) === BigInt(p.queryId) && s.loadUintBig(64) === seriesId && s.loadCoins() === BigInt(p.amountRaw), 'withdraw body');
            s.endParse();
            const before = vaultState(first, b, false).book.writers.get(seriesId), after = vaultState(first, b).book.writers.get(seriesId);
            check(before && after && before.owner.equals(address(p.owner)) && after.owner.equals(before.owner) && first.tx.now >= before.expiry, 'writer identity');
            const amount = BigInt(p.amountRaw) < before.amounts.available + before.amounts.premium ? BigInt(p.amountRaw) : before.amounts.available + before.amounts.premium;
            const premium = amount < before.amounts.premium ? amount : before.amounts.premium, backing = amount - premium;
            check(amount > 0n && after.amounts.available === before.amounts.available - backing && after.amounts.premium === before.amounts.premium - premium, 'reserved writer amount');
            const match = one(events.filter(({ t, e }) => e.kind === 6 && e.amount === amount && e.intentId === 0n && e.tokenId === 0n && maybe(() => {
                if (backing === 0n)
                    return t.hash === first.hash;
                check(after.pending?.queryId === BigInt(p.queryId) && after.pending.backing === backing && after.pending.premium === premium, 'original pending withdrawal');
                const vb = vaultState(t, b, false).book.writers.get(seriesId), va = vaultState(t, b).book.writers.get(seriesId);
                check(vb?.pending && va && !va.pending && vb.owner.equals(before.owner) && vb.pending.queryId === BigInt(p.queryId) && vb.pending.backing === backing && vb.pending.premium === premium && va.released === before.released + backing, 'consumed pending withdrawal');
                const ack = input(t, p.factory).body.beginParse();
                check(ack.loadUint(32) === 0x4f57414b && ack.loadUintBig(64) === seriesId && ack.loadCoins() === va.released, 'factory release acknowledgement');
                ack.endParse();
                const factory = one(txs.filter(f => f.account === p.factory && f.succeeded && verifyCurrentT3MessageLink(first, f) && verifyCurrentT3MessageLink(f, t)));
                check(factory, 'release causal graph');
                factoryState(factory, b, false);
                factoryState(factory, b);
                return true;
            }) === true));
            if (!match)
                return { status: 'pending' };
            const paid = pay(match, p, b, txs, 'delivered');
            // Accounting acceptance releases only this request's reservation. It never
            // proves cash arrived and must remain visible until physical delivery.
            return paid.status === 'pending' ? { ...effect(p, match.t, 'accepted', amount), ...('transferOrigins' in paid ? { transferOrigins: paid.transferOrigins } : {}) } : paid;
        }
        check(p.tokenId === null, 'deposit scope');
        // Purchase/funding authorization always starts with the saved TEP74 transfer.
        const transfer = decodeTransfer(body);
        check(transfer.query === BigInt(p.queryId) && transfer.amount === BigInt(p.amountRaw) && transfer.owner === p.vault && transfer.response === p.owner && transfer.custom === null && transfer.forwardValue > 0n, 'funding transfer');
        const payload = transfer.payload.beginParse(), op = payload.loadUint(32);
        check(payload.loadUintBig(64) === BigInt(p.queryId) && payload.loadUintBig(64) === seriesId, 'funding identity');
        check(op === (p.kind === 'fund' ? OPTION_OP.FUND : OPTION_OP.BUY), 'funding operation');
        if (p.kind !== 'fund')
            check(p.notionalRaw !== null && payload.loadCoins() === BigInt(p.notionalRaw), 'funding notional');
        else
            check(p.notionalRaw === null, 'fund notional');
        payload.endParse();
        const vaultCredit = one(txs.filter(t => maybe(() => { delivery(first, t, transfer, b, p.owner, p.vault); return true; }) === true));
        if (!vaultCredit)
            return { status: 'pending' };
        const admitted = one(txs.filter(t => t.account === p.vault && t.succeeded && verifyCurrentT3MessageLink(vaultCredit, t)).filter(t => maybe(() => {
            const s = input(t, vaultCredit.account).body.beginParse();
            check(s.loadUint(32) === 0x7362d09c && s.loadUintBig(64) === BigInt(p.queryId) && s.loadCoins() === BigInt(p.amountRaw) && raw(s.loadAddress()) === p.owner && either(s).equals(transfer.payload), 'exact deposit notification');
            return true;
        }) === true));
        if (!admitted)
            return { status: 'pending' };
        const prev = vaultState(admitted, b, false), next = vaultState(admitted, b);
        const intents = [...next.book.intents].filter(([id, i]) => !prev.book.intents.has(id) && intentMatches(i, p));
        const selected = one(intents);
        if (!selected)
            return { status: 'pending' };
        const [intentId] = selected;
        const choices = events.filter(({ t, e }) => t.tx.lt > admitted.tx.lt && e.intentId === intentId && maybe(() => {
            const old = vaultState(t, b, false), newer = vaultState(t, b);
            check(intentMatches(old.book.intents.get(intentId), p) && !newer.book.intents.has(intentId), 'exact consumed deposit');
            return true;
        }) === true);
        const refund = one(choices.filter(x => x.e.kind === 3 && x.e.tokenId === 0n && x.e.amount === BigInt(p.amountRaw)));
        if (refund) {
            const cash = pay(refund, p, b, txs, 'refunded');
            return cash.status === 'pending' ? { ...effect(p, refund.t, 'accepted', refund.e.amount), stage: 'refund', ...('transferOrigins' in cash ? { transferOrigins: cash.transferOrigins } : {}) } : cash;
        }
        const accepted = one(choices.filter(x => x.e.kind === (p.kind === 'fund' ? 1 : 2) && x.e.amount === BigInt(p.amountRaw) && x.e.tokenId === (p.kind === 'fund' ? 0n : intentId)));
        if (!accepted)
            return { status: 'pending' };
        const factory = one(txs.filter(t => t.account === p.factory && t.succeeded && verifyCurrentT3MessageLink(t, accepted.t)));
        if (!factory)
            return { status: 'pending' };
        const fs = factoryState(factory, b), series = fs.series.get(seriesId);
        check(series && (p.series === null || p.series === raw(series.child)) && optionChildAddress(b.options.factory, seriesId, series.kind === 1 ? fs.shoutCode : fs.outperfCode).equals(series.child), 'series state');
        if (p.kind === 'fund') {
            const writer = vaultState(accepted.t, b).book.writers.get(seriesId);
            check(writer?.owner.equals(address(p.owner)) && writer.amounts.funded === BigInt(p.amountRaw) && series.writer.equals(writer.owner) && series.fundIntent === intentId && series.funded === writer.amounts.funded, 'writer backing acceptance');
            return effect(p, accepted.t, 'delivered', BigInt(p.amountRaw));
        }
        check((p.series === null || p.series === raw(series.child)) && optionChildAddress(b.options.factory, seriesId, series.kind === 1 ? fs.shoutCode : fs.outperfCode).equals(series.child), 'canonical option series');
        const position = series.positions.get(intentId), escrow = vaultState(accepted.t, b).book.escrows.get(seriesId << 64n | intentId);
        check(position && escrow && position.buyer.equals(address(p.owner)) && position.notional === BigInt(p.notionalRaw!) && position.net + position.fee === BigInt(p.amountRaw) && escrow.owner.equals(position.buyer) && escrow.queryId === BigInt(p.queryId) && escrow.net === position.net && escrow.fee === position.fee && escrow.locked === position.lock, 'position and custody');
        const child = one(txs.filter(t => t.account === raw(series.child) && t.succeeded && verifyCurrentT3MessageLink(t, factory)).filter(t => maybe(() => {
            currentT3ActiveState(t.before, series.kind === 1 ? b.options.shoutHash : b.options.outperfHash);
            const c = decodeOptionChild(currentT3ActiveState(t.after, series.kind === 1 ? b.options.shoutHash : b.options.outperfHash).data), cp = c.positions.get(intentId);
            check(c.factory.equals(b.options.factory) && c.seriesId === seriesId && cp?.owner.equals(address(p.owner)) && cp.notional === position.notional && cp.net === position.net && cp.lock === position.lock, 'child position');
            return true;
        }) === true));
        if (!child)
            return { status: 'pending' };
        return effect(p, accepted.t, 'accepted', BigInt(p.amountRaw), intentId);
    }
    catch {
        return { status: 'unavailable' };
    }
}
