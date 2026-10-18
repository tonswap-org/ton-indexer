import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntimeManifestBundle, hashRegistry, hashReleaseManifest, parseCanonicalReleaseManifest, readCanonicalReleaseManifest } from '../config/releaseManifest';
import { validateReleaseManifest } from '../config/runtimeManifest';
import { deriveRuntimeManifestBindings } from '../config/runtimeManifestBindings';
import { nativeLocalnetManifestText, retainedNativeLocalnetManifestText, runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ton-indexer-release-manifest-')));
const writeManifest = (name: string, overrides: Record<string, unknown> = {}) => {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(runtimeManifestFixture(overrides), null, 2) + '\n');
  return path;
};
const fixture = runtimeManifestFixture();
const contracts = Object.fromEntries(Object.entries(fixture.contracts).map(([role, c]) => [role, c!.address]));
try {
  const path = writeManifest('good.json');
  const parsed = readCanonicalReleaseManifest(path, 'testnet');
  assert.deepEqual(parsed.contracts, contracts);
  assert.equal(parsed.registryHash, hashRegistry(contracts));
  assert.equal(parsed.manifestHash, fixture.manifestHash);
  assert.equal(parsed.markets.length, 1);
  assert.equal(parsed.spotMarkets.length, 3);
  assert.equal(parsed.markets[0].perpsCandleMarketKey, 'perps-oracle:1');
  assert.equal(parsed.markets[0].perpsPoolCodeHash, fixture.templates.DlmmPool);
  assert.equal(parsed.markets[0].optionAddress, undefined, 'an independent option catalog never invents a perps-series pair');
  assert.equal(parsed.markets[0].oracle, undefined, 'manifest identity is not current oracle readiness');
  assert.equal(parsed.markets[0].coverPolicyId, undefined);
  assert.equal(parsed.approvedComparisons[0].comparisonPool, fixture.spotMarkets[1].pool);
  assert.deepEqual(buildRuntimeManifestBundle(parsed.runtime).metadata.runtime, fixture);
  assert.equal(buildRuntimeManifestBundle(parsed.runtime).metadata.manifestHash, fixture.manifestHash);
  assert.equal(validateReleaseManifest(fixture).ok, true);
  const native = parseCanonicalReleaseManifest(nativeLocalnetManifestText, 'localnet');
  const nativeBindings = deriveRuntimeManifestBindings(native.runtime);
  assert.equal(native.runtime.schema, 'tonswap-release-v1');
  assert.equal(nativeBindings.network, 'localnet');
  assert.equal(nativeBindings.currentSpotMarkets.length, native.runtime.spotMarkets.length);
  assert.equal(nativeBindings.t3Hub, native.runtime.contracts.T3Hub!.address);
  assert.equal(native.manifestHash, '50ab97938efad54a000298046e308d0f8f3911e15a6ddbd335797a1a6527ba64');
  assert.equal(JSON.parse(retainedNativeLocalnetManifestText).manifestHash, 'd83b6ab905f17bb363ca88504358a3a3840e1fae9c301ecb4c7eeceb32f59b56');
  assert.throws(() => parseCanonicalReleaseManifest(retainedNativeLocalnetManifestText, 'localnet'), /templates/);
  assert.equal(native.runtime.source.contracts, '0'.repeat(40), 'native fixture remains sandbox evidence');
  assert.deepEqual(native.runtime.orderKeeper, { address: '0:6e99eb37460359d88a06cc351a874e619c6f78c6773671cd1490173e64d1bba5' });
  assert.equal(nativeBindings.jettonRoots[0].walletCodeHash, native.runtime.templates.T3Wallet);
  assert.equal(nativeBindings.perpsEngine, native.runtime.contracts.PerpsEngine!.address);
  assert.equal(nativeBindings.currentLedgerDecodersQualified, false);
  assert.equal(nativeBindings.optionCodeHashes, undefined);
  assert.equal(nativeBindings.currentOptionsBinding.options.factory.toRawString(), native.runtime.contracts.OptionFactory!.address);
  assert.equal(nativeBindings.currentOptionsBinding.options.vaultHash, native.runtime.contracts.OptionVault!.codeHash);
  assert.equal(nativeBindings.currentOptionsBinding.proofCodeHash, native.runtime.templates.T3RecoveryProof);
  assert.equal(nativeBindings.currentOptionsBinding.manifestHash, native.runtime.manifestHash);
  assert.equal(nativeBindings.currentLedgerDecodersQualified, false);
  if (process.env.TONSWAP_NATIVE_MANIFEST_FIXTURE) {
    const current = readCanonicalReleaseManifest(process.env.TONSWAP_NATIVE_MANIFEST_FIXTURE, 'localnet');
    assert.equal(deriveRuntimeManifestBindings(current.runtime).t3Hub, current.runtime.contracts.T3Hub!.address);
  }
  const spotOnly = readCanonicalReleaseManifest(writeManifest('spot-only.json', { perpsMarkets: [], options: [] }), 'testnet');
  assert.equal(spotOnly.markets.length, 0); assert.equal(spotOnly.spotMarkets.length, 3);
  const withSeries = readCanonicalReleaseManifest(writeManifest('two-series.json', { options: [fixture.options[0],
    { ...fixture.options[0], seriesId: '2', option: runtimeAddress(301) }, fixture.options[1]] }), 'testnet');
  assert.equal(withSeries.runtime.options.length, 3);
  for (const network of ['mainnet', 'localnet'] as const) {
    const current = writeManifest(network + '.json', { network: `ton:${network}`, globalId: network === 'mainnet' ? -239 : -3,
      releaseId: `${network}-unit-${fixture.source.build.slice(0, 12)}` });
    assert.equal(readCanonicalReleaseManifest(current, network).runtime.globalId, network === 'mainnet' ? -239 : -3);
  }
  assert.throws(() => readCanonicalReleaseManifest(path, 'mainnet'), /network mismatch/);
  const fail = (label: string, change: Record<string, unknown>, error = /Release manifest/) =>
    assert.throws(() => readCanonicalReleaseManifest(writeManifest(label + '.json', change), 'testnet'), error, label);
  fail('old-schema', { schema: 'tonswap-first-release-manifest-v1' }, /schema must be tonswap-release-v1/);
  fail('old-fields', { candidateDigest: 'a'.repeat(64) }, /top-level keys/);
  fail('wrong-network-domain', { globalId: -239 }, /network\/globalId/);
  fail('wrong-source', { source: { ...fixture.source, contracts: 'not-a-git-sha' } });
  fail('wrong-release-build', { releaseId: 'testnet-unit-123456789abc' });
  fail('missing-wallet-template', { templates: { ...fixture.templates, T3Wallet: undefined } });
  fail('unknown-role', { contracts: { ...fixture.contracts, T3Root: fixture.contracts.T3Hub } });
  fail('old-address-entry', { contracts: { ...fixture.contracts, T3Hub: contracts.T3Hub } });
  fail('missing-code-hash', { contracts: { ...fixture.contracts, T3Hub: { address: contracts.T3Hub } } });
  const shapeFail = (label: string, change: Record<string, unknown>, expected: string) => {
    const malformed = JSON.parse(JSON.stringify(runtimeManifestFixture(change)));
    malformed.manifestHash = hashReleaseManifest(malformed);
    const validation = validateReleaseManifest(malformed);
    if (validation.ok) assert.fail(`${label} must reject its malformed shape`);
    assert(validation.errors.includes(expected), `${label}: ${validation.errors.join(', ')}`);
    assert(!validation.errors.includes('manifestHash'), `${label} must carry a valid recomputed manifest hash`);
    assert.throws(() => parseCanonicalReleaseManifest(JSON.stringify(malformed), 'testnet'), /Release manifest is invalid:/, label);
  };
  shapeFail('array-source-sha', { source: { ...fixture.source, contracts: [fixture.source.contracts] } }, 'source');
  shapeFail('array-source-build-hash', { source: { ...fixture.source, build: [fixture.source.build] } }, 'source');
  shapeFail('array-singleton-code-hash', { contracts: { ...fixture.contracts, T3Hub: {
    ...fixture.contracts.T3Hub, codeHash: [fixture.contracts.T3Hub!.codeHash] } } }, 'contracts.T3Hub');
  shapeFail('array-template-code-hash', { templates: { ...fixture.templates,
    T3Wallet: [fixture.templates.T3Wallet] } }, 'templates');
  shapeFail('numeric-token-symbol', { tokens: fixture.tokens.map(token =>
    token.symbol === 'TS' ? { ...token, symbol: 123 } : token) }, 'tokens[1]');
  shapeFail('missing-perps-symbol-and-pool', { perpsMarkets: [{ marketId: 1 }] }, 'perpsMarkets[0]');
  shapeFail('missing-perps-pool', { perpsMarkets: [{ marketId: 1, symbol: 'USDT' }] }, 'perpsMarkets[0]');
  shapeFail('missing-perps-spot-symbol', { perpsMarkets: [{ marketId: 1, symbol: 'TS' }] }, 'perpsMarkets[0]');
  fail('friendly-address', { contracts: { ...fixture.contracts, T3Hub: { ...fixture.contracts.T3Hub, address: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' } } });
  fail('duplicate-singleton', { contracts: { ...fixture.contracts, T3Hub: { ...fixture.contracts.T3Hub, address: contracts.Governance } } });
  fail('wrong-token-root', { tokens: fixture.tokens.map(t => t.symbol === 'T3' ? { ...t, root: runtimeAddress(999) } : t) });
  const precision = parseCanonicalReleaseManifest(runtimeManifestFixture({ tokens: fixture.tokens.map(t => t.symbol === 'T3' ? { ...t, decimals: 6 } : t) }), 'testnet');
  assert.equal(precision.spotMarkets[0].quoteDecimals, 6, 'metadata preserves declared precision; it does not infer it from a symbol');

  fail('foreign-perps-pool', { perpsMarkets: [{ ...fixture.perpsMarkets[0], pool: runtimeAddress(999) }] });
  fail('oversized-perps-id', { perpsMarkets: [{ ...fixture.perpsMarkets[0], marketId: 0x100000000 }] });
  assert.equal(parseCanonicalReleaseManifest(runtimeManifestFixture({ perpsMarkets: [{ ...fixture.perpsMarkets[0], marketId: 5 }] }), 'testnet').markets[0].perpsMarketId, 5);
  fail('duplicate-perps-id', { perpsMarkets: [...fixture.perpsMarkets, fixture.perpsMarkets[0]] });
  fail('duplicate-spot', { spotMarkets: [...fixture.spotMarkets, fixture.spotMarkets[0]] });
  fail('oracle-claim', { spotMarkets: fixture.spotMarkets.map((spot, index) =>
    index === 0 ? { ...spot, oracle: { status: 'ready' } } : spot) });
  fail('self-comparison', { options: [{ ...fixture.options[1], comparisonSymbol: 'USDT' }] });
  fail('partial-series', { options: [{ ...fixture.options[1], seriesId: '2' }] });
  fail('duplicate-series', { options: [fixture.options[0], { ...fixture.options[0], option: runtimeAddress(302) }] });
  fail('invalid-service', { services: { ...fixture.services, tonRpc: 'file:///private/secret' } });
  const tamperedPath = writeManifest('tampered.json');
  const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8')); tampered.services.platform = 'https://other.example';
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  assert.throws(() => readCanonicalReleaseManifest(tamperedPath, 'testnet'), /manifestHash does not match/);

  const bound = deriveRuntimeManifestBindings(parsed.runtime);
  assert.equal(bound.perpsEngineCodeHash, fixture.contracts.PerpsEngine!.codeHash);
  assert.equal(bound.t3Hub, contracts.T3Hub);
  assert.deepEqual(bound.jettonRoots, fixture.tokens.map(token => ({ master: token.root, symbol: token.symbol,
    decimals: token.decimals, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash })));
  assert.equal(new Set(bound.jettonRoots.map(token => token.walletCodeHash)).size, 3, 'tokens retain three distinct wallet implementations');
  assert.equal(bound.currentSpotMarkets.length, 3);
  assert.deepEqual(bound.currentSpotMarkets[0].walletBudgetX, fixture.spotMarkets[0].walletBudgetX);
  assert.equal(bound.currentSpotMarkets[0].tokenX.masterCodeHash, fixture.tokens.find(t => t.symbol === 'USDT')!.masterCodeHash);
  assert.equal(bound.currentSpotMarkets[0].tokenT.walletCodeHash, fixture.templates.T3Wallet);
  assert.equal(parsed.spotMarkets.find(spot => spot.assetSymbol === 'USDT')!.tokenWalletCodeHash, bound.currentSpotMarkets[0].tokenX.walletCodeHash);
  assert.equal(parsed.spotMarkets[0].quoteWalletCodeHash, fixture.templates.T3Wallet);
  assert.equal(bound.currentLedgerDecodersQualified, false, 'discovery must not authorize the previous business-state decoders');
  assert.deepEqual(bound.marketBindings, []);
  for (const key of ['optionCodeHashes', 'launchpadCodeHashes', 't3CodeHashes', 't3RedemptionBinding'])
    assert.equal((bound as any)[key], undefined);
  assert.equal(bound.walletTemplateCodeHash, null, 'there is no global JTW1 wallet code');
  assert.deepEqual(JSON.parse(JSON.stringify(deriveRuntimeManifestBindings(parsed.runtime))), JSON.parse(JSON.stringify(bound)),
    'runtime values remain deterministic; current Options addresses have per-instance methods');
  fail('missing-v21-minter-template', { templates: Object.fromEntries(Object.entries(fixture.templates).filter(([role]) => role !== 'JettonV21Minter')) });
  fail('wrong-v21-minter-template', { templates: { ...fixture.templates, JettonV21Minter: 'f'.repeat(64) } });
  fail('omitted-master', { contracts: Object.fromEntries(Object.entries(fixture.contracts).filter(([role]) => role !== 'USDT')) });
  fail('non-root-token', { tokens: fixture.tokens.map(token => token.symbol === 'USDT' ? { ...token, root: contracts.PerpsEngine } : token) });
  fail('wrong-master-pin', { tokens: fixture.tokens.map(token => token.symbol === 'USDT' ? { ...token, masterCodeHash: 'f'.repeat(64) } : token) });
  fail('wrong-t3-wallet-pin', { tokens: fixture.tokens.map(token => token.symbol === 'T3' ? { ...token, walletCodeHash: fixture.templates.JettonV21Wallet } : token) });
  fail('old-wallet-template', { templates: { ...fixture.templates, JettonWallet: fixture.templates.T3Wallet } });
  fail('missing-wallet-profile', { spotMarkets: fixture.spotMarkets.map((spot, index) => index === 0 ? { ...spot, walletBudgetX: undefined } : spot) });
  fail('wallet-budget-overflow', { spotMarkets: fixture.spotMarkets.map((spot, index) => index === 0
    ? { ...spot, walletBudgetX: { ...spot.walletBudgetX, transferCopies: 9 } } : spot) });
  fail('wrong-wallet-decimals', { spotMarkets: fixture.spotMarkets.map((spot, index) => index === 0 ? { ...spot, xDecimals: 9 } : spot) });
  fail('moving-mount', { services: { ...fixture.services, indexer: 'https://test.tonswap.org/api/indexer/release-id' } });
  fail('service-query', { services: { ...fixture.services, indexer: 'https://test.tonswap.org/api/indexer?release=1' } });
  fail('public-http', { services: { ...fixture.services, indexer: 'http://test.tonswap.org/api/indexer' } });
  fail('campaign-root', { campaign: { ...fixture.campaign, root: 'invalid' } });
  fail('asset-path-traversal', { campaign: { ...fixture.campaign, leaves: { ...fixture.campaign.leaves, path: '../leaves.json' } } });
  shapeFail('null-keeper', { orderKeeper: null }, 'orderKeeper');
  shapeFail('missing-keeper', { orderKeeper: undefined }, 'orderKeeper');
  shapeFail('old-keeper-shape', { orderKeeper: { address: runtimeAddress(901), previous: null, fillGas: 1, fillMsgs: 1, tipMargin: '0' } }, 'orderKeeper');
  shapeFail('invalid-keeper-address', { orderKeeper: { address: '0:' + '0'.repeat(64) } }, 'orderKeeper');
  shapeFail('keeper-contract-collision', { orderKeeper: { address: contracts.Governance } }, 'orderKeeper duplicates an address');
  fail('keeper-pool-collision', { orderKeeper: { address: fixture.spotMarkets[0].pool } });
  fail('keeper-option-collision', { orderKeeper: { address: fixture.options[0].option } });
  assert.equal(parseCanonicalReleaseManifest(runtimeManifestFixture({ orderKeeper: { address: runtimeAddress(901) } }), 'testnet').runtime.orderKeeper.address, runtimeAddress(901));

  assert.throws(() => readCanonicalReleaseManifest('good.json', 'testnet'), /canonical absolute path/);
  const symlinkPath = join(root, 'symlink.json'); symlinkSync(path, symlinkPath);
  assert.throws(() => readCanonicalReleaseManifest(symlinkPath, 'testnet'), /symlink/); unlinkSync(symlinkPath);
  const hardlinkPath = join(root, 'hardlink.json'); linkSync(path, hardlinkPath);
  assert.throws(() => readCanonicalReleaseManifest(hardlinkPath, 'testnet'), /single-link/); unlinkSync(hardlinkPath);
  const unsafe = writeManifest('unsafe.json'); chmodSync(unsafe, 0o664);
  assert.throws(() => readCanonicalReleaseManifest(unsafe, 'testnet'), /not group\/other-writable/);
  const duplicate = join(root, 'duplicate.json');
  writeFileSync(duplicate, readFileSync(path, 'utf8').replace('"schema": "tonswap-release-v1",', '"schema": "tonswap-release-v1", "schema": "tonswap-release-v1",'));
  assert.throws(() => readCanonicalReleaseManifest(duplicate, 'testnet'), /duplicate object key/);
  const race = writeManifest('race.json'), replacement = writeManifest('replacement.json');
  assert.throws(() => readCanonicalReleaseManifest(race, 'testnet', { afterOpen: () => renameSync(replacement, race) }), /single-link|changed during/);
  for (const phase of ['afterOpen', 'afterRead'] as const) {
    const siblings = join(root, `siblings-${phase}`); mkdirSync(siblings, { mode: 0o700 });
    const manifestPath = join(siblings, 'manifest.json');
    writeFileSync(manifestPath, readFileSync(path), { mode: 0o600 });
    const temporary = join(siblings, 'snapshot.tmp'), snapshot = join(siblings, 'snapshot.json');
    const readWith = (change: () => void) => readCanonicalReleaseManifest(manifestPath, 'testnet', { [phase]: change });
    assert.equal(readWith(() => writeFileSync(temporary, '{}')).manifestHash, fixture.manifestHash,
      `${phase}: an unrelated sibling creation cannot retire the current manifest`);
    assert.equal(readWith(() => renameSync(temporary, snapshot)).manifestHash, fixture.manifestHash,
      `${phase}: an unrelated snapshot rename cannot retire the current manifest`);
    assert.equal(readWith(() => unlinkSync(snapshot)).manifestHash, fixture.manifestHash,
      `${phase}: an unrelated sibling deletion cannot retire the current manifest`);
    assert.equal(readWith(() => mkdirSync(join(siblings, 'other-state'))).manifestHash, fixture.manifestHash,
      `${phase}: an unrelated subdirectory cannot change manifest authority`);

    const parent = join(root, `parent-${phase}`); mkdirSync(parent, { mode: 0o700 });
    const protectedPath = join(parent, 'manifest.json');
    const bytes = readFileSync(path); writeFileSync(protectedPath, bytes, { mode: 0o600 });
    assert.throws(() => readCanonicalReleaseManifest(protectedPath, 'testnet', {
      [phase]: () => chmodSync(parent, 0o770),
    }), /not group\/other-writable/, `${phase}: unsafe parent permissions remain rejected`);
    chmodSync(parent, 0o700);
    assert.throws(() => readCanonicalReleaseManifest(protectedPath, 'testnet', {
      [phase]: () => chmodSync(parent, 0o750),
    }), /parent changed during/, `${phase}: changed parent authority remains rejected even when its new mode is safe`);
    chmodSync(parent, 0o700);
    const moved = join(root, `moved-parent-${phase}`);
    assert.throws(() => readCanonicalReleaseManifest(protectedPath, 'testnet', {
      [phase]: () => { renameSync(parent, moved); symlinkSync(moved, parent, 'dir'); },
    }), /non-symlink/, `${phase}: a parent symlink substitution remains rejected`);
    unlinkSync(parent); renameSync(moved, parent);
    assert.throws(() => readCanonicalReleaseManifest(protectedPath, 'testnet', {
      [phase]: () => { renameSync(parent, moved); mkdirSync(parent, { mode: 0o700 }); writeFileSync(protectedPath, bytes, { mode: 0o600 }); },
    }), /changed during/, `${phase}: a replacement directory with identical manifest content remains rejected`);

    const mutation = writeManifest(`mutation-${phase}.json`);
    assert.throws(() => readCanonicalReleaseManifest(mutation, 'testnet', {
      [phase]: () => writeFileSync(mutation, Buffer.concat([readFileSync(mutation), Buffer.from(' ')])),
    }), /changed during/, `${phase}: an in-place manifest mutation remains rejected`);
    const swapped = writeManifest(`swapped-${phase}.json`), substitute = writeManifest(`substitute-${phase}.json`);
    assert.throws(() => readCanonicalReleaseManifest(swapped, 'testnet', {
      [phase]: () => renameSync(substitute, swapped),
    }), /single-link|changed during/, `${phase}: an identical manifest file replacement remains rejected`);
  }
  process.stdout.write('runtime release manifest producer fixture, identities and derived bindings passed\n');
} finally { rmSync(root, { recursive: true, force: true }); }
