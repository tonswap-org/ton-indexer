import { describe, expect, it } from 'vitest';
import { alertCapabilities } from '../src/alertCapabilities.js';
import { dexConfig, native, token, quoteRoot, release } from './dexAlertFixtures.js';

const none = { target: false, percent: false };
describe('release-bound DEX alert capabilities', () => {
  it('supports target rules only for explicit active-release markets', () => {
    expect(alertCapabilities(dexConfig(), native)).toEqual({ target: true, percent: false });
    expect(alertCapabilities(dexConfig(), token)).toEqual({ target: true, percent: false });
    expect(alertCapabilities(dexConfig(), { kind: 'ton', network: 'testnet', assetId: quoteRoot })).toEqual(none);
  });
  it('never admits current listed prices, even when a CoinGecko key and mapping exist', () => {
    const cfg = dexConfig({ coingeckoKey: 'fixture', assetValuationPaths: [{ kind: 'coingecko', network: 'testnet', assetId: 'native', coinGeckoId: 'anchor' }] });
    expect(alertCapabilities(cfg, { kind: 'listed', coinGeckoId: 'anchor' })).toEqual(none);
    expect(alertCapabilities({ ...cfg, dexRelease: undefined }, native)).toEqual(none);
  });
  it('never borrows an asset or quote identity from a different network', () => {
    expect(alertCapabilities(dexConfig({ networks: ['mainnet', 'testnet'] }), { ...native, network: 'mainnet' })).toEqual(none);
    expect(alertCapabilities(dexConfig({ networks: ['mainnet'] }), native)).toEqual(none);
    expect(alertCapabilities(dexConfig(), { kind: 'ton', network: 'testnet', assetId: `0:${'9'.repeat(64)}` })).toEqual(none);
  });
  it('withdraws capability when the release, matching indexer or market binding is removed', () => {
    expect(alertCapabilities(dexConfig({ dexRelease: undefined }), token)).toEqual(none);
    expect(alertCapabilities(dexConfig({ indexerUrls: {} }), token)).toEqual(none);
    expect(alertCapabilities(dexConfig({ dexRelease: { ...release, markets: [] } }), token)).toEqual(none);
  });
});
