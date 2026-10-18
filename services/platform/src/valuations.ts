import { DexPrices } from './dexPrices.js';
import { Address } from '@ton/core';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Network } from './types.js';
import type { Database } from './db.js';
import type { Providers } from './providers.js';
import type { Fetcher } from './http.js';

export const canonicalAsset = (value: string): string => value === 'native' ? value : Address.parse(value).toRawString();
const assetId = z.string().max(128).transform(canonicalAsset);
const shared = { network: z.enum(['mainnet', 'testnet']), assetId };
export const valuationPathsSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ ...shared, kind: z.literal('coingecko'), coinGeckoId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/) }).strict(),
  z.object({ ...shared, kind: z.literal('market'), marketKey: z.string().min(1).max(200), marketAddress: assetId,
    baseAssetId: assetId, quoteAssetId: assetId, baseSymbol: z.string().regex(/^[A-Z0-9]{1,16}$/),
    quoteSymbol: z.string().regex(/^[A-Z0-9]{1,16}$/), baseDecimals: z.number().int().min(0).max(30),
    quoteDecimals: z.number().int().min(0).max(30) }).strict().refine(value => value.baseAssetId !== value.quoteAssetId &&
      [value.baseAssetId, value.quoteAssetId].includes(value.assetId) && value.marketAddress !== 'native', 'The configured asset must be one side of a distinct canonical market.'),
])).max(200).refine(values => new Set(values.map(value => `${value.network}:${value.assetId}`)).size === values.length, 'Each network asset needs one valuation path.');
export type ValuationPath = z.infer<typeof valuationPathsSchema>[number];
export interface AssetValuation {
  assetId: string; priceUsd: null; observedAt: null; source: 'unavailable';
  stale: true; status: 'unavailable'; evidence: Record<string, unknown>; issues: string[];
}

/** Monetary USD views stay empty until actual USD evidence exists. DEX pair
 * prices retain their own denomination and never inherit a stablecoin peg. */
export class AssetValuations {
  private dex: DexPrices;
  constructor(config: Config, _db: Database, _providers: Pick<Providers, 'prices'>, fetcher: Fetcher = fetch) {
    this.dex = new DexPrices(config, fetcher);
  }
  async prices(network: Network, assets: string[]) {
    const dex = await this.dex.prices(network, assets.map(canonicalAsset));
    const quotes: AssetValuation[] = dex.quotes.map(quote => ({ assetId: quote.assetId,
      priceUsd: null, observedAt: null, source: 'unavailable', stale: true, status: 'unavailable',
      evidence: { quoteAssetId: dex.quoteAssetId, currency: dex.currency, dexSource: 'tonswap-dex' },
      issues: ['dex_quote_is_not_usd'] }));
    return { network, currency: 'USD', requestedAt: dex.requestedAt, quotes, dex };
  }
}
