import pg from 'pg';
export interface QueryResult<T> { rows: T[]; rowCount?: number | null }
export interface Sql { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>> }
export interface Database extends Sql { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> }
export function postgres(databaseUrl: string): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, application_name: 'tonswap-platform' });
  return {
    async query<T>(text: string, values?: unknown[]) {
      const result = await pool.query(text, values);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
