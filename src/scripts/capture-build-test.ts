import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginCell, Cell } from '@ton/core';
import {
  assertCaptureBuildBinding, assertCaptureCode, assertCaptureTargetClosure, captureSha256,
  CAPTURE_PRODUCERS, CAPTURE_SANDBOX_TREASURY_HASH, readCaptureBuildManifest,
  type CaptureBuildBinding, type CaptureBuildManifest, type CaptureBuildManifestSnapshot,
} from './capture-build';

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-capture-build-test-')));
const nativeRoot = join(folder, 'native');
const artifactRoot = join(folder, 'artifacts');
const engineCode = beginCell().storeUint(123, 16).endCell();
const otherCode = beginCell().storeUint(456, 16).endCell();
const engineSource = 'tolk 1.4.2\nimport "./helper.tolk";\nimport "../generated/opcodes/perps/perps_engine_opcodes.tolk";\n';
const helperSource = 'tolk 1.4.2\n// import "./comment-only.tolk";\nconst test: int = 1;\n';
const opcodeSource = 'tolk 1.4.2\n\n// Auto-generated. Do not edit manually.\nconst OP_TEST: int = 0xFF;\n\n';
const registryBytes = Buffer.from(`export const DEPLOY_TARGETS = { PerpsEngine: 'contracts/perps/engine.tolk', Other: 'contracts/other.tolk' } as const;\nexport const TEST_TARGETS = {} as const;\n`);
const ordered = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const artifact = (code: Cell) => code.toBoc({ idx: false, crc32: false });
const file = (path: string, contents: string) => {
  const absolute = join(nativeRoot, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
};
try {
  mkdirSync(artifactRoot);
  writeFileSync(join(artifactRoot, 'PerpsEngine.boc'), artifact(engineCode));
  writeFileSync(join(artifactRoot, 'Other.boc'), artifact(otherCode));
  file('contracts/perps/engine.tolk', engineSource);
  file('contracts/perps/helper.tolk', helperSource);
  file('contracts/other.tolk', 'tolk 1.4.2\nconst other: int = 2;\n');
  file('config/opcodes.json', JSON.stringify({ 'contracts/perps/perps_engine.tolk': { OP_TEST: '0xff' } }));
  const inputs = ordered({
    'contracts/perps/engine.tolk': captureSha256(engineSource),
    'contracts/perps/helper.tolk': captureSha256(helperSource),
    'contracts/generated/opcodes/perps/perps_engine_opcodes.tolk': captureSha256(opcodeSource),
  });
  const manifest: CaptureBuildManifest = {
    schema: 'tonswap-build-v1', tolkVersion: '1.4.2', buildHash: '', targets: {
      PerpsEngine: { source: 'contracts/perps/engine.tolk', codeHash: engineCode.hash().toString('hex'),
        bocBytes: artifact(engineCode).length, cells: 1, bits: 16, inputs },
      Other: { source: 'contracts/other.tolk', codeHash: otherCode.hash().toString('hex'),
        bocBytes: artifact(otherCode).length, cells: 1, bits: 16,
        inputs: { 'contracts/other.tolk': captureSha256(readFileSync(join(nativeRoot, 'contracts/other.tolk'))) } },
    },
  };
  manifest.buildHash = captureSha256(Object.entries(manifest.targets).map(([role, target]) => `${role}:${target.codeHash}`).sort().join('\n'));
  const snapshot = (m = manifest): CaptureBuildManifestSnapshot => {
    const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n');
    return { manifest: m, bytes, sha256: captureSha256(bytes), registryBytes, registrySha256: captureSha256(registryBytes), artifactRoot };
  };
  const retained = snapshot();
  const binding: CaptureBuildBinding = {
    schema: 'tonswap-capture-build-v1', producer: 'funding', suite: CAPTURE_PRODUCERS.funding,
    tolkVersion: '1.4.2', sandboxVersion: '0.42.0', manifestSha256: retained.sha256, buildHash: manifest.buildHash,
    targets: { PerpsEngine: { source: manifest.targets.PerpsEngine.source, codeHash: manifest.targets.PerpsEngine.codeHash,
      artifact: 'build/PerpsEngine.boc', artifactSha256: captureSha256(artifact(engineCode)), inputs,
      inputsSha256: captureSha256(JSON.stringify(inputs)) } },
    captures: { 'funding.json': { executed: [], embedded: ['PerpsEngine'], unbuiltCode: [] } },
  };
  const verify = (b: unknown = clone(binding), m = retained) => assertCaptureBuildBinding(b, 'funding', nativeRoot, { manifest: m });
  const valid = verify();
  assertCaptureCode('PerpsEngine', engineCode.toBoc().toString('base64'), valid);
  assertCaptureCode('PerpsEngine', artifact(engineCode), valid);
  assertCaptureCode('PerpsEngine', engineCode, valid);
  assert.equal(assertCaptureTargetClosure('PerpsEngine', nativeRoot, retained).codeHash, engineCode.hash().toString('hex'));
  const manifestPath = join(folder, 'manifest.json');
  writeFileSync(manifestPath, retained.bytes);
  writeFileSync(join(folder, 'targets.txt'), registryBytes);
  assert.deepEqual(readCaptureBuildManifest(manifestPath), retained);

  const bad = (change: (value: any) => void, expected: RegExp) => {
    const value = clone(binding); change(value); assert.throws(() => verify(value), expected);
  };
  bad(value => { value.schema = 'tonswap-perps-fixture-producer-v1'; }, /producer\/toolchain/);
  bad(value => { value.sandboxVersion = '0.43.0'; }, /producer\/toolchain/);
  bad(value => { value.suite = CAPTURE_PRODUCERS.risk; }, /producer\/toolchain/);
  bad(value => { value.manifestSha256 = '0'.repeat(64); }, /manifest bytes/);
  bad(value => { value.buildHash = '0'.repeat(64); }, /buildHash mismatch/);
  bad(value => { value.targets.PerpsEngine.codeHash = [value.targets.PerpsEngine.codeHash]; }, /artifact\/source\/code binding/);
  bad(value => { value.targets.PerpsEngine.artifact = '../PerpsEngine.boc'; }, /artifact\/source\/code binding/);
  bad(value => { value.targets.PerpsEngine.inputsSha256 = '0'.repeat(64); }, /inputsSha256/);
  bad(value => { value.captures['funding.json'].embedded.push('Other'); value.captures['funding.json'].embedded.sort(); }, /target coverage/);
  bad(value => { value.targets.Other = value.targets.PerpsEngine; }, /target coverage/);
  bad(value => { value.captures['../escape.json'] = value.captures['funding.json']; }, /capture path/);
  bad(value => { value.captures['funding.json'].embedded.push('PerpsEngine'); }, /sorted and unique/);
  bad(value => { value.captures['funding.json'].unbuiltCode = ['1'.repeat(64)]; }, /unknown unbuilt code/);
  bad(value => { value.captures['funding.json'].unbuiltCode = ['90aec8965afabb16ebc3cb9b408ebae71b618d78788bc80d09843593cac98da4']; }, /unknown unbuilt code/);
  bad(value => { value.targets.PerpsEngine.inputs['../escape.tolk'] = '1'.repeat(64);
    value.targets.PerpsEngine.inputs = ordered(value.targets.PerpsEngine.inputs);
    value.targets.PerpsEngine.inputsSha256 = captureSha256(JSON.stringify(value.targets.PerpsEngine.inputs)); }, /invalid input/);
  assert.throws(() => assertCaptureBuildBinding(clone(binding), 'funding', nativeRoot,
    { manifest: retained, captureFiles: ['absent.json'] }), /Capture selection/);
  assert.throws(() => assertCaptureCode('PerpsEngine', engineCode, clone(binding)), /must be authenticated/);
  assert.throws(() => assertCaptureCode('Other', otherCode, valid), /absent from/);
  assert.throws(() => assertCaptureCode('PerpsEngine', otherCode, valid), /code hash/);
  const wrongArtifact = verify(); wrongArtifact.targets.PerpsEngine.artifactSha256 = '0'.repeat(64);
  assert.throws(() => assertCaptureCode('PerpsEngine', engineCode, wrongArtifact), /artifact digest/);
  writeFileSync(join(artifactRoot, 'PerpsEngine.boc'), artifact(otherCode));
  assert.throws(() => assertCaptureCode('PerpsEngine', engineCode, valid), /artifact digest/);
  writeFileSync(join(artifactRoot, 'PerpsEngine.boc'), artifact(engineCode));
  assertCaptureCode('PerpsEngine', engineCode, valid);

  // A forger rehashes both the retained manifest and binding after deleting or
  // changing an input. The independently read import closure still rejects it.
  for (const changedHash of [undefined, '1'.repeat(64)]) {
    const m = clone(manifest), b = clone(binding);
    if (changedHash) m.targets.PerpsEngine.inputs['contracts/perps/helper.tolk'] = changedHash;
    else delete m.targets.PerpsEngine.inputs['contracts/perps/helper.tolk'];
    m.targets.PerpsEngine.inputs = ordered(m.targets.PerpsEngine.inputs);
    const newSnapshot = snapshot(m);
    b.manifestSha256 = newSnapshot.sha256;
    b.targets.PerpsEngine.inputs = m.targets.PerpsEngine.inputs;
    b.targets.PerpsEngine.inputsSha256 = captureSha256(JSON.stringify(b.targets.PerpsEngine.inputs));
    assert.throws(() => verify(b, newSnapshot), /current source closure/);
  }
  const wrongBuild = clone(manifest); wrongBuild.buildHash = '0'.repeat(64);
  const wrongBuildSnapshot = snapshot(wrongBuild), wrongBuildBinding = clone(binding);
  wrongBuildBinding.manifestSha256 = wrongBuildSnapshot.sha256; wrongBuildBinding.buildHash = wrongBuild.buildHash;
  assert.throws(() => verify(wrongBuildBinding, wrongBuildSnapshot), /manifest buildHash/);
  const missingTarget = clone(manifest); delete missingTarget.targets.PerpsEngine;
  missingTarget.buildHash = captureSha256(`Other:${otherCode.hash().toString('hex')}`);
  const missingSnapshot = snapshot(missingTarget), missingBinding = clone(binding);
  missingBinding.manifestSha256 = missingSnapshot.sha256; missingBinding.buildHash = missingTarget.buildHash;
  assert.throws(() => verify(missingBinding, missingSnapshot), /missing a deploy target/);

  file('contracts/other.tolk', 'unrelated source changed\n');
  verify(); // Other is in the retained build identity, but never ran/was embedded here.
  assert.throws(() => assertCaptureTargetClosure('Other', nativeRoot, retained), /current source closure/);
  file('contracts/perps/helper.tolk', helperSource + '\n');
  assert.throws(() => verify(), /current source closure/);
  file('contracts/perps/helper.tolk', helperSource);
  file('config/opcodes.json', JSON.stringify({ 'contracts/perps/perps_engine.tolk': { OP_TEST: '0xfe' } }));
  assert.throws(() => verify(), /current source closure/);
  file('config/opcodes.json', JSON.stringify({ 'contracts/perps/perps_engine.tolk': { OP_TEST: '0xff' } }));
  const helper = join(nativeRoot, 'contracts/perps/helper.tolk'), savedHelper = join(folder, 'helper.saved');
  renameSync(helper, savedHelper);
  assert.throws(() => verify(), /ENOENT/);
  symlinkSync(savedHelper, helper);
  assert.throws(() => verify(), /physical/);
  unlinkSync(helper); renameSync(savedHelper, helper);
  const treasury = clone(binding); treasury.captures['funding.json'].unbuiltCode = [CAPTURE_SANDBOX_TREASURY_HASH];
  verify(treasury);
  assert.equal(beginCell().storeBit(false).endCell().hash().toString('hex'), '90aec8965afabb16ebc3cb9b408ebae71b618d78788bc80d09843593cac98da4');
  const factory = clone(binding); factory.producer = 'factory'; factory.suite = CAPTURE_PRODUCERS.factory;
  factory.captures = { 'case-17.json': { executed: [], embedded: ['PerpsEngine'],
    unbuiltCode: ['90aec8965afabb16ebc3cb9b408ebae71b618d78788bc80d09843593cac98da4'] } };
  assertCaptureBuildBinding(factory, 'factory', nativeRoot, { manifest: retained });
  factory.captures['case-16.json'] = factory.captures['case-17.json'];
  assert.throws(() => assertCaptureBuildBinding(factory, 'factory', nativeRoot, { manifest: retained }), /unknown unbuilt code/);
  process.stdout.write('Capture pure-build identities, current target closures, artifact encoding and malformed bindings passed\n');
} finally {
  rmSync(folder, { recursive: true, force: true });
}
