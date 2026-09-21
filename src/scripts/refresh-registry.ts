import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCanonicalReleaseManifest } from '../config/releaseManifest';

// One qualified release replaces the entire registry. Never merge a new
// deployment with addresses left in tmp_debug or with a previous release.
const manifestPath = process.argv[2] ?? process.env.INDEXER_RELEASE_MANIFEST_PATH;
if (!manifestPath || process.argv.length > 3) {
  throw new Error('Usage: npm run sync-registry -- /absolute/path/to/release-manifest.json');
}
const manifest = readCanonicalReleaseManifest(resolve(manifestPath), 'testnet');
const registryPath = resolve(process.cwd(), 'registry', 'testnet.json');
const stagingPath = `${registryPath}.${process.pid}.tmp`;
writeFileSync(stagingPath, JSON.stringify(manifest.contracts, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
renameSync(stagingPath, registryPath);
console.log(JSON.stringify({
  releaseId: manifest.releaseId,
  registryHash: manifest.registryHash,
  releaseManifestHash: manifest.releaseManifestHash,
  contracts: Object.keys(manifest.contracts).length,
}));
