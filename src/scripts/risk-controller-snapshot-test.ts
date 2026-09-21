import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cell, TupleItem } from '@ton/core';
import { decodeControlMeshSnapshot } from '../utils/controlMesh';
import assert from 'node:assert/strict';
import { Address, beginCell, TupleBuilder } from '@ton/core';
import { decodeRiskControllerSnapshot } from '../utils/riskController';

const address = new Address(0, Buffer.alloc(32, 7));
const builder = new TupleBuilder();
builder.writeAddress(address);
for (const value of [1n, 2n, 2_000_000_000n, 1n, (1n << 255n) + 1n, 7n, 7n, 2n]) builder.writeNumber(value);
builder.writeNumber(52_000_000_000n);
builder.writeAddress(address);
for (const value of [10, 345000, 197, 128, 0, 3, 2_000_000_060, 50000]) builder.writeNumber(value);
const scores = beginCell();
for (let i = 0; i < 12; i++) scores.storeUint(i * 10000, 32);
builder.writeCell(scores.endCell());
const stack = builder.build();
const actual = decodeRiskControllerSnapshot(stack);
assert.ok(actual);
assert.equal(actual.governance, address.toRawString());
assert.equal(actual.paramsHash, ((1n << 255n) + 1n).toString());
assert.equal(actual.sourceCount, 7);
assert.equal(actual.totalGrossBudget, '52000000000');
assert.equal(actual.staleMask, 128);
assert.equal(actual.admissionFlags, 3);
assert.equal(actual.moduleScores[11], 110000);
assert.equal(decodeRiskControllerSnapshot(stack.slice(0, 19)), null);
assert.equal(decodeRiskControllerSnapshot([...stack, { type: 'int', value: 0n }]), null);
for (const [index, value] of [[1, 2n], [2, 5n], [7, 33n], [8, 33n], [9, 52_500_000_001n], [12, 1_000_001n], [13, 4096n], [16, 8n], [17, -1n]] as const) {
  const malformed = [...stack]; malformed[index] = { type: 'int', value };
  assert.equal(decodeRiskControllerSnapshot(malformed), null);
}
const invalidScores = [...stack]; invalidScores[19] = { type: 'cell', cell: beginCell().endCell() };
assert.equal(decodeRiskControllerSnapshot(invalidScores), null);
console.log('risk controller snapshot tests passed');

const meshCapture = JSON.parse(readFileSync(join(__dirname, 'fixtures/control-mesh-current-getter.json'), 'utf8'));
assert.equal(Cell.fromBase64(meshCapture.codeBoc).hash().toString('hex'), meshCapture.codeHash);
for (const observation of meshCapture.observations) {
  const retiredStack: TupleItem[] = observation.stack.map((item: any) => item[0] === 'num'
    ? { type: 'int', value: BigInt(item[1]) } : { type: item[0], cell: Cell.fromBase64(item[1].bytes) });
  assert.equal(decodeControlMeshSnapshot(retiredStack), null, 'retired two-market tuple must stay unsupported');
  const addedMarketDecisions: TupleItem[] = [3000n, -7n, 19n, 4000n, -8n, 20n]
    .map(value => ({ type: 'int' as const, value }));
  const stack: TupleItem[] = [...retiredStack.slice(0, 25), ...addedMarketDecisions, ...retiredStack.slice(25)];
  const decoded = decodeControlMeshSnapshot(stack);
  assert(decoded); assert.equal(decoded.governance, Address.parse(observation.wrapper.governance).toRawString());
  assert.equal(decoded.enabled, observation.wrapper.enabled); assert.equal(decoded.sequence, String(observation.wrapper.sequence));
  assert.equal(decoded.lastHeartbeatTs, String(observation.wrapper.lastHeartbeatTs));
  assert.equal(decoded.perpsMarket1WeightMillibps, String(observation.wrapper.perpsTonWeightMillibps));
  assert.equal(decoded.perpsMarket2WeightMillibps, String(observation.wrapper.perpsBtcWeightMillibps));
  assert.equal(decoded.perpsMarket3WeightMillibps, '3000'); assert.equal(decoded.perpsMarket3FeeDeltaBps, '-7');
  assert.equal(decoded.perpsMarket3FundingCapBps, '19'); assert.equal(decoded.perpsMarket4WeightMillibps, '4000');
  assert.equal(decoded.perpsMarket4FeeDeltaBps, '-8'); assert.equal(decoded.perpsMarket4FundingCapBps, '20');
  assert.equal(decoded.insuranceBtcCover, String(observation.wrapper.insuranceBtcCover));
  for (const invalid of [stack.slice(0, 13), stack.slice(0, 36), [...stack, { type: 'int' as const, value: 0n }],
    [...stack, ...Array.from({ length: 26 }, (): TupleItem => ({ type: 'int', value: 0n }))]])
    assert.equal(decodeControlMeshSnapshot(invalid), null);
  for (const [index, value] of [[1, -1n], [3, 1n << 32n], [4, -1n], [14, -(1n << 31n) - 1n], [36, 1n << 31n]] as const) {
    const malformed = [...stack]; malformed[index] = { type: 'int', value };
    assert.equal(decodeControlMeshSnapshot(malformed), null);
  }
}
console.log('current 37-field Mesh snapshots decode completely and retired 31-field tuples are rejected');
