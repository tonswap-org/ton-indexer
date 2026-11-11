import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertCurrentCaptureTargets, readCurrentCaptureManifest } from '../current-capture-build';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = join(__dirname, '../fixtures/current-owed');
const sourceHash = 'f735914748f3b3bbf385ab75fed874d67aa866931c1bb3e92156b7a495068c6b';
const originalsHash = '3a1e29485b3a00d71d4a4bd4bdea05870e8a36038c878a032928470a1def27f4';

/** The full immutable producer source, original worker, compiler inputs,
 * artifacts, receipt, log and all sixteen captures remain in the two archives.
 * A temporary physical extraction is solely a verification cache; it never
 * executes the retained worker or establishes public consensus/deployment. */
export function currentOwedFixture() {
  const sourceBytes = readFileSync(join(root, 'source-closure.json.gz'));
  assert.equal(sha(sourceBytes), sourceHash, 'Reviewed owed producer source archive changed');
  const archive = JSON.parse(gunzipSync(sourceBytes, { maxOutputLength: 128 * 1024 * 1024 }).toString());
  assert.equal(archive.schema, 'tonswap-current-owed-source-archive-v1');
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(archive.files)) {
    assert(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) && path.split('/').every(p => p !== '.' && p !== '..'));
    assert.equal(typeof value, 'string'); files.set(path, Buffer.from(value as string, 'base64'));
  }
  const bytes = (path: string) => { const value = files.get(path); assert(value, `Missing retained ${path}`); return value; };
  const receipt = JSON.parse(bytes('completion.json').toString()), lock = JSON.parse(bytes('source-lock.json').toString());
  assert.equal(receipt.schema, 'current-owed-native-run-v1'); assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.changedSources, []); assert.equal(sha(bytes('source-lock.json')), receipt.sourceLockSha256);
  assert.equal(sha(bytes('native.log')), receipt.logSha256);
  assert(bytes('native.log').toString().includes('Tests  4 passed (4)'));
  assert.equal(lock.schema, 'current-owed-source-lock-v1');
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
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-owed-source-')));
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
  const pooled = JSON.parse(gunzipSync(originalBytes, { maxOutputLength: 128 * 1024 * 1024 }).toString());
  assert.equal(pooled.schema, 'tonswap-current-owed-originals-pooled-v1');
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
  assert.equal(pooled.cases.length, 16);
  for (const row of receipt.outputs.filter((r:any)=>r.path.startsWith("captures/deployment-"))) {const data=bytes(row.path.replace("captures/","deployment-records/"));assert.equal(data.length,row.bytes);assert.equal(sha(data),row.sha256);}
  return { buildHash, targets, *cases() {
    const order=['layouts','direct-refused','archive-refused','direct-delivered','archive-delivered','protected-failed','protected-marked','protected-delivered'];
    const rank=(file:string)=>order.indexOf(file.replace(/-(default|x6)\.json$/,''));
    for (const row of [...pooled.cases].sort((a:any,b:any)=>(a.file.endsWith('-x6.json')?1:0)-(b.file.endsWith('-x6.json')?1:0)||rank(a.file)-rank(b.file))) {
      const capture = restore(row.original), original = Buffer.from(JSON.stringify(capture, null, 2) + '\n');
      const output = receipt.outputs.find((out: any) => out.path === `captures/${row.file}`); assert(output);
      assert.equal(sha(original), row.sha256); assert.equal(row.sha256, output.sha256); assert.equal(original.length, output.bytes);
      assert.equal(capture.manifest.source.build, buildHash);
      for (const [role, template] of [['T3Hub', capture.manifest.contracts.T3Hub.codeHash],
        ['SwapCoordinator', capture.manifest.contracts.SwapCoordinator.codeHash], ['DlmmPool', capture.manifest.templates.DlmmPool],
        ['T3Wallet', capture.manifest.templates.T3Wallet]]) assert.equal(template, targets[role].codeHash);
      yield { file: row.file as string, bytes: original, capture };
    }
  } };
}
