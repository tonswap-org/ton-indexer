import type { Config } from './config.js';
import { DexPrices } from './dexPrices.js';
import type { AlertAssetOption, Network } from './types.js';
import { alertCapabilities } from './alertCapabilities.js';
import { canonicalAsset } from './valuations.js';

/** Search metadata and denomination come exclusively from the active release. */
export async function alertCatalogue(config: Config, dex: Pick<DexPrices, 'configured' | 'catalogue'>,
  network: Network, query: string) {
  if (!config.networks.includes(network) || !dex.configured(network))
    return { assets: [] as AlertAssetOption[], issues: ['dex_release_not_configured'] };
  const term = query.trim().toLowerCase();
  let canonicalQuery = term;
  try { canonicalQuery = canonicalAsset(query.trim()); } catch { /* A name or symbol can also be searched. */ }
  const assets: AlertAssetOption[] = dex.catalogue(network).filter(entry => !term || entry.assetId === canonicalQuery ||
    [entry.name, entry.symbol, entry.assetId].some(value => value.toLowerCase().includes(term))).map(entry => {
    const asset = { kind: 'ton' as const, network, assetId: entry.assetId };
    return { asset, name: entry.name, symbol: entry.symbol, currency: 'T3', quoteAssetId: entry.quoteAssetId, releaseManifestHash: config.dexRelease!.manifestHash,
      capabilities: alertCapabilities(config, asset, dex) };
  });
  return { assets, issues: [] as string[] };
}
