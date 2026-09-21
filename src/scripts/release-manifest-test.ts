import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistryBundle,
  hashReleaseManifest,
  hashRegistry,
  readCanonicalReleaseManifest,
} from '../config/releaseManifest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ton-indexer-release-manifest-')));
const addressA = `0:${'1'.repeat(64)}`;
const addressB = `0:${'2'.repeat(64)}`;
const usdtRootAndDiscovery = `0:${'a'.repeat(64)}`;
const usdcRootAndDiscovery = `0:${'b'.repeat(64)}`;
const kusdRootAndDiscovery = `0:${'c'.repeat(64)}`;
const reserveRootDiscoveryPairs = [
  ['UsdtRoot', 'UsdtDiscovery', usdtRootAndDiscovery],
  ['UsdcRoot', 'UsdcDiscovery', usdcRootAndDiscovery],
  ['KusdRoot', 'KusdDiscovery', kusdRootAndDiscovery],
] as const;
const marketAddresses = Array.from(
  { length: 15 },
  (_, index) => `0:${(index + 3).toString(16).padStart(64, '0')}`
);
const releaseMarkets = (['fixed', 'bonding', 'dutch'] as const).map((saleModel, index) => ({
  saleModel,
  key:`market-${index+1}`,optionTemplateId:index+1,optionExpiry:'1900000000',configuration:'ready',lifecycle:'not-run',quoteDecimals:9,
  codeHashes:{perpsPool:'b'.repeat(64)},
  contractRoles:{perpsPool:`Launchpad${saleModel[0].toUpperCase()+saleModel.slice(1)}PerpsPool`,tokenRoot:`Launchpad${saleModel[0].toUpperCase()+saleModel.slice(1)}TokenRoot`,pool:`Launchpad${saleModel[0].toUpperCase()+saleModel.slice(1)}Pool`,optionAddress:`Launchpad${saleModel[0].toUpperCase()+saleModel.slice(1)}Option`},
  oracle:{status:'pending',reason:'history-incomplete-or-stale',observationTimestamp:'0',windows:['300','1800','7200'].map(seconds=>({seconds,available:false,elapsed:'0',priceQ64:'0'}))},
  symbol: `R${index + 1}`,
  tokenRoot: marketAddresses[index * 5],
  sale: marketAddresses[index * 5 + 1],
  lpVault: marketAddresses[index * 5 + 2],
  pool: marketAddresses[index * 5 + 3],
  perpsPool: `0:${(index + 200).toString(16).padStart(64, '0')}`,
  coverSource:marketAddresses[index * 5 + 3],
  optionAddress: marketAddresses[index * 5 + 4],
  perpsMarketId: index + 1,
  optionSeriesId: String(index + 1),
  coverPolicyId: `cover-${index + 1}`,
  decimals: index + 6,
}));
const releaseSpots = releaseMarkets.map(market => ({key: market.key, symbol: market.symbol, pool: market.pool,
  tokenRoot: market.tokenRoot, decimals: market.decimals, quoteDecimals: 9, configuration: 'ready', lifecycle: 'not-run', oracle: market.oracle,
  codeHashes: {tokenRoot: 'b'.repeat(64), pool: 'b'.repeat(64)},
  contractRoles: {tokenRoot: market.contractRoles.tokenRoot, pool: market.contractRoles.pool}}));
const contracts = {
  DlmmPoolFactory: addressA,
  T3Root: addressB,
  UsdtRoot: usdtRootAndDiscovery,
  UsdtDiscovery: usdtRootAndDiscovery,
  UsdcRoot: usdcRootAndDiscovery,
  UsdcDiscovery: usdcRootAndDiscovery,
  KusdRoot: kusdRootAndDiscovery,
  KusdDiscovery: kusdRootAndDiscovery,
  LaunchpadFixedTokenRoot: releaseMarkets[0].tokenRoot,
  LaunchpadFixedSale: releaseMarkets[0].sale,
  LaunchpadFixedLpVault: releaseMarkets[0].lpVault,
  LaunchpadFixedPool: releaseMarkets[0].pool,
  LaunchpadFixedPerpsPool: releaseMarkets[0].perpsPool,
  LaunchpadFixedOption: releaseMarkets[0].optionAddress,
  LaunchpadBondingTokenRoot: releaseMarkets[1].tokenRoot,
  LaunchpadBondingSale: releaseMarkets[1].sale,
  LaunchpadBondingLpVault: releaseMarkets[1].lpVault,
  LaunchpadBondingPool: releaseMarkets[1].pool,
  LaunchpadBondingPerpsPool: releaseMarkets[1].perpsPool,
  LaunchpadBondingOption: releaseMarkets[1].optionAddress,
  LaunchpadDutchTokenRoot: releaseMarkets[2].tokenRoot,
  LaunchpadDutchSale: releaseMarkets[2].sale,
  LaunchpadDutchLpVault: releaseMarkets[2].lpVault,
  LaunchpadDutchPool: releaseMarkets[2].pool,
  LaunchpadDutchPerpsPool: releaseMarkets[2].perpsPool,
  LaunchpadDutchOption: releaseMarkets[2].optionAddress,
};

const writeManifest = (name: string, overrides: Record<string, unknown> = {}) => {
  const path = join(root, name);
  const unsigned = {
    schema: 'tonswap-first-release-manifest-v1',
    schemaVersion: 1,
    candidateDigest:'a'.repeat(64),attemptId:'first-attempt',setup:'ready',lifecycle:'not-run',
    codeHashes:Object.fromEntries(Object.keys(contracts).map(key=>[key,'b'.repeat(64)])),
    sourceHashes:{contracts:'c'.repeat(64),indexer:'d'.repeat(64),web:'e'.repeat(64)},
    artifactHashes:{contracts:'c'.repeat(64),indexer:'d'.repeat(64),web:'e'.repeat(64)},
    network: 'ton:localnet',
    releaseId: 'local-run-1',
    contracts,
    registryHash: hashRegistry(contracts),
    markets: releaseMarkets,
    spotMarkets: releaseSpots,
    approvedComparisons: [],
    ...overrides,
  };
  const serializable = JSON.parse(JSON.stringify(unsigned));
  writeFileSync(
    path,
    `${JSON.stringify({ ...serializable, manifestHash: hashReleaseManifest(serializable) }, null, 2)}\n`
  );
  return path;
};

try {
  const path = writeManifest('good.json');
  const parsed = readCanonicalReleaseManifest(path, 'localnet');
  assert.equal(parsed.releaseId, 'local-run-1');
  assert.equal(parsed.registryHash, hashRegistry(contracts));
  assert.deepEqual(parsed.contracts, contracts);
  for (const field of ['contracts', 'codeHashes', 'artifactCodeHashes', 'webAddresses']) {
    for (const role of ['ClmmRouter', 'ClmmPoolFactory', 'ClmmPool', 'clmmRouter', 'FarmFactory', 'farmFactory', 'BootstrapFactory', 'BootstrapPool', 'BootstrapEscrow', 'DlmmMigrator', 'SigmammPool', 'PositionNft', 'PositionCollection']) {
      const retired = writeManifest(`retired-${field}-${role}.json`, { [field]: { ...contracts, [role]: addressA } });
      assert.throws(() => readCanonicalReleaseManifest(retired, 'localnet'), /Unsupported first-release contract roles/);
    }
  }
  assert.throws(() => buildRegistryBundle({ ...contracts, ClmmPoolFactory: addressA }, 'localnet'), /Unsupported first-release contract roles/);
  for (const [rootLabel, discoveryLabel, address] of reserveRootDiscoveryPairs) {
    assert.equal(parsed.contracts[rootLabel], address);
    assert.equal(parsed.contracts[discoveryLabel], address);
    assert.equal(parsed.contracts[discoveryLabel], parsed.contracts[rootLabel]);
  }
  assert.equal(parsed.releaseManifestHash, hashReleaseManifest(JSON.parse(readFileSync(path, 'utf8'))));

  const bundle = buildRegistryBundle(contracts, 'localnet', path);
  assert.deepEqual(bundle.contracts, contracts);
  for (const [rootLabel, discoveryLabel, address] of reserveRootDiscoveryPairs) {
    assert.equal(bundle.contracts[rootLabel], address);
    assert.equal(bundle.contracts[discoveryLabel], address);
    assert.equal(bundle.contracts[discoveryLabel], bundle.contracts[rootLabel]);
  }
  assert.equal(bundle.metadata.releaseId, 'local-run-1');
  assert.equal(bundle.metadata.registryHash, hashRegistry(contracts));

  const marketContracts = contracts;
  const marketPath = writeManifest('markets.json', {
    contracts: marketContracts,
    registryHash: hashRegistry(marketContracts),
    markets: releaseMarkets,
  });
  const parsedMarkets = readCanonicalReleaseManifest(marketPath, 'localnet').markets;
  assert.equal(parsedMarkets[0].perpsPool, releaseMarkets[0].perpsPool);
  assert.notEqual(parsedMarkets[0].perpsPool, parsedMarkets[0].marketAddress);
  assert.equal(parsedMarkets[0].perpsCandleMarketKey, 'perps-oracle:1');
  assert.equal(parsedMarkets[0].perpsPoolCodeHash, 'b'.repeat(64));
  for (const [name, replacement, error] of [
    ['missing-perps-pool', { perpsPool: undefined }, /perpsPool contract binding/],
    ['foreign-perps-pool', { perpsPool: releaseMarkets[0].pool }, /perpsPool contract binding/],
    ['missing-perps-role', { contractRoles: { ...releaseMarkets[0].contractRoles, perpsPool: undefined } }, /perpsPool contract binding/],
    ['missing-perps-code', { codeHashes: {} }, /perpsPool code binding/],
    ['foreign-perps-code', { codeHashes: { perpsPool: 'f'.repeat(64) } }, /perpsPool code binding/],
    ['oversized-perps-market', { perpsMarketId: 0x100000000 }, /perpsMarketId/],
  ] as const) {
    assert.throws(() => readCanonicalReleaseManifest(writeManifest(`${name}.json`, {
      markets: releaseMarkets.map((market, index) => index === 0 ? { ...market, ...replacement } : market),
    }), 'localnet'), error);
  }
  assert.deepEqual(
    parsedMarkets.map((market) => ({
      marketKey: market.marketKey,
      marketAddress: market.marketAddress,
      assetDecimals: market.assetDecimals,
      quoteDecimals: market.quoteDecimals,
    })),
    [
      {
        marketKey: 'spot:R1-T3',
        marketAddress: releaseMarkets[0].pool,
        assetDecimals: 6,
        quoteDecimals: 9,
      },
      {
        marketKey: 'spot:R2-T3',
        marketAddress: releaseMarkets[1].pool,
        assetDecimals: 7,
        quoteDecimals: 9,
      },
      {
        marketKey: 'spot:R3-T3',
        marketAddress: releaseMarkets[2].pool,
        assetDecimals: 8,
        quoteDecimals: 9,
      },
    ]
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('spoofed-market.json', {
          contracts: marketContracts,
          registryHash: hashRegistry(marketContracts),
          markets: releaseMarkets.map((market, index) =>
            index === 0 ? { ...market, pool: `0:${'9'.repeat(64)}` } : market
          ),
        }),
        'localnet'
      ),
    /pool contract binding/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('mismatched-option.json', {
          markets: releaseMarkets.map((market, index) =>
            index === 0 ? { ...market, optionAddress: addressA } : market
          ),
        }),
        'localnet'
      ),
    /optionAddress contract binding/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('duplicate-product-ids.json', {
          markets: releaseMarkets.map((market, index) =>
            index === 1
              ? {
                  ...market,
                  perpsMarketId: releaseMarkets[0].perpsMarketId,
                  optionSeriesId: releaseMarkets[0].optionSeriesId,
                  coverPolicyId: releaseMarkets[0].coverPolicyId,
                }
              : market
          ),
        }),
        'localnet'
      ),
    /duplicate perpsMarketId/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('market-pool-unrelated-contract.json', {
          markets: releaseMarkets.map((market, index) =>
            index === 0 ? { ...market, pool: addressA } : market
          ),
        }),
        'localnet'
      ),
    /pool contract binding/
  );

  // One derivative instrument and a comparison-only spot pool remain distinct inventories.
  const paired = {markets: [releaseMarkets[0]], spotMarkets: releaseSpots.slice(0, 2),
    approvedComparisons: [{templateId: 10, baseSymbol: releaseSpots[0].symbol, comparisonSymbol: releaseSpots[1].symbol,
      basePool: releaseSpots[0].pool, comparisonPool: releaseSpots[1].pool}]};
  const pairedRead = readCanonicalReleaseManifest(writeManifest('paired-spot.json', paired), 'localnet');
  assert.equal(pairedRead.markets.length, 1);
  assert.equal(pairedRead.spotMarkets.length, 2);
  assert.deepEqual(pairedRead.approvedComparisons, paired.approvedComparisons);
  assert.equal(pairedRead.spotMarkets[1].poolCodeHash, 'b'.repeat(64));
  assert(!('perpsMarketId' in pairedRead.spotMarkets[1]), 'comparison spot cannot invent a derivative');
  const pairedBundle = buildRegistryBundle(contracts, 'localnet', writeManifest('paired-bundle.json', paired));
  assert.deepEqual(pairedBundle.metadata.spotMarkets, pairedRead.spotMarkets);
  assert.deepEqual(pairedBundle.metadata.approvedComparisons, pairedRead.approvedComparisons);
  const firstSpot = paired.spotMarkets[0], comparison = paired.approvedComparisons[0];
  for (const [label, change] of [
    ['missing spots', {spotMarkets: undefined}], ['empty spots', {spotMarkets: []}],
    ['missing comparisons', {approvedComparisons: undefined}],
    ['duplicate spot pool', {spotMarkets: [firstSpot, {...paired.spotMarkets[1], pool: firstSpot.pool}]}],
    ['missing pool code', {spotMarkets: [{...firstSpot, codeHashes: {tokenRoot: 'b'.repeat(64)}}]}],
    ['wrong token code', {spotMarkets: [{...firstSpot, codeHashes: {...firstSpot.codeHashes, tokenRoot: 'f'.repeat(64)}}]}],
    ['wrong pool code', {spotMarkets: [{...firstSpot, codeHashes: {...firstSpot.codeHashes, pool: 'f'.repeat(64)}}]}],
    ['wrong pool role', {spotMarkets: [{...firstSpot, contractRoles: {...firstSpot.contractRoles, pool: 'T3Root'}}]}],
    ['wrong quote precision', {spotMarkets: [{...firstSpot, quoteDecimals: 6}]}],
    ['missing underlying spot', {spotMarkets: [paired.spotMarkets[1]]}],
    ['invented spot derivative', {spotMarkets: [{...firstSpot, perpsMarketId: 2}]}],
    ['self comparison', {approvedComparisons: [{...comparison, comparisonPool: comparison.basePool, comparisonSymbol: comparison.baseSymbol}]}],
    ['foreign comparison pool', {approvedComparisons: [{...comparison, comparisonPool: addressA}]}],
    ['wrong comparison symbol', {approvedComparisons: [{...comparison, comparisonSymbol: 'IMPOSTOR'}]}],
    ['duplicate comparison', {approvedComparisons: [comparison, {...comparison}]}],
    ['duplicate pair', {approvedComparisons: [comparison, {...comparison, templateId: 11}]}],
    ['invalid comparison template', {approvedComparisons: [{...comparison, templateId: 0}]}],
    ['Shout template collision', {approvedComparisons: [{...comparison, templateId: releaseMarkets[0].optionTemplateId}]}],
  ] as const) assert.throws(() => readCanonicalReleaseManifest(writeManifest(`paired-bad-${label}.json`, {...paired, ...change}), 'localnet'), /Release manifest/, label);

  const objectAddressPath = writeManifest('object-address.json', {
    network: 'ton:localnet',
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([key, address]) => [key, { address }])
    ),
  });
  assert.throws(() => readCanonicalReleaseManifest(objectAddressPath, 'localnet'), /must be a raw address string/);
  assert.throws(() => readCanonicalReleaseManifest(writeManifest('retired-schema.json', {schema:'tonswap-testnet-release-v1'}), 'localnet'), /schema must be tonswap-first-release-manifest-v1/);
  const pending = readCanonicalReleaseManifest(writeManifest('pending-one-market.json', {markets:[releaseMarkets[0]]}), 'localnet');
  assert.equal(pending.markets.length, 1);
  assert.equal(pending.markets[0].oracle?.status, 'pending');
  assert.equal(pending.markets[0].coverPolicyId, undefined);
  assert.throws(() => readCanonicalReleaseManifest(writeManifest('false-oracle-ready.json', {markets:[{...releaseMarkets[0],oracle:{...releaseMarkets[0].oracle,status:'ready'}}]}), 'localnet'), /oracle ready/);

  assert.throws(
    () => buildRegistryBundle({ ...contracts, T3Root: addressA }, 'localnet', path),
    /address mismatch for T3Root/
  );
  assert.throws(
    () => buildRegistryBundle({ T3Root: addressB }, 'localnet', path),
    /key mismatch/
  );
  assert.throws(
    () => readCanonicalReleaseManifest(path, 'testnet'),
    /network mismatch/
  );
  assert.throws(
    () => readCanonicalReleaseManifest(writeManifest('bad-schema.json', { schemaVersion: 2 }), 'localnet'),
    /schemaVersion must be 1/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('missing-schema-version.json', { schemaVersion: undefined }),
        'localnet'
      ),
    /schemaVersion must be 1/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('missing-markets.json', { markets: undefined }),
        'localnet'
      ),
    /markets must contain configured/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('empty-markets.json', { markets: [] }),
        'localnet'
      ),
    /markets must contain configured/
  );
  assert.throws(
    () => readCanonicalReleaseManifest(writeManifest('bad-hash.json', { registryHash: '0'.repeat(64) }), 'localnet'),
    /registryHash does not match/
  );
  const tamperedPath = writeManifest('tampered.json');
  const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8'));
  tampered.releaseId = 'tampered-after-hash';
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(
    () => readCanonicalReleaseManifest(tamperedPath, 'localnet'),
    /manifestHash does not match/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('bad-address.json', { contracts: { T3Root: 'not-an-address' } }),
        'localnet'
      ),
    /invalid TON address/
  );

  assert.throws(
    () => readCanonicalReleaseManifest('good.json', 'localnet'),
    /canonical absolute path/
  );

  const symlinkPath = join(root, 'manifest-symlink.json');
  symlinkSync(path, symlinkPath);
  assert.throws(
    () => readCanonicalReleaseManifest(symlinkPath, 'localnet'),
    /must not contain symlink aliases/
  );
  unlinkSync(symlinkPath);

  const hardlinkPath = join(root, 'manifest-hardlink.json');
  linkSync(path, hardlinkPath);
  assert.throws(
    () => readCanonicalReleaseManifest(hardlinkPath, 'localnet'),
    /single-link regular file/
  );
  unlinkSync(hardlinkPath);

  const unsafeModePath = writeManifest('unsafe-mode.json');
  chmodSync(unsafeModePath, 0o664);
  assert.throws(
    () => readCanonicalReleaseManifest(unsafeModePath, 'localnet'),
    /not group\/other-writable/
  );

  const duplicateKeyPath = join(root, 'duplicate-key.json');
  const duplicateKeyRaw = readFileSync(path, 'utf8').replace(
    '"releaseId": "local-run-1",',
    '"releaseId": "shadowed-release",\n  "releaseId": "local-run-1",'
  );
  writeFileSync(duplicateKeyPath, duplicateKeyRaw);
  assert.throws(
    () => readCanonicalReleaseManifest(duplicateKeyPath, 'localnet'),
    /duplicate object key "releaseId"/
  );

  const racePath = writeManifest('race-target.json');
  const raceReplacementPath = writeManifest('race-replacement.json', {
    releaseId: 'replacement-release',
  });
  assert.throws(
    () =>
      readCanonicalReleaseManifest(racePath, 'localnet', {
        afterOpen: () => renameSync(raceReplacementPath, racePath),
      }),
    /single-link regular file|changed during/
  );

  const plain = buildRegistryBundle(contracts, 'testnet');
  assert.equal(plain.metadata.releaseId, null);
  assert.equal(plain.metadata.releaseManifestHash, null);
  assert.equal(plain.metadata.registryHash, hashRegistry(contracts));

  process.stdout.write('release manifest registry parity ok\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
