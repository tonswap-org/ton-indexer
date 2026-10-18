import { hash } from './crypto.js';
import type { Fetcher } from './http.js';
import { receitaWorkRatesCanonical, receitaWorkRatesObservation, receitaWorkRatesReplay, receitaWorkRatesRequest,
  receitaWorkRatesSnapshot, RECEITA_WORK_RATES_MAX_BYTES, RECEITA_WORK_RATES_TTL_MS,
  type ReceitaWorkRatesEvidence, type ReceitaWorkRatesRequest } from './receitaWorkRates.js';
export const receitaWorkRatesCacheKey = (request: ReceitaWorkRatesRequest) => `receita-work-rates:revision:${hash(receitaWorkRatesCanonical(request))}`;
export const receitaWorkRatesRevisionId = (evidence: ReceitaWorkRatesEvidence) => hash(receitaWorkRatesCanonical(evidence));
export function receitaWorkRatesEvidenceMatches(value: unknown, request: ReceitaWorkRatesRequest, now: Date): value is ReceitaWorkRatesEvidence {
  try {
    const expected = receitaWorkRatesRequest(request.receiptMonth);
    if (receitaWorkRatesCanonical(request) !== receitaWorkRatesCanonical(expected)) return false;
    const evidence = receitaWorkRatesReplay(value, expected.receiptMonth, now);
    return hash(evidence.sourceHtml) === evidence.sourceSha256;
  } catch { return false; }
}
/** A fixed public Receita origin only. Strict UTF-8 preserves the exact decoded HTTP body bytes. */
export async function fetchReceitaWorkRates(request: ReceitaWorkRatesRequest, fetcher: Fetcher, clock: () => Date): Promise<ReceitaWorkRatesEvidence> {
  const detached = receitaWorkRatesSnapshot(request) as ReceitaWorkRatesRequest, canonical = receitaWorkRatesRequest(detached.receiptMonth);
  if (receitaWorkRatesCanonical(detached) !== receitaWorkRatesCanonical(canonical)) throw Error('Receita work-rate request is not canonical.');
  const response = await fetcher(canonical.source.requestUrl, { redirect: 'error', credentials: 'omit', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok || response.redirected || response.url && response.url !== canonical.source.requestUrl ||
    !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    Number(response.headers.get('content-length') ?? 0) > RECEITA_WORK_RATES_MAX_BYTES) throw Error('Receita table response is unavailable or has an unexpected source/content type.');
  const reader = response.body?.getReader(); if (!reader) throw Error('Receita table response has no body.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength;
      if (length > RECEITA_WORK_RATES_MAX_BYTES) throw Error('Receita table exceeds its source limit.'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks), sourceHtml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), fetchedAt = clock();
  if (!Buffer.from(sourceHtml, 'utf8').equals(bytes)) throw Error('Receita source bytes were not preserved.');
  const evidence: ReceitaWorkRatesEvidence = { format: 'receita-work-rates-evidence-v1', request: canonical, fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + RECEITA_WORK_RATES_TTL_MS).toISOString(), sourceHtml, sourceSha256: hash(sourceHtml), ...receitaWorkRatesObservation(sourceHtml, canonical) };
  if (!receitaWorkRatesEvidenceMatches(evidence, canonical, fetchedAt)) throw Error('Receita table evidence did not replay.');
  return evidence;
}
