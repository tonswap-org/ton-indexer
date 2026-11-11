import { parse, stringify } from 'lossless-json';
import { hash } from './crypto.js';
import { ApiError } from './errors.js';
import { fetchJson, record, type Fetcher } from './http.js';
import { historicalPositive } from './historicalAnchors.js';

export const PTAX_CACHE_SECONDS = 21600;
const documentationUrl = 'https://www.bcb.gov.br/conteudo/dadosabertos/BCBDepin/gnastportal-dados-abertostaxas-de-cambio---todos-os-boletins-diarios.pdf';
const format = 'bcb-ptax-daily-evidence-v1' as const;
const sourceTimeZone = 'America/Sao_Paulo' as const;
const closingTypes = new Set(['Fechamento', 'Fechamento PTAX']);
const canonicalJson = (value: unknown): string => {
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, order(item)])) : v;
  return JSON.stringify(order(value));
};
/** Source civil time is retained explicitly; it is never mislabeled as UTC. */
function brazilCivilTime(now: Date): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: sourceTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
}
export interface PtaxRequest {
  currency: string; quoteCurrency: 'BRL'; requestedDate: string; method: 'bcb-ptax-daily-closing';
  source: { provider: 'banco-central-do-brasil'; requestUrl: string; documentationUrl: string };
}
export interface PtaxObservation {
  currency: string; quoteCurrency: 'BRL'; observationDate: string;
  sourceLocalTimestamp: string; sourceTimeZone: typeof sourceTimeZone; bulletin: string;
  /** Direct BRL per one foreign unit. USD parity fields are not BRL rates. */
  buy: string; sell: string; buySourceLexeme: string; sellSourceLexeme: string;
}
export interface PtaxEvidence {
  format: typeof format; request: PtaxRequest; fetchedAt: string; expiresAt: string;
  /** Complete response reserialized without losing numeric lexemes or extra source fields. */
  sourceJson: string; sourceSha256: string; observation: PtaxObservation | null; issues: string[];
}
export interface PtaxRevision { revisionId: string; evidence: PtaxEvidence }

export function ptaxRequest(currency: string, date: string, now: Date): PtaxRequest {
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'BRL') throw new ApiError(400, 'invalid_ptax_currency', 'Use a foreign fiat currency code; BRL identity does not require a bank rate.');
  const instant = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date ||
    date < '1994-07-01' || date > brazilCivilTime(now).slice(0, 10))
    throw new ApiError(400, 'invalid_ptax_date', 'Use a real date in the BRL era that is not in the future in Brazil.');
  const url = new URL('https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaDia(moeda=@moeda,dataCotacao=@dataCotacao)');
  url.searchParams.set('@moeda', `'${currency}'`);
  url.searchParams.set('@dataCotacao', `'${date.slice(5, 7)}-${date.slice(8, 10)}-${date.slice(0, 4)}'`);
  url.searchParams.set('$format', 'json');
  return { currency, quoteCurrency: 'BRL', requestedDate: date, method: 'bcb-ptax-daily-closing',
    source: { provider: 'banco-central-do-brasil', requestUrl: url.toString(), documentationUrl } };
}
export const ptaxCacheKey = (request: PtaxRequest) => `ptax:revision:${hash(canonicalJson(request))}`;
export const ptaxRevisionId = (evidence: PtaxEvidence) => hash(canonicalJson(evidence));
function originalNumber(value: unknown) {
  if (record(value).isLosslessNumber !== true) throw Error('PTAX requires an original JSON number.');
  const lexeme = String(value), rate = lexeme.length <= 2048 ? historicalPositive(lexeme) : null;
  if (!rate) throw Error('PTAX quote must be a finite positive exact amount.');
  return { lexeme, rate };
}
function observations(value: unknown, request: PtaxRequest, fetchedAt: Date) {
  const body = record(value);
  if (!Array.isArray(body.value) || body.value.length > 100 || Object.keys(body).some(key => /nextlink/i.test(key))) throw Error('PTAX response is not a complete bounded daily response.');
  const rows = body.value.map(record);
  for (const row of rows) {
    const timestamp = row.dataHoraCotacao;
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(timestamp) ||
      timestamp.slice(0, 10) !== request.requestedDate || timestamp > brazilCivilTime(fetchedAt) || typeof row.tipoBoletim !== 'string')
      throw Error('PTAX bulletin does not match the requested civil date.');
  }
  const closing = rows.filter(row => closingTypes.has(String(row.tipoBoletim)));
  if (closing.length > 1) throw Error('PTAX has more than one closing observation.');
  if (!closing.length) return { observation: null, issues: [rows.length ? 'ptax_daily_close_missing' : 'ptax_no_observation_on_requested_date'] };
  const row = closing[0]!, buy = originalNumber(row.cotacaoCompra), sell = originalNumber(row.cotacaoVenda);
  // Both sides are preserved. The applicable tax policy must choose the side and date.
  const observation: PtaxObservation = { currency: request.currency, quoteCurrency: 'BRL', observationDate: request.requestedDate,
    sourceLocalTimestamp: String(row.dataHoraCotacao), sourceTimeZone, bulletin: String(row.tipoBoletim),
    buy: buy.rate, sell: sell.rate, buySourceLexeme: buy.lexeme, sellSourceLexeme: sell.lexeme };
  return { observation, issues: [] };
}
export async function fetchPtax(request: PtaxRequest, fetcher: Fetcher, clock: () => Date): Promise<PtaxEvidence> {
  const now = clock(), canonical = ptaxRequest(request.currency, request.requestedDate, now);
  if (canonicalJson(request) !== canonicalJson(canonical)) throw Error('PTAX request identity is not canonical.');
  const response = await fetchJson(canonical.source.requestUrl, {}, fetcher), fetchedAt = clock();
  const sourceJson = stringify(response);
  if (typeof sourceJson !== 'string' || Buffer.byteLength(sourceJson) > 4_000_000) throw Error('Invalid PTAX source evidence.');
  return { format, request: canonical, fetchedAt: fetchedAt.toISOString(), expiresAt: new Date(fetchedAt.getTime() + PTAX_CACHE_SECONDS * 1000).toISOString(),
    sourceJson, sourceSha256: hash(sourceJson), ...observations(response, canonical, fetchedAt) };
}
export function ptaxEvidenceMatches(value: unknown, request: PtaxRequest, now: Date): value is PtaxEvidence {
  try {
    const canonical = ptaxRequest(request.currency, request.requestedDate, now), evidence = record(value);
    if (canonicalJson(request) !== canonicalJson(canonical) || canonicalJson(evidence.request) !== canonicalJson(canonical) || evidence.format !== format ||
      typeof evidence.fetchedAt !== 'string' || !Number.isFinite(Date.parse(evidence.fetchedAt)) || new Date(evidence.fetchedAt).toISOString() !== evidence.fetchedAt || Date.parse(evidence.fetchedAt) > now.getTime() ||
      brazilCivilTime(new Date(evidence.fetchedAt)).slice(0, 10) < request.requestedDate ||
      evidence.expiresAt !== new Date(Date.parse(evidence.fetchedAt) + PTAX_CACHE_SECONDS * 1000).toISOString() ||
      typeof evidence.sourceJson !== 'string' || Buffer.byteLength(evidence.sourceJson) > 4_000_000 || evidence.sourceSha256 !== hash(evidence.sourceJson)) return false;
    const replayed = observations(parse(evidence.sourceJson), canonical, new Date(evidence.fetchedAt));
    return canonicalJson(replayed.observation) === canonicalJson(evidence.observation) && canonicalJson(replayed.issues) === canonicalJson(evidence.issues);
  } catch { return false; }
}
export function ptaxResult(request: PtaxRequest, now: Date, revision?: PtaxRevision, expired = false) {
  const evidence = revision?.evidence;
  return { request, requestedAt: now.toISOString(), status: !evidence ? 'unavailable' : evidence.observation ? 'available' : 'missing',
    revisionId: revision?.revisionId ?? null, fetchedAt: evidence?.fetchedAt ?? null, expiresAt: evidence?.expiresAt ?? null,
    stale: !evidence || expired || Date.parse(evidence.expiresAt) <= now.getTime(), observation: evidence?.observation ?? null,
    issues: [...(evidence?.issues ?? []), ...(!evidence || expired ? ['ptax_refresh_unavailable'] : [])] };
}
