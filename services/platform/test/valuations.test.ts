import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { Providers } from '../src/providers.js';
import { AssetValuations } from '../src/valuations.js';
import { DexPrices } from '../src/dexPrices.js';
import { config, database, address, secondAddress } from './helpers.js';
let db: Database;
beforeAll(async () => { db = await database(); }); afterAll(async () => { await db.close(); });
describe('DEX denominations and monetary display boundary', () => {
  it('never invokes external spot providers even when an external anchor is configured', async () => {
    const cfg = config({ coingeckoKey: 'test-key', assetValuationPaths: [
      { kind: 'coingecko', network: 'testnet', assetId: 'native', coinGeckoId: 'anchor' },
    ] });
    const providers = new Providers(db, cfg); const prices = vi.spyOn(providers, 'prices');
    const fetcher = vi.fn();
    const result = await new AssetValuations(cfg, db, providers, fetcher).prices('testnet', ['native', address]);
    expect(result.quotes.every(quote => quote.priceUsd === null && quote.status === 'unavailable')).toBe(true);
    expect(prices).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains a verified T3 pool quote without inventing USD or a stablecoin peg', async () => {
    const dex = { network: 'testnet', currency: 'T3', quoteAssetId: secondAddress, requestedAt: new Date().toISOString(),
      release: { releaseId: 'test-release', manifestHash: 'a'.repeat(64) }, issues: [], quotes: [
        { assetId: address, price: '1.234567891', observedAt: new Date().toISOString(), source: 'tonswap-dex',
          status: 'available', stale: false, change24h: null, evidence: { method: 'pool_twap_median_v1' }, issues: [] },
      ] };
    const mock = vi.spyOn(DexPrices.prototype, 'prices').mockResolvedValue(dex as never);
    try {
      const cfg = config(); const result = await new AssetValuations(cfg, db, new Providers(db, cfg)).prices('testnet', [address]);
      expect(result.currency).toBe('USD'); expect(result.quotes[0]).toMatchObject({ priceUsd: null, observedAt: null,
        source: 'unavailable', status: 'unavailable', issues: ['dex_quote_is_not_usd'] });
      expect(result.dex).toEqual(dex);
    } finally { mock.mockRestore(); }
  });
});
