import { Address, Cell, Dictionary, beginCell } from '@ton/core';
import { activeOrderAccount, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalPhysicalMessage } from '../runtime/physicalEvidence';
import { decodeOptionVault, decodeOptionFactory } from './currentOptionsState';
import { inspectNativeOptionEvidence, verifyCurrentOptionTransaction, type NativeOptionEvidenceRequest, type NativeOptionProofBinding, type NativeOptionEvidence } from './currentOptionsProof';
import { t3Attempt } from './currentT3Wire';
/** Owner request tags understood by this decoder; internal controller messages
 * do not enroll arbitrary observed contracts or qualify a settlement. */
export const CURRENT_OPTIONS_USER_OPS = new Set([0x4f564259, 0x4f564644, 0x4f535757, 0x434c4d4a, 0x46455843, 0x4f464558]);
export type CurrentOptionsCashLeg = {
    direction: 'in' | 'out';
    amountRaw: string;
    ownerTransaction: string;
    debitTransaction: string;
    creditTransaction: string;
    wallet: string;
    otherOwner: string;
};
export type CurrentOptionsEconomics = {
    kind: NativeOptionEvidenceRequest['kind'];
    outcome: 'unresolved' | 'rejected' | 'accepted' | 'delivered' | 'refunded';
    factory: string;
    vault: string;
    owner: string;
    seriesId: string;
    positionId: string | null;
    queryId: string;
    requestBodyHash: string;
    dispatch: {
        lt: string;
        hash: string;
    };
    amountRequestedRaw: string;
    premiumNetRaw: string;
    protocolFeeRaw: string;
    writerBackingRaw: string;
    writerPremiumRaw: string;
    rightAcquiredRaw: string;
    rightRetiredRaw: string;
    paidInRaw: string;
    paidOutRaw: string;
    pendingOutRaw: string;
    aggregateOwed: boolean;
    cash: CurrentOptionsCashLeg[];
    evidenceHashes: string[];
};
export type CurrentOptionsOperation = {
    request: NativeOptionEvidenceRequest;
    proof: NativeOptionEvidence;
    economics: CurrentOptionsEconomics;
};
type Tx = ReturnType<typeof verifyOrderTransaction> & {
    account: string;
};
const raw = (a: Address | null | undefined) => a?.toRawString() ?? null;
const one = <T>(rows: T[]) => rows.length === 1 ? rows[0] : null;
const maybe = <T>(fn: () => T) => { try {
    return fn();
}
catch {
    return null;
} };
function need(v: unknown): asserts v { if (!v)
    throw Error('Current Options ledger identity mismatch'); }
const messageHashes = new WeakMap<object, {
    incoming: string | null;
    outgoing: Set<string>;
}>();
function cachedMessages(t: Tx) { let value = messageHashes.get(t); if (!value) {
    value = { incoming: t.incoming ? canonicalPhysicalMessage(t.incoming).hash().toString('hex') : null, outgoing: new Set(t.outgoing.values().map(c => canonicalPhysicalMessage(c).hash().toString('hex'))) };
    messageHashes.set(t, value);
} return value; }
function linked(a: Tx, b: Tx) { if (b.tx.lt <= a.tx.lt)
    return false; const incoming = cachedMessages(b).incoming; return incoming !== null && cachedMessages(a).outgoing.has(incoming); }
function descendants(first: Tx, txs: Tx[]) { const reached = new Set([first.hash]); for (const t of txs)
    if (txs.some(a => reached.has(a.hash) && linked(a, t)))
        reached.add(t.hash); return reached; }
function vault(t: Tx, b: NativeOptionProofBinding, after = false) { need(t.account === raw(b.options.vault)); return decodeOptionVault(activeOrderAccount(after ? t.after : t.before, b.options.vaultHash).data); }
function factory(t: Tx, b: NativeOptionProofBinding, after = false) { need(t.account === raw(b.options.factory)); return decodeOptionFactory(activeOrderAccount(after ? t.after : t.before, b.options.factoryHash).data); }
function either(s: ReturnType<Cell['beginParse']>) { if (s.loadBit()) {
    const c = s.loadRef();
    s.endParse();
    return c;
} return beginCell().storeSlice(s).endCell(); }
function inferred(t: Tx, m: ReturnType<Tx['tx']['outMessages']['values']>[number], txs: Tx[], b: NativeOptionProofBinding): NativeOptionEvidenceRequest | null {
    try {
        if (!t.succeeded || m.info.type !== 'internal' || m.info.bounced || m.body.isExotic || m.body.bits.length < 32)
            return null;
        const owner = t.account, target = raw(m.info.dest), s = m.body.beginParse(), op = s.loadUint(32), f = raw(b.options.factory)!, v = raw(b.options.vault)!;
        const first = one(txs.filter(n => n.account === target && linked(t, n) && n.tx.inMessage?.body.equals(m.body)));
        if (!first)
            return null;
        let kind: NativeOptionEvidenceRequest['kind'], query = 0n, series = 0n, amount = 0n, notional: bigint | null = null, token: bigint | null = null, sourceWallet: string | null = null;
        if (op === 0x0f8a7ea5) {
            query = s.loadUintBig(64);
            amount = s.loadCoins();
            if (raw(s.loadAddress()) !== v || raw(s.loadMaybeAddress()) !== owner || s.loadMaybeRef() || s.loadCoins() === 0n)
                return null;
            const p = either(s).beginParse(), intent = p.loadUint(32);
            if (![0x4f564259, 0x4f564644].includes(intent) || p.loadUintBig(64) !== query)
                return null;
            kind = intent === 0x4f564259 ? 'buy' : 'fund';
            series = p.loadUintBig(64);
            if (kind === 'buy')
                notional = p.loadCoins();
            p.endParse();
            sourceWallet = target;
        }
        else if (op === 0x4f535757 && target === v) {
            kind = 'withdraw';
            query = s.loadUintBig(64);
            series = s.loadUintBig(64);
            amount = s.loadCoins();
            s.endParse();
        }
        else if (op === 0x434c4d4a && target === v) {
            kind = 'owed';
            query = s.loadUintBig(64);
            if (s.loadUint(8) !== 0 || raw(s.loadAddress()) !== owner)
                return null;
            s.endParse();
            const owed = vault(first, b).owed;
            if (!owed)
                return null;
            const slots = Dictionary.loadDirect(Dictionary.Keys.Uint(8), { serialize() { throw Error('Read only'); }, parse(p) { p.loadCoins(); p.loadUint(16); const entries = p.loadDict(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)); p.loadMaybeRef(); p.endParse(); return entries; } }, owed);
            amount = slots.get(0)?.get(Address.parse(owner)) ?? 0n;
            if (amount <= 0n)
                return null;
        }
        else if ([0x46455843, 0x4f464558].includes(op) && target === f) {
            kind = 'payout';
            if (op === 0x4f464558)
                s.loadUintBig(64);
            series = s.loadUintBig(64);
            token = s.loadUintBig(64);
            if (op === 0x4f464558)
                amount = s.loadCoins();
            s.endParse();
            const pos = factory(first, b).series.get(series)?.positions.get(token);
            if (!pos || raw(pos.buyer) !== owner)
                return null;
            const queries = new Set(txs.filter(n => n.account === v).flatMap(n => [false, true].flatMap(after => { const e = maybe(() => vault(n, b, after).book.escrows.get(series << 64n | token!)); return e && raw(e.owner) === owner ? [e.queryId.toString()] : []; })));
            if (queries.size !== 1)
                return null;
            query = BigInt([...queries][0]);
        }
        else
            return null;
        if ((kind !== 'owed' && series === 0n) || (['buy', 'fund', 'withdraw'].includes(kind) && amount === 0n))
            return null;
        return { network: b.network, releaseId: b.releaseId, manifestHash: b.manifestHash, kind, owner, factory: f, vault: v, series: null, seriesId: String(series), queryId: String(query), amountRaw: String(amount), notionalRaw: notional === null ? null : String(notional), tokenId: token === null ? null : String(token), sourceWallet, bodyBoc: m.body.toBoc().toString('base64'), bodyHash: m.body.hash().toString('hex'), valueNano: String(m.info.value.coins), createdAt: t.tx.now * 1000, dispatch: { lt: String(t.tx.lt), hash: t.hash, valueNano: String(m.info.value.coins) } };
    }
    catch {
        return null;
    }
}
/** Discover requests only from the selected owner's original outgoing messages.
 * A full current fixture can contain other users and earlier operations; neither
 * query IDs alone nor the fixture's saved browser request select a ledger event. */
export function decodeCurrentOptionsOperations(owner: string, b: NativeOptionProofBinding, evidence: readonly OrderTransactionEvidence[]): CurrentOptionsOperation[] {
    const txs = evidence.map(verifyCurrentOptionTransaction).sort((a, b) => a.tx.lt < b.tx.lt ? -1 : a.tx.lt > b.tx.lt ? 1 : a.hash.localeCompare(b.hash));
    need(txs.length <= 10000 && new Set(txs.map(t => t.hash)).size === txs.length);
    const requests = txs.filter(t => t.account === owner).flatMap(t => t.tx.outMessages.values().flatMap(m => { const p = inferred(t, m, txs, b); return p ? [p] : []; }));
    return requests.map(request => {
        const origin = txs.find(t => t.hash === request.dispatch.hash)!, causal = descendants(origin, txs);
        // Earlier unrelated setup cannot exhaust a later operation's bounded proof.
        // Every original envelope at/after dispatch remains eligible, so repeated
        // queries or later conflicting events are never silently selected away.
        const operationEvidence = evidence.filter(e => verifyCurrentOptionTransaction(e).tx.lt >= origin.tx.lt);
        const proof = inspectNativeOptionEvidence(request, b, operationEvidence);
        const end = 'transactionHash' in proof ? txs.find(t => t.hash === proof.transactionHash) : undefined;
        if (end && !causal.has(end.hash)) {
            const ancestors = new Set([end.hash]);
            for (const t of [...txs].reverse())
                if (txs.some(a => ancestors.has(a.hash) && linked(t, a)))
                    ancestors.add(t.hash);
            for (const h of ancestors)
                causal.add(h);
        }
        const result: CurrentOptionsEconomics = { kind: request.kind, outcome: proof.status === 'unavailable' || proof.status === 'pending' ? 'unresolved' : proof.status,
            factory: request.factory, vault: request.vault, owner, seriesId: request.seriesId, positionId: 'positionId' in proof ? proof.positionId ?? request.tokenId : request.tokenId, queryId: request.queryId, requestBodyHash: request.bodyHash, dispatch: { lt: request.dispatch.lt, hash: request.dispatch.hash }, amountRequestedRaw: request.amountRaw,
            premiumNetRaw: '0', protocolFeeRaw: '0', writerBackingRaw: '0', writerPremiumRaw: '0', rightAcquiredRaw: '0', rightRetiredRaw: '0', paidInRaw: '0', paidOutRaw: '0', pendingOutRaw: '0', aggregateOwed: request.kind === 'owed', cash: [], evidenceHashes: [...causal] };
        if (!end || !('amountRaw' in proof))
            return { request, proof, economics: result };
        const first = one(txs.filter(n => linked(origin, n) && (request.kind === 'buy' || request.kind === 'fund' ? n.account === request.sourceWallet : n.account === (request.kind === 'payout' ? request.factory : request.vault))));
        need(first);
        const credited = (target: Tx, direction: 'in' | 'out') => {
            const m = target.tx.inMessage;
            if (m?.info.type !== 'internal' || m.body.bits.length !== 32 || m.body.refs.length !== 1 || m.body.beginParse().preloadUint(32) !== 0x5433444c)
                return;
            const a = t3Attempt(m.body.refs[0]), sourceAddress = m.info.src.toRawString(), source = txs.find(t => t.account === sourceAddress && t.tx.lt === a.originLt);
            need(source);
            const wallet = direction === 'in' ? target : source;
            result.cash.push({ direction, amountRaw: String(a.amount), ownerTransaction: wallet.hash, debitTransaction: source.hash, creditTransaction: target.hash, wallet: wallet.account, otherOwner: direction === 'in' ? a.owner : a.recipient });
        };
        if (request.kind === 'buy' || request.kind === 'fund') {
            const credit = one(txs.filter(t => linked(first, t) && maybe(() => { const m = t.tx.inMessage; need(m?.info.type === 'internal' && m.body.beginParse().loadUint(32) === 0x5433444c); const a = t3Attempt(m.body.refs[0]); return a.owner === owner && a.recipient === request.vault && a.amount === BigInt(request.amountRaw); }) === true));
            if (credit) {
                credited(credit, 'out');
                result.paidInRaw = request.amountRaw;
            }
            if (request.kind === 'buy' && proof.status === 'accepted' && proof.stage !== 'refund') {
                const id = BigInt(proof.positionId!), escrow = vault(end, b, true).book.escrows.get(BigInt(request.seriesId) << 64n | id);
                need(escrow);
                result.rightAcquiredRaw = request.notionalRaw!;
                result.premiumNetRaw = String(escrow.net);
                result.protocolFeeRaw = String(escrow.fee);
                result.writerBackingRaw = String(escrow.locked);
            }
            else if (request.kind === 'fund' && proof.status === 'delivered')
                result.writerBackingRaw = request.amountRaw;
            if (proof.status === 'refunded') {
                result.paidOutRaw = proof.amountRaw;
                credited(end, 'in');
            }
            else if (proof.status === 'accepted' && proof.stage === 'refund')
                result.pendingOutRaw = proof.amountRaw;
        }
        else {
            if (request.kind === 'payout' && proof.status !== 'rejected') {
                const p = factory(first, b).series.get(BigInt(request.seriesId))?.positions.get(BigInt(request.tokenId!));
                need(p);
                result.rightRetiredRaw = String(p.notional);
                result.premiumNetRaw = String(p.net);
                result.protocolFeeRaw = String(p.fee);
                result.writerBackingRaw = String(p.lock);
            }
            if (request.kind === 'withdraw') {
                const writer = vault(first, b).book.writers.get(BigInt(request.seriesId));
                need(writer);
                const amount = BigInt(proof.amountRaw), premium = amount < writer.amounts.premium ? amount : writer.amounts.premium;
                result.writerPremiumRaw = String(premium);
                result.writerBackingRaw = String(amount - premium);
            }
            if (proof.status === 'delivered' || proof.status === 'refunded') {
                result.paidOutRaw = proof.amountRaw;
                if (proof.amountRaw !== '0')
                    credited(end, 'in');
            }
            else if (proof.status === 'accepted')
                result.pendingOutRaw = proof.amountRaw;
        }
        return { request, proof, economics: result };
    });
}
