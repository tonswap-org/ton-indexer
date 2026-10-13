import type { Network } from './index';
import { resolve } from 'node:path';
import { parseCanonicalReleaseManifest, readCanonicalReleaseManifest } from './releaseManifest';

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
export type LoadedManifest = ReturnType<typeof parseCanonicalReleaseManifest>;
export class ManifestTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ManifestTransportError'; }
}

/** A configured transport is the trust source. The content hash also covers all
 * fields, and chain decoders still authenticate every manifest code pin. */
export async function loadRuntimeManifest(source: string, network: Network, fetcher: typeof fetch = fetch): Promise<LoadedManifest> {
  if (!source || source.includes('\0')) throw Error('INDEXER_RELEASE_MANIFEST must be a file path or URL');
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) return readCanonicalReleaseManifest(resolve(source), network);
  const url = new URL(source);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash)
    throw Error('Manifest URLs require HTTPS (HTTP is allowed on loopback), without credentials or fragments');
  let response: Response;
  try { response = await fetcher(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) }); }
  catch (cause) { throw new ManifestTransportError('Manifest transport unavailable', { cause }); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status >= 500) throw new ManifestTransportError(`Manifest transport returned HTTP ${response.status}`);
    throw Error(`Manifest request failed with HTTP ${response.status}`);
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_MANIFEST_BYTES)) {
    await response.body?.cancel();
    throw Error('Manifest response exceeds the byte limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Manifest response is empty');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (cause) { throw new ManifestTransportError('Manifest response transport interrupted', { cause }); }
      const { done, value } = chunk;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) throw Error('Manifest response exceeds the byte limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return parseCanonicalReleaseManifest(Buffer.concat(chunks).toString('utf8'), network);
}
