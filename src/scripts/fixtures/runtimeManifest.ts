import { hashReleaseManifest } from '../../config/releaseManifest';
import { RUNTIME_CONTRACT_ROLES, RUNTIME_TEMPLATES, type RuntimeReleaseManifest } from '../../config/runtimeManifest';

export const runtimeAddress = (value: number) => `0:${value.toString(16).padStart(64, '0')}`;

/** Synthetic parser fixture, with no assertion of deployment or chain readiness. */
export function runtimeManifestFixture(overrides: Record<string, unknown> = {}): RuntimeReleaseManifest {
  const contracts = Object.fromEntries(RUNTIME_CONTRACT_ROLES.map((role, i) => [role, { address: runtimeAddress(i + 1), codeHash: 'a'.repeat(64) }]));
  const unsigned = {
    schema: 'tonswap-release-v1', network: 'ton:testnet', globalId: -3,
    releaseId: `testnet-unit-${'b'.repeat(12)}`, createdAt: '2026-10-05T00:00:00.000Z',
    source: { contracts: 'c'.repeat(40), build: 'b'.repeat(64) },
    services: { indexer: 'https://ti.soramitsu.io', tonRpc: 'https://testnet.toncenter.com/api/v2/jsonRPC', platform: 'https://platform.tonswap.org' },
    contracts, templates: Object.fromEntries(RUNTIME_TEMPLATES.map((role, i) => [role, (i + 1).toString(16).repeat(64)])),
    tokens: [
      { symbol: 'T3', root: contracts.T3Root.address, decimals: 9 },
      { symbol: 'TS', root: contracts.TSRoot.address, decimals: 9 },
      ...['USDT', 'USDC', 'KUSD'].map(symbol => ({ symbol, root: contracts[symbol].address, decimals: 9 })),
    ],
    spotMarkets: ['USDT', 'USDC', 'KUSD'].map((symbol, i) => ({ symbol, pool: runtimeAddress(200 + i), binSpacing: 1, feePips: 3000 })),
    perpsMarkets: [{ marketId: 1, symbol: 'USDT', pool: runtimeAddress(200) }],
    options: [{ templateId: 1, kind: 'shout', symbol: 'USDT', seriesId: '1', option: runtimeAddress(300), expiry: '1900000000' },
      { templateId: 2, kind: 'outperformance', symbol: 'USDT', comparisonSymbol: 'USDC' }],
    ...overrides,
  };
  return { ...unsigned, manifestHash: hashReleaseManifest(unsigned) } as RuntimeReleaseManifest;
}
