import assert from 'node:assert/strict';
import { Address, beginCell, Cell, contractAddress } from '@ton/core';
import type { AccountStateResponse } from '../data/dataSource';
import { buildTonswapJettonWalletInitialData } from '../data/jettonAbi';
import { deriveT3RedemptionBinding } from '../ledger/runtimeT3Binding';
import { releaseDatabaseSchema, releaseSnapshotPath } from '../releaseState';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';

// Synthetic current JTRS/StateInit fixtures. These exercise pin validation and
// deterministic derivation only; no compiled or deployed contract is claimed.
const rootCode = beginCell().storeUint(0x524f4f54, 32).endCell();
const walletCode = beginCell().storeUint(0x57414c4c, 32).endCell();
const otherCode = beginCell().storeUint(0x4f544852, 32).endCell();
const base = runtimeManifestFixture();
const manifest = runtimeManifestFixture({
  contracts: { ...base.contracts, T3Root: { ...base.contracts.T3Root!, codeHash: rootCode.hash().toString('hex') } },
  templates: { ...base.templates, JettonWallet: walletCode.hash().toString('hex') },
});
const hub = manifest.contracts.T3!;
const root = manifest.contracts.T3Root!;
const reserves = ['USDT', 'USDC', 'KUSD'].map(symbol => manifest.tokens.find(token => token.symbol === symbol)!.root);
const boc = (cell: Cell) => cell.toBoc().toString('base64');

function rootData(emitter: string | null = hub.address, code = walletCode): Cell {
  const admin = Address.parse(runtimeAddress(900));
  const registry = beginCell().storeAddress(admin).storeUint(1, 8).storeUint(0, 8).storeRef(Cell.EMPTY).endCell();
  const data = beginCell().storeCoins(123_000_000_000n).storeAddress(admin)
    .storeRef(code).storeRef(Cell.EMPTY).storeAddress(emitter === null ? null : Address.parse(emitter)).endCell();
  const receipts = beginCell().storeDict(null).endCell();
  const mintTail = beginCell().storeDict(null).storeDict(null).endCell();
  const mintState = beginCell().storeUint(1n, 64).storeDict(null).storeDict(null).storeRef(mintTail).endCell();
  return beginCell().storeUint(0x4a545253, 32).storeRef(registry).storeRef(data).storeRef(receipts).storeRef(mintState).endCell();
}

const activeState = (overrides: Partial<AccountStateResponse> = {}): AccountStateResponse => ({
  balance: '1000000000', accountState: 'active', codeBoc: boc(rootCode), dataBoc: boc(rootData()), ...overrides,
});
const sourceFor = (state: AccountStateResponse, calls: string[] = []) => ({
  async getAccountState(address: string) {
    calls.push(address);
    assert.equal(address, root.address, 'only the manifest-approved T3 root supplies the wallet Cell');
    return state;
  },
});

async function main() {
  const calls: string[] = [];
  const binding = await deriveT3RedemptionBinding(manifest, sourceFor(activeState(), calls));
  assert.deepEqual(calls, [root.address]);
  assert(binding);
  assert.deepEqual(binding, {
    network: 'testnet', hub: hub.address, root: root.address,
    hubCodeHash: hub.codeHash, rootCodeHash: root.codeHash,
    walletCodeHash: manifest.templates.JettonWallet, receiverCodeHash: manifest.templates.T3Receiver,
    reserveRoutes: reserves.map(reserve => ({
      root: reserve, discovery: reserve,
      vault: contractAddress(0, {
        code: walletCode,
        data: buildTonswapJettonWalletInitialData(Address.parse(hub.address), Address.parse(reserve)),
      }).toRawString(),
    })),
  });
  assert.equal(new Set(binding.reserveRoutes.map(route => route.vault)).size, 3);
  assert.notEqual(binding.reserveRoutes[0].vault, contractAddress(0, {
    code: walletCode,
    data: buildTonswapJettonWalletInitialData(Address.parse(runtimeAddress(901)), Address.parse(reserves[0])),
  }).toRawString(), 'reserve wallet custody belongs to the approved hub');

  const reordered = runtimeManifestFixture({ ...manifest, tokens: [...manifest.tokens].reverse() });
  assert.deepEqual(await deriveT3RedemptionBinding(reordered, sourceFor(activeState())), binding,
    'reserve routes follow USDT/USDC/KUSD identity, not token inventory order');

  await assert.rejects(deriveT3RedemptionBinding(manifest, sourceFor(activeState({ codeBoc: boc(otherCode) }))),
    /root state does not match/, 'a live code hash cannot replace the approved root pin');
  for (const emitter of [runtimeAddress(902), null]) {
    await assert.rejects(deriveT3RedemptionBinding(manifest, sourceFor(activeState({ dataBoc: boc(rootData(emitter)) }))),
      /emitter or wallet template/, 'a foreign or absent issuer never qualifies the T3 root');
  }
  await assert.rejects(deriveT3RedemptionBinding(manifest, sourceFor(activeState({ dataBoc: boc(rootData(hub.address, otherCode)) }))),
    /emitter or wallet template/, 'observed wallet code is checked against the manifest template');
  const wrongWalletPin = runtimeManifestFixture({ ...manifest,
    templates: { ...manifest.templates, JettonWallet: otherCode.hash().toString('hex') } });
  await assert.rejects(deriveT3RedemptionBinding(wrongWalletPin, sourceFor(activeState())), /emitter or wallet template/);

  for (const symbol of ['USDT', 'USDC', 'KUSD']) {
    const incomplete = runtimeManifestFixture({ ...manifest, tokens: manifest.tokens.filter(token => token.symbol !== symbol) });
    const queried: string[] = [];
    await assert.rejects(deriveT3RedemptionBinding(incomplete, sourceFor(activeState(), queried)), /all three declared reserve roots/);
    assert.deepEqual(queried, [], 'incomplete reserve qualification fails before querying current state');
  }
  for (const state of [activeState({ accountState: 'frozen' }), activeState({ accountState: 'uninitialized' }),
    activeState({ codeBoc: null }), activeState({ dataBoc: null })]) {
    await assert.rejects(deriveT3RedemptionBinding(manifest, sourceFor(state)), /root state does not match/);
  }
  await assert.rejects(deriveT3RedemptionBinding(manifest, sourceFor(activeState({ dataBoc: boc(Cell.EMPTY) }))),
    'an old or incomplete root layout cannot qualify the wallet code');
  const absent = runtimeManifestFixture({ ...manifest,
    contracts: Object.fromEntries(Object.entries(manifest.contracts).filter(([role]) => role !== 'T3')) });
  const unused: string[] = [];
  assert.equal(await deriveT3RedemptionBinding(absent, sourceFor(activeState(), unused)), undefined);
  assert.deepEqual(unused, [], 'an absent T3 hub does not invent a recovery binding');

  const hashA = 'a'.repeat(64), hashB = 'a'.repeat(63) + 'b';
  const snapshotA = releaseSnapshotPath('/durable/snapshots/indexer', hashA)!;
  const snapshotB = releaseSnapshotPath('/durable/snapshots/indexer', hashB)!;
  assert.notEqual(snapshotA, snapshotB, 'snapshot names bind every manifest hash byte');
  assert(snapshotA.includes(hashA) && snapshotB.includes(hashB));
  assert.equal(releaseSnapshotPath(undefined, hashA), undefined);
  const schema = releaseDatabaseSchema(hashA);
  assert(Buffer.byteLength(schema, 'utf8') <= 63, 'release schema fits PostgreSQL without silent truncation');
  assert.match(schema, /^[a-z_][a-z0-9_]*$/);
  assert.notEqual(schema, releaseDatabaseSchema('b' + hashA.slice(1)));
  for (const invalid of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${hashA} `, ` ${hashA}`, 'a;DROP SCHEMA public']) {
    assert.throws(() => releaseDatabaseSchema(invalid), /canonical manifest hash/);
    assert.throws(() => releaseSnapshotPath('/durable/snapshots/indexer', invalid), /canonical manifest hash/);
    assert.throws(() => releaseSnapshotPath(undefined, invalid), /canonical manifest hash/);
  }
  console.log('runtime T3 binding and release state tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
