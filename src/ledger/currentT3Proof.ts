import { isDeepStrictEqual } from 'node:util';
import { Address, Cell, beginCell, storeStateInit } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import type { LedgerStateSnapshot } from './archive';
import type { Node, ProjectionInput } from './project';
import { canonicalLedgerHash } from './normalize';
import { businessBodyCell } from './wire';
import { readCurrentT3Hub, readCurrentT3Wallet } from './currentT3State';
import { t3Leaf, t3PathRoot, type t3Receipt } from './currentT3Wire';
import type { LedgerT3RedemptionBinding } from './bindings';
import { verifyOrderTransaction } from '../orders/evidence';
export function authenticT3Node(node: Node) {
    try {
        if (!node.raw.rawBoc)
            return false;
        const raw = decodeOriginalTransaction(Cell.fromBase64(node.raw.rawBoc), Address.parse(node.account));
        return isDeepStrictEqual(JSON.parse(JSON.stringify(raw)), JSON.parse(JSON.stringify(node.raw)));
    }
    catch {
        return false;
    }
}
function match(snapshot: LedgerStateSnapshot | null, lt: string, hash: string, codeHash: string, cold = false, frozen = false) {
    if (!snapshot || !Number.isSafeInteger(snapshot.seqno) || snapshot.seqno < 0 || snapshot.state.lastTxLt !== lt || !snapshot.state.lastTxHash || canonicalLedgerHash(snapshot.state.lastTxHash) !== canonicalLedgerHash(hash))
        return false;
    const s = snapshot.state;
    if (cold && s.accountState === 'uninitialized' && !s.codeBoc && !s.dataBoc)
        return true;
    if (frozen && s.accountState === 'frozen' && !s.codeBoc && !s.dataBoc)
        return true;
    return s.accountState === 'active' && !!s.codeBoc && !!s.dataBoc && !Cell.fromBase64(s.codeBoc).isExotic && Cell.fromBase64(s.codeBoc).hash().toString('hex') === codeHash;
}
export function currentT3OriginalBoundary(node: Node, before: LedgerStateSnapshot, after: LedgerStateSnapshot) {
    if (!authenticT3Node(node) || !before.state.shardAccountBoc || !after.state.shardAccountBoc)
        throw Error('original_state_boundary_unavailable');
    if (!Number.isSafeInteger(before.seqno) || before.seqno < 0 || !Number.isSafeInteger(after.seqno) || after.seqno < before.seqno)
        throw Error('state_boundary_seqno_mismatch');
    const physical = verifyOrderTransaction({ account: node.account, transactionBoc: node.raw.rawBoc!, beforeShardAccountBoc: before.state.shardAccountBoc, afterShardAccountBoc: after.state.shardAccountBoc });
    for (const [snapshot, shard] of [[before, physical.before], [after, physical.after]] as const) {
        const state = shard.account?.storage.state;
        if (snapshot.state.lastTxLt !== String(shard.lastTransactionLt) || !snapshot.state.lastTxHash || canonicalLedgerHash(snapshot.state.lastTxHash) !== Buffer.from(shard.lastTransactionHash.toString(16).padStart(64, '0'), 'hex').toString('base64'))
            throw Error('state_snapshot_cursor_mismatch');
        if (snapshot.state.accountState !== (state?.type === 'active' ? 'active' : state?.type === 'frozen' ? 'frozen' : 'uninitialized') || snapshot.state.balance !== (shard.account?.storage.balance.coins ?? 0n).toString())
            throw Error('state_snapshot_mismatch');
        if (state?.type === 'active' && (!state.state.code || !state.state.data || !snapshot.state.codeBoc || !snapshot.state.dataBoc || !state.state.code.equals(Cell.fromBase64(snapshot.state.codeBoc)) || !state.state.data.equals(Cell.fromBase64(snapshot.state.dataBoc))))
            throw Error('state_snapshot_mismatch');
        if (state?.type !== 'active' && (snapshot.state.codeBoc || snapshot.state.dataBoc))
            throw Error('state_snapshot_mismatch');
    }
    return physical;
}
export async function currentT3Boundary(input: ProjectionInput, node: Node, codeHash: string, cold = false, frozen = false) {
    try {
        if (!authenticT3Node(node) || !node.raw.success || node.raw.inMessage?.bounced || !node.raw.prevTransactionLt || !node.raw.prevTransactionHash)
            return null;
        const before = await input.stateAt(node.account, node.raw.prevTransactionLt, node.raw.prevTransactionHash), after = await input.stateAt(node.account, node.raw.lt, node.raw.hash);
        if (!match(before, node.raw.prevTransactionLt, node.raw.prevTransactionHash, codeHash, cold, frozen) || !match(after, node.raw.lt, node.raw.hash, codeHash) || before!.seqno > after!.seqno)
            return null;
        const physical = currentT3OriginalBoundary(node, before!, after!);
        if (!physical.succeeded)
            return null;
        let frozenData: Cell | null = null;
        if (before!.state.accountState === 'frozen') {
            const state = physical.before.account?.storage.state, init = physical.tx.inMessage?.init;
            if (state?.type !== 'frozen' || !init?.code || !init.data || init.code.isExotic || init.data.isExotic || init.code.hash().toString('hex') !== codeHash || BigInt('0x' + beginCell().store(storeStateInit(init)).endCell().hash().toString('hex')) !== state.stateHash)
                return null;
            frozenData = init.data;
        }
        return { before: before!, after: after!, frozenData };
    }
    catch {
        return null;
    }
}
export async function currentT3HubBoundary(input: ProjectionInput, node: Node, binding: LedgerT3RedemptionBinding) {
    try {
        const boundary = await currentT3Boundary(input, node, binding.hubCodeHash);
        if (!boundary || node.account !== binding.hub)
            return null;
        const before = readCurrentT3Hub(boundary.before.state.dataBoc!), after = readCurrentT3Hub(boundary.after.state.dataBoc!);
        for (const s of [before, after])
            if (s.configHash !== binding.configHash || s.walletCodeHash !== binding.walletCodeHash || s.proofCodeHash !== binding.proofCodeHash || s.governance !== binding.governance || binding.reserveRoutes.some(r => { const slot = s.slots.get(r.slot), p = s.policies.get(r.slot); return !slot || !p || slot.master !== r.root || (slot.wallet !== r.vault && !(r.slot === 2 && slot.wallet === null)) || p.scale !== r.scale || p.codeHash !== r.walletCodeHash; }))
                return null;
        return { ...boundary, beforeState: before, afterState: after };
    }
    catch {
        return null;
    }
}
export async function currentT3WalletDelta(input: ProjectionInput, node: Node, binding: LedgerT3RedemptionBinding, owner: string, delta: bigint) {
    try {
        const boundary = await currentT3Boundary(input, node, binding.walletCodeHash, true, true);
        if (!boundary)
            return null;
        const a = readCurrentT3Wallet(boundary.after.state.dataBoc!), b = boundary.before.state.dataBoc ? readCurrentT3Wallet(boundary.before.state.dataBoc) : boundary.frozenData ? readCurrentT3Wallet(boundary.frozenData) : null;
        if (a.owner !== owner || a.master !== binding.hub || a.proofCodeHash !== binding.proofCodeHash || (b && (b.owner !== owner || b.master !== binding.hub || b.proofCodeHash !== binding.proofCodeHash)) || a.balance - (b?.balance ?? 0n) !== delta)
            return null;
        return { ...boundary, beforeState: b, afterState: a };
    }
    catch {
        return null;
    }
}
export async function currentT3ReserveDelta(input: ProjectionInput, node: Node, route: LedgerT3RedemptionBinding['reserveRoutes'][number], owner: string, delta: bigint) {
    try {
        const boundary = await currentT3Boundary(input, node, route.walletCodeHash, true);
        if (!boundary)
            return null;
        const read = (boc: string) => {
            const c = Cell.fromBase64(boc);
            if (c.isExotic)
                throw Error('Exotic reserve');
            const s = c.beginParse();
            if (route.walletStorage === 'stablecoin')
                s.loadUint(4);
            const balance = s.loadCoins(), o = s.loadAddress().toRawString(), master = s.loadAddress().toRawString();
            s.endParse();
            if (o !== owner || master !== route.root)
                throw Error('Reserve identity mismatch');
            return balance;
        };
        if (read(boundary.after.state.dataBoc!) - (boundary.before.state.dataBoc ? read(boundary.before.state.dataBoc) : 0n) !== delta)
            return null;
        return boundary;
    }
    catch {
        return null;
    }
}
/** The external log is only a candidate. Its exact leaf must be in the authenticated
 * post-transaction tree, using the rightmost frontier or an original input witness. */
export function currentT3ReceiptCommitted(receipt: ReturnType<typeof t3Receipt>, node: Node, boundary: NonNullable<Awaited<ReturnType<typeof currentT3HubBoundary>>>) {
    try {
        const after = boundary.afterState.trees[receipt.slot], before = boundary.beforeState.trees[receipt.slot];
        if (!after.initialized || receipt.key > after.lastKey)
            return false;
        if (receipt.key === after.lastKey && after.lastLeaf === BigInt('0x' + t3Leaf(receipt.cell).toString('hex')) && after.frontier && t3PathRoot(receipt.key, receipt.cell, after.frontier, true) === after.root)
            return true;
        const input = businessBodyCell(node.raw.inMessage);
        if (!input)
            return false;
        const seen = new Set<string>(), queue = [input];
        for (let count = 0; queue.length && count < 1024; count++) {
            const c = queue.pop()!;
            if (c.isExotic)
                continue;
            const h = c.hash().toString('hex');
            if (seen.has(h))
                continue;
            seen.add(h);
            queue.push(...c.refs);
            if (c.bits.length === 0 && c.refs.length === 2) {
                try {
                    const old = c.refs[0], s = old.beginParse(), key = s.loadUintBig(64);
                    s.loadRef();
                    s.endParse();
                    if (key === receipt.key && t3PathRoot(key, old, c.refs[1]) === before.root && t3PathRoot(key, receipt.cell, c.refs[1]) === after.root)
                        return true;
                }
                catch { }
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
