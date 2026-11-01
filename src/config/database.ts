import { readSecretText } from './secrets';

/** Read credentials at runtime; public manifests should only contain the file path. */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const selected = readSecretText(env, 'INDEXER_DATABASE_URL');
  const value = selected?.trim();
  if (selected !== undefined && !value) throw new Error('The INDEXER_DATABASE_URL secret is empty.');
  if (value) {
    try { const url = new URL(value); if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(); }
    catch { throw new Error('The indexer database secret must be a PostgreSQL connection URL.'); }
  }
  return value;
}
