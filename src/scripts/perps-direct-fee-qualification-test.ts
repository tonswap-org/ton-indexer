import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginCell } from '@ton/core';
import { assertCompletePerpsDirectFeeProducer, assertCurrentCompiledCode } from './perps-direct-fee-qualification';
import { assertCompletePerpsProducer, assertPerpsProducerReceipt, producerSha256, assertPerpsStressChainConfig } from './perps-fixture-producer';

const log = 'PASS default tests/referral/PerpsTradeReferralPayout.spec.ts\n' +
  'Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total\nTime: 1.234 s\n';
assert.doesNotThrow(() => assertCompletePerpsDirectFeeProducer(log));
assert.throws(() => assertCompletePerpsDirectFeeProducer(log.slice(0, -12)), /terminal producer time/,
  'A truncated producer log cannot qualify a capture');
assert.throws(() => assertCompletePerpsDirectFeeProducer(log.replace('1 passed, 1 total\n',
  '1 passed, 2 total\n')), /Test Suites/,
  'An incomplete producer suite cannot qualify a capture');
assert.throws(() => assertCompletePerpsDirectFeeProducer(log.replace('Tests: 1 passed, 1 total',
  'Tests: 1 passed, 2 total')), /Tests/,
  'A missing direct-fee test cannot qualify a capture');
for (const suffix of ['Test Suites: 1 failed, 1 total', 'Test Suites: 1 skipped, 1 total',
  'Test Suites: 1 pending, 1 total', 'Test Suites: 1 todo, 1 total', 'Tests: 1 todo, 1 total',
  'Test Suites: 1 passed, 1 total', 'Tests: 1 passed, 1 total', 'Time: 2 s',
  'PASS tests/referral/PerpsTradeReferralPayout.spec.ts']) {
  assert.throws(() => assertCompletePerpsDirectFeeProducer(log + suffix + '\n'),
    'Conflicting or duplicate summaries cannot hide behind an earlier successful result');
}
assert.throws(() => assertCompletePerpsDirectFeeProducer(log.replace('Time: 1.234 s\n', '') +
  'Time: 1.234 s\nTests: 1 passed, 1 total\n'));
assert.throws(() => assertCompletePerpsDirectFeeProducer(log.replace('Tests: 1 passed, 1 total\n', '') +
  'Tests: 1 passed, 1 total\n'), /out of order/);
for (const malformed of ['.', '1..2', 'NaN', 'Infinity', '-1']) {
  assert.throws(() => assertCompletePerpsDirectFeeProducer(log.replace('Time: 1.234 s', `Time: ${malformed} s`)),
    /terminal producer time/);
}

const current = beginCell().storeUint(0x50455250, 32).endCell(),
  substituted = beginCell().storeUint(0x50455251, 32).endCell(),
  artifact = JSON.stringify({ hash: current.hash().toString('hex'), hex: current.toBoc().toString('hex') });
assert.equal(assertCurrentCompiledCode(current.toBoc(), artifact, 'PerpsEngine'), current.hash().toString('hex'));
assert.throws(() => assertCurrentCompiledCode(substituted.toBoc(), artifact, 'PerpsEngine'),
  /captured code differs/, 'A substituted code cell cannot qualify a capture');
const riskLog = 'PASS tests/perps/PerpsRiskAdmission.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 53 passed, 53 total\nTime: 1 s\n';
assert.doesNotThrow(() => assertCompletePerpsProducer(riskLog, 'risk'));
assert.throws(() => assertCompletePerpsProducer(riskLog.replaceAll('53', '54'), 'risk'), /Tests/,
  'Obsolete or fabricated test counts cannot authorize fixture adoption');
assert.throws(() => assertCompletePerpsProducer(riskLog.replace('53 passed, 53 total', '52 passed, 1 skipped, 53 total'), 'risk'), /Tests/);
const walletLog = 'PASS tests/perps/PerpsExecutionFunding.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 7 passed, 7 total\nTime: 1 s\n';
assert.doesNotThrow(() => assertCompletePerpsProducer(walletLog, 'wallets'));
assert.throws(() => assertCompletePerpsProducer(walletLog.replaceAll('7', '6'), 'wallets'), /Tests/,
  'The earlier six-case suite cannot qualify the newly required cold wallet deployment');
const provenance = JSON.parse(readFileSync(join(__dirname, 'fixtures/perps-direct-fee-current/provenance.json'), 'utf8'));
const receipt = provenance.producerReceipt, binding = provenance.buildBinding;
const actualLog = readFileSync(join(__dirname, 'fixtures/perps-direct-fee-current/producer-log.txt'));
const validate = (value: unknown, selectedBinding = binding) => assertPerpsProducerReceipt(value, 'directFee', '../tonswap_tolk',
  receipt.captureDirectory, actualLog, selectedBinding);
assert.doesNotThrow(() => validate(receipt));
assert.throws(() => validate({ ...receipt, schema: 'tonswap-perps-fixture-producer-v1' }));
assert.throws(() => validate({ ...receipt, runtime: { ...receipt.runtime, node: 'v26.5.1' } }));
assert.throws(() => validate({ ...receipt, exitCode: 1 }));
assert.throws(() => validate({ ...receipt, captureDirectory: '/tmp/another-run' }));
assert.throws(() => validate({ ...receipt, build: { ...receipt.build, sha256: '0'.repeat(64) } }));
assert.throws(() => validate({ ...receipt, compiled: {} }));
assert.throws(() => validate({ ...receipt, artifacts: { ...receipt.artifacts, '../escape': '0'.repeat(64) } }));
assert.throws(() => validate(receipt, { ...binding, manifestSha256: '0'.repeat(64) }));
const rehashedBinding = structuredClone(binding);
rehashedBinding.targets.PerpsEngine.codeHash = '0'.repeat(64);
assert.throws(() => validate({ ...receipt, build: { ...receipt.build,
  sha256: producerSha256(JSON.stringify(rehashedBinding, null, 2) + '\n') } }, rehashedBinding),
  'Rehashing receipt metadata cannot substitute a retained build identity');
const omittedBinding = structuredClone(binding), omittedReceipt = structuredClone(receipt);
for (const [file, capture] of Object.entries(omittedBinding.captures) as [string,{executed:string[];embedded:string[];unbuiltCode:string[]}][]) {
  capture.executed = capture.executed.filter(role => role !== 'FeeRouter');
  capture.embedded = capture.embedded.filter(role => role !== 'FeeRouter');
  if (capture.executed.length + capture.embedded.length + capture.unbuiltCode.length === 0) delete omittedBinding.captures[file];
}
delete omittedBinding.targets.FeeRouter;
delete omittedReceipt.compiled.FeeRouter;
omittedReceipt.build.sha256 = producerSha256(JSON.stringify(omittedBinding, null, 2) + '\n');
omittedReceipt.artifacts['build-binding.json'] = omittedReceipt.build.sha256;
assert.throws(() => validate(omittedReceipt, omittedBinding), /reviewed producer binding/,
  'Coordinated omission and rehashed metadata cannot hide an executed target');
const config = JSON.parse(readFileSync(join(__dirname, 'fixtures/perps-direct-fee-current/canonical-native-config.json'), 'utf8'));
assert.doesNotThrow(() => assertPerpsStressChainConfig(config.configBoc));
assert.throws(() => assertPerpsStressChainConfig(undefined), /exact execution chain config/);
assert.throws(() => assertPerpsStressChainConfig(current.toBoc().toString('base64')), /400-nanoton/);
console.log('PASS Perps fixture qualification rejects truncated/wrong-count logs, stale build closures, failed/mixed runs and substituted code');
