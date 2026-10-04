import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRegistryBundle, readCanonicalReleaseManifest } from '../config/releaseManifest';

// One qualified release replaces the entire registry. Never merge a new
// deployment with addresses left in tmp_debug or with a previous release.
const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
const manifestPath = args[0] ?? process.env.INDEXER_RELEASE_MANIFEST_PATH;
if (!manifestPath?.trim() || args.length > 1 || args.some(arg => arg.startsWith('-'))) {
  throw new Error('Usage: npm run sync-registry -- [--check] /absolute/path/to/release-manifest.json');
}
const registryPath = resolve(process.cwd(), 'registry', 'testnet.json');
// Check the same exact role/address parity required at service startup without
// replacing a retained registry or publishing addresses from another release.
const manifest = check
  ? (() => {
      const bundle = buildRegistryBundle(JSON.parse(readFileSync(registryPath, 'utf8')), 'testnet', resolve(manifestPath));
      return { ...bundle.metadata, contracts: bundle.contracts };
    })()
  : readCanonicalReleaseManifest(resolve(manifestPath), 'testnet');
if (!check) {
  const stagingPath = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(stagingPath, JSON.stringify(manifest.contracts, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  renameSync(stagingPath, registryPath);
}
console.log(JSON.stringify({
  mode: check ? 'check' : 'sync',
  releaseId: manifest.releaseId,
  registryHash: manifest.registryHash,
  releaseManifestHash: manifest.releaseManifestHash,
  contracts: Object.keys(manifest.contracts).length,
}));
