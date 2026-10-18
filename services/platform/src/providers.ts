import { Decimal } from './decimal.js';
import { fetchJson, record, type Fetcher } from './http.js';
import type { Database } from './db.js';
import type { Config } from './config.js';
import type { Price, PricesResponse, Quote, RatesResponse } from './types.js';
import { historicalAnchorRequest, historicalAnchorCacheKey,
  fetchHistoricalAnchor, historicalAnchorResponse, HISTORICAL_ANCHOR_CACHE_SECONDS,
  type HistoricalAnchorResponse } from './historicalAnchors.js';
import { HistoricalAnchorRepository } from './historicalAnchorRepository.js';
import { HistoricalFxRepository } from './historicalFxRepository.js';
import { HistoricalDailyRepository } from './historicalDailyRepository.js';
import { historicalDailyRequest, historicalDailyCacheKey, fetchHistoricalDaily, historicalDailyResult, HISTORICAL_DAILY_CACHE_SECONDS } from './historicalDaily.js';
import { PtaxRepository } from './ptaxRepository.js';
import { ReceitaWorkRatesRepository } from './receitaWorkRatesRepository.js';
import { fetchReceitaWorkRates, receitaWorkRatesCacheKey } from './receitaWorkRatesProvider.js';
import { receitaWorkRatesRequest, receitaWorkRatesResponse, RECEITA_WORK_RATES_TTL_MS } from './receitaWorkRates.js';
import { fetchPtax, ptaxCacheKey, ptaxRequest, ptaxResult, PTAX_CACHE_SECONDS } from './ptax.js';
import { historicalFxRequest, historicalFxDate, historicalFxCacheKey, fetchHistoricalFx, historicalFxResult, HISTORICAL_FX_CACHE_SECONDS } from './historicalFx.js';

const positive = (value: unknown): string | null => {
  try { const number = new Decimal(String(value)); return number.isFinite() && number.gt(0) ? number.toString() : null; }
  catch { return null; }
};
const day = (value: Date) => value.toISOString().slice(0, 10);
const emptyRate = (symbol: string, date?: string): Quote => ({ symbol, rate: null, observedAt: null,
  observationDate: null, requestedDate: date ?? null, source: 'frankfurter-v2', providers: [],
  stale: true, status: 'missing', precision: 'daily' });
const emptyPrice = (assetId: string, date?: string): Price => ({ assetId, price: null, observedAt: null,
  observationDate: null, requestedDate: date ?? null, source: 'coingecko', stale: true,
  status: 'missing', precision: date ? 'daily' : 'spot', change24h: null });
/** Public, wallet-independent provider queries only. Sources: frankfurter.dev and docs.coingecko.com. */
export class Providers {
  private inFlight = new Map<string, Promise<unknown>>();
  private historicalAnchors: HistoricalAnchorRepository;
  private historicalFx: HistoricalFxRepository;
  private historicalDaily: HistoricalDailyRepository;
  private ptaxArchive: PtaxRepository;
  private receitaWorkRatesArchive: ReceitaWorkRatesRepository;
  constructor(private db: Database, private config: Config, private fetcher: Fetcher = fetch,
    private clock: () => Date = () => new Date()) { this.historicalAnchors = new HistoricalAnchorRepository(db); this.historicalFx = new HistoricalFxRepository(db); this.historicalDaily = new HistoricalDailyRepository(db); this.ptaxArchive = new PtaxRepository(db); this.receitaWorkRatesArchive = new ReceitaWorkRatesRepository(db); }

  private async cached<T>(key: string, seconds: number, fetchValue: () => Promise<T>, validate?: (value: unknown) => boolean | Promise<boolean>,
    evidenceExpiry?: (value: T) => string): Promise<{ value: T; expired: boolean }> {
    const stored = (await this.db.query<{ value: T; expires_at: Date | string }>(
      'SELECT value,expires_at FROM platform_quote_cache WHERE key=$1', [key])).rows[0];
    const cached = stored && (!validate || await validate(stored.value)) ? stored : undefined;
    const expiresAt = (value: T, cacheExpiry: Date | string) => Math.min(new Date(cacheExpiry).getTime(),
      evidenceExpiry ? Date.parse(evidenceExpiry(value)) : Infinity);
    // The mutable cache cannot extend the lifetime of immutable source evidence.
    if (cached && expiresAt(cached.value, cached.expires_at) > this.clock().getTime()) return { value: cached.value, expired: false };
    let pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = (async () => {
        const value = await fetchValue();
        if (validate && !await validate(value)) throw new Error('Provider observation does not match its cache evidence contract.');
        await this.db.query(`INSERT INTO platform_quote_cache(key,value,expires_at) VALUES($1,$2,$3)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at,fetched_at=now()`,
        [key, JSON.stringify(value), new Date(expiresAt(value, new Date(this.clock().getTime() + seconds * 1000)))]);
        return value;
      })();
      this.inFlight.set(key, pending);
    }
    try { return { value: await pending, expired: false }; }
    catch (error) { if (cached) return { value: cached.value, expired: true }; throw error; }
    finally { this.inFlight.delete(key); }
  }

  async historicalAnchor(coinGeckoId: string, at: string): Promise<HistoricalAnchorResponse> {
    const request = historicalAnchorRequest(coinGeckoId, at, this.config.coingeckoTier, this.clock());
    if (!this.config.coingeckoKey) return historicalAnchorResponse(request, this.clock(), undefined, false, 'coingecko_key_not_configured');
    try {
      const result = await this.cached(historicalAnchorCacheKey(request), HISTORICAL_ANCHOR_CACHE_SECONDS,
        async () => this.historicalAnchors.persist(await fetchHistoricalAnchor(request, this.config.coingeckoKey!, this.config.coingeckoTier, this.fetcher, this.clock), this.clock()),
        value => this.historicalAnchors.matches(value, request, this.clock()), value => value.evidence.expiresAt);
      return historicalAnchorResponse(request, this.clock(), result.value, result.expired,
        result.expired ? 'historical_anchor_refresh_unavailable_cached_revision' : undefined);
    } catch { return historicalAnchorResponse(request, this.clock(), undefined, false, 'historical_anchor_refresh_unavailable'); }
  }

  async historicalAnchorRevision(revisionId: string) {
    return this.historicalAnchors.read(revisionId, this.clock());
  }

  async historicalDailyRevision(revisionId: string) { return this.historicalDaily.read(revisionId, this.clock()); }

  async historicalFxRevision(revisionId: string) {
    return this.historicalFx.read(revisionId, this.clock());
  }

  async ptax(currency: string, date: string) {
    const request = ptaxRequest(currency, date, this.clock());
    try {
      const cached = await this.cached(ptaxCacheKey(request), PTAX_CACHE_SECONDS,
        async () => this.ptaxArchive.persist(await fetchPtax(request, this.fetcher, this.clock), this.clock()),
        value => this.ptaxArchive.matches(value, request, this.clock()), value => value.evidence.expiresAt);
      return ptaxResult(request, this.clock(), cached.value, cached.expired);
    } catch { return ptaxResult(request, this.clock()); }
  }

  async ptaxRevision(id: string) { return this.ptaxArchive.read(id, this.clock()); }

  async receitaWorkRates(receiptMonth: string) {
    const request = receitaWorkRatesRequest(receiptMonth);
    try {
      const cached = await this.cached(receitaWorkRatesCacheKey(request), RECEITA_WORK_RATES_TTL_MS / 1000,
        async () => this.receitaWorkRatesArchive.persist(await fetchReceitaWorkRates(request, this.fetcher, this.clock), this.clock()),
        value => this.receitaWorkRatesArchive.matches(value, request, this.clock()), value => value.evidence.expiresAt);
      return receitaWorkRatesResponse(request, this.clock(), cached.value, cached.expired);
    } catch { return receitaWorkRatesResponse(request, this.clock()); }
  }
  async receitaWorkRatesRevision(id: string) { return this.receitaWorkRatesArchive.read(id, this.clock()); }

  async currencies(): Promise<unknown> {
    const result = await this.cached('fx:currencies:v2', 86400, async () => {
      const values = await fetchJson('https://api.frankfurter.dev/v2/currencies', {}, this.fetcher);
      if (!Array.isArray(values)) throw new Error('Invalid currency catalogue.');
      return values.map(value => { const row = record(value); return { code: String(row.iso_code ?? row.code ?? ''), name: String(row.name ?? '') }; })
        .filter(value => /^[A-Z]{3}$/.test(value.code));
    });
    return { currencies: result.value, source: 'frankfurter-v2', stale: result.expired };
  }

  async rates(base: string, symbols: string[], date?: string): Promise<RatesResponse> {
    const sorted = [...new Set(symbols)].sort(); const issues: string[] = [];
    const cryptoSymbols = sorted.filter(symbol => ['BTC', 'XOR', 'GRAM'].includes(symbol));
    const fiat = sorted.filter(symbol => !cryptoSymbols.includes(symbol) && symbol !== base);
    let quotes: Quote[] = [], historicalFx: RatesResponse['historicalFx'], historicalPrices: RatesResponse['historicalPrices'];
    if (date) historicalFxDate(date, this.clock());
    if (date && fiat.length) {
      const request = historicalFxRequest(base, fiat, date, this.clock());
      try {
        const result = await this.cached(historicalFxCacheKey(request), HISTORICAL_FX_CACHE_SECONDS,
          async () => this.historicalFx.persist(await fetchHistoricalFx(request, this.fetcher, this.clock), this.clock()),
          value => this.historicalFx.matches(value, request, this.clock()), value => value.evidence.expiresAt);
        const output = historicalFxResult(request, this.clock(), result.value, result.expired);
        quotes = output.quotes; historicalFx = output.historicalFx; issues.push(...output.issues);
        if (result.expired) issues.push('historical_fx_refresh_unavailable_cached_revision');
      } catch {
        const output = historicalFxResult(request, this.clock());
        quotes = output.quotes; historicalFx = output.historicalFx; issues.push('historical_fx_refresh_unavailable');
      }
    } else if (fiat.length) {
      try {
        const fetchRates = async (): Promise<Quote[]> => {
          const target = new URL('https://api.frankfurter.dev/v2/rates');
          target.searchParams.set('base', base); target.searchParams.set('quotes', fiat.join(','));
          target.searchParams.set('expand', 'providers');
          const response = await fetchJson(target, {}, this.fetcher);
          if (!Array.isArray(response)) throw new Error('Invalid FX provider response.');
          return fiat.map(symbol => {
            const matches = response.map(record).filter(row => row.quote === symbol && row.base === base);
            const row = matches.length === 1 ? matches[0] : undefined;
            if (!row) return emptyRate(symbol);
            const observationDate = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null;
            const rate = positive(row.rate);
            if (!rate || !observationDate || !Number.isFinite(Date.parse(observationDate)) || new Date(observationDate).toISOString().slice(0, 10) !== observationDate || observationDate > day(this.clock())) return emptyRate(symbol);
            const providerObservations = Array.isArray(row.providers) ? row.providers.map(record)
              .filter(provider => typeof provider.key === 'string' && typeof provider.date === 'string')
              .map(provider => ({ key: String(provider.key), date: String(provider.date), rate: positive(provider.rate), excluded: provider.excluded === true })) : [];
            return { ...emptyRate(symbol), rate, observationDate, observedAt: `${observationDate}T00:00:00.000Z`,
              providers: providerObservations.filter(provider => !provider.excluded).map(provider => provider.key),
              providerObservations, status: 'available' as const, stale: false };
          });
        };
        const result = await this.cached(`fx:v2:${base}:${fiat.join(',')}:latest`, 3600, fetchRates);
        quotes = result.value.map(quote => ({ ...quote, stale: result.expired || !quote.observedAt ||
          (this.clock().getTime() - Date.parse(quote.observedAt) > 96 * 3600_000) }));
        if (result.expired) issues.push('fx_provider_unavailable_cached_observation');
      } catch { quotes = fiat.map(symbol => ({ ...emptyRate(symbol), status: 'unavailable' })); issues.push('fx_provider_unavailable'); }
    }
    if (sorted.includes(base)) quotes.push({ ...emptyRate(base, date), source: date ? 'identity' : 'frankfurter-v2', rate: '1',
      observationDate: date ?? day(this.clock()), observedAt: `${date ?? day(this.clock())}T00:00:00.000Z`, stale: false, status: 'available' });
    for (const symbol of cryptoSymbols) {
      let quote: Quote = { ...emptyRate(symbol, date), source: 'unavailable', precision: date ? 'daily' : 'spot', status: 'unavailable' };
      if (date && base === 'USD' && symbol === 'BTC') {
        const result = await this.prices(['bitcoin'], 'usd', date); const price = result.quotes[0];
        if (result.historicalPrices) historicalPrices = result.historicalPrices;
        issues.push(...result.issues);
        if (price) quote = { ...quote, source: 'coingecko', providers: ['coingecko:bitcoin'],
          rate: price.price ? new Decimal(1).div(price.price).toString() : null,
          observedAt: price.observedAt, observationDate: price.observationDate, status: price.status, stale: price.stale };
      } else if (!date) issues.push(`dex_usd_conversion_unavailable:${symbol}`);
      quotes.push(quote);
    }
    return { base, requestedAt: this.clock().toISOString(), quotes: sorted.map(symbol => quotes.find(quote => quote.symbol === symbol)!), issues, ...(historicalFx ? { historicalFx } : {}), ...(historicalPrices ? { historicalPrices } : {}) };
  }

  async prices(ids: string[], currency = 'usd', date?: string): Promise<PricesResponse> {
    const sorted = [...new Set(ids)].sort();
    if (date !== undefined) {
      const quotes: Price[] = [], historicalPrices: NonNullable<PricesResponse['historicalPrices']> = [], issues: string[] = [];
      const requests = sorted.map(id => historicalDailyRequest(id, currency.toUpperCase(), date, this.config.coingeckoTier, this.clock()));
      for (let index = 0; index < requests.length; index += 2) {
        const batch = await Promise.all(requests.slice(index, index + 2).map(async request => {
          if (!this.config.coingeckoKey) { issues.push('coingecko_key_not_configured'); return historicalDailyResult(request, this.clock()); }
          try {
            const result = await this.cached(historicalDailyCacheKey(request), HISTORICAL_DAILY_CACHE_SECONDS,
              async () => this.historicalDaily.persist(await fetchHistoricalDaily(request, this.config.coingeckoKey!, this.fetcher, this.clock), this.clock()),
              value => this.historicalDaily.matches(value, request, this.clock()), value => value.evidence.expiresAt);
            if (result.expired) issues.push(`historical_price_refresh_unavailable_cached_revision:${request.coinGeckoId}:${date}`);
            return historicalDailyResult(request, this.clock(), result.value, result.expired);
          } catch { issues.push(`historical_price_unavailable:${request.coinGeckoId}:${date}`); return historicalDailyResult(request, this.clock()); }
        }));
        for (const result of batch) { quotes.push(result.quote); historicalPrices.push(result.historicalPrice); }
      }
      return { currency: currency.toUpperCase(), requestedAt: this.clock().toISOString(), quotes, historicalPrices, issues: [...new Set(issues)] };
    }
    // Current token prices belong to the release-bound DEX resolver. This dated
    // provider boundary must never fetch or revive cached external spot prices.
    return { currency: currency.toUpperCase(), requestedAt: this.clock().toISOString(),
      quotes: sorted.map(id => ({ ...emptyPrice(id), source: 'unavailable', status: 'unavailable' })),
      issues: ['current_prices_require_dex_pair'] };
  }
}
