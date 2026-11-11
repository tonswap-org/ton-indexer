import { Decimal } from '../src/decimal.js';
import type { Config } from '../src/config.js';
import type { AlertAsset, AlertQuote, PriceRuleInput } from '../src/types.js';
import { dexManifest, oracleFixture, poolIdFixture } from './dexFixtures.js';
import { address, config } from './helpers.js';

export const quoteRoot = `0:${'b'.repeat(64)}`;
export const otherRoot = `0:${'a'.repeat(64)}`;
export const otherToken: AlertAsset = { kind: 'ton', network: 'testnet', assetId: otherRoot };
export const token: AlertAsset = { kind: 'ton', network: 'testnet', assetId: address };
export const release: NonNullable<Config['dexRelease']> = {
  factory:`0:${'5'.repeat(64)}`,feeSink:`0:${'6'.repeat(64)}`,treasury:`0:${'7'.repeat(64)}`,
  network: 'testnet', releaseId: 'testnet-current-fixture', manifestHash: 'f'.repeat(64),
  indexerUrl: 'https://indexer.example.test/api/indexer/v1', quoteAssetId: quoteRoot, quoteRoot, quoteDecimals: 9, quoteCodeHash: 'b'.repeat(64),
  tokens: [
    { assetId: otherRoot, symbol: 'OTHER', name: 'Other token', root: otherRoot, decimals: 9, codeHash: 'a'.repeat(64) },
    { assetId: address, symbol: 'TOKEN', name: 'Token', root: address, decimals: 9, codeHash: 'e'.repeat(64) },
    { assetId: quoteRoot, symbol: 'T3', name: 'T3', root: quoteRoot, decimals: 9, codeHash: 'b'.repeat(64) },
  ],
  markets: [
    { assetId: otherRoot, marketKey: 'spot:OTHER-T3', address: `0:${'c'.repeat(64)}`, codeHash: 'c'.repeat(64), xDecimals:9,walletGasX:dexManifest().spotMarkets[0].walletGasX,walletGramX:'0',walletBudgetX:dexManifest().spotMarkets[0].walletBudgetX, binSpacing: 10, feePips: 30 },
    { assetId: address, marketKey: 'spot:TOKEN-T3', address: `0:${'d'.repeat(64)}`, codeHash: 'd'.repeat(64), xDecimals:9,walletGasX:dexManifest().spotMarkets[0].walletGasX,walletGramX:'0',walletBudgetX:dexManifest().spotMarkets[0].walletBudgetX, binSpacing: 10, feePips: 30 },
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
  const observedAt = overrides.observedAt === undefined ? new Date(Math.floor(at/1000)*1000).toISOString() : overrides.observedAt;
  const price = overrides.price === undefined ? '100.000000001' : overrides.price;
  const market = release.markets.find(value => value.assetId === assetId) ?? release.markets[1]!;
  const time = Number.isFinite(Date.parse(observedAt!)) ? Math.floor(Date.parse(observedAt!)/1000) : Math.floor(at/1000);
  let priceE9=100_000_000_000n;
  try { const n=new Decimal(price!).mul(1e9); if(n.isFinite()&&n.isInteger()&&n.gte(1_000_000)&&n.lt(new Decimal(2).pow(120))) priceE9=BigInt(n.toFixed(0)); } catch {}
  return { asset, currency: 'T3', quoteAssetId: quoteRoot, price, observedAt,
    source: 'tonswap-dex', stale: false, status: 'available', change24h: null, issue: null,
    evidence: { method: 'pool_twap_median_v1', precision: 'indicative_display', network: asset.kind === 'ton' ? asset.network : 'testnet',
      assetId, currency: 'T3', quoteAssetId: quoteRoot, release: { releaseId: release.releaseId, manifestHash: release.manifestHash },
      marketKey: market.marketKey, marketAddress: market.address, codeHash: market.codeHash,
      observedAt, queriedAt: observedAt, source: 'ton-indexer/lite',
      head: { workchain: -1, shard: '-9223372036854775808', seqno: 123, utime:time, rootHashHex: '1'.repeat(64), fileHashHex: '2'.repeat(64) },
      exactRatio: { numerator: priceE9.toString(), denominator: '1000000000' },
      oracle:{evidenceBoc:oracleFixture({servedAt:time,at:time,spot:priceE9,short:priceE9,medium:priceE9,long:priceE9}),windowsSeconds:[300,1800,7200],medianPriceE9:priceE9.toString()},
      pool:{idBoc:poolIdFixture({...market,xMaster:assetId}),factory:release.factory,feeSink:release.feeSink,treasury:release.treasury,t3Master:quoteRoot,flags:1,ready:true,activeBin:0},
      rootBindings: { assetRoot: assetId, quoteRoot,
        assetCodeHash: assetId === otherRoot ? 'a'.repeat(64) : 'e'.repeat(64), quoteCodeHash: 'b'.repeat(64) } }, ...overrides };
}
