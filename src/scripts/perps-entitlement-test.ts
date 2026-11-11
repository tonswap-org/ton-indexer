import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import { counterpartyClose, counterpartyShouldLiquidate, initialCounterpartyReserve, type CounterpartyCapital } from '../ledger/perpsEconomics';
import { readPerpsPosition } from '../ledger/perpsState';

// Synthetic integer/ABI vectors are independent of native capture provenance.
// The ordinary genuine execution fixture tests remain mandatory separately.
const owner = new Address(0, Buffer.alloc(32, 7));
const position = (counterparty: Cell) => beginCell().storeAddress(owner).storeUint(1, 32).storeInt(3, 128)
  .storeCoins(4).storeCoins(3).storeInt(-1, 128).storeRef(counterparty).endCell();
const coins = (values: bigint[]) => { const b = beginCell(); for (const v of values) b.storeCoins(v); return b; };
const parsed = readPerpsPosition(position(coins([6n, 1n, 2n, 3n]).endCell()));
assert.deepEqual(parsed.counterparty, { reservedRaw: '6', pendingFundingRaw: '1', collectedLossRaw: '2', remainingEntitlementRaw: '3' });
assert.throws(() => readPerpsPosition(position(coins([6n, 1n, 2n]).endCell())), 'Three-coin state is never a current position');
assert.throws(() => readPerpsPosition(position(coins([6n, 1n, 2n, 3n]).storeBit(0).endCell())));
assert.throws(() => readPerpsPosition(position(coins([6n, 1n, 2n, 3n]).storeRef(Cell.EMPTY).endCell())));
const c = (reserved: bigint, remainingEntitlement: bigint, pendingFunding = 0n): CounterpartyCapital =>
  ({ reserved, remainingEntitlement, pendingFunding, collectedLoss: 0n });
assert.equal(initialCounterpartyReserve(10n), 20n);
assert.equal(counterpartyShouldLiquidate(c(20n, 10n), 9n, 2n), false, 'Entitlement has no extra physical-reserve floor');
assert.equal(counterpartyShouldLiquidate(c(20n, 10n), 10n, 2n), true, 'An exhausted entitlement retires even surplus physical cash');
assert.equal(counterpartyShouldLiquidate(c(20n, 10n), 9n, 11n), true, 'The independent physical floor still retires risk');
const gap = counterpartyClose(c(20n, 10n), 1000n, 1n, 1n, 10n, 0n, 1n);
assert.equal(gap.profit, 9n, 'Cap gross positive benefit at N before opposite unpaid debt');
assert.equal(gap.state.remainingEntitlement, 0n);
assert.equal(gap.released, 11n);
const partial = counterpartyClose(c(20n, 10n, 1n), 6n, 1n, 3n, 10n, 0n, 0n);
assert.deepEqual(partial, { state: c(13n, 6n), forced: false, closed: 1n, pnl: 2n, profit: 3n, debit: 0n, unpaid: 0n, released: 4n });
const next = counterpartyClose(partial.state, 1000n, 2n, 2n, 10n, 0n, 0n);
assert.equal(next.profit, 6n, 'A surviving quantity cannot regain the retired closed entitlement');
const negative = counterpartyClose(c(20n, 10n, 4n), -1n, 1n, 3n, 10n, 0n, 0n);
assert.equal(negative.pnl, -1n, 'Signed TVM division floors a fractional loss');
assert.equal(negative.profit, 3n, 'Positive funding consumes its gross budget before offsetting a price loss');
assert.equal(negative.state.remainingEntitlement, 4n);
let vectors = 0;
for (let reserve = 1n; reserve <= 25n; reserve++) for (let entitlement = 0n; entitlement <= reserve; entitlement++) {
  for (const pnl of [-31n, -1n, 0n, 1n, 31n]) for (const pending of [0n, entitlement / 2n]) {
    const capital = c(reserve, entitlement, pending);
    const plan = counterpartyClose(capital, pnl, 1n, 3n, 5n, 1n, 0n);
    assert.equal(plan.state.reserved + plan.profit + plan.released, reserve);
    assert(plan.profit <= entitlement);
    assert(plan.state.remainingEntitlement <= entitlement);
    assert(plan.debit <= 5n);
    assert.equal(plan.state.collectedLoss, plan.debit);
    if (plan.closed < 3n) {
      const funding = pending < reserve ? pending : reserve;
      assert.equal(plan.state.remainingEntitlement,
        entitlement - funding - (entitlement - funding) * plan.closed / 3n);
    } else assert.equal(plan.state.remainingEntitlement, 0n);
    vectors++;
  }
}
console.log(`PASS strict four-coin current ABI, independent reserve/entitlement rails and ${vectors} isolated integer close vectors`);

for (const [reserve, funding, entitlement] of [[2n, 0n, 3n], [3n, 3n, 2n], [2n, 3n, 3n]]) {
  assert.throws(() => readPerpsPosition(position(beginCell().storeCoins(reserve).storeCoins(funding)
    .storeCoins(0n).storeCoins(entitlement).endCell())), /Unreachable perps counterparty/);
}
