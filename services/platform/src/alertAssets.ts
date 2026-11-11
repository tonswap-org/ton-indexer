import type { AlertAsset } from './types.js';

/** Format a validated identity. This module is shared with the browser and has no runtime dependencies. */
export function alertAssetKey(asset: AlertAsset): string {
  return asset.kind === 'listed' ? `listed:coingecko:${asset.coinGeckoId}` : `ton:${asset.network}:${asset.assetId}`;
}
