import { z } from 'zod';
import { canonicalAsset } from './valuations.js';
import type { AlertAsset } from './types.js';

const tonAsset = z.string().min(1).max(128).transform((value, context) => {
  try {
    const canonical = canonicalAsset(value);
    if (canonical !== 'native' && !/^(-1|0):[a-f0-9]{64}$/.test(canonical)) throw new Error();
    return canonical;
  }
  catch {
    context.addIssue({ code: 'custom', message: 'Use native or a valid TON contract address.' });
    return z.NEVER;
  }
});

/** The sole accepted rule identity; bare provider IDs and extra identity fields are rejected. */
export const alertAssetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listed'), coinGeckoId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/) }).strict(),
  z.object({ kind: z.literal('ton'), network: z.enum(['mainnet', 'testnet']), assetId: tonAsset }).strict(),
]).transform((asset): AlertAsset => asset.kind === 'listed'
  ? { kind: 'listed', coinGeckoId: asset.coinGeckoId }
  : { kind: 'ton', network: asset.network, assetId: asset.assetId });
