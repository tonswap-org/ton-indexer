import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
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
  directFeeObserved: { suite: 'tests/referral/PerpsTradeReferralPayout.spec.ts', tests: 1 },
  funding: { suite: 'tests/perps/PerpsEngineFunding.spec.ts', tests: 32 },
} as const;
export type PerpsProducer = keyof typeof PERPS_PRODUCERS;
export const producerSha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Bind executable dependencies; unrelated Router/Options edits cannot bless or
 * invalidate these captures. Tolk imports and local TypeScript imports are
 * traversed recursively, and the exact toolchain lock/configuration is bound. */
export function perpsProducerSourceInventory(nativeRoot: string) {
  const files = new Map<string, string>();
  const rawOptions = ts.readConfigFile(join(nativeRoot, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
  const compilerOptions = ts.convertCompilerOptionsFromJson(rawOptions, nativeRoot).options;
  const visit = (path: string): void => {
    path = resolve(path);
    const name = relative(nativeRoot, path).split('\\').join('/');
    assert(!name.startsWith('../'), `Producer dependency outside native package: ${path}`);
    if (files.has(name)) return;
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Producer source must be a physical file: ${path}`);
    const bytes = readFileSync(path), source = bytes.toString('utf8');
    files.set(name, producerSha256(bytes));
    if (/\.[cm]?tsx?$/.test(path)) {
      for (const entry of ts.preProcessFile(source, true, true).importedFiles) {
        if (!entry.fileName.startsWith('.')) continue;
        const dependency = ts.resolveModuleName(entry.fileName, path, compilerOptions, ts.sys).resolvedModule;
        assert(dependency && !dependency.isExternalLibraryImport, `Unresolved producer import ${entry.fileName} in ${name}`);
        visit(dependency.resolvedFileName);
      }
      for (const match of source.matchAll(/['"](contracts\/[A-Za-z0-9_./-]+\.tolk)['"]/g)) {
        if (!match[1].endsWith('.generated.tolk')) visit(join(nativeRoot, match[1]));
      }
    }
    if (path.endsWith('.tolk')) {
      for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
        if (!match[1].startsWith('@stdlib/')) visit(resolve(dirname(path), match[1]));
      }
    }
  };
  const roles = ['PerpsEngine', 'PerpsEngineBootstrap', 'DlmmPool', 'FeeRouter', 'ReferralRegistry',
    'ReferralDistributor', 'JettonRoot', 'JettonWallet', 'Treasury', 'EmissionsSplitter', 'RiskVault',
    'RiskController', 'NativeReturnCollector', 'GasVault', 'InsuranceVault', 'BounceWallet', 'NativeFundingRejector'];
  for (const name of ['package.json', 'package-lock.json', 'jest.config.cjs', 'tsconfig.json',
    'tests/setup.maxListeners.ts', 'tests/setup.silenceSandboxLogs.ts',
    ...Object.values(PERPS_PRODUCERS).map(row => row.suite),
    ...roles.map(role => `wrappers/${role}.compile.ts`)]) visit(join(nativeRoot, name));
  for (const dependency of ['@ton/blueprint', '@ton/tolk-js', '@ton/sandbox', '@ton/core', 'ts-jest', 'typescript']) {
    visit(join(nativeRoot, 'node_modules', dependency, 'package.json'));
  }
  const result = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
  assert(result.length > 100, 'Incomplete Perps producer source inventory');
  return { digest: producerSha256(JSON.stringify(result)), files: result };
}

export function assertCompletePerpsProducer(log: string, producer: PerpsProducer): void {
  const { suite, tests } = PERPS_PRODUCERS[producer];
  const lines = log.split(/\r?\n/);
  const uniqueLine = (prefix: RegExp, expected: RegExp, label: string): number => {
    const matches = lines.map((line, index) => ({ line, index })).filter(row => prefix.test(row.line));
    assert.equal(matches.length, 1, `Missing or duplicate ${label}`);
    assert.match(matches[0].line, expected, `Invalid ${label}`);
    return matches[0].index;
  };
  assert.doesNotMatch(log, /^(?:FAIL\s|(?:Test Suites|Tests):.*(?:failed|skipped|pending|todo))/mi);
  const passed = uniqueLine(/^(?:PASS|FAIL)\s/,
    new RegExp(`^PASS\\s+${suite.split('.').join('\\.')}($|\\s)`), `complete ${suite} result`);
  const suites = uniqueLine(/^Test Suites:/, /^Test Suites:\s+1 passed, 1 total$/, 'complete Test Suites result');
  const cases = uniqueLine(/^Tests:/, new RegExp(`^Tests:\\s+${tests} passed, ${tests} total$`), 'complete Tests result');
  const time = uniqueLine(/^Time:/, /^Time:\s+[0-9]+(?:\.[0-9]+)? s(?:, estimated [0-9]+ s)?$/, 'terminal producer time');
  assert(passed < suites && suites < cases && cases < time, 'Producer terminal summaries are out of order');
}

export function assertPerpsProducerReceipt(value: any, producer: PerpsProducer, nativeRoot: string,
  captureDirectory: string, log: Buffer): void {
  assert.equal(value?.schema, 'tonswap-perps-fixture-producer-v1');
  assert.equal(value.producer, producer);
  assert.equal(value.suite, PERPS_PRODUCERS[producer].suite);
  assert.equal(value.tests, PERPS_PRODUCERS[producer].tests);
  assert.equal(value.captureDirectory, resolve(captureDirectory));
  assert.equal(value.exitCode, 0);
  assert.equal(value.runtime?.version, 'v26.5.1');
  assert.equal(value.runtime?.noTurboFastApiCalls, true);
  assert.match(value.runtime?.binarySha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(value.logSha256, producerSha256(log));
  assertCompletePerpsProducer(log.toString('utf8'), producer);
  assert.deepEqual(value.sourceBefore, value.sourceAfter, 'Producer source changed during capture');
  assert.deepEqual(value.sourceAfter, perpsProducerSourceInventory(nativeRoot), 'Producer source is stale');
}

export function readPerpsProducerReceipt(captureDirectory: string, producer: PerpsProducer,
  nativeRoot: string, logPath = captureDirectory + '.log') {
  const receipt = JSON.parse(readFileSync(join(captureDirectory, 'producer-receipt.json'), 'utf8'));
  assertPerpsProducerReceipt(receipt, producer, nativeRoot, captureDirectory, readFileSync(logPath));
  assert(Object.keys(receipt.artifacts).length > 0, 'Producer artifact inventory is empty');
  for (const [name, expectedHash] of Object.entries(receipt.artifacts)) {
    assert(!name.startsWith('/') && !name.split('/').includes('..'), 'Invalid producer artifact path');
    const path = join(captureDirectory, name), stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Producer artifact is not physical');
    assert.equal(producerSha256(readFileSync(path)), expectedHash, `Producer artifact changed: ${name}`);
  }
  return receipt;
}
