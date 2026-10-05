import { PostgresLedgerStore } from '../ledger/store';
import { readDatabaseUrl } from '../config/database';
import { loadConfig } from '../config';
import { loadRuntimeManifest } from '../config/manifestSource';
import { createReleaseLedgerPool } from '../ledger/releasePool';

async function main() {
  const connectionString = readDatabaseUrl();
  if (!connectionString) throw new Error('A database URL secret is required');
  const config = loadConfig();
  if (!config.releaseManifestSource) throw Error('INDEXER_RELEASE_MANIFEST is required');
  const manifest = await loadRuntimeManifest(config.releaseManifestSource, config.network);
  const pool = await createReleaseLedgerPool(connectionString, manifest.runtime.manifestHash);
  try { await new PostgresLedgerStore(pool).initialize(); }
  finally { await pool.end(); }
}
main().catch(()=>{ console.error('Ledger schema bootstrap failed. Check database configuration and access.'); process.exitCode=1; });
