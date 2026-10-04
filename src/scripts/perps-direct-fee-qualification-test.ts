import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginCell } from '@ton/core';
import { assertCompletePerpsDirectFeeProducer, assertCurrentCompiledCode,
  perpsDirectFeeProducerSourceInventory } from './perps-direct-fee-qualification';
import { assertCompletePerpsProducer, assertPerpsProducerReceipt, producerSha256, assertPerpsStressChainConfig } from './perps-fixture-producer';

const log = 'PASS tests/referral/PerpsTradeReferralPayout.spec.ts\n' +
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
const inventory = perpsDirectFeeProducerSourceInventory('../tonswap_tolk');
assert.match(inventory.digest, /^[0-9a-f]{64}$/);
assert(inventory.files.length > 100);
const riskLog = 'PASS tests/perps/PerpsRiskAdmission.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 53 passed, 53 total\nTime: 1 s\n';
assert.doesNotThrow(() => assertCompletePerpsProducer(riskLog, 'risk'));
assert.throws(() => assertCompletePerpsProducer(riskLog.replaceAll('53', '54'), 'risk'), /Tests/,
  'Obsolete or fabricated test counts cannot authorize fixture adoption');
assert.throws(() => assertCompletePerpsProducer(riskLog.replace('53 passed, 53 total', '52 passed, 1 skipped, 53 total'), 'risk'), /Tests/);
const walletLog = 'PASS tests/perps/PerpsExecutionFunding.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 7 passed, 7 total\nTime: 1 s\n';
assert.doesNotThrow(() => assertCompletePerpsProducer(walletLog, 'wallets'));
assert.throws(() => assertCompletePerpsProducer(walletLog.replaceAll('7', '6'), 'wallets'), /Tests/,
  'The earlier six-case suite cannot qualify the newly required cold wallet deployment');
const receipt = { schema: 'tonswap-perps-fixture-producer-v1', producer: 'directFee',
  suite: 'tests/referral/PerpsTradeReferralPayout.spec.ts', tests: 1, captureDirectory: '/tmp/fixture-test', exitCode: 0,
  runtime: { version: 'v26.5.1', noTurboFastApiCalls: true, binarySha256: 'a'.repeat(64) },
  logSha256: producerSha256(log), sourceBefore: inventory, sourceAfter: inventory };
const validate = (value: unknown) => assertPerpsProducerReceipt(value, 'directFee', '../tonswap_tolk', '/tmp/fixture-test', Buffer.from(log));
assert.doesNotThrow(() => validate(receipt));
const stale = { digest: '0'.repeat(64), files: inventory.files.slice(1) };
assert.throws(() => validate({ ...receipt, sourceBefore: stale }), /changed during capture/);
assert.throws(() => validate({ ...receipt, sourceBefore: stale, sourceAfter: stale }), /source is stale/);
assert.throws(() => validate({ ...receipt, exitCode: 1 }));
assert.throws(() => validate({ ...receipt, captureDirectory: '/tmp/another-run' }));
const config = JSON.parse(readFileSync(join(__dirname, 'fixtures/perps-direct-fee-current/canonical-native-config.json'), 'utf8'));
assert.doesNotThrow(() => assertPerpsStressChainConfig(config.configBoc));
assert.throws(() => assertPerpsStressChainConfig(undefined), /exact execution chain config/);
assert.throws(() => assertPerpsStressChainConfig(current.toBoc().toString('base64')), /400-nanoton/);
console.log('PASS Perps fixture qualification rejects truncated/wrong-count logs, stale/changing source, failed/mixed runs and substituted code');
