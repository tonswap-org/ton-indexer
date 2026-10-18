import { Address } from '@ton/core';
import { describe, expect, it } from 'vitest';
import { alertAssetKey } from '../src/alertAssets.js';
import { alertAssetSchema } from '../src/alertAssetSchema.js';

const raw = `0:${'a'.repeat(64)}`;
describe('canonical alert asset identity', () => {
  it('separates provider listings, networks and native or contract identities', () => {
    const keys = [{ kind: 'listed' as const, coinGeckoId: 'the-open-network' },
      { kind: 'ton' as const, network: 'mainnet' as const, assetId: 'native' },
      { kind: 'ton' as const, network: 'testnet' as const, assetId: 'native' },
      { kind: 'ton' as const, network: 'mainnet' as const, assetId: raw }].map(alertAssetKey);
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual(['listed:coingecko:the-open-network', 'ton:mainnet:native', 'ton:testnet:native', `ton:mainnet:${raw}`]);
  });
  it('canonicalizes friendly addresses without changing network identity', () => {
    const asset = alertAssetSchema.parse({ kind: 'ton', network: 'testnet', assetId: Address.parse(raw).toString({ testOnly: true }) });
    expect(asset).toEqual({ kind: 'ton', network: 'testnet', assetId: raw });
  });
  it.each(['bitcoin', { assetId: 'bitcoin' }, { kind: 'listed', coinGeckoId: 'bitcoin', assetId: 'native' },
    { kind: 'listed', coinGeckoId: 'BTC' }, { kind: 'listed', coinGeckoId: 'a'.repeat(81) },
    { kind: 'ton', network: 'devnet', assetId: 'native' }, { kind: 'ton', network: 'testnet', assetId: 'TOKEN' },
    { kind: 'ton', network: 'testnet', assetId: raw, symbol: 'TON' },
    { kind: 'ton', network: 'testnet', assetId: `1:${'a'.repeat(64)}` },
  ])('rejects obsolete or ambiguous identity %#', value => {
    expect(alertAssetSchema.safeParse(value).success).toBe(false);
  });
});
