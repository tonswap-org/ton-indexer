import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { parseCanonicalReleaseManifest } from '../config/releaseManifest';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { loadOpcodes } from '../utils/opcodes';

const config = loadConfig();

try {
  const fixture = runtimeManifestFixture();
  const manifest = parseCanonicalReleaseManifest(fixture, 'testnet');
  assert.equal(manifest.runtime.manifestHash, fixture.manifestHash);
  assert.equal(manifest.contracts.T3Hub, fixture.contracts.T3Hub!.address);
  assert.equal('registryPath' in config, false);
  assert.equal('opcodesPath' in config, false);
  const opcodes = loadOpcodes();
  console.log('config ok', {
    network: config.network,
    fixtureContracts: Object.keys(manifest.contracts).length,
    opSwap: opcodes.swap.size,
  });
  process.exit(0);
} catch (error) {
  console.error('smoke failed', (error as Error).message);
  process.exit(1);
}
