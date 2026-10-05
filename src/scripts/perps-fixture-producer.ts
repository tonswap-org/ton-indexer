import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { assertCaptureBuildBinding, assertCaptureCode, assertRetainedCaptureBinding } from './capture-build';
import { Cell } from '@ton/core';

export const PERPS_STRESS_CHAIN_CONFIG_HASH = '6afa8bd6ae1aaf8d918b8a6461666601c151d14270d81efddf0f602042c842e6';
export function assertPerpsStressChainConfig(value: unknown): void {
  assert.equal(typeof value, 'string', 'Perps capture requires its exact execution chain config');
  const cells = Cell.fromBoc(Buffer.from(value as string, 'base64'));
  assert.equal(cells.length, 1);
  assert.equal(cells[0].hash().toString('hex'), PERPS_STRESS_CHAIN_CONFIG_HASH,
    'Perps execution capture requires the VM15 400-nanoton/gas stress configuration');
}


export const PERPS_PRODUCERS = {
  risk: { suite: 'tests/perps/PerpsRiskAdmission.spec.ts', tests: 53 },
  wallets: { suite: 'tests/perps/PerpsExecutionFunding.spec.ts', tests: 7 },
  browser: { suite: 'tests/perps/PerpsBrowserEvidence.spec.ts', tests: 5 },
  directFee: { suite: 'tests/referral/PerpsTradeReferralPayout.spec.ts', tests: 1 },
  funding: { suite: 'tests/perps/PerpsEngineFunding.spec.ts', tests: 32 },
} as const;
export type PerpsProducer = keyof typeof PERPS_PRODUCERS;
const PRODUCER_SUITES = { ...PERPS_PRODUCERS, factory: { suite: 'tests/dlmm/DlmmPoolFactory.spec.ts', tests: 29 } };
type QualifiedProducer = keyof typeof PRODUCER_SUITES;
export const producerSha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export function assertCompletePerpsProducer(log: string, producer: QualifiedProducer): void {
  const { suite, tests } = PRODUCER_SUITES[producer];
  const lines = log.split(/\r?\n/);
  const uniqueLine = (prefix: RegExp, expected: RegExp, label: string): number => {
    const matches = lines.map((line, index) => ({ line, index })).filter(row => prefix.test(row.line));
    assert.equal(matches.length, 1, `Missing or duplicate ${label}`);
    assert.match(matches[0].line, expected, `Invalid ${label}`);
    return matches[0].index;
  };
  assert.doesNotMatch(log, /^(?:FAIL\s|(?:Test Suites|Tests):.*(?:failed|skipped|pending|todo))/mi);
  const passed = uniqueLine(/^(?:PASS|FAIL)\s/,
    new RegExp(`^PASS\\s+(?:[^\\s/]+\\s+)?${suite.split('.').join('\\.')}($|\\s)`), `complete ${suite} result`);
  const suites = uniqueLine(/^Test Suites:/, /^Test Suites:\s+1 passed, 1 total$/, 'complete Test Suites result');
  const cases = uniqueLine(/^Tests:/, new RegExp(`^Tests:\\s+${tests} passed, ${tests} total$`), 'complete Tests result');
  const time = uniqueLine(/^Time:/, /^Time:\s+[0-9]+(?:\.[0-9]+)? s(?:, estimated [0-9]+ s)?$/, 'terminal producer time');
  assert(passed < suites && suites < cases && cases < time, 'Producer terminal summaries are out of order');
}

/** A receipt authenticates this build closure and captured bytes. It does not
 * claim a historical TypeScript source lock or a pinned Node executable. */
export function assertPerpsProducerReceipt(value: any, producer: QualifiedProducer, nativeRoot: string,
  captureDirectory: string, log: Buffer, buildBinding: unknown,
  compiledRoot = join(__dirname, 'fixtures/capture-build', producer)) {
  assert.equal(value?.schema, 'tonswap-capture-producer-v1');
  assert.equal(value.producer, producer);
  assert.equal(value.suite, PRODUCER_SUITES[producer].suite);
  assert.equal(value.tests, PRODUCER_SUITES[producer].tests);
  assert.equal(typeof captureDirectory, 'string', 'Missing producer capture directory');
  assert(isAbsolute(captureDirectory), 'Producer capture directory must be absolute');
  assert.equal(value.captureDirectory, resolve(captureDirectory));
  assert.equal(value.exitCode, 0);
  assert.deepEqual(value.runtime, { node: 'v26.10.0', tolk: '1.4.2', sandbox: '0.42.0' });
  assert.equal(value.logSha256, producerSha256(log));
  assertCompletePerpsProducer(log.toString('utf8'), producer);
  assertRetainedCaptureBinding(buildBinding, producer);
  const binding = assertCaptureBuildBinding(buildBinding, producer, resolve(nativeRoot));
  assert.deepEqual(value.build, { file: 'build-binding.json',
    sha256: producerSha256(JSON.stringify(buildBinding, null, 2) + '\n'),
    manifestSha256: binding.manifestSha256, buildHash: binding.buildHash });
  assert(value.artifacts && typeof value.artifacts === 'object' && !Array.isArray(value.artifacts));
  for (const [name, hash] of Object.entries(value.artifacts)) {
    assertArtifactPath(name);
    assert.equal(typeof hash, 'string');
    assert.match(hash as string, /^[0-9a-f]{64}$/, 'Invalid producer artifact hash');
  }
  assert.equal(value.artifacts['build-binding.json'], value.build.sha256);
  for (const name of Object.keys(binding.captures)) {
    assert(name in value.artifacts, `Bound capture is missing from receipt: ${name}`);
  }
  assert(value.compiled && typeof value.compiled === 'object' && !Array.isArray(value.compiled));
  assert.deepEqual(Object.keys(value.compiled).sort(), Object.keys(binding.targets).sort(),
    'Compiled roles must equal the executed/embedded target closure');
  for (const [role, target] of Object.entries(binding.targets)) {
    const entry = value.compiled[role];
    assert.equal(entry.file, `current-compiled/${role}.json`);
    assert.equal(entry.codeHash, target.codeHash, `${role} receipt code hash`);
    assert.equal(entry.sha256, value.artifacts[entry.file], `${role} compiled inventory hash`);
    const bytes = physicalArtifact(compiledRoot, entry.file);
    assert.equal(producerSha256(bytes), entry.sha256, `${role} retained compiled bytes`);
    const artifact = JSON.parse(bytes.toString('utf8'));
    assert.equal(artifact.hash, entry.codeHash);
    assert.equal(typeof artifact.hex, 'string');
    assert.match(artifact.hex, /^(?:[0-9a-f]{2})+$/, `${role} compiled BOC encoding`);
    assertCaptureCode(role, Buffer.from(artifact.hex, 'hex'), binding);
  }
  return binding;
}

function assertArtifactPath(name: string) {
  assert(name.length > 0 && !isAbsolute(name) && !name.includes('\\') &&
    name.split('/').every(part => part !== '..' && part !== '.' && part.length > 0),
    'Invalid producer artifact path');
}
function physicalArtifact(root: string, name: string): Buffer {
  assertArtifactPath(name);
  let path = resolve(root);
  for (const part of name.split('/')) {
    path = join(path, part);
    assert(!lstatSync(path).isSymbolicLink(), 'Producer artifact must not follow symlinks');
  }
  assert(lstatSync(path).isFile(), 'Producer artifact is not physical');
  return readFileSync(path);
}

export function readPerpsProducerReceipt(captureDirectory: string, producer: PerpsProducer,
  nativeRoot: string, logPath = captureDirectory + '.log') {
  const receipt = JSON.parse(physicalArtifact(captureDirectory, 'producer-receipt.json').toString('utf8'));
  const binding = JSON.parse(physicalArtifact(captureDirectory, 'build-binding.json').toString('utf8'));
  assertPerpsProducerReceipt(receipt, producer, nativeRoot, captureDirectory, readFileSync(logPath), binding, captureDirectory);
  for (const [name, expectedHash] of Object.entries(receipt.artifacts)) {
    assert.equal(producerSha256(physicalArtifact(captureDirectory, name)), expectedHash, `Producer artifact changed: ${name}`);
  }
  return receipt;
}
