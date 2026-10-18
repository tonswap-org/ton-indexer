import type { Config } from './config.js';
import { DexPrices } from './dexPrices.js';
import type { AlertAsset, AlertAssetOption } from './types.js';

/** Only a market bound to the active release can admit a current price rule. */
export function alertCapabilities(config: Config, asset: AlertAsset,
  dex: Pick<DexPrices, 'configured' | 'catalogue'> = new DexPrices(config)): AlertAssetOption['capabilities'] {
  if (asset.kind !== 'ton' || !config.networks.includes(asset.network) || !dex.configured(asset.network))
    return { target: false, percent: false };
  const entries = dex.catalogue(asset.network).filter(entry => entry.assetId === asset.assetId);
  return { target: entries.length === 1 && entries[0]!.priceConfigured, percent: false };
}
