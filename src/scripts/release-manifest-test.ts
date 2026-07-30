import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistryBundle,
  hashReleaseManifest,
  hashRegistry,
  readCanonicalReleaseManifest,
} from '../config/releaseManifest';

const root = mkdtempSync(join(tmpdir(), 'ton-indexer-release-manifest-'));
const addressA = `0:${'1'.repeat(64)}`;
const addressB = `0:${'2'.repeat(64)}`;
const marketAddresses = Array.from(
  { length: 15 },
  (_, index) => `0:${(index + 3).toString(16).padStart(64, '0')}`
);
const releaseMarkets = (['fixed', 'bonding', 'dutch'] as const).map((saleModel, index) => ({
  saleModel,
  symbol: `R${index + 1}`,
  tokenRoot: marketAddresses[index * 5],
  sale: marketAddresses[index * 5 + 1],
  lpVault: marketAddresses[index * 5 + 2],
  pool: marketAddresses[index * 5 + 3],
  optionAddress: marketAddresses[index * 5 + 4],
  perpsMarketId: index + 1,
  optionSeriesId: `series-${index + 1}`,
  coverPolicyId: `cover-${index + 1}`,
  decimals: index + 6,
}));
const contracts = {
  DlmmPoolFactory: addressA,
  T3Root: addressB,
  LaunchpadFixedTokenRoot: releaseMarkets[0].tokenRoot,
  LaunchpadFixedSale: releaseMarkets[0].sale,
  LaunchpadFixedLpVault: releaseMarkets[0].lpVault,
  LaunchpadFixedPool: releaseMarkets[0].pool,
  LaunchpadFixedOption: releaseMarkets[0].optionAddress,
  LaunchpadBondingTokenRoot: releaseMarkets[1].tokenRoot,
  LaunchpadBondingSale: releaseMarkets[1].sale,
  LaunchpadBondingLpVault: releaseMarkets[1].lpVault,
  LaunchpadBondingPool: releaseMarkets[1].pool,
  LaunchpadBondingOption: releaseMarkets[1].optionAddress,
  LaunchpadDutchTokenRoot: releaseMarkets[2].tokenRoot,
  LaunchpadDutchSale: releaseMarkets[2].sale,
  LaunchpadDutchLpVault: releaseMarkets[2].lpVault,
  LaunchpadDutchPool: releaseMarkets[2].pool,
  LaunchpadDutchOption: releaseMarkets[2].optionAddress,
};

const writeManifest = (name: string, overrides: Record<string, unknown> = {}) => {
  const path = join(root, name);
  const unsigned = {
    schema: 'tonswap-testnet-release-v1',
    schemaVersion: 1,
    network: 'ton:localnet',
    releaseId: 'local-run-1',
    contracts,
    registryHash: hashRegistry(contracts),
    markets: releaseMarkets,
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
  assert.equal(parsed.releaseManifestHash, hashReleaseManifest(JSON.parse(readFileSync(path, 'utf8'))));

  const bundle = buildRegistryBundle(contracts, 'localnet', path);
  assert.deepEqual(bundle.contracts, contracts);
  assert.equal(bundle.metadata.releaseId, 'local-run-1');
  assert.equal(bundle.metadata.registryHash, hashRegistry(contracts));

  const marketContracts = contracts;
  const marketPath = writeManifest('markets.json', {
    contracts: marketContracts,
    registryHash: hashRegistry(marketContracts),
    markets: releaseMarkets,
  });
  const parsedMarkets = readCanonicalReleaseManifest(marketPath, 'localnet').markets;
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
    /pool does not match contract LaunchpadFixedPool/
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
    /optionAddress does not match contract LaunchpadFixedOption/
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
    /pool does not match contract LaunchpadFixedPool/
  );

  const objectAddressPath = writeManifest('object-address.json', {
    network: 'ton:localnet',
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([key, address]) => [key, { address }])
    ),
  });
  assert.deepEqual(readCanonicalReleaseManifest(objectAddressPath, 'localnet').contracts, contracts);

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
    /markets must be an array/
  );
  assert.throws(
    () =>
      readCanonicalReleaseManifest(
        writeManifest('empty-markets.json', { markets: [] }),
        'localnet'
      ),
    /exactly three markets/
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

  const plain = buildRegistryBundle(contracts, 'testnet');
  assert.equal(plain.metadata.releaseId, null);
  assert.equal(plain.metadata.releaseManifestHash, null);
  assert.equal(plain.metadata.registryHash, hashRegistry(contracts));

  process.stdout.write('release manifest registry parity ok\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
