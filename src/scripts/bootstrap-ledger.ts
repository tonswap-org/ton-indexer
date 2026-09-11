import { Pool } from 'pg';
import { PostgresLedgerStore } from '../ledger/store';
import { readDatabaseUrl } from '../config/database';

async function main() {
  const connectionString = readDatabaseUrl();
  if (!connectionString) throw new Error('A database URL secret is required');
  const pool = new Pool({connectionString});
  try { await new PostgresLedgerStore(pool).initialize(); }
  finally { await pool.end(); }
}
main().catch(()=>{ console.error('Ledger schema bootstrap failed. Check database configuration and access.'); process.exitCode=1; });
