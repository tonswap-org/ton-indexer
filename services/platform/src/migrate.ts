import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { postgres, type Database } from './db.js';
export async function migrate(db: Database): Promise<void> {
  const schema = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  await db.transaction(async sql => {
    // PostgreSQL serializes concurrent schema changes; deployment should normally run this once before rollout.
    await sql.query(schema);
    await sql.query("INSERT INTO platform_migrations(id) VALUES('001_init') ON CONFLICT DO NOTHING");
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = postgres(process.env.DATABASE_URL ?? '');
  try { await migrate(db); } finally { await db.close(); }
}
