import { readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
import { assertPerpsProducerReceipt, producerSha256, assertPerpsStressChainConfig } from './perps-fixture-producer';

export const perpsRiskFixtureFolder = process.env.TONSWAP_PERPS_RISK_FIXTURE_DIR ??
  join(__dirname, 'fixtures/perps-risk-admission-current');

export function readPerpsRiskFixtureProvenance() {
  const provenance = JSON.parse(readFileSync(join(perpsRiskFixtureFolder, 'provenance.json'), 'utf8'));
  if (provenance.qualification !== 'qualified-after-native-source-lock' &&
      process.env.TONSWAP_ALLOW_PROVISIONAL_PERPS_FIXTURE !== '1') {
    throw Error('Perps risk VM fixtures are stale or provisional; recapture after native source lock');
  }
  if (provenance.qualification === 'qualified-after-native-source-lock') {
    assertPerpsProducerReceipt(provenance.producerReceipt, 'risk', resolve(__dirname, '../../../tonswap_tolk'),
      provenance.producerReceipt?.captureDirectory, Buffer.from(provenance.producerLog ?? ''));
    for (const artifact of provenance.artifacts) {
      const bytes = readFileSync(join(perpsRiskFixtureFolder, artifact.relative));
      assertPerpsStressChainConfig(JSON.parse(bytes.toString('utf8')).chainConfig);
      assert.equal(producerSha256(bytes), artifact.sha256, 'Adopted Perps capture changed');
      assert.equal(artifact.sha256, provenance.producerReceipt.artifacts[basename(artifact.source)], 'Capture is absent from authenticated producer run');
    }
  }
  return provenance;
}
