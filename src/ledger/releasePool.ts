import { Pool } from 'pg';
import { releaseDatabaseSchema } from '../releaseState';

export function releasePoolConfig(connectionString: string, manifestHash: string) {
  const schema = releaseDatabaseSchema(manifestHash);
  // pg merges URL parameters over object options. Put the enforced namespace
  // into the URL itself so an old ?options=search_path cannot override it.
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { connectionString: url.toString(), max: 10, connectionTimeoutMillis: 10_000 };
}

/** No public-schema fallback: an old publication or retry job belongs to its
 * original release, even when the new release uses the same owner/network. */
export async function createReleaseLedgerPool(connectionString: string, manifestHash: string): Promise<Pool> {
  const schema = releaseDatabaseSchema(manifestHash);
  const pool = new Pool(releasePoolConfig(connectionString, manifestHash));
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      const namespace = await client.query("SELECT current_schema() AS schema, current_setting('search_path') AS path");
      if (namespace.rows[0]?.schema !== schema || namespace.rows[0]?.path !== schema)
        throw Error('Release database search path does not match the manifest namespace');
      await client.query('CREATE TABLE IF NOT EXISTS release_identity (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), manifest_hash text NOT NULL)');
      await client.query('INSERT INTO release_identity (manifest_hash) VALUES ($1) ON CONFLICT (singleton) DO NOTHING', [manifestHash]);
      const identity = await client.query('SELECT manifest_hash FROM release_identity');
      if (identity.rows.length !== 1 || identity.rows[0].manifest_hash !== manifestHash)
        throw Error('Release database namespace belongs to a different manifest');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return pool;
  } catch (error) { await pool.end(); throw error; }
}
