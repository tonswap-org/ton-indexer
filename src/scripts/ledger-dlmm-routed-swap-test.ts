import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Address, Cell, Dictionary, beginCell, loadTransaction } from '@ton/core';
import { readDlmmRouterSettlementGroup } from '../ledger/dlmmRouterState';
import { createDlmmProofGraph } from '../ledger/dlmmProof';
import { verifyDlmmRoutedSwapExecution } from '../ledger/dlmmRoutedSwapProof';
import { opcode } from '../ledger/wire';
import type { DlmmMarketBinding, MarketNode } from '../ledger/marketTypes';
const fixture = JSON.parse(readFileSync(`${__dirname}/fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-settlements.json`, 'utf8'));
const code = (suffix: string) => fixture.compiler.find((c: any) => c.entrypointFileName.endsWith(suffix)).codeHash;
const binding: DlmmMarketBinding = { network: 'localnet', pool: fixture.accounts.pool, router: fixture.accounts.router, routerCodeHash: code('/dex/router.tolk'), poolCodeHash: code('/dlmm/pool.tolk'), walletCodeHash: code('/jetton/jetton_wallet.tolk'), tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX, tokenTCodeHash: code('/jetton/jetton_root.tolk'), tokenXCodeHash: code('/jetton/jetton_root.tolk') };
const nodes: MarketNode[] = fixture.transactions.map((t: any) => { const b = fixture.boundaries.find((b: any) => b.account === t.account && b.transactionLt === t.raw.lt && b.transactionHash === t.raw.hash); const tx = loadTransaction(Cell.fromBase64(t.transactionBoc).beginParse()); assert.equal(tx.hash().toString('hex'), t.raw.hash); assert.equal(tx.stateUpdate.oldHash.toString('hex'), Cell.fromBase64(b.before.shardAccountBoc).refs[0].hash().toString('hex')); assert.equal(tx.stateUpdate.newHash.toString('hex'), Cell.fromBase64(b.after.shardAccountBoc).refs[0].hash().toString('hex')); return { account: t.account, raw: t.raw, before: { seqno: 0, state: { ...b.before, accountState: b.before.accountState === 'uninit' ? 'uninitialized' : b.before.accountState } }, after: { seqno: 0, state: b.after } }; });
const proof = createDlmmProofGraph(binding, nodes), acceptances = proof.pools.filter(n => opcode(n.raw.inMessage) === 0x52505358);
assert.equal(acceptances.length, 2);
for (const node of acceptances) {
    const result = verifyDlmmRoutedSwapExecution(binding, proof, node);
    console.log('qualified', result.paid.toString(), result.output.toString());
}
import { projectDlmmMarket } from '../ledger/marketProjection';
import { validateMarketProjection } from '../ledger/marketStore';
const heads = new Map<string, MarketNode>();
for (const n of nodes)
    if (!heads.has(n.account) || BigInt(heads.get(n.account)!.raw.lt) < BigInt(n.raw.lt))
        heads.set(n.account, n);
const dependencies = [...heads].map(([account, n]) => ({ account, generation: '00000000-0000-4000-8000-000000000001', historyComplete: true, headLt: n.raw.lt, headHash: n.raw.hash, checkedThrough: new Date((n.raw.utime + 60) * 1000).toISOString() }));
const projected = projectDlmmMarket(binding, nodes, dependencies);
assert.equal(projected.observations.length, 2, JSON.stringify(projected.candidates));
validateMarketProjection(projected);
assert.deepEqual(projected.observations.map(o => [o.paidInputRaw, o.consumedInputRaw, o.returnedInputRaw, o.outputRaw]), [['100003', '100003', '0', '99703'], ['150007', '150007', '0', '149557']]);
for (const observation of projected.observations) {
    assert.equal(new Set(observation.fees.map(f => `${f.transaction.account}:${f.transaction.lt}:${f.transaction.hash}`)).size, observation.fees.length);
    assert.notEqual(observation.routing!.terminalSettlement.credit.account, observation.settlements[0].credit.account);
    assert.equal(observation.routing!.protocolFeeSettlement!.amountRaw, observation.paidInputRaw === '100003' ? '51' : '77');
    assert.equal(observation.routing!.directFeeSettlement!.amountRaw, observation.routing!.protocolFeeSettlement!.amountRaw);
    assert.equal(observation.routing!.directFeeSettlement!.kind, 15);
    assert.notEqual(observation.routing!.directFeeSettlement!.destinationOwner, binding.router);
    for (const fee of observation.fees)
        assert.equal(fee.nativeAmountRaw, nodes.find(n => n.account === fee.transaction.account && n.raw.lt === fee.transaction.lt)!.raw.totalFeesRaw);
    for (const mutate of [
        (o: typeof observation) => { o.routing!.terminalSettlement.amountRaw = '1'; },
        (o: typeof observation) => { o.routing!.terminalSettlement.destinationOwner = binding.pool; },
        (o: typeof observation) => { o.routing!.inputSettlement.boundaries = []; },
        (o: typeof observation) => { o.routing!.protocolFeeSettlement!.kind = 1; },
        (o: typeof observation) => { o.routing!.directFeeSettlement = null; },
        (o: typeof observation) => { o.routing!.directFeeSettlement!.amountRaw = '1'; },
        (o: typeof observation) => { o.routing!.directFeeSettlement!.destinationOwner = binding.router!; },
        (o: typeof observation) => { o.routing!.directFeeSettlement!.destinationOwner = fixture.accounts.payer; },
        (o: typeof observation) => { o.routing!.directFeeSettlement!.amountRaw = '1'; o.routing!.protocolFeeSettlement!.amountRaw = '1'; },
        (o: typeof observation) => { o.routing!.directFeeSettlement!.kind = 8; },
        (o: typeof observation) => { Reflect.deleteProperty(o.routing!, 'directFeeSettlement'); },
        (o: typeof observation) => { o.fees.push(o.fees[0]); },
    ]) {
        const malformed = structuredClone(projected);
        mutate(malformed.observations.find(o => o.id === observation.id)!);
        assert.throws(() => validateMarketProjection(malformed));
    }
}
// Each metadata leg is bound to the unmodified canonical transfer fields.
// Keep the real VM fixtures unchanged and mutate only the published evidence.
for (const observation of projected.observations) for (const name of ['inputSettlement', 'terminalSettlement', 'protocolFeeSettlement', 'directFeeSettlement'] as const) {
    for (const field of ['query', 'amount', 'owner', 'response', 'marker', 'trailing', 'tep74', 'coin-width', 'base64', 'oversize'] as const) {
        const malformed = structuredClone(projected), leg = malformed.observations.find(o => o.id === observation.id)!.routing![name]!;
        const s = Cell.fromBase64(leg.requestBodyBoc).beginParse(); s.loadUint(32);
        const query = s.loadUintBig(64), amount = s.loadCoins(), owner = s.loadAddress(), response = s.loadAddress();
        const marker = s.loadRef(), forward = s.loadCoins(), payload = s.loadRef(); s.endParse();
        const b = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(field === 'query' ? query + 1n : query, 64);
        if (field === 'coin-width') b.storeUint(15, 4).storeUint(amount, 120);
        else b.storeCoins(field === 'amount' ? amount + 1n : amount);
        b.storeAddress(field === 'owner' ? Address.parse(binding.tokenT) : owner)
            .storeAddress(field === 'response' ? Address.parse(fixture.accounts.payer) : response);
        if (field === 'tep74') b.storeMaybeRef(marker); else b.storeRef(field === 'marker' ? Cell.EMPTY : marker);
        b.storeCoins(forward); if (field === 'tep74') b.storeBit(true); b.storeRef(payload);
        if (field === 'trailing') b.storeBit(true);
        const body = b.endCell(); leg.requestBodyBoc = body.toBoc().toString('base64'); leg.requestBodyHash = body.hash().toString('hex');
        if (field === 'base64') leg.requestBodyBoc = '\n' + leg.requestBodyBoc;
        if (field === 'oversize') leg.requestBodyBoc = 'AAAA'.repeat(16385);
        assert.throws(() => validateMarketProjection(malformed), /Invalid market projection/, `${name} ${field}`);
    }
    const malformed = structuredClone(projected), leg = malformed.observations.find(o => o.id === observation.id)!.routing![name]!;
    leg.settlementId = (BigInt(leg.settlementId) + 1n).toString();
    assert.throws(() => validateMarketProjection(malformed), /Invalid market projection/, `${name} metadata query`);
}
for (const observation of projected.observations) for (const name of ['protocolFeeSettlement', 'directFeeSettlement'] as const) {
    const malformed = structuredClone(projected), o = malformed.observations.find(v => v.id === observation.id)!, r = o.routing!, leg = r[name]!;
    const original = leg.sourceWallet;
    const other = name === 'directFeeSettlement'
        ? (original === r.inputSettlement.sourceWallet ? r.terminalSettlement.sourceWallet : r.inputSettlement.sourceWallet)
        : (original === r.inputSettlement.destinationWallet ? o.settlements[0].sourceWallet : r.inputSettlement.destinationWallet);
    leg.sourceWallet = other;
    for (const ref of [leg.debit, leg.walletFinalized, ...leg.boundaries.map(b => b.transaction)]) if (ref.account === original) ref.account = other;
    assert.throws(() => validateMarketProjection(malformed), /Invalid market projection/, `${name} wrong token source`);
}
const replaceRef = (cell: Cell, index: number, ref: Cell) => {
    const builder = beginCell().storeBits(cell.bits); cell.refs.forEach((value, i) => builder.storeRef(i === index ? ref : value));
    return builder.endCell();
};
// Preserve the real surrounding transaction/archive and mutate only the fee
// context or queue state. The qualified proof must reject the substituted fact.
for (const observation of projected.observations) {
    const completion = observation.routing!.completion;
    for (const mutation of ['completion-context', 'context-configuration', 'group-refund-owner'] as const) {
        const altered = structuredClone(nodes), node = altered.find(n => n.account === completion.account && n.raw.lt === completion.lt)!;
        const root = Cell.fromBase64(node.after!.state.dataBoc!), extras = root.refs[3], tail = extras.refs[3], durable = tail.refs[3], journal = durable.refs[1];
        const primary = journal.refs[0].beginParse(), entries = primary.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
        const groups = primary.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), locks = primary.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(256));
        const fee = [...groups].find(([, value]) => readDlmmRouterSettlementGroup(value).kind === 10 &&
            readDlmmRouterSettlementGroup(value).finalized === 0)!;
        assert(fee); let cell = fee[1];
        if (mutation === 'group-refund-owner') {
            const builder = beginCell().storeBits(cell.bits.substring(0, cell.bits.length - 267)).storeAddress(null);
            cell.refs.forEach(ref => builder.storeRef(ref)); cell = builder.endCell();
        } else {
            const context = cell.refs[0];
            if (mutation === 'context-configuration') cell = replaceRef(cell, 0, replaceRef(context, 0, Cell.EMPTY));
            else {
                const cursor = context.beginParse(); const amount = cursor.loadCoins(); cursor.loadUintBig(256);
                const forged = beginCell().storeCoins(amount).storeUint(0, 256).storeSlice(cursor).endCell();
                cell = replaceRef(cell, 0, forged);
            }
        }
        groups.set(fee[0], cell);
        const changedPrimary = beginCell().storeDict(entries).storeDict(groups).storeDict(locks).endCell();
        node.after!.state.dataBoc = replaceRef(root, 3, replaceRef(extras, 3, replaceRef(tail, 3, replaceRef(durable, 1, replaceRef(journal, 0, changedPrimary))))).toBoc().toString('base64');
        const acceptance = altered.find(n => n.account === binding.pool && n.raw.lt === observation.acceptance.lt)!;
        assert.throws(() => verifyDlmmRoutedSwapExecution(binding, createDlmmProofGraph(binding, altered), acceptance), /market_router_direct_fee_allocation_invalid/);
    }
    const fee = observation.routing!.directFeeSettlement!, terminal = observation.routing!.terminalSettlement;
    if (fee.sourceWallet === terminal.sourceWallet) {
        assert.equal(terminal.request.lt, fee.routerFinalized.lt);
        for (const mutation of ['source-wallet', 'query', 'amount'] as const) {
            const altered = structuredClone(nodes), dispatch = altered.find(n => n.account === terminal.request.account && n.raw.lt === terminal.request.lt)!;
            if (mutation === 'source-wallet') dispatch.raw.inMessage!.source = binding.pool;
            else dispatch.raw.inMessage!.body = beginCell().storeUint(0x4a53464b, 32).storeUint(mutation === 'query' ? 1n : BigInt(fee.settlementId), 64)
                .storeCoins(mutation === 'amount' ? 1n : BigInt(fee.amountRaw)).storeAddress(Address.parse(fee.destinationWallet)).endCell().toBoc().toString('base64');
            const acceptance = altered.find(n => n.account === binding.pool && n.raw.lt === observation.acceptance.lt)!;
            assert.throws(() => verifyDlmmRoutedSwapExecution(binding, createDlmmProofGraph(binding, altered), acceptance));
        }
    } else assert.equal(terminal.request.lt, completion.lt);
}
for (const target of projected.observations) {
    const routing = target.routing!;
    for (const [label, transaction] of Object.entries({ original: target.input.request, payerDebit: target.input.debit, payerCredit: target.input.credit, routerAcceptance: routing.routerAcceptance,
        routerInputDebit: routing.inputSettlement.debit, routerInputCredit: routing.inputSettlement.credit, routerInputFinalizer: routing.inputSettlement.routerFinalized,
        poolOutputCredit: target.settlements[0].credit, poolOutputFinalizer: target.settlements[0].poolFinalized,
        poolFeeCredit: routing.protocolFeeSettlement!.credit, poolFeeFinalizer: routing.protocolFeeSettlement!.poolFinalized,
        directFeeCredit: routing.directFeeSettlement!.credit, directFeeFinalizer: routing.directFeeSettlement!.routerFinalized,
        completion: routing.completion, completionAck: routing.completionAcknowledged, beneficiaryCredit: routing.terminalSettlement.credit, terminalFinalizer: routing.terminalSettlement.routerFinalized })) {
        const matches = (n: MarketNode) => n.account === transaction.account && n.raw.lt === transaction.lt;
        const missing = projectDlmmMarket(binding, nodes.filter(n => !matches(n)), dependencies);
        assert.ok(!missing.observations.some(o => o.id === target.id), label);
        assert.ok(missing.observations.some(o => o.id !== target.id), `${label} preserves independent trade`);
        if (label === 'original')
            continue;
        const forged = structuredClone(nodes), node = forged.find(matches)!;
        if (node.after)
            node.after.state.lastTxHash = '0'.repeat(64);
        const damaged = projectDlmmMarket(binding, forged, dependencies);
        assert.ok(!damaged.observations.some(o => o.id === target.id), `${label} forged archive`);
    }
}
const malformedExecute=structuredClone(nodes);
const malformedAcceptance=malformedExecute.find(n=>n.account===binding.pool && n.raw.lt===acceptances[0].raw.lt)!;
delete malformedAcceptance.raw.inMessage!.body;
const malformedProjection=projectDlmmMarket(binding,malformedExecute,dependencies);
assert.equal(malformedProjection.candidates.length,2);
assert.equal(malformedProjection.observations.length,1);
assert.equal(malformedProjection.candidates.find(c=>c.acceptance.lt===malformedAcceptance.raw.lt)!.status,'unresolved');
const wrongBinding = projectDlmmMarket({ ...binding, routerCodeHash: '0'.repeat(64) }, nodes, dependencies);
assert.equal(wrongBinding.observations.length, 0);
assert.equal(projectDlmmMarket({ ...binding, router: null, routerCodeHash: null }, nodes, dependencies).observations.length, 0);
assert.deepEqual(projectDlmmMarket(binding, [...nodes].reverse(), dependencies), projected);
console.log('DLMM routed market physical custody, historical finality and adversarial evidence checks passed');
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import type { LedgerAsset } from '../ledger/types';
import { canonicalLedgerHash } from '../ledger/normalize';
import { loadOpcodes } from '../utils/opcodes';
function ownerInput(rows = nodes): ProjectionInput {
    const owner = fixture.accounts.payer, wallets = new Map<string, LedgerAsset>();
    for (const [name, pair] of Object.entries(fixture.accounts.wallets) as [
        string,
        string[]
    ][])
        for (const [side, wallet] of pair.entries()) {
            const master = side ? binding.tokenX : binding.tokenT, walletOwner = name === 'other' ? fixture.accounts.otherPayer : fixture.accounts[name];
            wallets.set(wallet, { kind: 'jetton', id: `localnet:jetton:${master}`, master, wallet, owner: walletOwner });
        }
    const chains = new Map<string, LedgerChain>();
    for (const node of rows) {
        if (!chains.has(node.account))
            chains.set(node.account, { account: node.account, role: node.account === owner ? 'owner' : node.account === binding.pool ? 'pool' : wallets.get(node.account)?.owner === owner ? 'owned_jetton_wallet' : 'counterparty', generation: 'sandbox-original-linked-account-history', historyComplete: true, transactions: [] });
        chains.get(node.account)!.transactions.push(node.raw);
    }
    return { network: 'localnet', owner, wallets, chains, pools: new Map([[binding.pool, { address: binding.pool, tokenT: binding.tokenT, tokenX: binding.tokenX, codeHash: binding.poolCodeHash }]]), marketBindings: new Map([[binding.pool, binding]]), opcodes: loadOpcodes(), stateAt: async (account, lt, hash) => {
            const current = rows.find(n => n.account === account && n.raw.lt === lt && canonicalLedgerHash(n.raw.hash) === canonicalLedgerHash(hash));
            if (current)
                return current.after ?? null;
            const next = rows.find(n => n.account === account && n.raw.prevTransactionLt === lt && n.raw.prevTransactionHash && canonicalLedgerHash(n.raw.prevTransactionHash) === canonicalLedgerHash(hash));
            return next?.before ?? null;
        } };
}
async function ownerChecks() {
    const complete = await projectOwnerLedger(ownerInput()), trades = complete.events.filter(e => e.kind === 'swap');
    assert.equal(trades.length, 2);
    assert.ok(trades.every(e => e.settlement?.status === 'confirmed'), JSON.stringify(trades.map(e => e.issues)));
    assert.deepEqual(trades.map(e => [e.settlement!.dlmmSwap!.paidInputRaw, e.settlement!.dlmmSwap!.outputRaw]).sort(), [['100003', '99703'], ['150007', '149557']].sort());
    for (const trade of trades) {
        const economic = trade.movements.filter(m => m.asset.kind === 'jetton');
        assert.equal(economic.length, 2, 'each user trade contains exactly one payment and one received output');
        assert.ok(trade.settlement!.dlmmSwap!.routing);
        const visit = (value: unknown): void => { if (!value || typeof value !== 'object')
            return; const r = value as Record<string, unknown>; if (typeof r.account === 'string' && typeof r.lt === 'string' && typeof r.hash === 'string')
            assert.equal(r.hash, canonicalLedgerHash(r.hash)); Object.values(r).forEach(visit); };
        visit(trade.settlement);
        assert.equal(new Set(trade.movements.map(m => m.id)).size, trade.movements.length);
    }
    const unqualified = ownerInput();
    unqualified.marketBindings = new Map();
    assert.ok((await projectOwnerLedger(unqualified)).events.filter(e => e.kind === 'swap').every(e => e.settlement?.status === 'incomplete'));
    const dropped = projected.observations[0].routing!.terminalSettlement.routerFinalized;
    const partial = await projectOwnerLedger(ownerInput(nodes.filter(n => n.account !== dropped.account || n.raw.lt !== dropped.lt)));
    assert.equal(partial.events.filter(e => e.kind === 'swap' && e.settlement?.status === 'confirmed').length, 1);
    console.log('DLMM routed owner projection preserves one trade and explicit missing-finality gaps');
}
ownerChecks().catch(error => { console.error(error); process.exitCode = 1; });
