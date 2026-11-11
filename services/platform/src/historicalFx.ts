import { parse, stringify } from 'lossless-json';
import { hash } from './crypto.js';
import { ApiError } from './errors.js';
import { fetchJson, record, type Fetcher } from './http.js';
import { historicalPositive } from './historicalAnchors.js';
import type { Quote } from './types.js';

export const HISTORICAL_FX_METHOD = 'frankfurter-v2-daily-blend' as const;
export const HISTORICAL_FX_CACHE_SECONDS = 21600;
const format = 'frankfurter-daily-evidence-v1';
const documentationUrl = 'https://api.frankfurter.dev/v2/openapi.json';
const canonicalJson = (value: unknown): string => {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : item;
  return JSON.stringify(ordered(value));
};
export type HistoricalFxRequest = {
  base: string; symbols: string[]; requestedDate: string; method: typeof HISTORICAL_FX_METHOD; precision: 'daily';
  source: { provider: 'frankfurter-v2'; requestUrl: string; documentationUrl: string };
};
export type HistoricalFxObservation = {
  base: string; symbol: string; observationDate: string; observedAt: string; rate: string; sourceRateLexeme: string;
  attribution: 'provider-observations' | 'provider-field-omitted';
  providerObservations: { key: string; date: string; rate: string; sourceRateLexeme: string; excluded: boolean; sourceUrl: string }[];
};
export type HistoricalFxEvidence = {
  format: typeof format; request: HistoricalFxRequest; fetchedAt: string; expiresAt: string;
  /** Losslessly reserialized complete response, retaining numeric lexemes and additional source fields. */
  sourceJson: string; sourceSha256: string; observations: HistoricalFxObservation[]; issues: string[];
};
export type HistoricalFxRevision = { revisionId: string; evidence: HistoricalFxEvidence };
export type HistoricalFxEnvelope = { revisionId: string | null; request: HistoricalFxRequest;
  fetchedAt: string | null; expiresAt: string | null; stale: boolean };

export function historicalFxDate(value: string, now: Date): string {
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value ||
    value < '1948-01-01' || value > now.toISOString().slice(0, 10))
    throw new ApiError(400, 'invalid_historical_fx_date', 'Use a real historical calendar date from 1948 onward.');
  return value;
}
export function historicalFxRequest(base: string, symbols: string[], date: string, now: Date): HistoricalFxRequest {
  if (!/^[A-Z]{3}$/.test(base) || !symbols.length || symbols.length > 50 || symbols.some(symbol => !/^[A-Z]{3}$/.test(symbol) || symbol === base))
    throw new ApiError(400, 'invalid_historical_fx_pair', 'Use fiat currency pairs; currency identity does not require a provider quote.');
  const requestedDate = historicalFxDate(date, now), sorted = [...new Set(symbols)].sort();
  const target = new URL('https://api.frankfurter.dev/v2/rates');
  target.searchParams.set('base', base); target.searchParams.set('quotes', sorted.join(','));
  target.searchParams.set('expand', 'providers'); target.searchParams.set('date', requestedDate);
  return { base, symbols: sorted, requestedDate, method: HISTORICAL_FX_METHOD, precision: 'daily',
    source: { provider: 'frankfurter-v2', requestUrl: target.toString(), documentationUrl } };
}
export const historicalFxCacheKey = (request: HistoricalFxRequest): string => `fx:revision:${hash(canonicalJson(request))}`;
export const historicalFxRevisionId = (evidence: HistoricalFxEvidence): string => hash(canonicalJson(evidence));
const dateMatches = (value: unknown, request: HistoricalFxRequest): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value &&
  value >= '1948-01-01' && value <= request.requestedDate;
function exactRate(value: unknown): { rate: string; lexeme: string } {
  if (record(value).isLosslessNumber !== true) throw Error('FX evidence requires an original JSON number.');
  const lexeme = String(value);
  if (lexeme.length > 2048) throw Error('FX numeric lexeme exceeds its evidence bound.');
  const rate = historicalPositive(lexeme);
  if (!rate) throw Error('FX observation must be positive.');
  return { rate, lexeme };
}
function sourceObservations(source: unknown, request: HistoricalFxRequest) {
  if (!Array.isArray(source) || source.length > 100) throw Error('Invalid historical FX response.');
  const rows = source.map(record), observations: HistoricalFxObservation[] = [], issues: string[] = [];
  if (rows.some(row => row.base !== request.base || !request.symbols.includes(String(row.quote)))) issues.push('historical_fx_unrequested_row');
  for (const symbol of request.symbols) {
    const matches = rows.filter(row => row.quote === symbol);
    if (!matches.length) continue;
    if (matches.length !== 1) { issues.push(`historical_fx_ambiguous_pair:${symbol}`); continue; }
    const row = matches[0]!;
    try {
      if (row.base !== request.base || !dateMatches(row.date, request)) throw Error('FX observation identity/date mismatch.');
      const price = exactRate(row.rate), present = Object.hasOwn(row, 'providers');
      if (present && (!Array.isArray(row.providers) || row.providers.length > 200)) throw Error('Invalid provider attribution.');
      const providers = (present ? row.providers as unknown[] : []).map(value => {
        const provider = record(value);
        if (typeof provider.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(provider.key) || !dateMatches(provider.date, request) ||
          (provider.excluded !== undefined && typeof provider.excluded !== 'boolean')) throw Error('Invalid provider observation.');
        const amount = exactRate(provider.rate);
        const url = new URL(`https://api.frankfurter.dev/v2/providers/${encodeURIComponent(provider.key)}/rate/${request.base}/${symbol}`);
        url.searchParams.set('date', provider.date);
        return { key: provider.key, date: provider.date, rate: amount.rate, sourceRateLexeme: amount.lexeme,
          excluded: provider.excluded === true, sourceUrl: url.toString() };
      });
      if (new Set(providers.map(provider => provider.key)).size !== providers.length) throw Error('Ambiguous provider attribution.');
      observations.push({ base: request.base, symbol, observationDate: row.date, observedAt: `${row.date}T00:00:00.000Z`,
        rate: price.rate, sourceRateLexeme: price.lexeme, attribution: present ? 'provider-observations' : 'provider-field-omitted', providerObservations: providers });
    } catch { issues.push(`historical_fx_invalid_observation:${symbol}`); }
  }
  if (!observations.length && issues.length) throw Error('Historical FX response contains no valid requested observation.');
  return { observations, issues };
}
export async function fetchHistoricalFx(request: HistoricalFxRequest, fetcher: Fetcher, clock: () => Date): Promise<HistoricalFxEvidence> {
  const response = await fetchJson(request.source.requestUrl, {}, fetcher);
  const sourceJson = stringify(response);
  if (typeof sourceJson !== 'string' || sourceJson.length > 4_000_000) throw Error('Invalid historical FX source evidence.');
  const { observations, issues } = sourceObservations(response, request), now = clock();
  return { format, request, fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + HISTORICAL_FX_CACHE_SECONDS * 1000).toISOString(),
    sourceJson, sourceSha256: hash(sourceJson), observations, issues };
}
export function historicalFxEvidenceMatches(value: unknown, request: HistoricalFxRequest, now: Date): value is HistoricalFxEvidence {
  try {
    if (canonicalJson(request) !== canonicalJson(historicalFxRequest(request.base, request.symbols, request.requestedDate, now))) return false;
    const evidence = record(value);
    if (evidence.format !== format || canonicalJson(evidence.request) !== canonicalJson(request) ||
      typeof evidence.fetchedAt !== 'string' || !Number.isFinite(Date.parse(evidence.fetchedAt)) ||
      new Date(evidence.fetchedAt).toISOString() !== evidence.fetchedAt || Date.parse(evidence.fetchedAt) > now.getTime() ||
      evidence.fetchedAt.slice(0, 10) < request.requestedDate ||
      evidence.expiresAt !== new Date(Date.parse(evidence.fetchedAt) + HISTORICAL_FX_CACHE_SECONDS * 1000).toISOString() ||
      typeof evidence.sourceJson !== 'string' || evidence.sourceJson.length > 4_000_000 || evidence.sourceSha256 !== hash(evidence.sourceJson)) return false;
    const parsed = sourceObservations(parse(evidence.sourceJson), request);
    return canonicalJson(parsed.observations) === canonicalJson(evidence.observations) && canonicalJson(parsed.issues) === canonicalJson(evidence.issues);
  } catch { return false; }
}
export function historicalFxResult(request: HistoricalFxRequest, now: Date, revision?: HistoricalFxRevision, expired = false) {
  const evidence = revision?.evidence, stale = !evidence || expired || Date.parse(evidence.expiresAt) <= now.getTime();
  const historicalFx: HistoricalFxEnvelope = { request, revisionId: revision?.revisionId ?? null, fetchedAt: evidence?.fetchedAt ?? null,
    expiresAt: evidence?.expiresAt ?? null, stale };
  const quotes: Quote[] = request.symbols.map(symbol => {
    const observation = evidence?.observations.find(row => row.symbol === symbol);
    return { symbol, rate: observation?.rate ?? null, observationDate: observation?.observationDate ?? null, observedAt: observation?.observedAt ?? null,
      requestedDate: request.requestedDate, source: 'frankfurter-v2', precision: 'daily', providers: observation?.providerObservations.filter(row => !row.excluded).map(row => row.key) ?? [],
      ...(observation ? { providerObservations: observation.providerObservations.map(({ key, date, rate, excluded }) => ({ key, date, rate, excluded })) } : {}),
      status: observation ? 'available' : evidence ? 'missing' : 'unavailable', stale: stale || !observation };
  });
  return { historicalFx, quotes, issues: [...(evidence?.issues ?? []), ...quotes.flatMap(quote => quote.observationDate && quote.observationDate !== request.requestedDate
    ? [`prior_observation:${quote.symbol}:${quote.observationDate}`] : [])] };
}
