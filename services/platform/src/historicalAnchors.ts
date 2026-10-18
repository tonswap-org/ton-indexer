import { Decimal } from './decimal.js';
import { hash } from './crypto.js';
import { ApiError } from './errors.js';
import { fetchJson, record, type Fetcher } from './http.js';

// Shared with daily accounting observations: retain every source digit before arithmetic.
const historicalDecimalLimit = 2048;
export const historicalPositive = (value: unknown): string | null => {
  let number: InstanceType<typeof Decimal>;
  try { number = new Decimal(String(value)); }
  catch { return null; }
  if (!number.isFinite() || !number.gt(0)) return null;
  const places = number.decimalPlaces();
  const length = Math.max(1, number.e + 1) + (places ? places + 1 : 0);
  if (length > historicalDecimalLimit) throw new Error('Historical price exceeds the supported plain-decimal length.');
  return number.toFixed();
};
export const historicalDecimalMatches = (value: unknown): value is string => typeof value === 'string' &&
  value.length <= historicalDecimalLimit && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) && historicalPositive(value) === value;

export const HISTORICAL_ANCHOR_METHOD = 'coingecko-hourly-latest-at-or-before-v1' as const;
export const HISTORICAL_ANCHOR_LOOKBACK_SECONDS = 7200;
export const HISTORICAL_ANCHOR_CACHE_SECONDS = 21600;
const format = 'coingecko-range-evidence-v1';
const numericLexeme = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const canonicalJson = (value: unknown): string => {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) :
    value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, ordered(entry)])) : value;
  return JSON.stringify(ordered(value));
};

export type HistoricalAnchorRequest = {
  coinGeckoId: string; currency: 'USD'; at: string;
  method: typeof HISTORICAL_ANCHOR_METHOD;
  range: { fromUnixSeconds: number; toUnixSeconds: number; from: string; to: string };
  source: { provider: 'coingecko'; identityBinding: 'request-path'; requestUrl: string;
    interval: 'hourly'; pricePrecision: 'full' };
};
export type HistoricalAnchorObservation = {
  observedAt: string; timestampMs: string; priceUsd: string;
  sourceTimestampLexeme: string; sourcePriceLexeme: string;
};
export type HistoricalAnchorEvidence = {
  format: typeof format; request: HistoricalAnchorRequest; fetchedAt: string; expiresAt: string;
  observations: HistoricalAnchorObservation[]; pricesSha256: string;
};
export type HistoricalAnchorRevision = { revisionId: string; evidence: HistoricalAnchorEvidence };
export type HistoricalAnchorResponse = HistoricalAnchorRequest & {
  retrievedAt: string; status: 'available' | 'missing' | 'unavailable'; precision: 'sampled';
  priceUsd: string | null; observedAt: string | null; lagMilliseconds: number | null;
  selectedObservationIndex: number | null; maximumLagSeconds: number;
  observations: HistoricalAnchorObservation[]; pricesSha256: string | null; revisionId: string | null;
  cache: { fetchedAt: string | null; expiresAt: string | null; stale: boolean };
  stale: boolean; issues: string[];
};

/** Require a real offset-qualified timestamp; never accept Date's calendar rollover. */
export function historicalAnchorTime(value: string, now: Date): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const fail = () => { throw new ApiError(400, 'invalid_historical_time', 'Use a real, offset-qualified historical timestamp with at most millisecond precision.'); };
  if (!parts) return fail();
  const [, year, month, date, hour, minute, second, , offset] = parts;
  const localDate = new Date(`${year}-${month}-${date}T00:00:00.000Z`);
  const millis = Date.parse(value);
  if (!Number.isFinite(localDate.getTime()) || localDate.toISOString().slice(0, 10) !== `${year}-${month}-${date}` ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59)) ||
    !Number.isSafeInteger(millis) || millis < HISTORICAL_ANCHOR_LOOKBACK_SECONDS * 1000 || millis > now.getTime()) return fail();
  return new Date(millis).toISOString();
}

export function historicalAnchorRequest(coinGeckoId: string, at: string, tier: 'demo' | 'pro', now: Date): HistoricalAnchorRequest {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(coinGeckoId))
    throw new ApiError(400, 'invalid_historical_asset', 'Use a configured CoinGecko asset identity.');
  const instant = historicalAnchorTime(at, now), millis = Date.parse(instant);
  const fromUnixSeconds = Math.floor(millis / 1000) - HISTORICAL_ANCHOR_LOOKBACK_SECONDS;
  const toUnixSeconds = Math.ceil(millis / 1000);
  const target = new URL(`/api/v3/coins/${encodeURIComponent(coinGeckoId)}/market_chart/range`,
    tier === 'pro' ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com');
  target.searchParams.set('vs_currency', 'usd'); target.searchParams.set('from', String(fromUnixSeconds));
  target.searchParams.set('to', String(toUnixSeconds)); target.searchParams.set('interval', 'hourly');
  target.searchParams.set('precision', 'full');
  return { coinGeckoId, currency: 'USD', at: instant, method: HISTORICAL_ANCHOR_METHOD,
    range: { fromUnixSeconds, toUnixSeconds, from: new Date(fromUnixSeconds * 1000).toISOString(), to: new Date(toUnixSeconds * 1000).toISOString() },
    source: { provider: 'coingecko', identityBinding: 'request-path', requestUrl: target.toString(), interval: 'hourly', pricePrecision: 'full' } };
}

export const historicalAnchorCacheKey = (request: HistoricalAnchorRequest): string => `cg:range:${hash(canonicalJson(request))}`;
export const historicalAnchorRevisionId = (evidence: HistoricalAnchorEvidence): string => hash(canonicalJson(evidence));

function observation(timestampLexeme: string, priceLexeme: string, request: HistoricalAnchorRequest, now: Date): HistoricalAnchorObservation {
  if (timestampLexeme.length > 100 || priceLexeme.length > historicalDecimalLimit ||
    !numericLexeme.test(timestampLexeme) || !numericLexeme.test(priceLexeme)) throw new Error('Invalid historical numeric observation.');
  const exactTimestamp = new Decimal(timestampLexeme);
  if (!exactTimestamp.isInteger() || exactTimestamp.abs().gt(Number.MAX_SAFE_INTEGER)) throw new Error('Historical timestamps require exact integer milliseconds.');
  const millis = exactTimestamp.toNumber(), priceUsd = historicalPositive(priceLexeme);
  if (!Number.isSafeInteger(millis) || millis < request.range.fromUnixSeconds * 1000 ||
    millis > request.range.toUnixSeconds * 1000 || millis > now.getTime() || !priceUsd)
    throw new Error('Historical observation is outside its requested range or has no positive price.');
  return { timestampMs: String(millis), observedAt: new Date(millis).toISOString(), priceUsd,
    sourceTimestampLexeme: timestampLexeme, sourcePriceLexeme: priceLexeme };
}

export async function fetchHistoricalAnchor(request: HistoricalAnchorRequest, key: string, tier: 'demo' | 'pro',
  fetcher: Fetcher, clock: () => Date): Promise<HistoricalAnchorEvidence> {
  const response = record(await fetchJson(request.source.requestUrl, { headers: {
    [tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: key,
  } }, fetcher));
  // This endpoint does not provide a response ID. Its authenticated URL is the
  // identity evidence; an unexpected conflicting ID is still rejected.
  if (response.id !== undefined && response.id !== request.coinGeckoId) throw new Error('Historical response identity conflicts with its request path.');
  if (!Array.isArray(response.prices) || response.prices.length > 512) throw new Error('Invalid historical price series.');
  const fetched = clock();
  const observations = response.prices.map((point: unknown) => {
    if (!Array.isArray(point) || point.length !== 2 || point.some(value => record(value).isLosslessNumber !== true))
      throw new Error('Historical prices must contain original JSON numeric tuples.');
    return observation(String(point[0]), String(point[1]), request, fetched);
  });
  if (new Set(observations.map(point => point.timestampMs)).size !== observations.length)
    throw new Error('Duplicate historical observation timestamps are ambiguous.');
  return { format, request, fetchedAt: fetched.toISOString(), expiresAt: new Date(fetched.getTime() + HISTORICAL_ANCHOR_CACHE_SECONDS * 1000).toISOString(),
    observations, pricesSha256: hash(canonicalJson(observations)) };
}

export function historicalAnchorEvidenceMatches(value: unknown, request: HistoricalAnchorRequest, now: Date): value is HistoricalAnchorEvidence {
  try {
    const origin = new URL(request.source.requestUrl).origin;
    if (origin !== 'https://pro-api.coingecko.com' && origin !== 'https://api.coingecko.com') return false;
    if (canonicalJson(request) !== canonicalJson(historicalAnchorRequest(request.coinGeckoId, request.at,
      origin === 'https://pro-api.coingecko.com' ? 'pro' : 'demo', now))) return false;
    const cached = record(value);
    if (cached.format !== format || canonicalJson(cached.request) !== canonicalJson(request) ||
      typeof cached.fetchedAt !== 'string' || !Number.isFinite(Date.parse(cached.fetchedAt)) ||
      new Date(cached.fetchedAt).toISOString() !== cached.fetchedAt || Date.parse(cached.fetchedAt) < Date.parse(request.at) || Date.parse(cached.fetchedAt) > now.getTime() ||
      cached.expiresAt !== new Date(Date.parse(cached.fetchedAt) + HISTORICAL_ANCHOR_CACHE_SECONDS * 1000).toISOString() ||
      !Array.isArray(cached.observations) || cached.observations.length > 512) return false;
    const observations = cached.observations.map((value: unknown) => {
      const point = record(value);
      if (typeof point.sourceTimestampLexeme !== 'string' || typeof point.sourcePriceLexeme !== 'string') throw new Error('Missing original lexemes.');
      const canonical = observation(point.sourceTimestampLexeme, point.sourcePriceLexeme, request, new Date(cached.fetchedAt as string));
      if (canonicalJson(canonical) !== canonicalJson(point)) throw new Error('Historical cache observation changed.');
      return canonical;
    });
    return new Set(observations.map(point => point.timestampMs)).size === observations.length && cached.pricesSha256 === hash(canonicalJson(observations));
  } catch { return false; }
}

export function historicalAnchorResponse(request: HistoricalAnchorRequest, now: Date, revision?: HistoricalAnchorRevision,
  expired = false, issue?: string): HistoricalAnchorResponse {
  const cached = revision?.evidence;
  const observations = cached?.observations ?? [], at = Date.parse(request.at);
  let selectedObservationIndex: number | null = null;
  for (let index = 0; index < observations.length; index++) {
    const timestamp = Number(observations[index]!.timestampMs), lag = at - timestamp;
    if (lag < 0 || lag > HISTORICAL_ANCHOR_LOOKBACK_SECONDS * 1000) continue;
    if (selectedObservationIndex === null || timestamp > Number(observations[selectedObservationIndex]!.timestampMs)) selectedObservationIndex = index;
  }
  const selected = selectedObservationIndex === null ? null : observations[selectedObservationIndex]!;
  const stale = !cached || expired || Date.parse(cached.expiresAt) <= now.getTime();
  return { ...request, retrievedAt: now.toISOString(), status: selected ? 'available' : cached ? 'missing' : 'unavailable', precision: 'sampled',
    priceUsd: selected?.priceUsd ?? null, observedAt: selected?.observedAt ?? null, lagMilliseconds: selected ? at - Number(selected.timestampMs) : null,
    selectedObservationIndex, maximumLagSeconds: HISTORICAL_ANCHOR_LOOKBACK_SECONDS,
    observations, pricesSha256: cached?.pricesSha256 ?? null, revisionId: revision?.revisionId ?? null,
    cache: { fetchedAt: cached?.fetchedAt ?? null, expiresAt: cached?.expiresAt ?? null, stale }, stale,
    issues: [...(issue ? [issue] : []), ...(!selected && cached ? ['no_observation_at_or_before_requested_time'] : [])] };
}
