import { Address } from '@ton/core';
import { describe, expect, it, vi } from 'vitest';
import { AlertObservations } from '../src/alertObservations.js';
import { DexPrices } from '../src/dexPrices.js';
import { assessPriceObservation } from '../src/priceMonitoring.js';
import type { AlertAsset, AlertQuote } from '../src/types.js';
import { dexConfig, dexQuote, native, token, quoteRoot, release } from './dexAlertFixtures.js';
const now = Date.parse('2026-10-09T06:00:00.000Z');
function setup(change: Record<string, unknown> = {}, overrides: Partial<AlertQuote> = {}) {
  const cfg = dexConfig({ networks: ['mainnet', 'testnet'] });
  const forbidden = vi.fn(async () => { throw Error('Unexpected external provider request.'); });
  const dex = new DexPrices(cfg, forbidden);
  const prices = vi.spyOn(dex, 'prices').mockImplementation(async (network, assets) => ({
    network, currency: 'T3', quoteAssetId: quoteRoot, release: { releaseId: release.releaseId, manifestHash: release.manifestHash },
    requestedAt: new Date(now).toISOString(), quotes: assets.map(assetId => {
      const value = dexQuote({ asset: { kind: 'ton', network, assetId }, ...overrides }, now);
      return { ...value, assetId, source: value.source ?? 'unavailable', issues: value.issue ? [value.issue] : [] };
    }), ...change,
  }));
  return { cfg, dex, prices, forbidden, observations: new AlertObservations(cfg, dex, () => new Date(now)) };
}
describe('canonical current DEX alert observations', () => {
  it('captures native and token T3 prices without listed provider calls or percentage fabrication', async () => {
    const { observations, prices, forbidden } = setup();
    const result = await observations.prices([native, token, { kind: 'listed', coinGeckoId: 'bitcoin' }]);
    expect(prices).toHaveBeenCalledExactlyOnceWith('testnet', ['native', token.assetId]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(result).toMatchObject({ currency: 'T3', quoteAssetId: quoteRoot });
    for (const value of result.quotes.slice(0, 2)) expect(value).toMatchObject({ currency: 'T3', quoteAssetId: quoteRoot,
      source: 'tonswap-dex', status: 'available', change24h: null, price: '100.000000000000000001' });
    expect(result.quotes[2]).toMatchObject({ status: 'unavailable', issue: 'dex_asset_required', price: null });
    expect(assessPriceObservation(token, 'target', result.quotes[1]!, 'T3', now, quoteRoot).outcome).toBe('observed');
    expect(assessPriceObservation(token, 'percent', result.quotes[1]!, 'T3', now, quoteRoot).issue).toBe('change_unavailable');
  });
  it('normalizes and deduplicates friendly addresses without merging networks', async () => {
    const { observations, prices } = setup();
    const result = await observations.prices([token, { ...token, assetId: Address.parse(token.assetId).toString({ testOnly: true }) },
      { ...token, network: 'mainnet' }]);
    expect(result.quotes).toHaveLength(2);
    expect(result.quotes[1]).toMatchObject({ status: 'unavailable', issue: 'dex_release_not_configured' });
    expect(prices).toHaveBeenCalledExactlyOnceWith('testnet', [token.assetId]);
  });
  it('does not call any provider for invalid identities or unconfigured release', async () => {
    const { cfg, dex, prices } = setup();
    await expect(new AlertObservations(cfg, dex).prices(['bitcoin' as unknown as AlertAsset])).rejects.toThrow();
    vi.spyOn(dex, 'configured').mockReturnValue(false);
    expect((await new AlertObservations(cfg, dex).prices([token])).quotes[0]?.issue).toBe('dex_release_not_configured');
    expect(prices).not.toHaveBeenCalled();
  });
  it.each([{ currency: 'USD' }, { quoteAssetId: `0:${'9'.repeat(64)}` }, { network: 'mainnet' },
    { release: { releaseId: release.releaseId, manifestHash: '0'.repeat(64) } }, { release: null }])('rejects a foreign response scope %#', async change => {
    const { observations } = setup(change);
    expect((await observations.prices([token])).quotes[0]).toMatchObject({ price: null, status: 'unavailable', issue: 'quote_scope_invalid' });
  });
  it('rejects foreign evidence even when its response envelope matches the active release', async () => {
    const value = dexQuote({ asset: token }, now);
    for (const evidence of [{ ...value.evidence, release: { releaseId: release.releaseId, manifestHash: '0'.repeat(64) } },
      { ...value.evidence, marketAddress: `0:${'9'.repeat(64)}` }]) {
      const { observations } = setup({}, { evidence });
      expect((await observations.prices([token])).quotes[0]).toMatchObject({ status: 'unavailable', issue: 'quote_scope_invalid' });
    }
  });
  it('retains explicit stale evidence and original time without substituting an external observation', async () => {
    const observedAt = new Date(now - 120001).toISOString();
    const { observations } = setup({}, { observedAt });
    expect((await observations.prices([token])).quotes[0]).toMatchObject({ observedAt, status: 'available', stale: true, issue: 'quote_stale' });
  });
  it('distinguishes missing, duplicate, and unavailable quotes and never retains cached success after failure', async () => {
    const { observations, prices } = setup();
    const first = await observations.prices([token]);
    prices.mockResolvedValueOnce({ network: 'testnet', currency: 'T3', quoteAssetId: quoteRoot, release, requestedAt: '', quotes: [] });
    expect((await observations.prices([token])).quotes[0]).toMatchObject({ status: 'missing', issue: 'quote_missing' });
    const value = { ...first.quotes[0]!, assetId: token.assetId, issues: [] };
    prices.mockResolvedValueOnce({ network: 'testnet', currency: 'T3', quoteAssetId: quoteRoot, release, requestedAt: '', quotes: [value, value] });
    expect((await observations.prices([token])).quotes[0]).toMatchObject({ status: 'unavailable', issue: 'quote_scope_invalid' });
    prices.mockRejectedValueOnce(Error('Private connection diagnostics'));
    expect((await observations.prices([token])).quotes[0]).toMatchObject({ status: 'unavailable', price: null, observedAt: null, issue: 'dex_provider_unavailable' });
  });
});
