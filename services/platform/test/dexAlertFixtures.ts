import { Decimal } from '../src/decimal.js';
import type { Config } from '../src/config.js';
import type { AlertAsset, AlertQuote, PriceRuleInput } from '../src/types.js';
import { address, config } from './helpers.js';

export const quoteRoot = `0:${'b'.repeat(64)}`;
export const nativeRoot = `0:${'a'.repeat(64)}`;
export const native: AlertAsset = { kind: 'ton', network: 'testnet', assetId: 'native' };
export const token: AlertAsset = { kind: 'ton', network: 'testnet', assetId: address };
export const release: NonNullable<Config['dexRelease']> = {
  network: 'testnet', releaseId: 'testnet-r2-fixture', manifestHash: 'f'.repeat(64),
  indexerUrl: 'https://indexer.example.test/api/indexer/v1', quoteAssetId: quoteRoot, quoteRoot, quoteDecimals: 9, quoteCodeHash: 'b'.repeat(64),
  tokens: [
    { assetId: 'native', symbol: 'GRAM', name: 'Gram', root: nativeRoot, decimals: 9, codeHash: 'a'.repeat(64) },
    { assetId: address, symbol: 'TOKEN', name: 'Token', root: address, decimals: 9, codeHash: 'e'.repeat(64) },
    { assetId: quoteRoot, symbol: 'T3', name: 'T3', root: quoteRoot, decimals: 9, codeHash: 'b'.repeat(64) },
  ],
  markets: [
    { assetId: 'native', marketKey: 'spot:GRAM-T3', address: `0:${'c'.repeat(64)}`, codeHash: 'c'.repeat(64), binSpacing: 10, feePips: 30 },
    { assetId: address, marketKey: 'spot:TOKEN-T3', address: `0:${'d'.repeat(64)}`, codeHash: 'd'.repeat(64), binSpacing: 10, feePips: 30 },
  ],
};
export const dexConfig = (overrides: Partial<Config> = {}) => config({ dexRelease: release, ...overrides });
export const dexDefinition = (overrides: Partial<PriceRuleInput> = {}): PriceRuleInput => ({
  asset: token, currency: 'T3', quoteAssetId: quoteRoot, releaseManifestHash: release.manifestHash,
  enabled: true, kind: 'target', thresholdPercent: null, targetPrice: '105', direction: 'above', ...overrides,
});
export function dexQuote(overrides: Partial<AlertQuote> = {}, at = Date.now()): AlertQuote {
  const asset = overrides.asset ?? token;
  const assetId = asset.kind === 'ton' ? asset.assetId : address;
  const observedAt = overrides.observedAt === undefined ? new Date(at).toISOString() : overrides.observedAt;
  const price = overrides.price === undefined ? '100.000000000000000001' : overrides.price;
  let numerator = '1', denominator = '1';
  try {
    const value = new Decimal(price!);
    if (value.isFinite() && value.gt(0)) {
      denominator = new Decimal(10).pow(value.decimalPlaces()).toFixed(0);
      numerator = value.mul(denominator).toFixed(0);
    }
  } catch { /* Invalid values remain available for rejection tests. */ }
  const market = release.markets.find(value => value.assetId === assetId) ?? release.markets[1]!;
  return { asset, currency: 'T3', quoteAssetId: quoteRoot, price, observedAt,
    source: 'tonswap-dex', stale: false, status: 'available', change24h: null, issue: null,
    evidence: { method: 'active_pool_q64', precision: 'indicative_display', network: asset.kind === 'ton' ? asset.network : 'testnet',
      assetId, currency: 'T3', quoteAssetId: quoteRoot, release: { releaseId: release.releaseId, manifestHash: release.manifestHash },
      marketKey: market.marketKey, marketAddress: market.address, codeHash: market.codeHash,
      observedAt, queriedAt: observedAt, source: 'ton-indexer/http4',
      head: { workchain: -1, shard: '-9223372036854775808', seqno: 123, rootHashHex: '1'.repeat(64), fileHashHex: '2'.repeat(64) },
      exactRatio: { numerator, denominator }, activeBin: 0, q64: '18446744073709551616',
      lastMarketObservationAt: observedAt, executableDepthT3Raw: '1000000000', executableDepthAssetRaw: '1000000000',
      rootBindings: { assetRoot: assetId === 'native' ? nativeRoot : assetId, quoteRoot,
        assetCodeHash: assetId === 'native' ? 'a'.repeat(64) : 'e'.repeat(64), quoteCodeHash: 'b'.repeat(64) } }, ...overrides };
}
