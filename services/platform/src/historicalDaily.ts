import { parse, stringify } from 'lossless-json';
import { hash } from './crypto.js';
import { ApiError } from './errors.js';
import { fetchJson, record, type Fetcher } from './http.js';
import { historicalPositive } from './historicalAnchors.js';
import type { Price } from './types.js';

export const HISTORICAL_DAILY_METHOD = 'coingecko-utc-daily-snapshot' as const;
export const HISTORICAL_DAILY_CACHE_SECONDS = 21600;
export const HISTORICAL_DAILY_MISSING_SECONDS = 60;
const format = 'coingecko-daily-evidence-v1';
const documentationUrl = 'https://docs.coingecko.com/reference/coins-id-history';
const canonicalJson = (value: unknown): string => {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : item;
  return JSON.stringify(ordered(value));
};
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',');
export type HistoricalDailyRequest = {
  coinGeckoId: string; currency: string; requestedDate: string; method: typeof HISTORICAL_DAILY_METHOD; precision: 'daily';
  source: { provider: 'coingecko'; requestUrl: string; documentationUrl: string };
};
export type HistoricalDailyObservation = { price: string; sourcePriceLexeme: string; observationDate: string; observedAt: string };
export type HistoricalDailyEvidence = {
  format: typeof format; request: HistoricalDailyRequest; fetchedAt: string; expiresAt: string;
  sourceJson: string; sourceSha256: string; observation: HistoricalDailyObservation | null;
};
export type HistoricalDailyRevision = { revisionId: string; evidence: HistoricalDailyEvidence };
export type HistoricalDailyEnvelope = { revisionId: string | null; request: HistoricalDailyRequest; fetchedAt: string | null; expiresAt: string | null; stale: boolean };

export function historicalDailyRequest(coinGeckoId: string, currency: string, requestedDate: string, tier: 'demo' | 'pro', now: Date): HistoricalDailyRequest {
  const instant = Date.parse(`${requestedDate}T00:00:00.000Z`);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(coinGeckoId) || !/^[A-Z]{3}$/.test(currency) || !['demo', 'pro'].includes(tier))
    throw new ApiError(400, 'invalid_historical_price_identity', 'Use an original CoinGecko identity and currency.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== requestedDate || requestedDate > now.toISOString().slice(0, 10))
    throw new ApiError(400, 'invalid_historical_price_date', 'Use a real historical calendar date.');
  const target = new URL(`/api/v3/coins/${coinGeckoId}/history`, tier === 'pro' ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com');
  target.searchParams.set('date', requestedDate); target.searchParams.set('localization', 'false');
  return { coinGeckoId, currency, requestedDate, method: HISTORICAL_DAILY_METHOD, precision: 'daily', source: { provider: 'coingecko', requestUrl: target.toString(), documentationUrl } };
}
export const historicalDailyCacheKey = (request: HistoricalDailyRequest): string => `cg:daily:revision:${hash(canonicalJson(request))}`;
export const historicalDailyRevisionId = (evidence: HistoricalDailyEvidence): string => hash(canonicalJson(evidence));
function nullableObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || record(value).isLosslessNumber === true) throw Error('Historical source contains malformed market data.');
  return value as Record<string, unknown>;
}
function observation(source: unknown, request: HistoricalDailyRequest): HistoricalDailyObservation | null {
  const row = nullableObject(source);
  if (!row || row.id !== request.coinGeckoId) throw Error('Historical source coin identity differs from the request.');
  const markets = nullableObject(row.market_data), prices = nullableObject(markets?.current_price), price = prices?.[request.currency.toLowerCase()];
  if (price === undefined || price === null) return null;
  if (record(price).isLosslessNumber !== true) throw Error('Historical price must retain its original JSON numeric lexeme.');
  const sourcePriceLexeme = String(price);
  if (sourcePriceLexeme.length > 2048) throw Error('Historical price lexeme exceeds its bound.');
  const exact = historicalPositive(sourcePriceLexeme);
  if (!exact) throw Error('Historical price must be positive.');
  return { price: exact, sourcePriceLexeme, observationDate: request.requestedDate, observedAt: `${request.requestedDate}T00:00:00.000Z` };
}
export async function fetchHistoricalDaily(request: HistoricalDailyRequest, key: string, fetcher: Fetcher, clock: () => Date): Promise<HistoricalDailyEvidence> {
  const pro = new URL(request.source.requestUrl).origin === 'https://pro-api.coingecko.com';
  if (canonicalJson(request) !== canonicalJson(historicalDailyRequest(request.coinGeckoId, request.currency, request.requestedDate, pro ? 'pro' : 'demo', clock()))) throw Error('Invalid historical source request.');
  const response = await fetchJson(request.source.requestUrl, { headers: { [pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: key } }, fetcher);
  const sourceJson = stringify(response), value = observation(response, request), now = clock();
  if (typeof sourceJson !== 'string' || sourceJson.length > 4_000_000) throw Error('Invalid historical source evidence.');
  return { format, request, fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (value ? HISTORICAL_DAILY_CACHE_SECONDS : HISTORICAL_DAILY_MISSING_SECONDS) * 1000).toISOString(),
    sourceJson, sourceSha256: hash(sourceJson), observation: value };
}
/** Archive age does not invalidate preserved evidence; only fresh admission uses expiry. */
export function historicalDailyEvidenceMatches(value: unknown, request: HistoricalDailyRequest, now: Date): value is HistoricalDailyEvidence {
  try {
    const tier = new URL(request.source.requestUrl).origin === 'https://pro-api.coingecko.com' ? 'pro' : 'demo';
    if (canonicalJson(request) !== canonicalJson(historicalDailyRequest(request.coinGeckoId, request.currency, request.requestedDate, tier, now))) return false;
    const evidence = record(value);
    if (!keys(evidence, ['format', 'request', 'fetchedAt', 'expiresAt', 'sourceJson', 'sourceSha256', 'observation']) || evidence.format !== format || canonicalJson(evidence.request) !== canonicalJson(request)
      || typeof evidence.fetchedAt !== 'string' || !Number.isFinite(Date.parse(evidence.fetchedAt)) || new Date(evidence.fetchedAt).toISOString() !== evidence.fetchedAt
      || Date.parse(evidence.fetchedAt) > now.getTime() || evidence.fetchedAt.slice(0, 10) < request.requestedDate
      || typeof evidence.sourceJson !== 'string' || evidence.sourceJson.length > 4_000_000 || evidence.sourceSha256 !== hash(evidence.sourceJson)) return false;
    const parsed = observation(parse(evidence.sourceJson), request);
    return canonicalJson(parsed) === canonicalJson(evidence.observation)
      && evidence.expiresAt === new Date(Date.parse(evidence.fetchedAt) + (parsed ? HISTORICAL_DAILY_CACHE_SECONDS : HISTORICAL_DAILY_MISSING_SECONDS) * 1000).toISOString();
  } catch { return false; }
}
export function historicalDailyResult(request: HistoricalDailyRequest, now: Date, revision?: HistoricalDailyRevision, expired = false): { quote: Price; historicalPrice: HistoricalDailyEnvelope } {
  const evidence = revision?.evidence, value = evidence?.observation, stale = !evidence || expired || Date.parse(evidence.expiresAt) <= now.getTime();
  return { historicalPrice: { request, revisionId: revision?.revisionId ?? null, fetchedAt: evidence?.fetchedAt ?? null, expiresAt: evidence?.expiresAt ?? null, stale },
    quote: { assetId: request.coinGeckoId, price: value?.price ?? null, observedAt: value?.observedAt ?? null, observationDate: value?.observationDate ?? null,
      requestedDate: request.requestedDate, source: 'coingecko', stale: stale || !value, status: value ? 'available' : evidence ? 'missing' : 'unavailable', precision: 'daily', change24h: null } };
}
