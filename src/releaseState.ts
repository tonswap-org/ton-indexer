/** Keep operational snapshots from every release; never silently load a
 * previous release into a process with different deployment bindings. */
export function releaseSnapshotPath(path: string | undefined, manifestHash: string): string | undefined {
  requireManifestHash(manifestHash);
  return path ? `${path}.${manifestHash}.json` : undefined;
}

/** PostgreSQL identifiers are limited to 63 bytes. Record the complete digest
 * inside each namespace too, so even a prefix collision fails closed. */
const requireManifestHash = (hash: string) => {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw Error('Release state requires a canonical manifest hash');
};
export const releaseDatabaseSchema = (manifestHash: string) => {
  requireManifestHash(manifestHash);
  return `tonswap_${manifestHash.slice(0, 55)}`;
};
