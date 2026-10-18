import { alertAssetKey } from './alertAssets.js';
import { alertAssetSchema } from './alertAssetSchema.js';
import type { Config } from './config.js';
import { DexPrices } from './dexPrices.js';
import { assessPriceObservation } from './priceMonitoring.js';
import type { AlertAsset, AlertQuote, AlertQuotesResponse } from './types.js';

const unavailable = (asset: AlertAsset, issue: string, quoteAssetId: string | null = null,
  status: AlertQuote['status'] = 'unavailable'): AlertQuote => ({
  asset, currency: 'T3', quoteAssetId, price: null, observedAt: null, source: null, status, stale: true,
  change24h: null, evidence: {}, issue,
});

/** Resolve current alert prices only through the active release's DEX markets. */
export class AlertObservations {
  constructor(private config: Config, private dex: Pick<DexPrices, 'prices' | 'configured' | 'catalogue'> = new DexPrices(config),
    private clock: () => Date = () => new Date()) {}

  async prices(input: AlertAsset[]): Promise<AlertQuotesResponse> {
    const assets = [...new Map(input.map(value => {
      const asset = alertAssetSchema.parse(value); return [alertAssetKey(asset), asset] as const;
    })).values()];
    const requestedAt = this.clock().toISOString();
    const resolved = new Map<string, AlertQuote>();
    for (const asset of assets) {
      if (asset.kind === 'listed') resolved.set(alertAssetKey(asset), unavailable(asset, 'dex_asset_required'));
      else if (!this.config.networks.includes(asset.network))
        resolved.set(alertAssetKey(asset), unavailable(asset, 'network_not_configured'));
    }
    for (const network of ['mainnet', 'testnet'] as const) {
      const networkAssets = assets.filter((asset): asset is Extract<AlertAsset, { kind: 'ton' }> =>
        asset.kind === 'ton' && asset.network === network && !resolved.has(alertAssetKey(asset)));
      if (!networkAssets.length) continue;
      if (!this.dex.configured(network)) {
        for (const asset of networkAssets) resolved.set(alertAssetKey(asset), unavailable(asset, 'dex_release_not_configured'));
        continue;
      }
      const catalogue = this.dex.catalogue(network);
      const quoteIds = new Set(catalogue.map(entry => entry.quoteAssetId));
      const quoteAssetId = quoteIds.size === 1 ? [...quoteIds][0]! : null;
      try {
        const response = await this.dex.prices(network, networkAssets.map(asset => asset.assetId));
        const scoped = response.network === network && response.currency === 'T3' && quoteAssetId !== null &&
          response.quoteAssetId === quoteAssetId && response.release?.manifestHash === this.config.dexRelease?.manifestHash &&
          response.release?.releaseId === this.config.dexRelease?.releaseId;
        for (const asset of networkAssets) {
          const matches = response.quotes.filter(quote => quote.assetId === asset.assetId);
          const entry = catalogue.filter(entry => entry.assetId === asset.assetId);
          if (!scoped || entry.length !== 1) {
            resolved.set(alertAssetKey(asset), unavailable(asset, 'quote_scope_invalid', quoteAssetId)); continue;
          }
          if (matches.length !== 1) {
            resolved.set(alertAssetKey(asset), unavailable(asset, matches.length ? 'quote_scope_invalid' : 'quote_missing',
              quoteAssetId, matches.length ? 'unavailable' : 'missing')); continue;
          }
          const value = matches[0]!;
          const evidenceRelease = value.evidence.release as { releaseId?: unknown; manifestHash?: unknown } | undefined;
          const roots = value.evidence.rootBindings as Record<string, unknown> | undefined;
          const token = this.config.dexRelease?.tokens.find(token => token.assetId === asset.assetId);
          const market = this.config.dexRelease?.markets.find(market => market.assetId === asset.assetId);
          if (value.status === 'available' && (evidenceRelease?.manifestHash !== this.config.dexRelease?.manifestHash ||
              evidenceRelease?.releaseId !== this.config.dexRelease?.releaseId || value.evidence.marketKey !== entry[0]!.marketKey ||
              value.evidence.marketAddress !== entry[0]!.marketAddress || !entry[0]!.priceConfigured ||
              !token || !market || value.evidence.codeHash !== market.codeHash || roots?.assetRoot !== token.root ||
              roots?.assetCodeHash !== token.codeHash || roots?.quoteRoot !== this.config.dexRelease?.quoteRoot ||
              roots?.quoteCodeHash !== this.config.dexRelease?.quoteCodeHash)) {
            resolved.set(alertAssetKey(asset), unavailable(asset, 'quote_scope_invalid', quoteAssetId)); continue;
          }
          const quote: AlertQuote = { asset, currency: 'T3', quoteAssetId, price: value.price, observedAt: value.observedAt,
            source: value.source === 'tonswap-dex' ? value.source : null, status: value.status, stale: value.stale,
            change24h: null, issue: value.issues[0] ?? null, evidence: { ...value.evidence, change24hIssue: 'change_unavailable' } };
          resolved.set(alertAssetKey(asset), this.assessed(quote, quoteAssetId));
        }
      } catch {
        for (const asset of networkAssets) resolved.set(alertAssetKey(asset), unavailable(asset, 'dex_provider_unavailable', quoteAssetId));
      }
    }
    const quotes = assets.map(asset => resolved.get(alertAssetKey(asset))!);
    const quoteIds = new Set(quotes.flatMap(quote => quote.quoteAssetId ? [quote.quoteAssetId] : []));
    return { currency: 'T3', quoteAssetId: quoteIds.size === 1 ? [...quoteIds][0]! : null, requestedAt, quotes,
      issues: [...new Set(quotes.flatMap(quote => quote.issue ? [quote.issue] : []))] };
  }

  private assessed(quote: AlertQuote, expectedQuoteAssetId: string | null): AlertQuote {
    const assessment = assessPriceObservation(quote.asset, 'target', quote, 'T3', this.clock().getTime(), expectedQuoteAssetId);
    if (assessment.outcome === 'unavailable') return { ...quote, status: quote.status === 'missing' ? 'missing' : 'unavailable',
      price: null, change24h: null, issue: assessment.issue };
    return { ...quote, stale: assessment.outcome === 'stale', issue: assessment.issue ?? quote.issue };
  }
}
