import { Address, beginCell, Cell, storeStateInit } from '@ton/core';
import { businessBodyCell, bodyCell } from './wire';
import type { RawTransaction } from '../data/dataSource';
import type { LedgerStateSnapshot } from './archive';
import type { LedgerT3RedemptionBinding } from './bindings';
import type { Node, ProjectionInput } from './project';
import { canonicalLedgerHash } from './normalize';
import { readCurrentT3Hub, readCurrentT3Wallet, currentT3WalletAddress } from './currentT3State';
import { authenticT3Node, currentT3HubBoundary, currentT3ReceiptCommitted, currentT3OriginalBoundary } from './currentT3Proof';
import { t3ReceiptLog, t3Receipt, t3Attempt, t3Delivery, t3Burn, t3PathRoot, t3SameRequest } from './currentT3Wire';
async function cooperate(index: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (index % 16 === 0)
        await new Promise<void>(resolve => setImmediate(resolve));
    signal?.throwIfAborted();
}
function validSnapshot(snapshot: LedgerStateSnapshot | null, head: LedgerStateSnapshot, codeHash: string, previousSeqno = 0): snapshot is LedgerStateSnapshot {
    if (!snapshot || !Number.isSafeInteger(snapshot.seqno) || snapshot.seqno < previousSeqno || !Number.isSafeInteger(head.seqno) || snapshot.seqno > head.seqno || head.seqno < 0 || snapshot.state.accountState !== 'active' || !snapshot.state.codeBoc || !snapshot.state.dataBoc)
        return false;
    const code = Cell.fromBase64(snapshot.state.codeBoc);
    return !code.isExotic && code.hash().toString('hex') === codeHash;
}
export class SparseT3Tree {
    private levels = Array.from({ length: 65 }, () => new Map<bigint, Buffer>());
    private zero: Buffer[] = [beginCell().storeUint(0, 8).endCell().hash()];
    constructor(private domain = 3) {
        for (let i = 0; i < 64; i++)
            this.zero.push(this.pair(this.zero[i], this.zero[i]));
    }
    private pair(a: Buffer, b: Buffer) { return beginCell().storeUint(this.domain + 1, 8).storeBuffer(a).storeBuffer(b).endCell().hash(); }
    set(key: bigint, record: Cell) {
        if (key < 0n || key >= 1n << 64n)
            throw Error('invalid_receipt_key');
        this.levels[0].set(key, beginCell().storeUint(this.domain, 8).storeRef(record).endCell().hash());
        for (let i = 0; i < 64; i++) {
            const parent = key >> 1n;
            this.levels[i + 1].set(parent, this.pair(this.levels[i].get(parent << 1n) ?? this.zero[i], this.levels[i].get((parent << 1n) | 1n) ?? this.zero[i]));
            key = parent;
        }
    }
    get root() { return BigInt('0x' + (this.levels[64].get(0n) ?? this.zero[64]).toString('hex')); }
    proof(key: bigint) {
        const siblings: Buffer[] = [];
        for (let i = 0; i < 64; i++) {
            siblings.push(this.levels[i].get(key ^ 1n) ?? this.zero[i]);
            key >>= 1n;
        }
        let proof: Cell | null = null;
        for (let i = 63; i >= 0; i--)
            proof = beginCell().storeBuffer(siblings[i]).storeMaybeRef(proof).endCell();
        return proof!;
    }
}
export function currentT3ReceiptWitness(records: ReadonlyMap<bigint, Cell>, key: bigint) {
    const tree = new SparseT3Tree();
    for (const [k, c] of records)
        tree.set(k, c);
    return { root: tree.root, proof: tree.proof(key) };
}
export type CurrentT3ReceiptCandidate = {
    slot: number;
    key: string;
    recordBoc: string;
    recordHash: string;
    witnessBoc: string;
    owner: string;
    kind: 'credit' | 'burn';
    phase: number | null;
};
export type CurrentT3ReceiptResult = {
    status: 'ok';
    trees: Array<{
        slot: number;
        root: string;
        lastKey: string;
        records: CurrentT3ReceiptCandidate[];
    }>;
} | {
    status: 'unavailable';
    reason: string;
};
/** Original physical history is required. Missing external hints are recoverable
 * only when the retained records still reproduce every authenticated tree root.
 * These are current membership witnesses, never balance or payment evidence. */
export async function reconstructCurrentT3Receipts(input: {
    binding: LedgerT3RedemptionBinding;
    transactions: readonly RawTransaction[];
    currentState: LedgerStateSnapshot;
    stateAt: ProjectionInput['stateAt'];
    maxTransactions?: number;
    signal?: AbortSignal;
}): Promise<CurrentT3ReceiptResult> {
    try {
        input.signal?.throwIfAborted();
        const { binding, currentState } = input, transactions = [...input.transactions].sort((a, b) => BigInt(a.lt) < BigInt(b.lt) ? -1 : 1);
        const limit = input.maxTransactions ?? 100000;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000 || !transactions.length || transactions.length > limit)
            throw Error('history_unavailable_or_limit');
        const nodes = transactions.map(raw => ({ account: binding.hub, raw, id: `${binding.hub}:${raw.lt}:${raw.hash}` })), last = nodes.at(-1)!;
        if (transactions[0].prevTransactionLt !== '0' || BigInt('0x' + Buffer.from(canonicalLedgerHash(transactions[0].prevTransactionHash!), 'base64').toString('hex')) !== 0n)
            throw Error('history_start_missing');
        if (currentState.state.lastTxLt !== last.raw.lt || !currentState.state.lastTxHash || canonicalLedgerHash(currentState.state.lastTxHash) !== canonicalLedgerHash(last.raw.hash))
            throw Error('history_not_at_boundary');
        if (!validSnapshot(currentState, currentState, binding.hubCodeHash))
            throw Error('current_hub_identity_unavailable');
        const current = readCurrentT3Hub(currentState.state.dataBoc!);
        if (current.configHash !== binding.configHash)
            throw Error('current_config_mismatch');
        const records = Array.from({ length: 4 }, () => new Map<bigint, Cell>()), trees = Array.from({ length: 4 }, () => new SparseT3Tree());
        let previousSeqno = 0, finalDataHash: string | null = null;
        for (let i = 0; i < nodes.length; i++) {
            await cooperate(i, input.signal);
            const n = nodes[i];
            if (!authenticT3Node(n))
                throw Error('transaction_evidence_mismatch');
            if (i && (n.raw.prevTransactionLt !== nodes[i - 1].raw.lt || canonicalLedgerHash(n.raw.prevTransactionHash!) !== canonicalLedgerHash(nodes[i - 1].raw.hash)))
                throw Error('history_gap');
            const after = await input.stateAt(binding.hub, n.raw.lt, n.raw.hash);
            if (!validSnapshot(after, currentState, binding.hubCodeHash, previousSeqno) || after.state.lastTxLt !== n.raw.lt || !after.state.lastTxHash || canonicalLedgerHash(after.state.lastTxHash) !== canonicalLedgerHash(n.raw.hash))
                throw Error('historical_code_unavailable');
            const before = await input.stateAt(binding.hub, n.raw.prevTransactionLt!, n.raw.prevTransactionHash!);
            if (!before)
                throw Error('original_state_boundary_unavailable');
            currentT3OriginalBoundary(n, before, after);
            previousSeqno = after.seqno;
            const state = readCurrentT3Hub(after.state.dataBoc!);
            finalDataHash = state.dataHash;
            if (state.configHash !== binding.configHash)
                throw Error('historical_config_mismatch');
            const logs = n.raw.outMessages.map(t3ReceiptLog).filter((r): r is NonNullable<typeof r> => !!r);
            if (logs.length) {
                const boundary = await currentT3HubBoundary({ stateAt: input.stateAt } as ProjectionInput, n, binding);
                if (!boundary)
                    throw Error('receipt_state_boundary_unavailable');
                for (const r of logs) {
                    if (!currentT3ReceiptCommitted(r, n, boundary))
                        throw Error('receipt_commitment_mismatch');
                    records[r.slot].set(r.key, r.cell);
                    trees[r.slot].set(r.key, r.cell);
                }
            }
            for (let slot = 0; slot < 4; slot++)
                if (trees[slot].root !== state.trees[slot].root)
                    throw Error('receipt_history_incomplete');
        }
        if (finalDataHash !== current.dataHash)
            throw Error('current_hub_state_mismatch');
        const result: Extract<CurrentT3ReceiptResult, {
            status: 'ok';
        }>['trees'] = [];
        for (let slot = 0; slot < 4; slot++) {
            const candidates: CurrentT3ReceiptCandidate[] = [];
            for (const [key, record] of records[slot]) {
                await cooperate(candidates.length, input.signal);
                const r = t3Receipt(slot, record), proof = trees[slot].proof(key);
                candidates.push({ slot, key: String(key), recordBoc: record.toBoc().toString('base64'), recordHash: record.hash().toString('hex'), witnessBoc: beginCell().storeRef(record).storeRef(proof).endCell().toBoc().toString('base64'), owner: r.kind === 'credit' ? r.credit.owner : r.attempt.owner, kind: r.kind, phase: r.kind === 'credit' ? r.phase : null });
            }
            result.push({ slot, root: current.trees[slot].root.toString(16).padStart(64, '0'), lastKey: String(current.trees[slot].lastKey), records: candidates });
        }
        return { status: 'ok', trees: result };
    }
    catch (error) {
        input.signal?.throwIfAborted();
        return { status: 'unavailable', reason: error instanceof Error ? error.message : 'receipt_history_unavailable' };
    }
}
export type CurrentT3WalletClaim = {
    id: string;
    recordBoc: string;
    recordHash: string;
    proofBoc: string;
    failed: boolean;
    cancelled: boolean;
    attempt: string;
    originLt: string;
    owner: string;
    recipient: string;
    queryId: string;
    amountRaw: string;
    burn: boolean;
};
export type CurrentT3WalletClaimsResult = {
    status: 'ok';
    wallet: string;
    owner: string;
    root: string;
    count: string;
    records: CurrentT3WalletClaim[];
    failureRoot: string;
    failureCount: string;
    failures: Array<{
        index: string;
        evidenceBoc: string;
        proofBoc: string;
        attemptHash: string;
    }>;
} | {
    status: 'unavailable';
    reason: string;
};
export async function reconstructCurrentT3WalletClaims(input: {
    binding: Pick<LedgerT3RedemptionBinding, 'hub' | 'walletCodeHash' | 'proofCodeHash'>;
    wallet: string;
    owner: string;
    transactions: readonly RawTransaction[];
    currentState: LedgerStateSnapshot;
    stateAt: ProjectionInput['stateAt'];
    maxTransactions?: number;
    signal?: AbortSignal;
}): Promise<CurrentT3WalletClaimsResult> {
    try {
        input.signal?.throwIfAborted();
        const { binding, wallet, owner, currentState } = input, transactions = [...input.transactions].sort((a, b) => BigInt(a.lt) < BigInt(b.lt) ? -1 : 1);
        const limit = input.maxTransactions ?? 100000;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000 || !transactions.length || transactions.length > limit)
            throw Error('history_unavailable_or_limit');
        if (transactions[0].prevTransactionLt !== '0' || Buffer.from(canonicalLedgerHash(transactions[0].prevTransactionHash!), 'base64').some(n => n !== 0))
            throw Error('history_start_missing');
        const last = transactions.at(-1)!;
        if (currentState.state.lastTxLt !== last.lt || !currentState.state.lastTxHash || canonicalLedgerHash(currentState.state.lastTxHash) !== canonicalLedgerHash(last.hash))
            throw Error('history_not_at_boundary');
        if (!validSnapshot(currentState, currentState, binding.walletCodeHash))
            throw Error('current_wallet_identity_unavailable');
        const records = new Map<bigint, Cell>(), tree = new SparseT3Tree(), failureTree = new SparseT3Tree(1), failures: Cell[] = [];
        let previousRoot = tree.root, previousSeqno = 0, current: ReturnType<typeof readCurrentT3Wallet> | null = null;
        let previousShard: Cell | null = null, lastActiveInit: Cell | null = null, lastOriginalActive = false;
        const record = (cell: Cell) => {
            if (cell.isExotic)
                throw Error('exotic_wallet_record');
            const s = cell.beginParse(), failed = s.loadBit(), cancelled = s.loadBit(), attempt = t3Attempt(s.loadRef());
            s.endParse();
            return { failed, cancelled, attempt };
        };
        const put = (attempt: ReturnType<typeof t3Attempt>, failed = false, cancelled = false) => { const cell = beginCell().storeBit(failed).storeBit(cancelled).storeRef(attempt.cell).endCell(); records.set(attempt.id, cell); tree.set(attempt.id, cell); };
        for (let i = 0; i < transactions.length; i++) {
            await cooperate(i, input.signal);
            const raw = transactions[i], node: Node = { account: wallet, raw, id: `${wallet}:${raw.lt}:${raw.hash}` };
            if (!authenticT3Node(node))
                throw Error('transaction_evidence_mismatch');
            if (i && (raw.prevTransactionLt !== transactions[i - 1].lt || canonicalLedgerHash(raw.prevTransactionHash!) !== canonicalLedgerHash(transactions[i - 1].hash)))
                throw Error('history_gap');
            const after = await input.stateAt(wallet, raw.lt, raw.hash);
            const frozen = after?.state.accountState === 'frozen' && !after.state.codeBoc && !after.state.dataBoc;
            if (!after || !Number.isSafeInteger(after.seqno) || after.seqno < previousSeqno || after.seqno > currentState.seqno
                || (!frozen && !validSnapshot(after, currentState, binding.walletCodeHash, previousSeqno))
                || after.state.lastTxLt !== raw.lt || !after.state.lastTxHash || canonicalLedgerHash(after.state.lastTxHash) !== canonicalLedgerHash(raw.hash))
                throw Error('wallet_state_unavailable');
            const before = await input.stateAt(wallet, raw.prevTransactionLt!, raw.prevTransactionHash!);
            if (!before)
                throw Error('original_state_boundary_unavailable');
            const physical = currentT3OriginalBoundary(node, before, after);
            if (previousShard && !previousShard.equals(Cell.fromBase64(before.state.shardAccountBoc!)))
                throw Error('wallet_original_state_gap');
            previousShard = Cell.fromBase64(after.state.shardAccountBoc!);
            previousSeqno = after.seqno;
            const priorStorage = physical.before.account?.storage.state, storage = physical.after.account?.storage.state;
            lastOriginalActive = storage?.type === 'active';
            if (priorStorage?.type === 'frozen') {
                if (!lastActiveInit || BigInt('0x' + lastActiveInit.hash().toString('hex')) !== priorStorage.stateHash)
                    throw Error('frozen_wallet_commitment_mismatch');
                if (storage?.type === 'active') {
                    const init = physical.tx.inMessage?.init;
                    if (!init || !beginCell().store(storeStateInit(init)).endCell().equals(lastActiveInit))
                        throw Error('frozen_wallet_thaw_mismatch');
                }
            }
            if (storage?.type === 'frozen') {
                // No frozen row is omitted. Its original state commitment must
                // preserve the last authenticated code/data, and no VM action
                // may have changed either sparse tree while execution skipped.
                if (!lastActiveInit || BigInt('0x' + lastActiveInit.hash().toString('hex')) !== storage.stateHash
                    || physical.succeeded || physical.tx.description.type !== 'generic' || physical.tx.description.computePhase.type !== 'skipped')
                    throw Error('frozen_wallet_commitment_mismatch');
                continue;
            }
            if (storage?.type !== 'active') throw Error('wallet_state_unavailable');
            lastActiveInit = beginCell().store(storeStateInit(storage.state)).endCell();
            const code = Cell.fromBase64(after.state.codeBoc!);
            if (code.isExotic || code.hash().toString('hex') !== binding.walletCodeHash || currentT3WalletAddress(Address.parse(owner), Address.parse(binding.hub), binding.proofCodeHash, code) !== wallet)
                throw Error('wallet_code_or_address_mismatch');
            current = readCurrentT3Wallet(after.state.dataBoc!);
            if (current.owner !== owner || current.master !== binding.hub || current.proofCodeHash !== binding.proofCodeHash)
                throw Error('wallet_config_mismatch');
            if (raw.success) {
                if (raw.inMessage?.bounced) {
                    const body = bodyCell(raw.inMessage);
                    if (body && !body.isExotic && [73, 137].includes(body.bits.length) && body.refs.length === 2) {
                        const s = body.beginParse();
                        if (s.loadUint(32) === 0xfffffffe) {
                            const original = s.loadRef(), info = s.loadRef().beginParse();
                            info.loadCoins();
                            if (info.loadBit())
                                info.loadRef();
                            info.loadUintBig(64);
                            info.loadUint(32);
                            info.endParse();
                            s.loadUint(8);
                            s.loadInt(32);
                            if (s.loadBit()) {
                                s.loadUint(32);
                                s.loadUint(32);
                            }
                            s.endParse();
                            const a = original.beginParse(), op = a.loadUint(32);
                            if ([0x5433444c, 0x54335742].includes(op)) {
                                const attempt = t3Attempt(a.loadRef());
                                a.endParse();
                                const evidence = beginCell().storeAddress(Address.parse(wallet)).storeRef(attempt.cell).endCell();
                                failureTree.set(BigInt(failures.length), evidence);
                                failures.push(evidence);
                            }
                        }
                    }
                }
                else {
                    const body = businessBodyCell(raw.inMessage), s = body?.beginParse(), op = s && s.remainingBits >= 32 ? s.loadUint(32) : null;
                    if (op !== null && [0x5433574b, 0x54335759, 0x54335758, 0x54334643].includes(op)) {
                        let payload = s!;
                        if (op === 0x54334643) {
                            payload.loadRef();
                            const p = payload.loadRef();
                            payload.loadRef();
                            payload.endParse();
                            payload = p.beginParse();
                        }
                        const priorCell = payload.loadRef(), proof = payload.loadRef(), prior = record(priorCell);
                        if (!records.get(prior.attempt.id)?.equals(priorCell) || t3PathRoot(prior.attempt.id, priorCell, proof) !== previousRoot)
                            throw Error('wallet_record_history_mismatch');
                        if (op === 0x54335758)
                            put(prior.attempt, false, true);
                        else if (op !== 0x54335759)
                            put(prior.attempt, true, false);
                    }
                    for (const outgoing of raw.outMessages) {
                        const attempt = t3Delivery(outgoing) ?? t3Burn(outgoing);
                        if (!attempt)
                            continue;
                        if (attempt.owner !== owner || attempt.amount <= 0n)
                            throw Error('wallet_attempt_mismatch');
                        if (attempt.attempt === 0n && (attempt.id !== BigInt(records.size) || attempt.originLt !== BigInt(raw.lt)))
                            throw Error('wallet_append_history_mismatch');
                        if (attempt.attempt > 0n) {
                            const old = records.get(attempt.id);
                            const prior = old ? record(old).attempt : null;
                            if (!prior || prior.attempt + 1n !== attempt.attempt || !t3SameRequest(prior, attempt))
                                throw Error('wallet_retry_history_mismatch');
                        }
                        put(attempt);
                    }
                }
            }
            if (current.nextId !== BigInt(records.size) || current.root !== tree.root || current.failureCount !== BigInt(failures.length) || current.failureRoot !== (failures.length ? failureTree.root : 0n))
                throw Error('wallet_history_commitment_mismatch');
            previousRoot = tree.root;
        }
        if (!current || !lastOriginalActive || !currentState.state.shardAccountBoc
            || !previousShard?.equals(Cell.fromBase64(currentState.state.shardAccountBoc))
            || !currentState.state.dataBoc || readCurrentT3Wallet(currentState.state.dataBoc).dataHash !== current.dataHash)
            throw Error('current_wallet_state_mismatch');
        const claims: CurrentT3WalletClaim[] = [], failureClaims: Extract<CurrentT3WalletClaimsResult, {
            status: 'ok';
        }>['failures'] = [];
        for (const [id, cell] of records) {
            await cooperate(claims.length, input.signal);
            const r = record(cell), a = r.attempt;
            claims.push({ id: String(id), recordBoc: cell.toBoc().toString('base64'), recordHash: cell.hash().toString('hex'), proofBoc: tree.proof(id).toBoc().toString('base64'), failed: r.failed, cancelled: r.cancelled, attempt: String(a.attempt), originLt: String(a.originLt), owner: a.owner, recipient: a.recipient, queryId: String(a.queryId), amountRaw: String(a.amount), burn: a.burn });
        }
        for (const [index, cell] of failures.entries()) {
            await cooperate(index, input.signal);
            failureClaims.push({ index: String(index), evidenceBoc: cell.toBoc().toString('base64'), proofBoc: failureTree.proof(BigInt(index)).toBoc().toString('base64'), attemptHash: cell.refs[0].hash().toString('hex') });
        }
        return { status: 'ok', wallet, owner, root: tree.root.toString(16).padStart(64, '0'), count: String(records.size), records: claims, failureRoot: current.failureRoot.toString(16).padStart(64, '0'), failureCount: String(failures.length), failures: failureClaims };
    }
    catch (error) {
        input.signal?.throwIfAborted();
        return { status: 'unavailable', reason: error instanceof Error ? error.message : 'wallet_history_unavailable' };
    }
}
