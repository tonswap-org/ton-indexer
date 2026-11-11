import { assertCaptureCode } from './capture-build';
import { readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
import { assertPerpsProducerReceipt, producerSha256, assertPerpsStressChainConfig } from './perps-fixture-producer';

export const perpsRiskFixtureFolder = process.env.TONSWAP_PERPS_RISK_FIXTURE_DIR ??
  join(__dirname, 'fixtures/perps-risk-admission-current');

export function readPerpsRiskFixtureProvenance() {
  const provenance = JSON.parse(readFileSync(join(perpsRiskFixtureFolder, 'provenance.json'), 'utf8'));
  assert.equal(provenance.qualification, 'qualified-pure-build-target-closure');
  {
    assertPerpsProducerReceipt(provenance.producerReceipt, 'risk', resolve(__dirname, '../../../tonswap_tolk'),
      provenance.producerReceipt?.captureDirectory, Buffer.from(provenance.producerLog ?? ''), provenance.buildBinding);
    for (const artifact of provenance.artifacts) {
      const bytes = readFileSync(join(perpsRiskFixtureFolder, artifact.relative));
      const capture = JSON.parse(bytes.toString('utf8'));
      assertPerpsStressChainConfig(capture.chainConfig);
      assert(provenance.buildBinding.captures[basename(artifact.source)], 'Adopted capture lacks build closure');
      for (const [field, role] of Object.entries({ engineCode: 'PerpsEngine', poolCode: 'DlmmPool',
        walletCode: 'JettonWallet', riskVaultCode: 'RiskVault', riskControllerCode: 'RiskController' })) {
        assertCaptureCode(role, capture[field], provenance.buildBinding);
      }
      assert.equal(producerSha256(bytes), artifact.sha256, 'Adopted Perps capture changed');
      assert.equal(artifact.sha256, provenance.producerReceipt.artifacts[basename(artifact.source)], 'Capture is absent from authenticated producer run');
    }
  }
  return provenance;
}
