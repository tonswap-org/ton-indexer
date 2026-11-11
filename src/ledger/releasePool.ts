import type { RuntimeMetrics } from '../runtimeMetrics';
import type { LedgerSqlPool } from './store';
import { Pool } from 'pg';
import { releaseDatabaseSchema } from '../releaseState';
import { RELEASE_IDENTITY_DDL } from './schemaReadiness';

export type ReleasePoolOptions = { size?: number; metrics?: RuntimeMetrics; role?: 'worker' | 'read'; statementTimeoutMs?: number };
export function releasePoolConfig(connectionString: string, manifestHash: string, options: ReleasePoolOptions = {}) {
  const max = options.size ?? 10;
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) throw new Error('Invalid release pool size');
  const schema = releaseDatabaseSchema(manifestHash);
  // pg merges URL parameters over object options. Put the enforced namespace
  // into the URL itself so an old ?options=search_path cannot override it.
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  if (options.statementTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.statementTimeoutMs) || options.statementTimeoutMs < 1 || options.statementTimeoutMs > 30_000)
      throw Error('Invalid release statement timeout');
    url.searchParams.set('statement_timeout', String(options.statementTimeoutMs));
  }
  return { connectionString: url.toString(), max, connectionTimeoutMillis: 10_000 };
}

/** No public-schema fallback: an old publication or retry job belongs to its
 * original release, even when the new release uses the same owner/network. */
export async function createReleaseLedgerPool(connectionString: string, manifestHash: string, options: ReleasePoolOptions = {}): Promise<LedgerSqlPool> {
  const schema = releaseDatabaseSchema(manifestHash);
  const pool = new Pool(releasePoolConfig(connectionString, manifestHash, options));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      const namespace = await client.query("SELECT current_schema() AS schema, current_setting('search_path') AS path");
      if (namespace.rows[0]?.schema !== schema || namespace.rows[0]?.path !== schema)
        throw Error('Release database search path does not match the manifest namespace');
      await client.query(RELEASE_IDENTITY_DDL);
      await client.query('INSERT INTO release_identity (manifest_hash) VALUES ($1) ON CONFLICT (singleton) DO NOTHING', [manifestHash]);
      const identity = await client.query('SELECT manifest_hash FROM release_identity');
      if (identity.rows.length !== 1 || identity.rows[0].manifest_hash !== manifestHash)
        throw Error('Release database namespace belongs to a different manifest');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const connect = async () => {
      const start = performance.now();
      try { return await pool.connect(); }
      finally { options.metrics?.observe('ledger_pool_wait_ms', performance.now() - start, { role: options.role ?? 'worker' }); }
    };
    return { connect, end: () => pool.end(), query: async (sql, params) => {
      const client = await connect();
      try { return await client.query(sql, params); } finally { client.release(); }
    } };
  } catch (error) { await pool.end(); throw error; }
}
