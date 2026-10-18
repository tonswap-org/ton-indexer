// Retained 1.4.2 factory producer/source qualification. This strict historical
// verifier is separate from the current PoolReady/PoolListed ordinary gate.
import { createHash } from 'node:crypto';
import { assertPerpsProducerReceipt } from './perps-fixture-producer';
import assert from 'node:assert/strict';
import { Address, Cell, beginCell, loadTransaction, storeMessage, loadShardAccount, Transaction } from '@ton/core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { assertCaptureBuildBinding, assertCaptureCode, assertCaptureTargetClosure, assertRetainedCaptureBinding, readCaptureBuildManifest } from './capture-build';
type FactoryCapture = {
  name: string; factory: string; pool: string;
  accepted: { account: string; boc: string; hash: string; before: { originalShardAccount: string; codeBoc: string }; after: { originalShardAccount: string; codeBoc: string } };
  emitter: FactoryCapture['accepted']; attempt: FactoryCapture['accepted'];
};
// The capture's observed execution targets and the fixture's independent
// compiler inventory are separate facts. Authenticate every retained compiler
// role against its own reviewed pure-build closure without inventing execution.
const factoryNativeRoot = resolve(__dirname, '../../../tonswap_tolk');
const factoryCompilerRoles = [
  'DlmmPoolFactory', 'DlmmPool', 'DlmmRegistry', 'JettonWallet', 'DlmmSeedingExecutor',
  'GasVault', 'NativeReturnCollector', 'LpVault', 'JettonRoot',
] as const;
const factoryManifest = readCaptureBuildManifest();
const assertFactoryCompilerCodes = (compiler: unknown, nativeRoot = factoryNativeRoot) => {
  assert(compiler && typeof compiler === 'object' && !Array.isArray(compiler));
  assert.deepEqual(Object.keys(compiler).sort(), [...factoryCompilerRoles].sort(), 'Factory requires all nine independent compiler pins');
  for (const role of factoryCompilerRoles) {
    const target = assertCaptureTargetClosure(role, nativeRoot, factoryManifest);
    const code: { codeHash: string; boc: string } = (compiler as Record<string, { codeHash: string; boc: string }>)[role]!;
    assert(code && typeof code === 'object' && !Array.isArray(code));
    assert.deepEqual(Object.keys(code).sort(), ['boc', 'codeHash']);
    assert.equal(code.codeHash, target.codeHash, `${role}: current pure-build code pin`);
    assert.equal(typeof code.boc, 'string', `${role}: retained independent compiler BOC required`);
    assert.equal(Buffer.from(code.boc, 'base64').toString('base64'), code.boc, `${role}: canonical retained compiler BOC`);
    const cells = Cell.fromBoc(Buffer.from(code.boc, 'base64'));
    assert(cells.length === 1 && !cells[0]!.isExotic, `${role}: one ordinary compiler code Cell required`);
    assert.equal(cells[0]!.hash().toString('hex'), code.codeHash, `${role}: retained independent compiler BOC`);
  }
};
const assertFactoryBuild = (fixture: any, nativeRoot: string) => {
  assertRetainedCaptureBinding(fixture.buildBinding, 'factory');
  const binding = assertCaptureBuildBinding(fixture.buildBinding, 'factory', nativeRoot, { manifest: factoryManifest });
  assertFactoryCompilerCodes(fixture.compiler, nativeRoot);
  for (const role of Object.keys(binding.targets)) {
    assert(factoryCompilerRoles.includes(role as typeof factoryCompilerRoles[number]), 'Observed factory target must have an independent compiler pin');
    assertCaptureCode(role, fixture.compiler[role].boc, binding);
  }
  return binding;
};

const factoryEvidence = (nativeRoot = factoryNativeRoot) => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/pool-factory-current-transactions.json'), 'utf8'));
  assert.equal(fixture.schema, 'tonswap-pool-tracker-original-factory-v2');
  assert.equal(fixture.nativeSourceInventoryModel, 'pure-build-executed-target-closure-v1');
  assert.equal(fixture.nativeSuite, 'tests/dlmm/DlmmPoolFactory.spec.ts');
  assert.equal(fixture.tests, 29);
  const log = readFileSync(resolve(__dirname, 'fixtures/capture-build/factory/producer-log.txt'));
  assert.equal(createHash('sha256').update(log).digest('hex'), fixture.provenance.nativeLogSha256);
  assertPerpsProducerReceipt(fixture.provenance.producerReceipt, 'factory', nativeRoot,
    fixture.provenance.captureDirectory, log, fixture.buildBinding);
  assertFactoryBuild(fixture, nativeRoot);
  const original = (row: FactoryCapture['accepted'], codeHash: string) => {
    const cell = Cell.fromBase64(row.boc), parsed = loadTransaction(cell.beginParse());
    assert.equal(cell.hash().toString('hex'), row.hash);
    assert.equal(parsed.stateUpdate.oldHash.toString('hex'), Cell.fromBase64(row.before.originalShardAccount).refs[0]!.hash().toString('hex'));
    assert.equal(parsed.stateUpdate.newHash.toString('hex'), Cell.fromBase64(row.after.originalShardAccount).refs[0]!.hash().toString('hex'));
    for (const boundary of [row.before, row.after]) {
      const account = loadShardAccount(Cell.fromBase64(boundary.originalShardAccount).beginParse()).account;
      assert.equal(account?.storage.state.type, 'active');
      if (account?.storage.state.type !== 'active') throw new Error('Expected actual active contract boundary');
      assert.equal(account.storage.state.state.code?.hash().toString('hex'), codeHash);
    }
    assert.equal(Cell.fromBase64(row.before.codeBoc).hash().toString('hex'), codeHash);
    assert.equal(Cell.fromBase64(row.after.codeBoc).hash().toString('hex'), codeHash);
    return { cell, parsed, raw: decodeOriginalTransaction(cell, Address.parse(row.account)) };
  };
  const cases = (fixture.cases as FactoryCapture[]).map(capture => {
    const ack = original(capture.accepted, fixture.compiler.DlmmPoolFactory.codeHash);
    const emitter = original(capture.emitter, fixture.compiler.DlmmPool.codeHash);
    const attempt = original(capture.attempt, fixture.compiler.DlmmPoolFactory.codeHash);
    assert.equal(ack.raw.success, true);
    assert.equal(emitter.raw.success, true);
    assert.equal(ack.raw.inMessage!.source && Address.parse(ack.raw.inMessage!.source).toRawString(), capture.pool);
    const normalizedMessage = (message: NonNullable<Transaction['inMessage']>) => beginCell().store(storeMessage(message, { forceRef: true })).endCell();
    assert.ok([...emitter.parsed.outMessages.values()].some(message => normalizedMessage(message).equals(normalizedMessage(ack.parsed.inMessage!))), 'Actual Pool emitter and Factory receiver carry the same message fields');
    return { capture, ...ack, attempt: attempt.raw };
  });
  assert.deepEqual(cases.map(c => c.capture.name), ['direct', 'public', 'launch']);
  return { fixture, cases };
};

const testFactoryPureBuildTargetClosures = () => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/pool-factory-current-transactions.json'), 'utf8'));
  assertFactoryBuild(fixture, factoryNativeRoot);
  const sources = new Set<string>();
  for (const role of factoryCompilerRoles) {
    for (const filename of Object.keys(factoryManifest.manifest.targets[role]!.inputs)) sources.add(filename);
  }
  const cleanRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tonswap-factory-source-')));
  try {
    // Opcode modules are virtual compiler inputs derived from this reviewed
    // configuration, not retained generated files or native renderer modules.
    const opcodeConfig = 'config/opcodes.json';
    mkdirSync(join(cleanRoot, 'config'));
    copyFileSync(join(factoryNativeRoot, opcodeConfig), join(cleanRoot, opcodeConfig));
    for (const filename of sources) {
      if (filename.startsWith('contracts/generated/opcodes/')) continue;
      const target = join(cleanRoot, filename);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(factoryNativeRoot, filename), target);
    }
    assert.equal(existsSync(join(cleanRoot, 'wrappers')), false, 'Pure target verification needs no native TypeScript renderers');
    assert.equal(factoryEvidence(cleanRoot).cases.length, 3, 'Original accepted callbacks verify from the nine current source closures');
    mkdirSync(join(cleanRoot, 'wrappers'));
    const shadow = join(cleanRoot, 'wrappers/entrypointWriter.js');
    writeFileSync(shadow, 'globalThis.__factoryUnboundShadowExecuted = true; throw new Error("unbound renderer dependency");');
    assert.equal(factoryEvidence(cleanRoot).cases.length, 3);
    assert.equal((globalThis as Record<string, unknown>).__factoryUnboundShadowExecuted, undefined, 'Closure validation never executes ambient native modules');
    rmSync(shadow);
    let rejected = 0;
    const rejects = (fn: () => void) => { assert.throws(fn); rejected++; };
    for (const role of factoryCompilerRoles) {
      const omitted = { ...fixture.compiler }; delete omitted[role];
      rejects(() => assertFactoryCompilerCodes(omitted, cleanRoot));
      const target = factoryManifest.manifest.targets[role]!;
      const path = join(cleanRoot, target.source), original = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([original, Buffer.from('\n// tampered input\n')]));
        rejects(() => assertFactoryCompilerCodes(fixture.compiler, cleanRoot));
      } finally { writeFileSync(path, original); }
      try {
        rmSync(path);
        rejects(() => assertFactoryCompilerCodes(fixture.compiler, cleanRoot));
      } finally { writeFileSync(path, original); }
    }
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, UnknownCode: fixture.compiler.DlmmPoolFactory }, cleanRoot));
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: fixture.compiler.DlmmPool }, cleanRoot));
    const arbitraryCode = beginCell().storeUint(0, 1).endCell();
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: {
      codeHash: arbitraryCode.hash().toString('hex'), boc: arbitraryCode.toBoc().toString('base64'),
    } }, cleanRoot));
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: {
      ...fixture.compiler.DlmmPoolFactory, boc: arbitraryCode.toBoc().toString('base64'),
    } }, cleanRoot));
    const withoutBoc = { ...fixture.compiler.DlmmPoolFactory }; delete withoutBoc.boc;
    rejects(() => assertFactoryCompilerCodes({ ...fixture.compiler, DlmmPoolFactory: withoutBoc }, cleanRoot));
    const mutatedBinding = () => JSON.parse(JSON.stringify(fixture.buildBinding));
    for (const role of Object.keys(fixture.buildBinding.targets)) {
      const omitted = mutatedBinding(); delete omitted.targets[role];
      rejects(() => assertCaptureBuildBinding(omitted, 'factory', cleanRoot, { manifest: factoryManifest }));
      const changed = mutatedBinding(); changed.targets[role].codeHash = '0'.repeat(64);
      rejects(() => assertCaptureBuildBinding(changed, 'factory', cleanRoot, { manifest: factoryManifest }));
      const missingInput = mutatedBinding(); delete missingInput.targets[role].inputs[missingInput.targets[role].source];
      rejects(() => assertCaptureBuildBinding(missingInput, 'factory', cleanRoot, { manifest: factoryManifest }));
      const traversal = mutatedBinding(); traversal.targets[role].inputs['../outside.tolk'] = '0'.repeat(64);
      rejects(() => assertCaptureBuildBinding(traversal, 'factory', cleanRoot, { manifest: factoryManifest }));
    }
    const unknown = mutatedBinding(); unknown.targets.UnknownCode = unknown.targets.DlmmPoolFactory;
    rejects(() => assertCaptureBuildBinding(unknown, 'factory', cleanRoot, { manifest: factoryManifest }));
    const physicalSource = join(cleanRoot, 'contracts/shared/math/integer.tolk');
    const retainedSource = readFileSync(physicalSource);
    rmSync(physicalSource);
    symlinkSync(join(factoryNativeRoot, 'contracts/shared/math/integer.tolk'), physicalSource);
    rejects(() => assertFactoryCompilerCodes(fixture.compiler, cleanRoot));
    rmSync(physicalSource); writeFileSync(physicalSource, retainedSource);
    // A changed closure map cannot be repaired by rehashing unrelated bytes.
    const missingTransitive = mutatedBinding();
    const transitive = Object.keys(missingTransitive.targets.DlmmPool.inputs).find(filename => filename !== missingTransitive.targets.DlmmPool.source)!;
    delete missingTransitive.targets.DlmmPool.inputs[transitive];
    rejects(() => assertCaptureBuildBinding(missingTransitive, 'factory', cleanRoot, { manifest: factoryManifest }));
    assertFactoryBuild(fixture, cleanRoot);
    console.log(`Factory provenance: nine pure-build target closures and ${rejected} tamper checks passed`);
  } finally { rmSync(cleanRoot, { recursive: true, force: true }); }
};


if (require.main === module) testFactoryPureBuildTargetClosures();
