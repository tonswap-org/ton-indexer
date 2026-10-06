import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LedgerCatalog } from './schemaReadiness';

export type LedgerBuildIdentity = { schema: 'tonswap-indexer-build-v1'; sha256: string; sqlSha256: string; files: Record<string, string> };
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const freezeTree = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
};

/** Exact executed JS tree plus canonical SQL; the generated ID never hashes itself. */
export function fingerprintLedgerBuild(packageRoot: string): LedgerBuildIdentity {
  const root = realpathSync(packageRoot);
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Compiled build directory must be physical');
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), entry = lstatSync(file);
      if (entry.isSymbolicLink()) throw Error('Compiled build cannot contain symbolic links');
      if (entry.isDirectory()) visit(file);
      else if (name.endsWith('.js')) {
        if (!entry.isFile()) throw Error('Compiled JavaScript must be a regular file');
        files[relative(root, file).split('\\').join('/')] = sha(readFileSync(file));
      }
    }
  };
  visit(join(root, 'dist'));
  if (!files['dist/index.js'] || !files['dist/ledger/buildIdentity.js'] || !files['dist/ledger/canonicalSchema.generated.js'])
    throw Error('Compiled ledger build is incomplete');
  const sql = join(root, 'sql/ledger.sql'), stat = lstatSync(sql);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Canonical ledger SQL must be a physical file');
  const sqlSha256 = sha(readFileSync(sql)); files['sql/ledger.sql'] = sqlSha256;
  const sorted = Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]]));
  return { schema: 'tonswap-indexer-build-v1', sha256: sha(JSON.stringify(sorted)), sqlSha256, files: sorted };
}

export type AuthenticatedLedgerBuild = {
  identity: Readonly<LedgerBuildIdentity>;
  catalog: LedgerCatalog;
  assertCurrent(): void;
};

export function authenticateLedgerBuild(packageRoot: string): AuthenticatedLedgerBuild {
  const root = realpathSync(packageRoot), identity = fingerprintLedgerBuild(root);
  const idPath = join(root, 'dist/build-id.json'), stat = lstatSync(idPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Build identity must be a physical file');
  const advertised = JSON.parse(readFileSync(idPath, 'utf8'));
  if (JSON.stringify(advertised) !== JSON.stringify(identity)) throw Error('Compiled JS/SQL does not match its generated build identity');
  // Parse the authenticated generated data directly: require.cache must not retain
  // a catalog from a different build when qualification checks several candidates.
  const source = readFileSync(join(root, 'dist/ledger/canonicalSchema.generated.js'), 'utf8');
  const prefix = "'use strict';\nmodule.exports = ", suffix = ';\n';
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) throw Error('Canonical catalog encoding is malformed');
  const canonical = JSON.parse(source.slice(prefix.length, -suffix.length)) as { sqlSha256: string; catalog: LedgerCatalog };
  if (canonical.sqlSha256 !== identity.sqlSha256) throw Error('Canonical catalog is detached from its SQL');
  const frozen = freezeTree(identity);
  const catalog = freezeTree(canonical.catalog);
  return { identity: frozen, catalog, assertCurrent() {
    if (JSON.stringify(fingerprintLedgerBuild(root)) !== JSON.stringify(frozen) ||
      readFileSync(idPath, 'utf8').trim() !== JSON.stringify(frozen)) throw Error('Running compiled build changed after authentication');
  } };
}

/** Pin once when the compiled worker imports this module; later mutable IDs cannot replace it. */
export const runningLedgerBuild = (() => {
  try {
    if (!__filename.endsWith('.js')) return undefined;
    return authenticateLedgerBuild(resolve(__dirname, '../..'));
  } catch { return undefined; }
})();
