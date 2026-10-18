import assert from 'node:assert/strict';
import { Address, beginCell, Cell, type TupleItem } from '@ton/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveT3RedemptionBinding } from '../ledger/runtimeT3Binding';
import { validateT3RedemptionBinding } from '../ledger/bindings';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { currentT3Fixture } from './support/currentT3Fixture';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
const cell = (path: string) => Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/current-t3', path)))[0];
const addr = (address: string): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(Address.parse(address)).endCell() });
async function main() {
    const f = currentT3Fixture(), base = runtimeManifestFixture(), head = fixtureHead(123), last = f.hubRows.at(-1)!;
    const walletCodes = [cell('stablecoin/JettonWallet.code.boc'), cell('stablecoin/JettonWallet.code.boc'), cell('hub/compiler/JettonV21Wallet.boc')];
    const masterCodes = [cell('stablecoin/JettonMinter.code.boc'), cell('stablecoin/JettonMinter.code.boc'), cell('hub/compiler/JettonV21Minter.boc')];
    const tokens = f.binding.reserveRoutes.map((r, i) => ({ symbol: ['USDT', 'USDC', 'KUSD'][i], root: r.root, decimals: r.decimals, masterCodeHash: masterCodes[i].hash().toString('hex'), walletCodeHash: walletCodes[i].hash().toString('hex') }));
    const manifest = { ...base, contracts: { ...base.contracts, T3Hub: { address: f.hub, codeHash: f.binding.hubCodeHash }, Governance: { address: f.state.governance, codeHash: base.contracts.Governance!.codeHash } }, templates: { ...base.templates, T3Wallet: f.state.walletCodeHash, T3RecoveryProof: f.state.proofCodeHash, JettonV21Wallet: walletCodes[2].hash().toString('hex') }, tokens, vendor: { ...base.vendor, stablecoin: { ...base.vendor.stablecoin, wallet: { ...base.vendor.stablecoin.wallet, codeHash: walletCodes[0].hash().toString('hex') } } } };
    let corrupt = false, reads = 0, expectedSignal: AbortSignal | undefined;
    const source = fakeChainSource({ head: async () => head, getAccountState: async (address, options) => {
            assert.equal(options?.at, head);
            assert.equal(options?.signal, expectedSignal);
            reads++;
            if (address === f.hub)
                return { accountState: 'active', balance: '0', codeBoc: last.row.codeBoc, dataBoc: last.row.afterDataBoc };
            const root = tokens.findIndex(t => t.root === address);
            if (root >= 0)
                return { accountState: 'active', balance: '0', codeBoc: (corrupt ? Cell.EMPTY : masterCodes[root]).toBoc().toString('base64') };
            const wallet = f.binding.reserveRoutes.findIndex(r => r.vault === address);
            assert(wallet >= 0);
            return wallet === 2 ? { accountState: 'uninitialized', balance: '0' } : { accountState: 'active', balance: '0', codeBoc: walletCodes[wallet].toBoc().toString('base64'), lastTxLt: '1', lastTxHash: '1'.repeat(64) };
        }, runGetMethod: async (address, method, args, options) => {
            assert.equal(options?.at, head);
            assert.equal(options?.signal, expectedSignal);
            reads++;
            const root = tokens.findIndex(t => t.root === address), wallet = f.binding.reserveRoutes.findIndex(r => r.vault === address);
            if (method === 'get_jetton_data')
                return { exitCode: 0, stack: [{ type: 'int', value: 0n }, { type: 'int', value: -1n }, { type: 'null' }, { type: 'cell', cell: Cell.EMPTY }, { type: 'cell', cell: walletCodes[root] }] };
            if (method === 'get_wallet_address')
                return { exitCode: 0, stack: [addr(f.binding.reserveRoutes[root].vault)] };
            if (method === 'get_wallet_data')
                return { exitCode: 0, stack: [{ type: 'int', value: 0n }, addr(f.hub), addr(tokens[wallet].root), { type: 'cell', cell: walletCodes[wallet] }] };
            throw Error(method);
        } });
    const binding = await deriveT3RedemptionBinding(manifest, source);
    assert(binding);
    assert.equal(binding.root, binding.hub);
    assert.equal(binding.reserveRoutes[2].profile.wallet, null);
    assert.equal(binding.reserveRoutes[0].decimals, 6);
    assert.equal(binding.reserveRoutes[2].decimals, 9);
    assert(reads > 10);
    validateT3RedemptionBinding(binding, binding.network);
    corrupt = true;
    await assert.rejects(() => deriveT3RedemptionBinding(manifest, source), /not authenticated/);
    corrupt = false;
    await assert.rejects(() => deriveT3RedemptionBinding({ ...manifest, templates: { ...manifest.templates, T3RecoveryProof: '0'.repeat(64) } }, source), /template mismatch/);
    await assert.rejects(() => deriveT3RedemptionBinding({ ...manifest, tokens: tokens.map((t, i) => i === 0 ? { ...t, decimals: 9 } : t) }, source), /precision/);
    assert.throws(() => validateT3RedemptionBinding({ ...binding, root: tokens[0].root }, 'localnet'));
    expectedSignal=new AbortController().signal;
    assert(await deriveT3RedemptionBinding(manifest,source,{at:head,signal:expectedSignal}));
    console.log('current T3 binding: authenticated hub/master, per-token pins, mixed precision, optional undiscovered reserve, one-head reads and mismatch rejection passed');
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
