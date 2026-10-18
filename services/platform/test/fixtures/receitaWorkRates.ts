import { PGlite } from '@electric-sql/pglite';
import type { Config } from '../../src/config.js';
import type { Database, Sql } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';
/** Owned in-memory SQL fixture. No provider workers, wallets or external requests. */
export const receitaWorkRatesTestConfig = (): Config => ({
  host: '127.0.0.1', port: 8787, mode: 'api', databaseUrl: 'postgres://unused',
  appOrigins: ['https://app.example.test'], platformUrl: 'https://app.example.test/platform', cookieSecure: true, cookieSameSite: 'lax',
  encryptionKey: Buffer.alloc(32, 42), networks: ['testnet'], sessionHours: 24,
  indexerUrls: { testnet: 'https://indexer.example.test/api/indexer/v1' }, tonRpcUrls: {}, coingeckoTier: 'demo',
  governanceContracts: {}, pollSeconds: 30, priceSeconds: 120, workerConcurrency: 4, retentionDays: 90, allowInsecureLocal: false,
  assetValuationPaths: [], trustLoopbackProxy: false,
});
export async function receitaWorkRatesTestDatabase(): Promise<Database> {
  const pg = new PGlite();
  const adapter = (client: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    async query<T>(sql: string, values?: unknown[]) {
      if (!values && sql.split(';').filter(value => value.trim()).length > 1) {
        const results = await client.exec(sql); return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      const result = await client.query<T>(sql, values); return { rows: result.rows, rowCount: result.affectedRows };
    },
  });
  const db: Database = { ...adapter(pg), transaction: fn => pg.transaction(tx => fn(adapter(tx))), close: () => pg.close() };
  await migrate(db); return db;
}
