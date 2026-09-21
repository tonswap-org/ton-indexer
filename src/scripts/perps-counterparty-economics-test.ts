import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, loadTransaction } from '@ton/core';
import { perpsEconomics, counterpartyClose } from '../ledger/perpsEconomics';
import { readPerpsState, perpsPosition } from '../ledger/perpsState';
import { perpsWalletAddress } from '../ledger/perpsWire';
const cp = (reserved: bigint, pendingFunding = 0n, collectedLoss = 0n) => ({ reserved, pendingFunding, collectedLoss });
assert.deepEqual(counterpartyClose(cp(100n, 10n), 20n, 1n, 3n, 100n, 0n, 0n), {
    state: cp(60n), forced: false, closed: 1n, pnl: 6n, profit: 16n, debit: 0n, unpaid: 0n, released: 24n
});
assert.equal(counterpartyClose(cp(50n, 100n), -10n, 1n, 2n, 100n, 0n, 0n).profit, 40n);
assert.equal(counterpartyClose(cp(100n), -1n, 1n, 3n, 100n, 0n, 0n).debit, 1n);
assert.equal(counterpartyClose(cp(200n), 0n, 80n, 100n, 100n, 150n, 0n).forced, false);
assert.equal(counterpartyClose(cp(2n), 10n, 1n, 1n, 0n, 0n, 1n).profit, 1n, 'Cap gross gap profit before subtracting unpaid funding');
assert.equal(counterpartyClose(cp(20n), 10n, 1n, 2n, 0n, 0n, 1n).closed, 2n, 'Funding debt compels a full close');
for (let i = 1; i <= 40; i++) {
    const R = BigInt(1 + i * 7), S = BigInt(2 + i % 9), r = counterpartyClose(cp(R, BigInt(i % 13), 3n), BigInt(i % 2 ? i * 11 : -i * 9), BigInt(1 + i % Number(S)), S, BigInt(i % 7), 1n, 0n);
    assert.equal(r.state.reserved + r.profit + r.released, R);
    assert.equal(r.state.collectedLoss, 3n + r.debit);
}
for (const name of ['open-accepted', 'modify-accepted']) {
    const f = JSON.parse(readFileSync(join(__dirname, 'fixtures/perps-risk-admission-current', name + '.json'), 'utf8'));
    const hash = Cell.fromBase64(f.engineCode).hash().toString('hex'), owner = Address.parse(f.owner).toRawString(), engine = BigInt('0x' + Address.parse(f.engine).hash.toString('hex'));
    let checked = 0;
    for (const saved of f.transactions) {
        const tx = loadTransaction(Cell.fromBase64(saved.transaction).beginParse());
        if (tx.address !== engine)
            continue;
        const before = readPerpsState(saved.oldStorage, hash), after = readPerpsState(saved.newStorage, hash);
        const receipt = [...after.oracleRefreshes.values()].map(rows => rows.get(owner)).find(row => row?.order?.outcome === 2);
        if (!receipt || JSON.stringify(perpsPosition(before, owner, receipt.order!.request.marketId)) === JSON.stringify(perpsPosition(after, owner, receipt.order!.request.marketId)))
            continue;
        const request = receipt.order!.request, deposit = receipt.order!.funding?.amountRaw ?? '0', wallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, owner);
        const result = perpsEconomics(before, after, owner, wallet, request, deposit);
        assert(result, `${name}: authentic execution passes isolated capital and engine cash ledger conservation`);
        const tampered = { ...after, accounts: new Map(after.accounts) };
        tampered.accounts.set(owner, { ...after.accounts.get(owner)!, collateralRaw: (BigInt(after.accounts.get(owner)!.collateralRaw) + 1n).toString() });
        assert.equal(perpsEconomics(before, tampered, owner, wallet, request, deposit), null, 'Synthetic pooled profit credit is rejected');
        checked++;
    }
    assert.equal(checked, 1, `${name}: exactly one economic execution boundary`);
}
console.log('Perps isolated counterparty integer arithmetic and authentic execution conservation passed');
