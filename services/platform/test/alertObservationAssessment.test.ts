import { describe, expect, it } from 'vitest';
import { assessPriceObservation } from '../src/priceMonitoring.js';
import type { AlertQuote } from '../src/types.js';
import { dexQuote, token, quoteRoot } from './dexAlertFixtures.js';
const now = Date.parse('2026-09-26T10:00:00.000Z');
const quote = (overrides: Partial<AlertQuote> = {}) => dexQuote(overrides, now);
const assess = (value = quote(), at = now) => assessPriceObservation(token, 'target', value, 'T3', at, quoteRoot);

describe('DEX alert observation identity and denomination', () => {
  it('accepts an exact positive T3 price with current release/getter evidence', () => {
    expect(assess(quote({ price: '0.000000000000000001' }))).toMatchObject({ outcome: 'observed', source: 'tonswap-dex', issue: null });
  });
  it('binds asset, network, explicit T3 denomination and quote-root identity', () => {
    expect(assess(quote({ asset: { ...token, network: 'mainnet' } }))).toMatchObject({ issue: 'quote_scope_invalid' });
    expect(assess(quote({ asset: { kind: 'listed', coinGeckoId: 'bitcoin' } }))).toMatchObject({ issue: 'quote_scope_invalid' });
    expect(assess(quote({ currency: 'USD' }))).toMatchObject({ issue: 'currency_mismatch' });
    expect(assess(quote({ quoteAssetId: `0:${'9'.repeat(64)}` }))).toMatchObject({ issue: 'currency_mismatch' });
    expect(assessPriceObservation(token, 'target', quote(), 'T3', now)).toMatchObject({ issue: 'currency_mismatch' });
    expect(assessPriceObservation(token, 'target', quote(), 'USD', now, quoteRoot)).toMatchObject({ issue: 'currency_mismatch' });
  });
  it.each([
    { method: 'coingecko-utc-daily-snapshot' }, { precision: 'daily' }, { quoteAssetId: 'native' },
    { release: { releaseId: 'wrong', manifestHash: '' } }, { rootBindings: {} }, { head: {} },
    { exactRatio: { numerator: '0', denominator: '1' } }, { executableDepthAssetRaw: '0' },
  ])('rejects incomplete or foreign evidence %#', evidence => {
    expect(assess(quote({ evidence: { ...quote().evidence, ...evidence } }))).toMatchObject({ outcome: 'unavailable', issue: 'quote_scope_invalid' });
  });
  it('never accepts CoinGecko source or synthesizes 24-hour changes from a current state', () => {
    expect(assess(quote({ source: 'coingecko' as AlertQuote['source'] }))).toMatchObject({ outcome: 'unavailable', source: null });
    for (const change24h of [null, '5']) expect(assessPriceObservation(token, 'percent', quote({ change24h }), 'T3', now, quoteRoot))
      .toMatchObject({ outcome: 'unavailable', issue: 'change_unavailable' });
  });
  it('does not substitute a quote decimal for its exact witnessed ratio', () => {
    const original = quote();
    expect(assess({ ...original, price: '999' })).toMatchObject({ issue: 'quote_invalid' });
  });
  it('retains explicit unavailable results without inventing source times', () => {
    expect(assess(quote({ source: null, status: 'unavailable', evidence: {}, observedAt: null, issue: 'network_not_configured' })))
      .toEqual({ outcome: 'unavailable', source: null, issue: 'network_not_configured', observed_at: null });
  });
  it('uses inclusive freshness boundaries and rejects forged future or mismatched observation times', () => {
    expect(assess(quote(), now + 120000)).toMatchObject({ outcome: 'observed' });
    expect(assess(quote(), now + 120001)).toMatchObject({ outcome: 'stale' });
    expect(assess(quote(), now - 5001)).toMatchObject({ issue: 'observation_time_invalid' });
    expect(assess({ ...quote(), observedAt: new Date(now - 1000).toISOString() })).toMatchObject({ issue: 'observation_time_invalid' });
    expect(assess(quote({ price: 'Infinity' }))).toMatchObject({ issue: 'quote_invalid' });
    expect(assess(quote({ evidence: { ...quote().evidence, queriedAt: new Date(now + 5001).toISOString() } }))).toMatchObject({ issue: 'observation_time_invalid' });
  });
});
