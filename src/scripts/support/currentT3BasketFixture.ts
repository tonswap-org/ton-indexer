import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertCurrentCaptureTargets, readCurrentCaptureManifest } from '../current-capture-build';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = join(__dirname, '../fixtures/current-t3-basket');
const sourceHash = '31f0f0c0f08033d0456e0fa023d5eeca0bb160bea6303b0218e2daf3449fd2f7';
const originalsHash = 'd9927f095c6cc8ce51b22d7ba4411f6ccc3b54f902cb043d6affcc70f8bb13b2';

/** The full immutable producer source, original worker, compiler inputs,
 * artifacts, receipt, log and all eight captures remain in the two archives.
 * A temporary physical extraction is solely a verification cache; it never
 * executes the retained worker or establishes public consensus/deployment. */
export function currentT3BasketFixture() {
  const sourceBytes = readFileSync(join(root, 'source-closure.json.gz'));
  assert.equal(sha(sourceBytes), sourceHash, 'Reviewed T3 basket producer source archive changed');
  const archive = JSON.parse(gunzipSync(sourceBytes, { maxOutputLength: 64 * 1024 * 1024 }).toString());
  assert.equal(archive.schema, 'tonswap-current-t3-basket-source-archive-v1');
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(archive.files)) {
    assert(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) && path.split('/').every(p => p !== '.' && p !== '..'));
    assert.equal(typeof value, 'string'); files.set(path, Buffer.from(value as string, 'base64'));
  }
  const bytes = (path: string) => { const value = files.get(path); assert(value, `Missing retained ${path}`); return value; };
  const receipt = JSON.parse(bytes('completion.json').toString()), lock = JSON.parse(bytes('source-lock.json').toString());
  assert.equal(receipt.schema, 'current-t3-basket-native-run-v1'); assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.changedSources, []); assert.equal(sha(bytes('source-lock.json')), receipt.sourceLockSha256);
  assert.equal(sha(bytes('native.log')), receipt.logSha256);
  assert(bytes('native.log').toString().includes('Tests  2 passed (2)'));
  assert.equal(lock.schema, 'current-t3-basket-source-lock-v1');
  const seen = new Set<string>();
  for (const row of lock.files) {
    assert(!seen.has(row.snapshot)); seen.add(row.snapshot);
    assert.equal(bytes(row.snapshot).length, row.bytes); assert.equal(sha(bytes(row.snapshot)), row.sha256);
  }
  for (const row of lock.virtualFiles) assert.equal(sha(bytes(row.snapshot)), row.sha256);
  for (const [input, value] of Object.entries(lock.compilerInputs) as Array<[string, any]>) {
    const path = value.virtual ? lock.virtualFiles.find((row: any) => row.input === input)?.snapshot : `source/contracts/${input}`;
    assert(path); assert.equal(sha(bytes(path)), value.sha256);
  }
  // Reuse the maintained physical source/registry/virtual-input verifier. The
  // old toolchain.json and unrelated harness files are preserved historical
  // producer inputs; only build/manifest.json's current targets are authority.
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-t3-basket-source-')));
  let buildHash: string, targets: ReturnType<typeof assertCurrentCaptureTargets>;
  try {
    for (const [path, value] of files) { const file = join(cache, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value, { flag: 'wx' }); }
    const nativeRoot = join(cache, 'source/contracts');
    const snapshot = readCurrentCaptureManifest({ nativeRoot, artifactRoot: join(nativeRoot, 'build'),
      manifestPath: join(nativeRoot, 'build/manifest.json'),
      expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
    assert.equal(Object.keys(snapshot.manifest.targets).length, 59);
    targets = assertCurrentCaptureTargets(snapshot, Object.keys(snapshot.manifest.targets)); buildHash = snapshot.manifest.buildHash;
  } finally { rmSync(cache, { recursive: true, force: true }); }
  const originalBytes = readFileSync(join(root, 'originals.json.gz'));
  assert.equal(sha(originalBytes), originalsHash, 'Reviewed native originals changed');
  const pooled = JSON.parse(gunzipSync(originalBytes, { maxOutputLength: 64 * 1024 * 1024 }).toString());
  assert.equal(pooled.schema, 'tonswap-current-t3-basket-originals-pooled-v1');
  const restore = (value: any): any => {
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, 'originalString')) {
        assert.equal(Object.keys(value).length, 1); assert(Number.isSafeInteger(value.originalString));
        const result = pooled.strings[value.originalString]; assert.equal(typeof result, 'string'); return result;
      }
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restore(entry)]));
    }
    return value;
  };
  assert.equal(pooled.cases.length, 8); assert.equal(receipt.outputs.length, 8);
  return { buildHash, targets, *cases() {
    for (const row of pooled.cases) {
      const capture = restore(row.original), original = Buffer.from(JSON.stringify(capture, null, 2) + '\n');
      const output = receipt.outputs.find((out: any) => out.path === `captures/${row.file}`); assert(output);
      assert.equal(sha(original), row.sha256); assert.equal(row.sha256, output.sha256); assert.equal(original.length, output.bytes);
      assert.equal(capture.manifest.source.build, buildHash);
      for (const [role, template] of [['T3Hub', capture.manifest.contracts.T3Hub.codeHash],
        ['T3RecoveryProof', capture.manifest.templates.T3RecoveryProof],
        ['T3Wallet', capture.manifest.templates.T3Wallet]]) assert.equal(template, targets[role].codeHash);
      yield { file: row.file as string, bytes: original, capture };
    }
  } };
}
