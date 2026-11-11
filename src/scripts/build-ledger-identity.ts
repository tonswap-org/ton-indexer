import { PGlite } from '@electric-sql/pglite';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprintLedgerBuild } from '../ledger/buildIdentity';
import { readLedgerCatalog, RELEASE_IDENTITY_DDL } from '../ledger/schemaReadiness';

async function main() {
  const root = resolve(__dirname, '../..'), sql = readFileSync(resolve(root, 'sql/ledger.sql'));
  const db = new PGlite();
  try {
    await db.exec(`${RELEASE_IDENTITY_DDL};\n${sql.toString('utf8')}`);
    const catalog = await readLedgerCatalog(db, 'public');
    const source = `'use strict';\nmodule.exports = ${JSON.stringify({ sqlSha256: createHash('sha256').update(sql).digest('hex'), catalog })};\n`;
    writeFileSync(resolve(root, 'dist/ledger/canonicalSchema.generated.js'), source, { flag: 'wx' });
    writeFileSync(resolve(root, 'dist/build-id.json'), `${JSON.stringify(fingerprintLedgerBuild(root))}\n`, { flag: 'wx' });
  } finally { await db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
