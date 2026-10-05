import assert from 'node:assert/strict';
import { beginCell, Cell } from '@ton/core';
import { mintFeesFromStateTransition } from '../ledger/t3MintFees';

const feeCell = (proportional: bigint[] = [0n, 0n, 0n], single: bigint[] = [0n, 0n, 0n]) => {
  const b = beginCell();
  [...proportional, ...single].forEach(value => b.storeCoins(value));
  return b.endCell();
};
const snapshot = (balances: bigint[], supply: bigint, proportional = [0n, 0n, 0n], single = [0n, 0n, 0n]) => ({
  balances: balances.map(String),
  totalSupply: String(supply),
  fees: feeCell(proportional, single),
});
const zero = [0n, 0n, 0n];

// The active two-asset proportional deposit is fee-free. Counting nonzero
// deposit legs incorrectly charged each leg merely because KUSD is absent.
const beforeTwo = snapshot([1000n, 1000n, 0n], 2000n, [4n, 5n, 0n]);
const afterTwo = snapshot([1100n, 1100n, 0n], 2200n, [4n, 5n, 0n]);
assert.deepEqual(mintFeesFromStateTransition(beforeTwo, afterTwo, ['100', '100', '0'], '200'), ['0', '0', '0']);

// Nonzero three-asset deposits do not imply a fee exemption. The exact native
// skim rounds up per asset because the kept amount is rounded down.
const beforeThree = snapshot([1000n, 1000n, 1000n], 3000n, [7n, 8n, 9n], [3n, 2n, 1n]);
const afterThree = snapshot([1100n, 1101n, 1102n], 3298n, [8n, 10n, 11n], [3n, 2n, 1n]);
assert.deepEqual(mintFeesFromStateTransition(beforeThree, afterThree, ['100', '101', '102'], '298'), ['1', '2', '2']);
assert.deepEqual(mintFeesFromStateTransition(
  snapshot([1000n, 1000n, 0n], 2000n),
  snapshot([1001n, 1100n, 0n], 2099n, [1n, 1n, 0n]),
  ['1', '100', '0'], '99',
), ['1', '1', '0']);

// The separately authenticated manual bootstrap can add exactly equal two-leg
// reserves without a fee. A later zero-reserve seed or governed recap can pay a
// fee despite an equal two-leg basket; only its recorded execution decides it.
const seed = 75_000_000_000_000n;
assert.deepEqual(mintFeesFromStateTransition(
  snapshot(zero, 0n), snapshot([seed, seed, 0n], seed * 2n),
  [String(seed), String(seed), '0'], String(seed * 2n),
), ['0', '0', '0']);
const seedFee = seed * 30n / 10000n;
assert.deepEqual(mintFeesFromStateTransition(
  snapshot([6n, 5n, 0n], 11n),
  snapshot([seed + 6n, seed + 5n, 0n], 11n + 2n * (seed - seedFee), [seedFee, seedFee, 0n]),
  [String(seed), String(seed), '0'], String(2n * (seed - seedFee)),
), [String(seedFee), String(seedFee), '0']);

// A mint retry changes neither committed collateral nor supply; it is never a
// fresh zero-fee execution. Missing/obsolete buckets and unrelated fee mutations
// remain unavailable instead of fabricating a zero or estimated fee.
assert.equal(mintFeesFromStateTransition(afterTwo, afterTwo, ['100', '100', '0'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo, afterTwo, ['100', '101', '0'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo, afterTwo, ['100', '100', '0'], '199'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo, { ...afterTwo, fees: Cell.EMPTY }, ['100', '100', '0'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo,
  { ...afterTwo, fees: feeCell([4n, 5n, 0n], [1n, 0n, 0n]) }, ['100', '100', '0'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo,
  { ...afterTwo, fees: feeCell([3n, 5n, 0n]) }, ['100', '100', '0'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo,
  { ...afterTwo, fees: feeCell([105n, 5n, 0n]) }, ['100', '100', '0'], '200'), null);
const trailing = beginCell().storeSlice(feeCell().beginParse()).storeBit(false).endCell();
assert.equal(mintFeesFromStateTransition(snapshot([1000n, 1000n, 0n], 2000n),
  { ...snapshot([1100n, 1100n, 0n], 2200n), fees: trailing }, ['100', '100', '0'], '200'), null);
const reference = beginCell().storeSlice(feeCell().beginParse()).storeRef(Cell.EMPTY).endCell();
assert.equal(mintFeesFromStateTransition(snapshot([1000n, 1000n, 0n], 2000n),
  { ...snapshot([1100n, 1100n, 0n], 2200n), fees: reference }, ['100', '100', '0'], '200'), null);
const nonminimal = beginCell().storeUint(1, 4).storeUint(0, 8);
for (let i = 0; i < 5; i++) nonminimal.storeCoins(0);
assert.equal(mintFeesFromStateTransition(snapshot([1000n, 1000n, 0n], 2000n),
  { ...snapshot([1100n, 1100n, 0n], 2200n), fees: nonminimal.endCell() }, ['100', '100', '0'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo, afterTwo, ['100', '100'], '200'), null);
assert.equal(mintFeesFromStateTransition(beforeTwo, afterTwo, ['-100', '100', '0'], '200'), null);

console.log('T3 original mint fee transition regressions passed');
