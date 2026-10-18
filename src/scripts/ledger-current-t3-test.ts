import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import { currentT3Fixture, currentT3MintFixture } from './support/currentT3Fixture';
import { currentT3HubBoundary, currentT3ReceiptCommitted, currentT3WalletDelta } from '../ledger/currentT3Proof';
import { t3ReceiptLog, t3PathRoot, t3Attempt, t3SameRequest } from '../ledger/currentT3Wire';
import { currentT3ReceiptWitness, reconstructCurrentT3Receipts, reconstructCurrentT3WalletClaims } from '../ledger/currentT3Receipts';
import { projectOwnerLedger, type Node, type ProjectionInput } from '../ledger/project';
import { readCurrentT3Wallet } from '../ledger/currentT3State';
import { bodyCell, tokenWire } from '../ledger/wire';
async function main() {
    let commitments = 0, negative = 0;
    for (const name of ['case-01.json', 'case-02.json']) {
        const f = currentT3Fixture(name), input = { stateAt: f.stateAt } as ProjectionInput;
        for (const row of f.hubRows) {
            const node: Node = { account: row.account, raw: row.raw, id: row.raw.lt };
            const boundary = await currentT3HubBoundary(input, node, f.binding);
            assert(boundary, 'captured hub before/after binding');
            for (const receipt of node.raw.outMessages.map(t3ReceiptLog).filter((r): r is NonNullable<typeof r> => !!r)) {
                assert(currentT3ReceiptCommitted(receipt, node, boundary), 'receipt must match authenticated tree');
                commitments++;
                const altered = { ...receipt, cell: beginCell().storeUint(receipt.key, 64).storeRef(Cell.EMPTY).endCell() };
                assert.equal(currentT3ReceiptCommitted(altered, node, boundary), false);
                negative++;
            }
            assert.equal(await currentT3HubBoundary(input, { ...node, raw: { ...node.raw, totalFeesRaw: '999' } }, f.binding), null, 'changed decoded summary cannot authenticate original tx');
            negative++;
            assert.equal(await currentT3HubBoundary(input, node, { ...f.binding, hubCodeHash: '0'.repeat(64) }), null);
            negative++;
            assert.equal(await currentT3HubBoundary({ stateAt: async (a, l, h) => { const s = await f.stateAt(a, l, h); return s ? { ...s, state: { ...s.state, balance: String(BigInt(s.state.balance) + 1n) } } : null; } } as ProjectionInput, node, f.binding), null, 'snapshot fields must match original ShardAccount');
            negative++;
        }
        const last = f.hubRows.at(-1)!, currentState = await f.stateAt(f.hub, last.raw.lt, last.raw.hash);
        assert(currentState);
        const history = await reconstructCurrentT3Receipts({ binding: f.binding, transactions: f.hubRows.map((r: any) => r.raw), currentState, stateAt: f.stateAt });
        assert.deepEqual(history, { status: 'unavailable', reason: 'history_start_missing' });
        negative++;
    }
    const entries = new Map([1n, 8n, 99n].map(key => [key, beginCell().storeUint(key, 64).storeRef(beginCell().storeUint(key, 64).endCell()).endCell()]));
    for (const [key, cell] of entries) {
        const w = currentT3ReceiptWitness(entries, key);
        assert.equal(t3PathRoot(key, cell, w.proof), w.root);
    }
    const prior = currentT3ReceiptWitness(entries, 8n).root;
    entries.set(8n, beginCell().storeUint(8, 64).storeRef(beginCell().storeUint(123, 64).endCell()).endCell());
    assert.notEqual(currentT3ReceiptWitness(entries, 8n).root, prior);
    const owner = Address.parse('0:' + '1'.repeat(64)), other = Address.parse('0:' + '2'.repeat(64));
    const attempt = (burn: boolean, recipient: Address, amount = 100n) => t3Attempt(beginCell().storeUint(0, 64).storeUint(1000, 64).storeUint(0, 64).storeRef(beginCell().storeAddress(owner).storeAddress(recipient).storeBit(burn).storeCoins(amount).storeRef(beginCell().storeUint(7, 64).storeAddress(owner).storeCoins(0).storeRef(Cell.EMPTY).storeMaybeRef(null).endCell()).endCell()).endCell());
    assert(t3SameRequest(attempt(false, owner), attempt(false, other)), 'native transfer retry may redirect without a second debit');
    assert(!t3SameRequest(attempt(true, owner), attempt(true, other)), 'native burn retry cannot redirect its terms');
    assert(!t3SameRequest(attempt(false, owner), attempt(false, other, 99n)), 'redirect cannot change atomic amount');
    let nativeTransactions = 0, hubTrees = 0, walletHistories = 0, injectedWalletGaps = 0, failureWitnesses = 0;
    for (let index = 1; index <= 6; index++) {
        const f = currentT3Fixture(`case-${String(index).padStart(2, '0')}.json`, 'recovery'), last = f.hubRows.at(-1)!;
        nativeTransactions += f.rows.length;
        const currentState = (await f.stateAt(f.hub, last.raw.lt, last.raw.hash))!;
        const source = { binding: f.binding, transactions: f.hubRows.map((r: any) => r.raw), currentState, stateAt: f.stateAt };
        if (index === 1) {
            let reads = 0;
            const controller = new AbortController();
            setImmediate(() => controller.abort());
            await assert.rejects(reconstructCurrentT3Receipts({ ...source, signal: controller.signal, stateAt: async (a, l, h) => { reads++; return f.stateAt(a, l, h); } }), { name: 'AbortError' });
            assert.equal(reads, 0, 'cancellation during cooperative yield precedes archive work');
        }
        const receipts = await reconstructCurrentT3Receipts(source);
        assert.equal(receipts.status, 'ok', JSON.stringify(receipts));
        if (receipts.status === 'ok')
            for (const tree of receipts.trees) {
                hubTrees++;
                for (const candidate of tree.records) {
                    const witness = Cell.fromBase64(candidate.witnessBoc).beginParse(), record = witness.loadRef(), proof = witness.loadRef();
                    witness.endParse();
                    assert.equal(t3PathRoot(BigInt(candidate.key), record, proof).toString(16).padStart(64, '0'), tree.root);
                }
            }
        assert.equal((await reconstructCurrentT3Receipts({ ...source, transactions: source.transactions.filter((_: any, i: number) => i !== 1) })).status, 'unavailable');
        assert.equal((await reconstructCurrentT3Receipts({ ...source, currentState: { ...currentState, seqno: -1 } })).status, 'unavailable');
        const walletAccounts = new Set<string>(f.rows.filter((r: any) => r.row.after.codeBoc && Cell.fromBase64(r.row.after.codeBoc).hash().toString('hex') === f.binding.walletCodeHash).map((r: any) => r.account));
        for (const wallet of walletAccounts) {
            const rows = f.rows.filter((r: any) => r.account === wallet), last = rows.at(-1)!, state = readCurrentT3Wallet(last.row.after.dataBoc);
            if (index === 1)
                await assert.rejects(reconstructCurrentT3WalletClaims({ binding: f.binding, wallet, owner: state.owner, transactions: rows.map((r: any) => r.raw), currentState: (await f.stateAt(wallet, last.raw.lt, last.raw.hash))!, stateAt: f.stateAt, signal: AbortSignal.abort() }), { name: 'AbortError' });
            const claims = await reconstructCurrentT3WalletClaims({ binding: f.binding, wallet, owner: state.owner, transactions: rows.map((r: any) => r.raw), currentState: (await f.stateAt(wallet, last.raw.lt, last.raw.hash))!, stateAt: f.stateAt });
            if ([...f.ambiguousStates].some(k => k.startsWith(wallet + ':'))) {
                assert.equal(claims.status, 'unavailable', 'injected GRAM drain is not continuous physical history');
                injectedWalletGaps++;
                continue;
            }
            assert.equal(claims.status, 'ok', JSON.stringify(claims));
            walletHistories++;
            if (claims.status === 'ok') {
                for (const claim of claims.records)
                    assert.equal(t3PathRoot(BigInt(claim.id), Cell.fromBase64(claim.recordBoc), Cell.fromBase64(claim.proofBoc)).toString(16).padStart(64, '0'), claims.root);
                // The wallet failure journal uses leaf/node domains 1/2, not
                // the claim tree's 3/4. Authenticate the complete returned
                // witness independently before a client can mark a claim.
                for (const failure of claims.failures) {
                    const evidence = Cell.fromBase64(failure.evidenceBoc), s = evidence.beginParse();
                    assert.equal(s.loadAddress().toRawString(), wallet);
                    assert.equal(s.loadRef().hash().toString('hex'), failure.attemptHash);
                    s.endParse();
                    let hash = beginCell().storeUint(1, 8).storeRef(evidence).endCell().hash();
                    let path = Cell.fromBase64(failure.proofBoc).beginParse();
                    const key = BigInt(failure.index);
                    for (let depth = 0; depth < 64; depth++) {
                        const sibling = path.loadBuffer(32), tail = path.loadMaybeRef();
                        path.endParse();
                        assert.equal(tail === null, depth === 63);
                        hash = ((key >> BigInt(depth)) & 1n) === 0n
                            ? beginCell().storeUint(2, 8).storeBuffer(hash).storeBuffer(sibling).endCell().hash()
                            : beginCell().storeUint(2, 8).storeBuffer(sibling).storeBuffer(hash).endCell().hash();
                        if (tail) path = tail.beginParse();
                    }
                    assert.equal(hash.toString('hex'), claims.failureRoot);
                    failureWitnesses++;
                }
                if (index === 1 && claims.records.length) {
                    const source = { binding: f.binding, wallet, owner: state.owner, transactions: rows.map((r: any) => r.raw), currentState: (await f.stateAt(wallet, last.raw.lt, last.raw.hash))!, stateAt: f.stateAt };
                    for (const transactions of [source.transactions.slice(1), source.transactions.slice(0, -1), source.transactions.map((r: any, i: number) => i === 0 ? { ...r, totalFeesRaw: '999' } : r)])
                        assert.equal((await reconstructCurrentT3WalletClaims({ ...source, transactions })).status, 'unavailable', 'missing or changed original history cannot produce a recovery claim');
                    assert.equal((await reconstructCurrentT3WalletClaims({ ...source, owner: other.toRawString() })).status, 'unavailable', 'a claim is bound to the canonical owner wallet');
                    assert.equal((await reconstructCurrentT3WalletClaims({ ...source, binding: { ...f.binding, proofCodeHash: '0'.repeat(64) } })).status, 'unavailable', 'recovery code is part of the immutable wallet identity');
                }
            }
        }
    }
    assert.equal(nativeTransactions, 806);
    assert.equal(injectedWalletGaps, 2);
    assert(failureWitnesses > 0, 'original native traces exercise failure-journal proof paths');
    for (let index = 3; index <= 6; index++) {
        const f = currentT3MintFixture(`case-0${index}.json`), projection = await projectOwnerLedger(f.input), settled = projection.events.filter(e => e.settlement?.protocol === 't3' && e.settlement.status === 'confirmed');
        if (index <= 4) {
            const redeemed = settled.filter(e => e.settlement?.t3?.stage === 'redeemed');
            assert.equal(redeemed.length, 1);
            assert.deepEqual(redeemed[0].settlement!.t3!.deliveredRaw, ['500000', '500000', '0']);
            assert.equal(redeemed[0].movements.filter(m => m.purpose === 't3_burn').length, 1, 'payout retries cannot debit T3 twice');
        }
        else {
            assert.equal(settled.filter(e => e.settlement?.t3?.stage === 'minted').length, 3, 'prior mint and authenticated later retry retain separate physical credit');
            const r = f.rows.find((r: any) => r.raw.lt === '122000000')!, owner = readCurrentT3Wallet(r.row.after.dataBoc).owner;
            const restored = await currentT3WalletDelta(f.input, { account: r.account, raw: r.raw, id: r.raw.lt }, f.binding, owner, 0n);
            assert(restored?.frozenData, 'frozen account must restore the exact committed current StateInit');
            assert.equal(restored.beforeState!.balance, restored.afterState.balance, 'unfreeze is not a mint');
        }
    }
    const f = currentT3MintFixture(), projected = await projectOwnerLedger(f.input), settled = projected.events.filter(e => e.settlement?.protocol === 't3' && e.settlement.status === 'confirmed');
    assert.equal(settled.filter(e => e.settlement?.t3?.stage === 'minted').length, 2, 'pair and direct mint remain separate operations');
    for (const event of settled.filter(e => e.settlement?.t3?.receipt?.slot !== 3 && e.settlement?.t3?.receipt)) {
        const receipt = event.settlement!.t3!.receipt!, request = receipt.request;
        const original = f.rows.find((r: any) => r.account === request.sourceWallet && bodyCell(r.raw.inMessage)?.hash().toString('hex') === request.bodyHash);
        assert(original);
        const wire = tokenWire(original.raw.inMessage);
        assert.equal(wire?.amountRaw, request.amountRaw);
        assert.equal(wire?.queryId, request.queryId);
        assert.equal(f.input.wallets.get(original.account)?.master, f.binding.reserveRoutes[receipt.slot].root, 'pair request identity belongs to its own receipt slot');
    }
    for (const stage of ['redeemed', 'refunded', 'cancelled'])
        assert.equal(settled.filter(e => e.settlement?.t3?.stage === stage).length, 1, stage);
    assert.equal(settled.filter(e => e.kind === 'transfer').length, 1);
    const ownT3 = [...f.input.wallets.values()].find(a => a.owner === f.input.owner && a.master === f.hub)!;
    const finalWallet = f.rows.filter((r: any) => r.account === ownT3.wallet).at(-1)!;
    const t3Net = projected.events.flatMap(e => e.movements).filter(m => m.asset.master === f.hub).reduce((n, m) => n + (m.direction === 'in' ? 1n : -1n) * BigInt(m.amountRaw), 0n);
    assert.equal(t3Net, readCurrentT3Wallet(finalWallet.row.after.dataBoc).balance, 'original debits, delivered credits and cancellation restore conserve physical T3');
    const cancel = settled.find(e => e.settlement?.t3?.stage === 'cancelled')!.settlement!.t3!.walletRecovery!;
    assert.notEqual(cancel.requestBodyHash, cancel.recoveryBodyHash);
    const missing = currentT3MintFixture(), wallet = [...missing.input.wallets.values()].find(a => a.owner === missing.input.owner && a.master === missing.hub)!;
    missing.input.chains.get(wallet.wallet!)!.transactions = [];
    const incomplete = await projectOwnerLedger(missing.input);
    assert(!incomplete.events.some(e => e.settlement?.t3?.stage === 'minted' && e.settlement.status === 'confirmed'), 'receipt status without physical mint credit cannot settle');
    const missingArchive = currentT3MintFixture(), stateAt = missingArchive.input.stateAt;
    missingArchive.input.stateAt = async (a, l, h) => a === missingArchive.config.vaults[0] ? null : stateAt(a, l, h);
    assert(!(await projectOwnerLedger(missingArchive.input)).events.some(e => e.settlement?.t3?.stage === 'minted' && e.settlement.status === 'confirmed'), 'missing reserve boundary cannot certify collateral');
    console.log(`current T3 native: ${nativeTransactions} original transactions, ${hubTrees} reconstructed hub trees, ${walletHistories} wallet histories, ${failureWitnesses} independent failure witnesses, ${injectedWalletGaps} explicit injected-state gaps; physical mint/pair/transfer/redeem/refund/cancel and negative evidence checks passed`);
    console.log(`current T3: ${commitments} authenticated G14 receipt commitments, ${negative} negative boundaries, sparse witness/update checks passed; partial source-closure qualification explicitly retained`);
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
