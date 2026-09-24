import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cell, loadTransaction } from '@ton/core';
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
    for (const fee of observation.fees)
        assert.equal(fee.nativeAmountRaw, nodes.find(n => n.account === fee.transaction.account && n.raw.lt === fee.transaction.lt)!.raw.totalFeesRaw);
    for (const mutate of [
        (o: typeof observation) => { o.routing!.terminalSettlement.amountRaw = '1'; },
        (o: typeof observation) => { o.routing!.terminalSettlement.destinationOwner = binding.pool; },
        (o: typeof observation) => { o.routing!.inputSettlement.boundaries = []; },
        (o: typeof observation) => { o.routing!.protocolFeeSettlement!.kind = 1; },
        (o: typeof observation) => { o.fees.push(o.fees[0]); },
    ]) {
        const malformed = structuredClone(projected);
        mutate(malformed.observations.find(o => o.id === observation.id)!);
        assert.throws(() => validateMarketProjection(malformed));
    }
}
for (const target of projected.observations) {
    const routing = target.routing!;
    for (const [label, transaction] of Object.entries({ original: target.input.request, payerDebit: target.input.debit, payerCredit: target.input.credit, routerAcceptance: routing.routerAcceptance,
        routerInputDebit: routing.inputSettlement.debit, routerInputCredit: routing.inputSettlement.credit, routerInputFinalizer: routing.inputSettlement.routerFinalized,
        poolOutputCredit: target.settlements[0].credit, poolOutputFinalizer: target.settlements[0].poolFinalized,
        poolFeeCredit: routing.protocolFeeSettlement!.credit, poolFeeFinalizer: routing.protocolFeeSettlement!.poolFinalized,
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
