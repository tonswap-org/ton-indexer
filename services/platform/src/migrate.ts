import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { postgres, type Database } from './db.js';
import { readDatabaseUrl } from './secrets.js';
export async function migrate(db: Database): Promise<void> {
  const schema = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  await db.transaction(async sql => {
    // PostgreSQL serializes concurrent schema changes; deployment should normally run this once before rollout.
    await sql.query(schema);
    await sql.query("INSERT INTO platform_migrations(id) VALUES('001_init') ON CONFLICT DO NOTHING");
  });
}
export async function migrateFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = readDatabaseUrl(env);
  const db = postgres(databaseUrl);
  try { await migrate(db); } finally { await db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await migrateFromEnvironment();
}
