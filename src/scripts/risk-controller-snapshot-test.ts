import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Address, beginCell, Cell, TupleBuilder, TupleItem } from '@ton/core';
import { decodeRiskControllerSnapshot } from '../utils/riskController';
import { decodeControlMeshSnapshot } from '../utils/controlMesh';

const address = new Address(0, Buffer.alloc(32, 7));
const builder = new TupleBuilder();
builder.writeAddress(address);
for (const value of [1n, 2n, 2_000_000_000n, 1n, (1n << 255n) + 1n, 7n, 7n, 2n]) builder.writeNumber(value);
builder.writeNumber(50_000_000_000n); builder.writeNumber(52_000_000_000n);
builder.writeAddress(address);
for (const value of [10, 345000, 197, 128, 4, 3, 2_000_000_060, 50000]) builder.writeNumber(value);
const scores = beginCell();
for (let i = 0; i < 12; i++) scores.storeUint(i * 10000, 32);
builder.writeCell(scores.endCell());
const stack = builder.build();
const actual = decodeRiskControllerSnapshot(stack);
assert.deepEqual(actual, {
  governance: address.toRawString(), enabled: true, posture: 2, postureEnteredAt: '2000000000',
  paramsVersion: 1, paramsHash: ((1n << 255n) + 1n).toString(), sourceVersion: 7, sourceCount: 7, policyCount: 2,
  configuredGrossBudget: '50000000000', committedGrossBudget: '52000000000', controlMesh: address.toRawString(),
  controlReportSeq: 10, gri: 345000, presentMask: 197, staleMask: 128, acuteMask: 4, admissionFlags: 3,
  validUntil: '2000000060', automationWeightEffective: 50000, moduleScores: Array.from({ length: 12 }, (_, i) => i * 10000)
});
for (const malformed of [stack.slice(0, 19), stack.slice(0, 20), [...stack, { type: 'int' as const, value: 0n }]])
  assert.equal(decodeRiskControllerSnapshot(malformed), null);
for (const [index, value] of [[1, 2n], [2, 5n], [3, -1n], [4, 1n << 32n], [5, 1n << 256n], [6, -1n],
  [7, 33n], [8, 33n], [9, -1n], [9, 52_000_000_001n], [10, 52_500_000_001n], [10, 1n << 64n],
  [12, 1n << 32n], [13, 1_000_001n], [14, 4096n], [15, 4096n], [16, 4096n], [17, 8n], [18, -1n], [19, 1_000_001n]] as const) {
  const malformed = [...stack]; malformed[index] = { type: 'int', value };
  assert.equal(decodeRiskControllerSnapshot(malformed), null, `Invalid current field ${index}`);
}
const none = beginCell().storeAddress(null).endCell();
const optional = [...stack]; optional[11] = { type: 'slice', cell: none };
assert.equal(decodeRiskControllerSnapshot(optional)?.controlMesh, null);
for (const index of [0, 11]) for (const invalid of [beginCell().endCell(), beginCell().storeUint(0, 3).endCell(),
  beginCell().storeAddress(address).storeBit(0).endCell(), beginCell().storeAddress(address).storeRef(none).endCell(),
  ...(index === 0 ? [none] : [])]) {
  const malformed = [...stack]; malformed[index] = { type: 'slice', cell: invalid };
  assert.equal(decodeRiskControllerSnapshot(malformed), null);
}
for (const invalid of [beginCell().endCell(), beginCell().storeSlice(scores.endCell().beginParse()).storeBit(0).endCell(),
  beginCell().storeSlice(scores.endCell().beginParse()).storeRef(none).endCell(),
  beginCell().storeUint(1_000_001, 32).storeUint(0, 352).endCell()]) {
  const malformed = [...stack]; malformed[20] = { type: 'cell', cell: invalid };
  assert.equal(decodeRiskControllerSnapshot(malformed), null);
}
const wire = (stack: any[]): TupleItem[] => stack.map(item => item[0] === 'num'
  ? { type: 'int', value: BigInt(item[1]) } : { type: item[0], cell: Cell.fromBase64(item[1].bytes) });
// Original account BOCs and producer bindings remain in these historical
// fixtures. Web tests reexecute their getters; they are not release evidence.
const riskCapture = JSON.parse(readFileSync(join(__dirname, 'fixtures/risk-controller-retained-getters.json'), 'utf8'));
assert.equal(Cell.fromBase64(riskCapture.codeBoc).hash().toString('hex'), riskCapture.codeHash);
for (const [index, observation] of riskCapture.observations.entries()) {
  const decoded = decodeRiskControllerSnapshot(wire(observation.stack)); assert(decoded);
  assert.equal(decoded.configuredGrossBudget, '30000000000'); assert.equal(decoded.committedGrossBudget, '30000000000');
  assert.equal(decoded.controlMesh, null); assert.equal(decoded.controlReportSeq, 1);
  assert.equal(decoded.presentMask, index === 0 ? 32 : 0); assert.equal(decoded.automationWeightEffective, 80000);
  assert.equal(decoded.validUntil, index === 0 ? '1700007330' : '1700007961');
}
console.log('current 21-field RiskController snapshots preserve configured/committed budgets and reject retired tuples');

const meshCapture = JSON.parse(readFileSync(join(__dirname, 'fixtures/control-mesh-current-getter.json'), 'utf8'));
assert.equal(Cell.fromBase64(meshCapture.codeBoc).hash().toString('hex'), meshCapture.codeHash);
for (const observation of meshCapture.observations) {
  const stack = wire(observation.stack), decoded = decodeControlMeshSnapshot(stack); assert(decoded);
  for (const [key, value] of Object.entries(observation.wrapper))
    assert.equal((decoded as Record<string, unknown>)[key], typeof value === 'boolean' ? value : String(value), `Exact actual Mesh field ${key}`);
  for (const malformed of [stack.slice(0, 13), stack.slice(0, 31), stack.slice(0, 36), [...stack, { type: 'int' as const, value: 0n }]])
    assert.equal(decodeControlMeshSnapshot(malformed), null);
  for (const [index, value] of [[1, -1n], [3, 1n << 32n], [4, -1n], [14, -(1n << 31n) - 1n], [36, 1n << 31n]] as const) {
    const malformed = [...stack]; malformed[index] = { type: 'int', value };
    assert.equal(decodeControlMeshSnapshot(malformed), null);
  }
}
console.log('actual retained four-market 37-field Mesh getters decode completely and retired 31-field tuples are rejected');
