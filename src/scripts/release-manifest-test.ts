import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRegistryBundle, hashReleaseManifest, hashRegistry, readCanonicalReleaseManifest } from '../config/releaseManifest';
import { applyRuntimeManifestBindings } from '../config/runtimeManifestBindings';
import type { Config } from '../config';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ton-indexer-release-manifest-')));
const writeManifest = (name: string, overrides: Record<string, unknown> = {}) => {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(runtimeManifestFixture(overrides), null, 2) + '\n');
  return path;
};
const fixture = runtimeManifestFixture();
const contracts = Object.fromEntries(Object.entries(fixture.contracts).map(([role, c]) => [role, c!.address]));
const config = () => ({ network: 'testnet', ledgerMarketBindings: [] } as unknown as Config);
try {
  const path = writeManifest('good.json');
  const parsed = readCanonicalReleaseManifest(path, 'testnet');
  assert.deepEqual(parsed.contracts, contracts);
  assert.equal(parsed.registryHash, hashRegistry(contracts));
  assert.equal(parsed.releaseManifestHash, fixture.manifestHash);
  assert.equal(parsed.markets.length, 1);
  assert.equal(parsed.spotMarkets.length, 3);
  assert.equal(parsed.markets[0].perpsCandleMarketKey, 'perps-oracle:1');
  assert.equal(parsed.markets[0].perpsPoolCodeHash, fixture.templates.DlmmPool);
  assert.equal(parsed.markets[0].optionAddress, undefined, 'an independent option catalog never invents a perps-series pair');
  assert.equal(parsed.markets[0].oracle, undefined, 'manifest identity is not current oracle readiness');
  assert.equal(parsed.markets[0].coverPolicyId, undefined);
  assert.equal(parsed.approvedComparisons[0].comparisonPool, fixture.spotMarkets[1].pool);
  assert.deepEqual(buildRegistryBundle(contracts, 'testnet', path).metadata.runtime, fixture);
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
  fail('old-fields', { candidateDigest: 'a'.repeat(64) }, /top-level fields/);
  fail('wrong-network-domain', { globalId: -239 }, /network\/globalId/);
  fail('wrong-source', { source: { ...fixture.source, contracts: 'not-a-git-sha' } });
  fail('wrong-release-build', { releaseId: 'testnet-unit-123456789abc' });
  fail('missing-wallet-template', { templates: { ...fixture.templates, JettonWallet: undefined } });
  fail('unknown-role', { contracts: { ...fixture.contracts, T3Hub: fixture.contracts.T3 } });
  fail('old-address-entry', { contracts: { ...fixture.contracts, T3: contracts.T3 } });
  fail('missing-code-hash', { contracts: { ...fixture.contracts, T3: { address: contracts.T3 } } });
  fail('friendly-address', { contracts: { ...fixture.contracts, T3: { ...fixture.contracts.T3, address: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' } } });
  fail('duplicate-singleton', { contracts: { ...fixture.contracts, T3: { ...fixture.contracts.T3, address: contracts.T3Root } } });
  fail('wrong-token-root', { tokens: fixture.tokens.map(t => t.symbol === 'T3' ? { ...t, root: runtimeAddress(999) } : t) });
  fail('wrong-quote-precision', { tokens: fixture.tokens.map(t => t.symbol === 'T3' ? { ...t, decimals: 6 } : t) });
  fail('wrong-reserve-root', { tokens: fixture.tokens.map(t => t.symbol === 'USDT' ? { ...t, root: contracts.PerpsEngine } : t) });
  fail('foreign-perps-pool', { perpsMarkets: [{ ...fixture.perpsMarkets[0], pool: runtimeAddress(999) }] });
  fail('unsupported-perps-id', { perpsMarkets: [{ ...fixture.perpsMarkets[0], marketId: 5 }] });
  fail('duplicate-perps-id', { perpsMarkets: [...fixture.perpsMarkets, fixture.perpsMarkets[0]] });
  fail('duplicate-spot', { spotMarkets: [...fixture.spotMarkets, fixture.spotMarkets[0]] });
  fail('oracle-readiness-claim', { spotMarkets: [{ ...fixture.spotMarkets[0], oracle: { status: 'ready' } }] });
  fail('self-comparison', { options: [{ ...fixture.options[1], comparisonSymbol: 'USDT' }] });
  fail('partial-series', { options: [{ ...fixture.options[1], seriesId: '2' }] });
  fail('duplicate-series', { options: [fixture.options[0], { ...fixture.options[0], option: runtimeAddress(302) }] });
  fail('conflicting-template', { options: [fixture.options[0], { ...fixture.options[1], templateId: 1 }] });
  fail('service-secret', { services: { ...fixture.services, tonRpc: 'https://user:secret@example.org' } });
  const tamperedPath = writeManifest('tampered.json');
  const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8')); tampered.services.platform = 'https://other.example';
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  assert.throws(() => readCanonicalReleaseManifest(tamperedPath, 'testnet'), /manifestHash does not match/);

  const bound = config(); applyRuntimeManifestBindings(bound, parsed.runtime);
  assert.equal(bound.ledgerPerpsEngineCodeHash, fixture.contracts.PerpsEngine!.codeHash);
  assert.equal(bound.ledgerOptionsCodeHashes?.walletCodeHash, fixture.templates.JettonWallet);
  assert.equal(bound.ledgerLaunchpadCodeHashes?.fixedCodeHash, fixture.templates.SaleFixed);
  assert.equal(bound.ledgerMarketBindings.length, 3);
  assert.equal(bound.ledgerMarketBindings[0].router, contracts.DexRouter);
  assert.equal(bound.ledgerT3RedemptionBinding, undefined, 'reserve wallet identity must be separately authenticated');
  applyRuntimeManifestBindings(bound, parsed.runtime);
  const conflict = config(); conflict.ledgerPerpsEngineCodeHash = 'f'.repeat(64);
  assert.throws(() => applyRuntimeManifestBindings(conflict, parsed.runtime), /LEDGER_PERPS_ENGINE_CODE_HASH conflicts/);
  const wrongMarket = config(); wrongMarket.ledgerMarketBindings = [{ ...bound.ledgerMarketBindings[0], pool: runtimeAddress(999) }];
  assert.throws(() => applyRuntimeManifestBindings(wrongMarket, parsed.runtime), /LEDGER_MARKET_BINDINGS_JSON conflicts/);
  const external = runtimeManifestFixture({ contracts: Object.fromEntries(Object.entries(fixture.contracts).filter(([role]) => role !== 'USDT')) });
  const externalConfig = config(); applyRuntimeManifestBindings(externalConfig, external);
  assert.equal(externalConfig.ledgerMarketBindings.length, 2, 'a missing external root hash remains unresolved');

  assert.throws(() => buildRegistryBundle({ ...contracts, T3Root: runtimeAddress(999) }, 'testnet', path), /address mismatch/);
  assert.throws(() => buildRegistryBundle({ T3Root: contracts.T3Root }, 'testnet', path), /key mismatch/);
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
  const plain = buildRegistryBundle(contracts, 'testnet');
  assert.equal(plain.metadata.releaseManifestHash, null); assert.equal(plain.metadata.registryHash, hashRegistry(contracts));

  mkdirSync(join(root, 'registry')); const registryPath = join(root, 'registry/testnet.json');
  const syncCommand = resolve(__dirname, 'refresh-registry.ts'), tsx = resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
  const sync = (...args: string[]) => spawnSync(process.execPath, [tsx, syncCommand, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...process.env, INDEXER_RELEASE_MANIFEST_PATH: '' },
  });
  const exact = JSON.stringify(contracts, null, 2) + '\n'; writeFileSync(registryPath, exact);
  assert.equal(sync('--check', path).status, 0); assert.equal(readFileSync(registryPath, 'utf8'), exact);
  const { T3Root: omitted, ...missing } = contracts;
  for (const registry of [missing, { ...contracts, T3Root: runtimeAddress(999) }, { ...contracts, ExtraRole: runtimeAddress(999) }]) {
    const retained = JSON.stringify(registry); writeFileSync(registryPath, retained);
    assert.equal(sync('--check', path).status, 1); assert.equal(readFileSync(registryPath, 'utf8'), retained);
  }
  assert.equal(sync(path).status, 0); assert.deepEqual(JSON.parse(readFileSync(registryPath, 'utf8')), contracts);
  assert.deepEqual(readdirSync(join(root, 'registry')), ['testnet.json']);
  assert.equal(sync('--check', path).status, 0);
  process.stdout.write('runtime release manifest identities, bindings and registry parity passed\n');
} finally { rmSync(root, { recursive: true, force: true }); }
