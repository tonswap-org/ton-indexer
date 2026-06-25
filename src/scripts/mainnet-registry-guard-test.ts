import assert from 'node:assert/strict';

import {
  REQUIRED_MAINNET_REGISTRY_KEYS,
  isLikelyTonAddress,
  validateMainnetRegistry
} from '../config/mainnetRegistry';

const sampleBase64Address = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const sampleRawAddress = '0:0000000000000000000000000000000000000000000000000000000000000000';

function validRegistry() {
  return Object.fromEntries(REQUIRED_MAINNET_REGISTRY_KEYS.map((key) => [key, sampleBase64Address]));
}

function testAddressShapeValidation() {
  assert.equal(isLikelyTonAddress(sampleBase64Address), true);
  assert.equal(isLikelyTonAddress(sampleRawAddress), true);
  assert.equal(isLikelyTonAddress('REPLACE_WITH_MAINNET_T3_ROOT'), false);
  assert.equal(isLikelyTonAddress('../../../etc/passwd'), false);
  assert.equal(isLikelyTonAddress(''), false);
}

function testRejectsPlaceholders() {
  const registry = validRegistry();
  registry.T3Root = 'REPLACE_WITH_MAINNET_T3_ROOT';
  assert.throws(
    () => validateMainnetRegistry(registry),
    /missing\/placeholder keys: T3Root/
  );
}

function testRejectsMissingRequiredKeys() {
  const registry = validRegistry();
  delete registry.UsdtRoot;
  assert.throws(
    () => validateMainnetRegistry(registry),
    /missing\/placeholder keys: UsdtRoot/
  );
}

function testRejectsMalformedAddresses() {
  const registry = validRegistry();
  registry.FeeRouter = 'not-a-ton-address';
  assert.throws(
    () => validateMainnetRegistry(registry),
    /invalid address format keys: FeeRouter/
  );
}

function testAcceptsCompleteRegistry() {
  assert.doesNotThrow(() => validateMainnetRegistry(validRegistry()));
}

function main() {
  testAddressShapeValidation();
  testRejectsPlaceholders();
  testRejectsMissingRequiredKeys();
  testRejectsMalformedAddresses();
  testAcceptsCompleteRegistry();
  process.stdout.write('mainnet registry guard ok\n');
}

main();
