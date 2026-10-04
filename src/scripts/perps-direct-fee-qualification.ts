import assert from 'node:assert/strict';
import { Cell } from '@ton/core';
import { assertCompletePerpsProducer, perpsProducerSourceInventory } from './perps-fixture-producer';

export function assertCompletePerpsDirectFeeProducer(log: string): void {
  assertCompletePerpsProducer(log, 'directFee');
}

export function assertCurrentCompiledCode(capturedBoc: Buffer, artifactJson: string, role: string): string {
  const artifact = JSON.parse(artifactJson) as { hash?: string; hex?: string;
    codeHashHex?: string; codeBoc64?: string };
  const expectedHash = artifact.hash ?? artifact.codeHashHex;
  const expectedBoc = artifact.hex ? Buffer.from(artifact.hex, 'hex') :
    artifact.codeBoc64 ? Buffer.from(artifact.codeBoc64, 'base64') : null;
  assert.match(expectedHash ?? '', /^[0-9a-f]{64}$/, `${role} compiled hash`);
  assert(expectedBoc, `${role} compiled code BOC is absent`);
  const compiled = Cell.fromBoc(expectedBoc), captured = Cell.fromBoc(capturedBoc);
  assert.equal(compiled.length, 1, `${role} compiled code root`);
  assert.equal(captured.length, 1, `${role} captured code root`);
  assert.equal(compiled[0].hash().toString('hex'), expectedHash, `${role} compiled artifact is internally inconsistent`);
  assert.equal(captured[0].hash().toString('hex'), expectedHash, `${role} captured code differs from current compiled source`);
  return expectedHash!;
}

/** The native graph producer's executable source, independent of fixture bytes. */
export function perpsDirectFeeProducerSourceInventory(nativeRoot: string): {
  digest: string; files: { path: string; sha256: string }[] } {
  return perpsProducerSourceInventory(nativeRoot);
}
