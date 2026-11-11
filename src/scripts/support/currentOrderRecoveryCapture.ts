import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readCurrentCaptureManifest, assertCurrentCaptureTargets, currentCaptureSha256 as sha } from '../current-capture-build';

/** The retained source archive is data only. Its original worker is never executed.
 * Materialization is limited to a fresh disposable directory for the maintained
 * source/import/artifact verifier; producer originals stay in the tracked corpus. */
export function currentOrderRecoveryCaptures(): any[] {
  const root = join(__dirname, '../fixtures/current-order-recovery-native');
  const read = (file: string) => readFileSync(join(root, file));
  const indexBytes = read('index.json');
  assert.equal(sha(indexBytes), 'e107519cf4d367b82037b0526a71432d67a5cc37d5a70cfade95a485533f4174');
  const index = JSON.parse(indexBytes.toString());
  assert.equal(index.schema, 'tonswap-current-order-recovery-fixture-v1');
  const inventoryBytes = read('inventory.json'); assert.equal(sha(inventoryBytes), index.inventorySha256);
  const inventory = JSON.parse(inventoryBytes.toString());
  assert.equal(inventory.schema, 'tonswap-order-recovery-portable-v1');
  const archive = read(index.sourceArchive.file); assert.equal(sha(archive), index.sourceArchive.sha256);
  const source = JSON.parse(gunzipSync(archive).toString());
  assert.equal(source.schema, 'tonswap-original-source-bytes-v1');
  assert.equal(Object.keys(source.files).length, index.sourceArchive.files);
  const bytes = new Map<string, Buffer>();
  for (const [file, encoded] of Object.entries(source.files)) {
    assert(/^(?:source|virtual)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(file));
    assert(file.split('/').every(p => p !== '.' && p !== '..'));
    assert.equal(typeof encoded, 'string');
    const value = Buffer.from(encoded as string, 'base64'); assert.equal(value.toString('base64'), encoded);
    assert.equal(sha(value), inventory.files[file], `Original source changed: ${file}`); bytes.set(file, value);
  }
  for (const [file, hash] of Object.entries(inventory.files)) {
    if (file.startsWith('source/') || file.startsWith('virtual/')) assert.equal(sha(bytes.get(file)!), hash);
    else assert.equal(sha(read(file)), hash, `Original producer evidence changed: ${file}`);
  }
  const lockBytes = read('source-lock.json'), receiptBytes = read('completion.json'), log = read('native.log');
  assert.equal(sha(lockBytes), inventory.sourceLockSha256);
  assert.equal(sha(receiptBytes), inventory.completionSha256);
  const lock = JSON.parse(lockBytes.toString()), receipt = JSON.parse(receiptBytes.toString());
  assert.equal(lock.schema, 'order-ledger-source-lock-v1'); assert.equal(receipt.schema, 'order-ledger-native-run-v1');
  assert.equal(lock.files.length, 386); assert.equal(Object.keys(lock.compilerInputs).length, 165);
  for (const entry of lock.files) {
    const original = bytes.get(entry.snapshot); assert(original);
    assert.equal(original.length, entry.bytes); assert.equal(sha(original), entry.sha256);
  }
  for (const entry of lock.virtualFiles) {
    assert.equal(sha(bytes.get(entry.snapshot)!), entry.sha256);
    assert.equal(lock.compilerInputs[entry.input].sha256, entry.sha256); assert.equal(lock.compilerInputs[entry.input].virtual, true);
  }
  for (const [file, entry] of Object.entries(lock.compilerInputs) as [string, any][]) {
    const original = bytes.get(entry.virtual ? `virtual/${file}` : `source/contracts/${file}`); assert(original);
    assert.equal(sha(original), entry.sha256, `Compiler input differs: ${file}`);
  }
  assert.equal(receipt.exitCode, 0); assert.deepEqual(receipt.changedSources, []);
  assert.equal(receipt.sourceLockSha256, sha(lockBytes)); assert.equal(receipt.logSha256, sha(log));
  assert.match(log.toString(), /^ Test Files\s+1 passed \(1\)$/m);
  assert.match(log.toString(), /^\s+Tests\s+2 passed \(2\)$/m);
  assert.doesNotMatch(log.toString(), /\b(?:failed|skipped)\b/i);
  assert.equal(receipt.outputs.length, 12); assert.equal(Object.keys(inventory.captures).length, 12);

  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-order-original-source-')));
  let targets: Record<string, { codeHash: string }>;
  try {
    for (const [file, original] of bytes) {
      const path = join(temporary, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, original, { flag: 'wx' });
    }
    const options = inventory.currentCaptureTargets;
    const snapshot = readCurrentCaptureManifest({
      nativeRoot: join(temporary, options.nativeRoot), artifactRoot: join(temporary, options.artifactRoot),
      manifestPath: join(temporary, options.manifestPath), expectedManifestSha256: options.expectedManifestSha256,
    });
    assert.equal(Object.keys(snapshot.manifest.targets).length, 59);
    assertCurrentCaptureTargets(snapshot, Object.keys(snapshot.manifest.targets)); targets = snapshot.manifest.targets;
  } finally { rmSync(temporary, { recursive: true }); }

  const pool = JSON.parse(gunzipSync(read('originals.json.gz')).toString());
  assert.equal(pool.schema, 'tonswap-current-order-recovery-originals-pooled-v1');
  assert.equal(pool.strings.length, 1710); assert.equal(pool.cases.length, 12);
  const expand = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    if (Object.keys(value).length === 1 && Object.hasOwn(value, 'originalString')) {
      assert(Number.isInteger(value.originalString) && value.originalString >= 0 && value.originalString < pool.strings.length);
      assert.equal(typeof pool.strings[value.originalString], 'string'); return pool.strings[value.originalString];
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  };
  const cases = expand(pool.cases), names = new Set<string>();
  for (const entry of cases) {
    const { file, ...capture } = entry; assert(!names.has(file)); names.add(file);
    assert.equal(capture.schema, 'tonswap-current-order-native-ledger-v1');
    const row = inventory.captures[file]; assert(row);
    const original = Buffer.from(JSON.stringify(capture, null, 2) + '\n');
    assert.equal(original.length, row.bytes); assert.equal(sha(original), row.sha256);
    const output = receipt.outputs.find((r: any) => r.path === row.originalRelativePath); assert(output);
    assert.equal(output.bytes, original.length); assert.equal(output.sha256, sha(original));
    const release = capture.binding.identity.release;
    for (const role of ['T3Hub', 'DlmmPoolFactory', 'SpotOrderFactory']) assert.equal(release.contracts[role].codeHash, targets[role].codeHash);
    for (const role of ['T3Wallet', 'T3RecoveryProof', 'SpotOrder', 'DlmmPool', 'JettonV21Minter', 'JettonV21Wallet']) {
      assert.equal(release.templates[role], targets[role].codeHash);
    }
  }
  return cases;
}
