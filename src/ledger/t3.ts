import { Address, Cell, beginCell } from '@ton/core';
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from './types';
import type { Flow, Node, ProjectionInput } from './project';
import { chainCoversTransaction } from './project';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { bodyCell, tokenWire, NOTIFY, TRANSFER } from './wire';
import type { LedgerT3RedemptionBinding } from './bindings';
import { currentT3WalletAddress } from './currentT3State';
import * as w from './currentT3Wire';
import { currentT3HubBoundary, currentT3ReceiptCommitted, currentT3ReserveDelta, currentT3WalletDelta } from './currentT3Proof';
export type LedgerT3Hub = {
    address: string;
    root: string;
    codeHash: string;
    redemptionBinding: LedgerT3RedemptionBinding;
    reserveRoots: string[];
    vaults: string[];
};
export type T3LedgerOperation = {
    anchor: Node;
    kind: 't3_mint' | 't3_redeem' | 'swap' | 'transfer';
    queryId: string;
    confirmed: boolean;
    evidence: LedgerEvidenceRef[];
    issue?: string;
    settlement: NonNullable<LedgerEvent['settlement']>;
};
const addr = (s?: string) => {
    try {
        return s ? canonicalLedgerAddress(s) : null;
    }
    catch {
        return null;
    }
};
const ref = (n: Node): LedgerEvidenceRef => ({ account: n.account, lt: n.raw.lt, hash: canonicalLedgerHash(n.raw.hash), utime: n.raw.utime });
const ok = (n: Node) => n.raw.success && n.raw.status !== 'failed' && !n.raw.inMessage?.bounced;
const zero = () => ['0', '0', '0'];
export async function decodeT3(input: ProjectionInput, nodes: Node[], flows: Flow[], receiptFor: (n: Node, i: number) => Node | null, attach: (a: Node, b: Node) => void) {
    const operations: T3LedgerOperation[] = [], usedFlows = new Set<string>(), credited = new Set<string>();
    for (const hub of input.t3Hubs?.values() ?? []) {
        const binding = hub.redemptionBinding;
        // A dispatch debits the original wallet even if the destination later
        // rejects it. Recovery and delivery do not erase or repeat that debit.
        for (const source of nodes) {
            if (!source.event || !ok(source))
                continue;
            for (const message of source.raw.outMessages) {
                const attempt = w.t3Delivery(message) ?? w.t3Burn(message);
                if (!attempt || attempt.owner !== input.owner || attempt.attempt !== 0n || attempt.originLt !== BigInt(source.raw.lt))
                    continue;
                const debit = await currentT3WalletDelta(input, source, binding, attempt.owner, -attempt.amount);
                if (!debit)
                    continue;
                const code = Cell.fromBase64(debit.after.state.codeBoc!);
                if (source.account !== currentT3WalletAddress(Address.parse(attempt.owner), Address.parse(hub.address), binding.proofCodeHash, code))
                    continue;
                const id = `${source.id}:${attempt.burn ? 't3-burn' : 't3-transfer-out'}`;
                if (source.event.movements.some(m => m.id === id))
                    continue;
                source.event.movements.push({ id, direction: 'out', ...(attempt.burn ? { purpose: 't3_burn' as const } : {}), asset: input.wallets.get(source.account) ?? { kind: 'jetton', id: `${input.network}:jetton:${hub.root}`, master: hub.root, wallet: source.account, owner: attempt.owner, decimals: 9, symbol: 'T3' }, amountRaw: String(attempt.amount), source: attempt.owner, destination: attempt.burn ? hub.address : attempt.recipient, evidence: { kind: attempt.burn ? 't3_burn' : 'jetton_internal_transfer', bodyHash: bodyCell(source.raw.inMessage)?.hash().toString('hex'), stateBeforeHash: debit.beforeState?.dataHash, stateAfterHash: debit.afterState.dataHash, beforeSeqno: debit.before.seqno, afterSeqno: debit.after.seqno, transactions: [ref(source)] } });
            }
        }
        // Updates replace one receipt identity; they are not new economic operations.
        const latest = new Map<string, {
            node: Node;
            boundary: NonNullable<Awaited<ReturnType<typeof currentT3HubBoundary>>>;
            receipt: ReturnType<typeof w.t3Receipt>;
        }>();
        const hubNodes = nodes.filter(n => n.account === hub.address && ok(n)).sort((a, b) => BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1);
        const hubBoundaries = new Map<string, NonNullable<Awaited<ReturnType<typeof currentT3HubBoundary>>>>();
        for (const node of hubNodes) {
            const boundary = await currentT3HubBoundary(input, node, binding);
            if (!boundary)
                continue;
            hubBoundaries.set(node.raw.lt, boundary);
            for (const receipt of node.raw.outMessages.map(w.t3ReceiptLog).filter((r): r is NonNullable<typeof r> => r !== null)) {
                if (currentT3ReceiptCommitted(receipt, node, boundary))
                    latest.set(`${receipt.slot}:${receipt.key}`, { node, boundary, receipt });
            }
        }
        const paired = new Map<string, Extract<ReturnType<typeof w.t3Receipt>, {
            kind: 'credit';
        }>>(), consumed = new Set<string>();
        for (const { receipt: r } of latest.values()) {
            if (r.kind !== 'credit' || ![2, 4].includes(r.phase) || w.t3Intent(r.credit.intent)?.op !== w.T3_PAIR)
                continue;
            const first = latest.get(`${r.linkedSlot}:${r.linkedKey}`)?.receipt;
            if (first?.kind !== 'credit' || first.phase !== 1 || first.linkedSlot !== r.slot || first.linkedKey !== r.key || first.credit.owner !== r.credit.owner)
                continue;
            if (r.staged && !r.staged.equals(first.cell.refs[0].refs[0]))
                continue;
            paired.set(`${r.slot}:${r.key}`, first);
            consumed.add(`${first.slot}:${first.key}`);
        }
        // Each physical receipt is independently identified by hub, reserve/burn tree and receiving LT.
        // Query IDs and SENT/FAILED flags never establish a credit or settlement.
        for (const { node, boundary, receipt } of latest.values()) {
            if (consumed.has(`${receipt.slot}:${receipt.key}`))
                continue;
            const owner = receipt.kind === 'credit' ? receipt.credit.owner : receipt.attempt.owner, queryId = (receipt.kind === 'credit' ? receipt.credit.queryId : receipt.attempt.queryId).toString();
            const recipient = receipt.kind === 'credit' ? (receipt.mint?.recipient ?? receipt.payout?.recipient ?? owner) : (receipt.payout?.recipient ?? owner);
            if (owner !== input.owner && recipient !== input.owner)
                continue;
            const ns: Node[] = [node], basket = zero(), delivered = zero();
            let anchor: Node | null = null, minted = 0n, burned = false, collateral = false, requestBodyHash: string | null = null, sourceWallet: string | null = null;
            const evidence: LedgerMovement['evidence'] = { kind: receipt.kind === 'credit' ? 't3_mint' : 't3_burn', stateBeforeHash: boundary.beforeState.dataHash, stateAfterHash: boundary.afterState.dataHash, beforeSeqno: boundary.before.seqno, afterSeqno: boundary.after.seqno, transactions: [ref(node)] };
            if (receipt.kind === 'credit') {
                const partner = paired.get(`${receipt.slot}:${receipt.key}`);
                const deposits = [{ slot: receipt.slot, key: receipt.key, credit: receipt.credit }, ...(partner ? [{ slot: partner.slot, key: partner.key, credit: partner.credit }] : [])];
                let proved = 0;
                for (const deposit of deposits) {
                    const credit = deposit.credit;
                    basket[deposit.slot] = String(credit.amount);
                    const route = binding.reserveRoutes.find(route => route.slot === deposit.slot);
                    if (!route)
                        continue;
                    for (const f of flows) {
                        if (!f.confirmed || f.sourceAsset.owner !== credit.owner || f.recipient.account !== route.vault || BigInt(f.recipient.raw.lt) !== deposit.key || f.wire.amountRaw !== String(credit.amount) || f.wire.queryId !== String(credit.queryId) || !f.wire.forward.equals(credit.intent))
                            continue;
                        const notifyIndex = f.recipient.raw.outMessages.findIndex(m => addr(m.destination) === hub.address && tokenWire(m)?.op === NOTIFY), notify = notifyIndex < 0 ? null : receiptFor(f.recipient, notifyIndex);
                        if (!credit.certified && (!notify || !ok(notify)))
                            continue;
                        if (!await currentT3ReserveDelta(input, f.source, route, credit.owner, -credit.amount) || !await currentT3ReserveDelta(input, f.recipient, route, hub.address, credit.amount))
                            continue;
                        if (deposit.slot === receipt.slot && deposit.key === receipt.key) {
                            requestBodyHash = bodyCell(f.source.raw.inMessage)?.hash().toString('hex') ?? null;
                            sourceWallet = f.source.account;
                        }
                        proved++;
                        usedFlows.add(f.id);
                        ns.push(f.source, f.recipient, ...(notify ? [notify] : []));
                        anchor ??= f.source;
                        for (const movement of f.source.event?.movements ?? [])
                            if (movement.direction === 'out' && movement.asset.master === route.root && movement.amountRaw === String(credit.amount))
                                movement.purpose = 't3_collateral';
                        break;
                    }
                }
                collateral = proved === deposits.length && (w.t3Intent(receipt.credit.intent)?.op !== w.T3_PAIR || receipt.phase === 3 || !!partner);
                const dispatch = receipt.mint ? hubNodes.find(n => BigInt(n.raw.lt) === receipt.mint!.sentLt && hubBoundaries.has(n.raw.lt)) : null;
                if (receipt.mint && dispatch)
                    for (const [i, m] of dispatch.raw.outMessages.entries()) {
                        const mint = w.t3Mint(m), credit = receiptFor(dispatch, i), r = receipt.mint;
                        if (!mint || !credit || !ok(credit) || mint.identity.domain !== 0 || mint.identity.slot !== receipt.slot || mint.identity.key !== receipt.key || mint.identity.attempt !== r.attempt || mint.amount !== r.amount || mint.queryId.toString() !== queryId || r.status !== 0)
                            continue;
                        const wallet = currentT3WalletAddress(Address.parse(r.recipient), Address.parse(hub.address), binding.proofCodeHash, boundary.afterState.walletCode);
                        if (credit.account !== wallet || addr(m.destination) !== wallet || !await currentT3WalletDelta(input, credit, binding, r.recipient, r.amount))
                            continue;
                        minted = r.amount;
                        ns.push(dispatch, credit);
                        if (r.recipient === input.owner && credit.event && !credited.has(credit.id)) {
                            credited.add(credit.id);
                            anchor ??= credit;
                            credit.event.movements.push({ id: `${credit.id}:t3-mint-credit`, direction: 'in', purpose: 't3_mint', asset: input.wallets.get(wallet) ?? { kind: 'jetton', id: `${input.network}:jetton:${hub.root}`, master: hub.root, wallet, owner: r.recipient, decimals: 9, symbol: 'T3' }, amountRaw: String(r.amount), source: hub.address, destination: r.recipient, evidence: { ...evidence, bodyHash: bodyCell(credit.raw.inMessage)!.hash().toString('hex'), transactions: ns.map(ref) } });
                        }
                    }
            }
            else {
                const a = receipt.attempt;
                const burnNode = hubNodes.find(n => BigInt(n.raw.lt) === receipt.key), burnBoundary = burnNode ? hubBoundaries.get(burnNode.raw.lt) : null;
                // The hub's exact burn input must originate in the canonical wallet's physical dispatch.
                for (const wallet of nodes) {
                    if (!ok(wallet) || !burnNode || !burnBoundary)
                        continue;
                    const i = wallet.raw.outMessages.findIndex((m, j) => receiptFor(wallet, j)?.id === burnNode.id && w.t3Burn(m)?.cell.equals(a.cell));
                    if (i < 0)
                        continue;
                    const expected = currentT3WalletAddress(Address.parse(a.owner), Address.parse(hub.address), binding.proofCodeHash, boundary.afterState.walletCode);
                    if (wallet.account !== expected || !await currentT3WalletDelta(input, wallet, binding, a.owner, a.attempt === 0n ? -a.amount : 0n) || burnBoundary.beforeState.supply - burnBoundary.afterState.supply !== a.amount)
                        continue;
                    const original = nodes.find(n => n.account === wallet.account && n.raw.lt === String(a.originLt));
                    if (!original || !original.raw.outMessages.some(m => { const first = w.t3Burn(m); return first && first.id === a.id && first.originLt === a.originLt && first.attempt === 0n && w.t3SameRequest(first, a); }) || !await currentT3WalletDelta(input, original, binding, a.owner, -a.amount))
                        continue;
                    requestBodyHash = bodyCell(original.raw.inMessage)?.hash().toString('hex') ?? null;
                    sourceWallet = original.account;
                    burned = true;
                    ns.push(original, wallet, burnNode);
                    anchor = original;
                    if (original.event && a.owner === input.owner && !original.event.movements.some(m => m.id === `${original.id}:t3-burn`))
                        original.event.movements.push({ id: `${original.id}:t3-burn`, direction: 'out', purpose: 't3_burn', asset: input.wallets.get(original.account)!, amountRaw: String(a.amount), source: a.owner, destination: hub.address, evidence: { ...evidence, transactions: ns.map(ref) } });
                }
            }
            const payout = receipt.payout;
            if (payout) {
                for (let slot = 0; slot < 3; slot++) {
                    const leg = payout.legs[slot];
                    basket[slot] = String(leg.amount);
                    if (!leg.amount)
                        continue;
                    const dispatch = hubNodes.find(n => BigInt(n.raw.lt) === leg.sentLt && hubBoundaries.has(n.raw.lt));
                    if (!dispatch)
                        continue;
                    for (const [i, m] of dispatch.raw.outMessages.entries()) {
                        const command = tokenWire(m), id = command ? w.t3PayoutIdentity(command.forward) : null, source = receiptFor(dispatch, i), route = binding.reserveRoutes.find(route => route.slot === slot);
                        if (!route || !command || command.op !== TRANSFER || !id || !source || source.account !== route.vault || id.domain !== (receipt.kind === 'burn' ? 1 : 0) || id.slot !== receipt.slot || id.key !== receipt.key || id.output !== slot || id.attempt !== leg.attempt || command.amountRaw !== String(leg.amount) || command.owner !== leg.recipient || command.queryId !== queryId || leg.status !== 0)
                            continue;
                        for (const f of flows) {
                            if (!f.confirmed || f.source.id !== source.id || f.recipientAsset.owner !== leg.recipient || f.recipientAsset.master !== route.root || f.wire.amountRaw !== String(leg.amount) || f.wire.queryId !== queryId || !await currentT3ReserveDelta(input, f.source, route, hub.address, -leg.amount) || !await currentT3ReserveDelta(input, f.recipient, route, leg.recipient, leg.amount))
                                continue;
                            delivered[slot] = String(leg.amount);
                            usedFlows.add(f.id);
                            ns.push(dispatch, f.source, f.recipient);
                            if (leg.recipient === input.owner)
                                anchor ??= f.recipient;
                            for (const movement of f.recipient.event?.movements ?? [])
                                if (movement.direction === 'in' && movement.asset.master === route.root && movement.amountRaw === String(leg.amount))
                                    movement.purpose = receipt.kind === 'credit' && receipt.phase === 3 ? 't3_refund' : 't3_payout';
                        }
                    }
                }
            }
            anchor ??= nodes.find(n => n.event && n.account === input.owner && n.raw.outMessages.some((m, i) => receiptFor(n, i)?.id === node.id)) ?? null;
            if (!anchor?.event)
                continue;
            const full = ns.every(n => chainCoversTransaction(input.chains.get(n.account), n.raw)), allPaid = !payout || payout.legs.every((l, i) => String(l.amount) === delivered[i]);
            const fulfilled = receipt.kind === 'burn' ? burned && allPaid : (receipt.phase === 2 || receipt.phase === 3) && (!receipt.mint || minted === receipt.mint.amount) && allPaid;
            // A later retry can prove its own physical delivery. It cannot recreate the original collateral debit.
            const confirmed = full && fulfilled && (receipt.kind === 'burn' || collateral);
            const stage = confirmed ? (receipt.kind === 'burn' ? 'redeemed' : receipt.phase === 3 ? 'refunded' : w.t3Intent(receipt.credit.intent)?.op === w.T3_SWAP ? 'swapped' : 'minted') : receipt.kind === 'credit' && receipt.phase === 0 ? 'claimable' : 'unresolved';
            const unique = [...new Map(ns.map(n => [n.id, n])).values()];
            for (const n of unique)
                attach(anchor, n);
            const kind = receipt.kind === 'burn' ? 't3_redeem' : w.t3Intent(receipt.credit.intent)?.op === w.T3_SWAP ? 'swap' : 't3_mint';
            operations.push({ anchor, kind, queryId, confirmed, evidence: unique.map(ref), ...(!confirmed ? { issue: 't3_physical_settlement_incomplete' } : {}), settlement: { protocol: 't3', operation: kind, status: confirmed ? 'confirmed' : 'incomplete', evidence: unique.map(ref), t3: { hub: hub.address, root: hub.root, owner, recipient, queryId, amountRaw: receipt.kind === 'burn' ? String(receipt.attempt.amount) : String(receipt.credit.amount), mintedRaw: String(minted), stage, reserveRoots: hub.reserveRoots, basketRaw: basket, deliveredRaw: delivered, feeBreakdown: 'unavailable', receipt: { slot: receipt.slot, key: String(receipt.key), hash: receipt.cell.hash().toString('hex'), recordBoc: receipt.cell.toBoc().toString('base64'), request: { sourceWallet, bodyHash: requestBodyHash, owner, queryId, amountRaw: receipt.kind === 'burn' ? String(receipt.attempt.amount) : String(receipt.credit.amount), intentHash: (receipt.kind === 'burn' ? receipt.attempt.customPayload : receipt.credit.intent)?.hash().toString('hex') ?? null }, root: boundary.afterState.trees[receipt.slot].root.toString(16).padStart(64, '0'), phase: receipt.kind === 'credit' ? receipt.phase : null, committed: true }, localNetworkFees: unique.map(n => ({ transaction: ref(n), amountRaw: n.raw.totalFeesRaw ?? null, includedInOwnerFeeMovements: !!n.event })) } } });
        }
        for (const node of nodes) {
            const body = bodyCell(node.raw.inMessage);
            if (!body || !ok(node) || body.isExotic)
                continue;
            try {
                const s = body.beginParse();
                if (s.loadUint(32) !== 0x54335758)
                    continue;
                const record = s.loadRef(), proof = s.loadRef();
                s.endParse();
                const r = record.beginParse(), failed = r.loadBit(), cancelled = r.loadBit(), attempt = w.t3Attempt(r.loadRef());
                r.endParse();
                if (!failed || cancelled || !attempt.burn || attempt.owner !== input.owner || addr(node.raw.inMessage?.source) !== input.owner)
                    continue;
                const delta = await currentT3WalletDelta(input, node, binding, input.owner, attempt.amount);
                if (!delta?.beforeState || !node.event)
                    continue;
                const code = Cell.fromBase64(delta.after.state.codeBoc!);
                if (node.account !== currentT3WalletAddress(Address.parse(input.owner), Address.parse(hub.address), binding.proofCodeHash, code))
                    continue;
                const restored = beginCell().storeBit(false).storeBit(true).storeRef(attempt.cell).endCell();
                if (w.t3PathRoot(attempt.id, record, proof) !== delta.beforeState.root || w.t3PathRoot(attempt.id, restored, proof) !== delta.afterState.root)
                    continue;
                const evidence: LedgerMovement['evidence'] = { kind: 't3_refund', bodyHash: body.hash().toString('hex'), stateBeforeHash: delta.beforeState.dataHash, stateAfterHash: delta.afterState.dataHash, beforeSeqno: delta.before.seqno, afterSeqno: delta.after.seqno, transactions: [ref(node)] };
                node.event.movements.push({ id: `${node.id}:t3-burn-cancel`, direction: 'in', purpose: 't3_refund', asset: input.wallets.get(node.account)!, amountRaw: String(attempt.amount), source: hub.address, destination: input.owner, evidence });
                const original = nodes.find(n => n.account === node.account && n.raw.lt === String(attempt.originLt));
                const initial = original?.raw.outMessages.map(w.t3Burn).find(a => a && a.id === attempt.id && a.originLt === attempt.originLt && a.attempt === 0n && w.t3SameRequest(a, attempt));
                const debit = original && initial ? await currentT3WalletDelta(input, original, binding, input.owner, -attempt.amount) : null;
                const requestBodyHash = debit && original ? bodyCell(original.raw.inMessage)?.hash().toString('hex') ?? null : null;
                const refs = original && debit ? [ref(original), ref(node)] : [ref(node)];
                const confirmed = !!requestBodyHash && chainCoversTransaction(input.chains.get(node.account), node.raw) && !!original && chainCoversTransaction(input.chains.get(node.account), original.raw);
                operations.push({ anchor: node, kind: 't3_redeem', queryId: String(attempt.queryId), confirmed, evidence: refs, ...(!confirmed ? { issue: 't3_cancel_history_incomplete' } : {}), settlement: { status: confirmed ? 'confirmed' : 'incomplete', protocol: 't3', operation: 't3_redeem', evidence: refs, t3: { hub: hub.address, root: hub.root, owner: input.owner, recipient: input.owner, queryId: String(attempt.queryId), amountRaw: String(attempt.amount), stage: 'cancelled', reserveRoots: hub.reserveRoots, basketRaw: zero(), deliveredRaw: zero(), feeBreakdown: 'unavailable', walletRecovery: { wallet: node.account, id: String(attempt.id), attempt: String(attempt.attempt), originLt: String(attempt.originLt), recordHash: restored.hash().toString('hex'), rootBefore: delta.beforeState.root.toString(16).padStart(64, '0'), rootAfter: delta.afterState.root.toString(16).padStart(64, '0'), status: 'cancelled', restoredRaw: String(attempt.amount), requestBodyHash, recoveryBodyHash: body.hash().toString('hex') }, localNetworkFees: [{ transaction: ref(node), amountRaw: node.raw.totalFeesRaw ?? null, includedInOwnerFeeMovements: true }] } } });
            }
            catch { /* Malformed or unavailable recovery evidence cannot establish a credit. */ }
        }
        for (const source of nodes)
            for (const [index, message] of source.raw.outMessages.entries()) {
                const attempt = w.t3Delivery(message), recipient = receiptFor(source, index);
                if (!attempt || attempt.burn || !recipient || !ok(source) || !ok(recipient) || (attempt.owner !== input.owner && attempt.recipient !== input.owner))
                    continue;
                const credit = await currentT3WalletDelta(input, recipient, binding, attempt.recipient, attempt.amount);
                if (!credit)
                    continue;
                const code = Cell.fromBase64(credit.after.state.codeBoc!);
                if (source.account !== currentT3WalletAddress(Address.parse(attempt.owner), Address.parse(hub.address), binding.proofCodeHash, code) || recipient.account !== currentT3WalletAddress(Address.parse(attempt.recipient), Address.parse(hub.address), binding.proofCodeHash, code))
                    continue;
                const original = nodes.find(n => n.account === source.account && n.raw.lt === String(attempt.originLt));
                const initial = original?.raw.outMessages.map(w.t3Delivery).find(a => a && a.id === attempt.id && a.originLt === attempt.originLt && a.attempt === 0n && w.t3SameRequest(a, attempt));
                const debit = original && initial ? await currentT3WalletDelta(input, original, binding, attempt.owner, -attempt.amount) : null;
                if (!debit)
                    continue;
                if (attempt.attempt > 0n && !await currentT3WalletDelta(input, source, binding, attempt.owner, 0n))
                    continue;
                const related = [...new Map([original!, source, recipient].map(n => [n.id, n])).values()], refs = related.map(ref), anchor = attempt.owner === input.owner ? original! : recipient;
                if (!anchor.event)
                    continue;
                const asset = (wallet: string, owner: string) => input.wallets.get(wallet) ?? { kind: 'jetton' as const, id: `${input.network}:jetton:${hub.root}`, master: hub.root, wallet, owner, symbol: 'T3', decimals: 9 };
                for (const [n, direction, owner, delta] of [[original!, 'out', attempt.owner, debit], [recipient, 'in', attempt.recipient, credit]] as const) {
                    if (owner !== input.owner || !n.event)
                        continue;
                    const id = `${n.id}:t3-transfer-${direction}`;
                    if (n.event.movements.some(m => m.id === id))
                        continue;
                    n.event.movements.push({ id, direction, asset: asset(n.account, owner), amountRaw: String(attempt.amount), source: attempt.owner, destination: attempt.recipient, evidence: { kind: 'jetton_internal_transfer', opcode: w.T3_WALLET_DELIVERY, bodyHash: bodyCell(recipient.raw.inMessage)!.hash().toString('hex'), stateBeforeHash: delta.before.state.dataBoc ? Cell.fromBase64(delta.before.state.dataBoc).hash().toString('hex') : undefined, stateAfterHash: delta.afterState.dataHash, beforeSeqno: delta.before.seqno, afterSeqno: delta.after.seqno, transactions: refs } });
                }
                for (const n of related)
                    attach(anchor, n);
                const confirmed = related.every(n => chainCoversTransaction(input.chains.get(n.account), n.raw));
                operations.push({ anchor, kind: 'transfer', queryId: String(attempt.queryId), confirmed, evidence: refs, ...(!confirmed ? { issue: 't3_transfer_history_incomplete' } : {}), settlement: { status: confirmed ? 'confirmed' : 'incomplete', protocol: 't3', operation: 'transfer', evidence: refs } });
            }
    }
    return { operations, usedFlows };
}
