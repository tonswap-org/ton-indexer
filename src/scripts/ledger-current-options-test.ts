import { currentOptionsProjectionFixture, currentOptionsGraphFixture } from './support/currentOptionsFixture';
import { projectOwnerLedger } from '../ledger/project';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { Address } from '@ton/core';
import { decodeCurrentOptionsOperations } from '../ledger/currentOptions';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { readCurrentCaptureManifest, assertCurrentCaptureTargets, currentCaptureSha256 as sha } from './current-capture-build';
async function main() {
    const root = join(__dirname, 'fixtures/current-options-native'), build = join(__dirname, 'fixtures/current-capture-build');
    const indexBytes = readFileSync(join(root, 'index.json')), index = JSON.parse(indexBytes.toString());
    assert.equal(sha(indexBytes), '278173a1fe01ea68a0fbb34ab0ed3bf9dae022f0a9a7895d4bfa94f74e935cdf');
    const snapshot = readCurrentCaptureManifest({ nativeRoot: join(build, 'source'), artifactRoot: join(build, 'artifacts'), manifestPath: join(build, 'manifest.json'), expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
    assertCurrentCaptureTargets(snapshot, Object.keys(snapshot.manifest.targets));
    assert.equal(index.schema, 'tonswap-current-options-fixtures-v1');
    assert.equal(index.manifestSha256, snapshot.sha256);
    const receiptBytes = readFileSync(join(root, 'producer-receipt.json')), receipt = JSON.parse(receiptBytes.toString()), log = readFileSync(join(root, 'producer.log'));
    assert.equal(sha(receiptBytes), index.producerReceiptSha256);
    assert.equal(sha(log), index.logSha256);
    assert.equal(sha(readFileSync(join(root, 'source-inventory.json'))), index.sourceInventorySha256);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.completed, true);
    assert.equal(receipt.sourcePrePostEqual, true);
    assert.equal(receipt.tests, 10);
    assert.equal(receipt.captureCount, 24);
    assert.equal(receipt.manifestSha256, snapshot.sha256);
    assert.match(log.toString(), /^ Test Files\s+2 passed \(2\)$/m);
    assert.match(log.toString(), /^\s+Tests\s+10 passed \(10\)$/m);
    assert.doesNotMatch(log.toString(), /\b(?:failed|skipped)\b/i);
    const roles = { factoryHash: 'OptionFactory', vaultHash: 'OptionVault', managerHash: 'OptionSeriesManager', shoutHash: 'ShoutOption', outperfHash: 'OutperformanceOption', t3MasterHash: 'T3Hub', t3WalletHash: 'T3Wallet' };
    let checks = 0;
    const cases = new Map<string, any>();
    function select(c: any, e: OrderTransactionEvidence[] = c.completeTransactions) { const operations = decodeCurrentOptionsOperations(c.request.owner, c.binding, e); return operations.find(o => o.request.dispatch.hash === c.request.dispatch.hash && o.request.bodyHash === c.request.bodyHash); }
    for (const f of index.files) {
        const compressed = readFileSync(join(root, f.file));
        assert.equal(sha(compressed), f.sha256);
        const bytes = brotliDecompressSync(compressed);
        assert.equal(bytes.length, f.originalBytes);
        assert.equal(sha(bytes), f.originalSha256);
        assert.equal(receipt.artifacts['captures/' + f.originalFile], f.originalSha256);
        const c = JSON.parse(bytes.toString());
        for (const [key, role] of Object.entries(roles))
            assert.equal(c.binding.options[key], snapshot.manifest.targets[role].codeHash);
        assert.equal(c.binding.proofCodeHash, snapshot.manifest.targets.T3RecoveryProof.codeHash);
        for (const k of ['factory', 'vault', 'manager', 'governance', 'feeSink', 'treasury', 't3Root'])
            c.binding.options[k] = Address.parse(c.binding.options[k]);
        const op = select(c);
        assert(op, `${f.file}: original owner request must be independently discovered`);
        const e = op.economics;
        const name = f.originalFile.replace(/-(default|x6)\.json$/, '');
        const outcomes: Record<string, string> = { buy: 'accepted', 'real-pool-buy': 'accepted', fund: 'delivered', withdraw: 'delivered', owed: 'delivered', payout: 'delivered', 'zero-payout': 'delivered', 'exercise-refused': 'rejected', refund: 'refunded', 'retry-before-mark': 'accepted', 'retry-marked': 'accepted', retry: 'delivered' };
        const expected = outcomes[name];
        assert(expected);
        assert.equal(e.outcome, expected, f.file);
        if (name === 'buy' || name === 'real-pool-buy') {
            assert.equal(e.paidInRaw, '40000000');
            assert.equal(e.rightAcquiredRaw, '1000000000');
            assert.equal(BigInt(e.premiumNetRaw) + BigInt(e.protocolFeeRaw), 40000000n);
            assert.equal(e.paidOutRaw, '0');
        }
        if (name === 'fund') {
            assert.equal(e.writerBackingRaw, '22500000000');
            assert.equal(e.paidInRaw, '22500000000');
            assert.equal(e.cash.length, 1);
            assert.equal(e.rightAcquiredRaw, '0');
        }
        if (name === 'refund') {
            assert.equal(e.paidInRaw, '39999999');
            assert.equal(e.paidOutRaw, '39999999');
            assert.equal(e.rightAcquiredRaw, '0');
            assert.equal(e.cash.length, 2);
        }
        if (name === 'payout') {
            assert.equal(e.paidOutRaw, '100000000');
            assert.equal(e.rightRetiredRaw, '1000000000');
        }
        if (name === 'zero-payout') {
            assert.equal(e.rightRetiredRaw, '1000000000');
            assert.equal(e.paidOutRaw, '0');
            assert.equal(e.cash.length, 0);
        }
        if (name === 'exercise-refused') {
            assert.equal(e.rightRetiredRaw, '0');
            assert.equal(e.paidOutRaw, '0');
            assert.equal(e.cash.length, 0);
        }
        if (['withdraw', 'owed', 'retry'].includes(name)) {
            assert.equal(e.paidOutRaw, '22500000000');
            assert.equal(e.cash.length, 1);
            assert.equal(e.paidInRaw, '0');
        }
        if (name === 'retry-before-mark' || name === 'retry-marked') {
            assert.equal(e.pendingOutRaw, '22500000000');
            assert.equal(e.paidOutRaw, '0');
            assert.equal(e.cash.length, 0);
        }
        assert.equal(new Set(e.cash.map(leg => leg.ownerTransaction)).size, e.cash.length, 'A retried debit or credit cannot count twice');
        cases.set(f.originalFile, { capture: c, operation: op });
        checks++;
    }
    const bought = cases.get('buy-default.json')!, paid = cases.get('payout-default.json')!, refund = cases.get('refund-default.json')!, retry = cases.get('retry-default.json')!;
    for (const sample of [bought, paid, refund, retry]) {
        const c = sample.capture, positive = sample.operation.economics;
        const wrong = { ...c, binding: { ...c.binding, options: { ...c.binding.options, vaultHash: '00'.repeat(32) } } };
        const rejected = select(wrong);
        assert(!rejected || rejected.economics.outcome === 'unresolved');
        checks++;
        const debit = positive.cash.find((x: any) => x.direction === 'out')?.debitTransaction ?? positive.cash[0]?.debitTransaction;
        assert(debit);
        const removed = c.completeTransactions.filter((t: OrderTransactionEvidence) => verifyOrderTransaction(t).hash !== debit), missing = select(c, removed);
        assert(!missing || missing.economics.outcome === 'unresolved' || (missing.economics.outcome === 'accepted' && missing.economics.paidOutRaw === '0' && BigInt(missing.economics.pendingOutRaw) > 0n));
        if (missing)
            assert(!missing.economics.cash.some(x => x.direction === 'in'));
        checks++;
        const foreign = decodeCurrentOptionsOperations(c.binding.options.governance.toRawString(), c.binding, c.completeTransactions);
        assert(!foreign.some(o => o.request.bodyHash === c.request.bodyHash));
        checks++;
    }
    for (const sample of [paid, refund, retry, cases.get('owed-default.json')!]) {
        const c = sample.capture, credit = sample.operation.economics.cash.find((x: any) => x.direction === 'in').creditTransaction;
        const missing = select(c, c.completeTransactions.filter((t: OrderTransactionEvidence) => verifyOrderTransaction(t).hash !== credit));
        assert(missing);
        assert.equal(missing.economics.paidOutRaw, '0');
        assert(!missing.economics.cash.some(x => x.direction === 'in'));
        assert(BigInt(missing.economics.pendingOutRaw) > 0n);
        checks++;
    }
    const c = bought.capture;
    assert.throws(() => decodeCurrentOptionsOperations(c.request.owner, c.binding, [...c.completeTransactions, c.completeTransactions[0]]), /identity mismatch/);
    checks++;
    const corrupt = structuredClone(c.completeTransactions);
    corrupt[0].afterShardAccountBoc = corrupt[1].afterShardAccountBoc;
    assert.throws(() => decodeCurrentOptionsOperations(c.request.owner, c.binding, corrupt));
    checks++;
    for (const name of ['buy-default.json', 'fund-default.json', 'refund-default.json', 'payout-default.json', 'zero-payout-default.json', 'exercise-refused-default.json', 'retry-before-mark-default.json', 'retry-default.json']) {
        const sample = cases.get(name)!, input = currentOptionsProjectionFixture(sample.capture), projected = await projectOwnerLedger(input);
        const event = projected.events.find(e => e.settlement?.currentOptions?.requestBodyHash === sample.capture.request.bodyHash && e.settlement?.currentOptions?.dispatch.hash === sample.capture.request.dispatch.hash);
        assert(event, `${name}: ordinary ledger must retain the inferred current operation`);
        const financial = event.movements.filter(m => m.asset.kind === 'jetton' && m.asset.master === input.currentOptionsBinding!.options.t3Root.toRawString());
        const total = (direction: string) => financial.filter(m => m.direction === direction && m.evidence.kind === 'jetton_internal_transfer').reduce((n, m) => n + BigInt(m.amountRaw ?? '0'), 0n).toString();
        assert.equal(total('in'), sample.operation.economics.paidOutRaw, `${name}: one physical cash credit`);
        assert.equal(total('out'), sample.operation.economics.paidInRaw, `${name}: one physical cash debit`);
        assert.equal(event.movements.filter(m => m.asset.kind === 'option_position' && m.direction === 'in').reduce((n, m) => n + BigInt(m.amountRaw ?? '0'), 0n).toString(), sample.operation.economics.rightAcquiredRaw);
        assert.equal(event.movements.filter(m => m.asset.kind === 'option_position' && m.direction === 'out').reduce((n, m) => n + BigInt(m.amountRaw ?? '0'), 0n).toString(), sample.operation.economics.rightRetiredRaw);
        assert(!event.issues.includes('multiple_protocol_operations_grouped'), name);
        if (sample.operation.economics.pendingOutRaw === '0')
            assert(!event.issues.some(i => ['settlement_not_decoded', 'transaction_not_decoded'].includes(i)), `${name}: ${event.issues}`);
        assert.equal(event.settlement!.status, sample.operation.economics.pendingOutRaw === '0' ? 'confirmed' : 'incomplete', `${name}: cash pending remains incomplete`);
        checks++;
    }
    const graphInput = currentOptionsProjectionFixture(bought.capture), graph = await currentOptionsGraphFixture(graphInput);
    assert.equal(graph.bindings[`current-options:${bought.capture.request.factory}`], true);
    assert(graph.currentOptionsBinding);
    assert(graph.chains.has(bought.capture.request.vault));
    const current = await projectOwnerLedger({ network: graphInput.network, owner: graphInput.owner, ...graph, opcodes: graphInput.opcodes, t3Hubs: graphInput.t3Hubs });
    assert(current.events.some(e => e.settlement?.currentOptions?.requestBodyHash === bought.capture.request.bodyHash && e.settlement?.status === 'confirmed'));
    checks++;
    const unavailable = await currentOptionsGraphFixture(graphInput, { missingAccount: bought.capture.request.vault });
    assert.equal(unavailable.currentOptionsBinding, undefined);
    assert(unavailable.issues.includes('option_current_discovery_unavailable'));
    checks++;
    const bounded = await currentOptionsGraphFixture(graphInput, { maxAccounts: 1 });
    assert(bounded.issues.includes('related_account_limit_reached'));
    const boundedProjection = await projectOwnerLedger({ network: graphInput.network, owner: graphInput.owner, ...bounded, opcodes: graphInput.opcodes });
    assert(!boundedProjection.events.some(e => e.settlement?.protocol === 'options' && e.settlement?.status === 'confirmed'));
    checks++;
    const noT3 = await projectOwnerLedger({ ...graphInput, t3Hubs: new Map() });
    assert(!noT3.events.some(e => e.settlement?.currentOptions?.requestBodyHash === bought.capture.request.bodyHash && e.settlement?.status === 'confirmed'), 'Options cannot claim complete cash when physical T3 projection is unavailable');
    checks++;
    const noArchive = await projectOwnerLedger({ ...graphInput, stateAt: async () => null });
    assert(!noArchive.events.some(e => e.settlement?.protocol === 'options' && e.settlement?.status === 'confirmed'));
    checks++;
    console.log(`Current Options: ${checks} native original/source/owner inference/economic and refusal checks passed across 24 default/x6 captures; sandbox head and release mocks remain explicit.`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
