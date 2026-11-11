import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readCurrentCaptureManifest, assertCurrentCaptureTargets, currentCaptureSha256 as sha } from '../current-capture-build';

/** Preserve original financial bytes and decode one native world at a time. */
export function* currentLaunchpadCaptures(): Generator<{ file: string; capture: any; requests: any[]; refund: boolean }> {
  const root = join(__dirname, '../fixtures/current-launchpad-native');
  const build = join(__dirname, '../fixtures/current-capture-build');
  const bytes = readFileSync(join(root, 'index.json')), index = JSON.parse(bytes.toString());
  assert.equal(sha(bytes), '01d5a3a1b267e4d2e600d1750622250ca519e43242ca1eed04ceb2476f39cb27');
  assert.equal(index.schema, 'tonswap-current-launchpad-fixtures-v1');
  const snapshot = readCurrentCaptureManifest({ nativeRoot: join(build, 'source'), artifactRoot: join(build, 'artifacts'), manifestPath: join(build, 'manifest.json'), expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
  assertCurrentCaptureTargets(snapshot, index.buildTargets);
  assert.equal(index.manifestSha256, snapshot.sha256);
  const receiptBytes = readFileSync(join(root, 'producer-receipt.json')), receipt = JSON.parse(receiptBytes.toString());
  const inventory = readFileSync(join(root, 'source-inventory.json')), log = readFileSync(join(root, 'producer.log'));
  assert.equal(sha(receiptBytes), index.producerReceiptSha256);
  assert.equal(sha(inventory), index.sourceInventorySha256);
  assert.equal(sha(log), index.logSha256);
  assert.equal(sha(readFileSync(join(root, 'producer-runner.py'))), index.producerRunnerSha256);
  assert.equal(sha(readFileSync(join(root, index.producerSourceArchive.file))), index.producerSourceArchive.sha256);
  assert.equal(JSON.parse(inventory.toString()).files.length, 180);
  assert.equal(receipt.sourceLockSha256, sha(inventory)); assert.equal(receipt.logSha256, sha(log));
  assert.equal(receipt.exitCode, 0); assert.deepEqual(receipt.changedSources, []);
  assert.equal(index.files.length, 44); assert.equal(receipt.outputs.length, 44);
  assert.match(log.toString(), /^ Test Files\s+2 passed \(2\)$/m);
  assert.match(log.toString(), /^\s+Tests\s+8 passed \(8\)$/m);
  assert.doesNotMatch(log.toString(), /\b(?:failed|skipped)\b/i);
  const read = (entry: any) => {
    const zipped = readFileSync(join(root, entry.file)); assert.equal(sha(zipped), entry.sha256);
    const original = gunzipSync(zipped); assert.equal(original.length, entry.originalBytes); assert.equal(sha(original), entry.originalSha256);
    const output = receipt.outputs.find((row: any) => row.path === entry.originalFile);
    assert(output); assert.equal(output.sha256, sha(original)); assert.equal(output.bytes, original.length);
    return JSON.parse(original.toString());
  };
  // Saved requests are expectations only; the decoder receives original envelopes.
  const requests = index.files.filter((f: any) => f.kind === 'captures').map((entry: any) => ({ file: entry.originalFile, request: read(entry).request }));
  for (const entry of index.files.filter((f: any) => f.kind === 'complete' || f.kind === 'refund')) {
    const capture = read(entry), prefix = entry.originalFile.split('/')[1].replace('-complete.json', '-');
    assert.equal(capture.schema, 'tonswap-launchpad-native-capture-v1');
    assert.equal(capture.fixtureAuthority.codeHash, snapshot.manifest.targets.T3Hub.codeHash);
    for (const role of ['T3Hub', 'SaleFactory', 'DlmmPoolFactory']) assert.equal(capture.release.contracts[role].codeHash, snapshot.manifest.targets[role].codeHash);
    for (const role of ['T3Wallet', 'T3RecoveryProof', 'SaleFixed', 'SaleBonding', 'SaleAuction', 'LpVault', 'VestingVault', 'DlmmPool', 'JettonV21Minter', 'JettonV21Wallet']) assert.equal(capture.release.templates[role], snapshot.manifest.targets[role].codeHash);
    yield { file: entry.originalFile, capture, requests: requests.filter((r: any) => r.file.startsWith('captures/' + prefix)).map((r: any) => r.request), refund: entry.kind === 'refund' };
  }
}
