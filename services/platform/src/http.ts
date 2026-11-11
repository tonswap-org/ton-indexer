import { parse } from 'lossless-json';
import { ApiError } from './errors.js';
export type Fetcher = typeof fetch;
export async function fetchJson(url: string | URL, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<unknown> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Object.assign(new ApiError(503, 'provider_unavailable', `Provider returned HTTP ${response.status}.`), { upstreamStatus: response.status });
  if (Number(response.headers.get('content-length') ?? 0) > 4_000_000) throw new Error('Provider response exceeds size limit.');
  // Stream with a bound: content-length is not a security boundary.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider returned an empty response.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 4_000_000) throw new Error('Provider response exceeds size limit.');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  // Preserve decimal lexemes for accounting consumers; numeric coercion must be deliberate.
  return parse(Buffer.concat(chunks).toString('utf8'));
}
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const numeric = (value: unknown): number => Number(String(value));
export const ordinaryJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry: unknown) =>
  record(entry).isLosslessNumber === true ? numeric(entry) : entry));
