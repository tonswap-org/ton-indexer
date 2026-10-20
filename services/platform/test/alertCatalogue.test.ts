import { describe, expect, it, vi } from 'vitest';
import { Address } from '@ton/core';
import { alertCatalogue } from '../src/alertCatalogue.js';
import { DexPrices } from '../src/dexPrices.js';
import { canonicalAsset } from '../src/valuations.js';
import { dexConfig, otherToken, token, quoteRoot } from './dexAlertFixtures.js';

const metadata = { asset: otherToken, name: 'Other token', symbol: 'OTHER', currency: 'T3', quoteAssetId: quoteRoot, releaseManifestHash: 'f'.repeat(64), capabilities: { target: true, percent: false } };
const forbidden = vi.fn(async () => { throw Error('Catalogue must not fetch external metadata.'); });
const search = (query: string, cfg = dexConfig()) => alertCatalogue(cfg, new DexPrices(cfg, forbidden), 'testnet', query);
describe('active-release DEX catalogue', () => {
  it.each(['OTHER', 'Other', 'other', '  oThEr  ', 'oth', 'ther', otherToken.assetId])('finds canonical release token metadata for %j', async query => {
    expect(await search(query)).toEqual({ assets: [metadata], issues: [] });
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('finds friendly contract addresses without creating ticker identity aliases', async () => {
    const response = await search(Address.parse(token.assetId).toString({ testOnly: true }));
    expect(response.assets).toEqual([{ asset: token, name: 'Token', symbol: 'TOKEN', currency: 'T3', quoteAssetId: quoteRoot, releaseManifestHash: 'f'.repeat(64), capabilities: { target: true, percent: false } }]);
    expect(canonicalAsset('native')).toBe('native');
    for (const symbol of ['GRAM', 'gram', 'TON', 'NATIVE']) expect(() => canonicalAsset(symbol)).toThrow();
  });
  it.each(['GRAM', 'native', 'TON', 'Toncoin', 'Bitcoin'])('does not add provider listings or old native names for %j', async query => {
    expect(await search(query)).toEqual({ assets: [], issues: [] });
  });
  it('includes the explicit T3 identity without advertising a self-price alert', async () => {
    const result = await search('');
    expect(result.assets).toHaveLength(3);
    expect(result.assets.find(entry => entry.symbol === 'T3')).toMatchObject({ currency: 'T3', quoteAssetId: quoteRoot, releaseManifestHash: 'f'.repeat(64), capabilities: { target: false, percent: false } });
  });
  it('returns an explicit unavailable release without fabricating native metadata', async () => {
    expect(await search('GRAM', dexConfig({ dexRelease: undefined }))).toEqual({ assets: [], issues: ['dex_release_not_configured'] });
    expect(await search('GRAM', dexConfig({ networks: ['mainnet'] }))).toEqual({ assets: [], issues: ['dex_release_not_configured'] });
  });
});
