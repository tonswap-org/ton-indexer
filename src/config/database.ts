import { readFileSync } from 'node:fs';

/** Read credentials at runtime; public manifests should only contain the file path. */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inline = env.INDEXER_DATABASE_URL?.trim();
  const file = env.INDEXER_DATABASE_URL_FILE?.trim();
  if (inline && file) throw new Error('Configure only one INDEXER_DATABASE_URL source.');
  let value = inline;
  if (file) {
    try { value = readFileSync(file, 'utf8').trim(); }
    catch { throw new Error('The INDEXER_DATABASE_URL_FILE secret could not be read.'); }
    if (!value) throw new Error('The INDEXER_DATABASE_URL_FILE secret is empty.');
  }
  if (value) {
    try { const url = new URL(value); if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(); }
    catch { throw new Error('The indexer database secret must be a PostgreSQL connection URL.'); }
  }
  return value;
}
