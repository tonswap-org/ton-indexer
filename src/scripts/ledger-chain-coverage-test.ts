import assert from 'node:assert/strict';
import type { RawTransaction } from '../data/dataSource';
import { chainAtBoundary, chainCoversTransaction, type LedgerChain } from '../ledger/project';

const transaction = (utime = 10): RawTransaction => ({ lt: '1', hash: '1'.repeat(64), utime, success: true, outMessages: [] });
const chain = (historyComplete: boolean, atBoundary?: boolean): LedgerChain => ({
  account: `0:${'1'.repeat(64)}`, role: 'owner', generation: null, historyComplete, ...(atBoundary === undefined ? {} : { atBoundary }), transactions: []
});
for (const complete of [false, true]) for (const boundary of [false, true]) {
  assert.equal(chainCoversTransaction(chain(complete, boundary), transaction()), complete, 'Positive linked evidence does not depend on refresh success');
  assert.equal(chainAtBoundary(chain(complete, boundary)), complete && boundary, 'Absence needs complete history at the boundary');
}
assert.equal(chainCoversTransaction(undefined, transaction()), false); assert.equal(chainAtBoundary(undefined), false);
assert.equal(chainCoversTransaction(chain(true), transaction()), true); assert.equal(chainAtBoundary(chain(true)), true);
assert.equal(chainCoversTransaction(chain(false), transaction()), false); assert.equal(chainAtBoundary(chain(false)), false);
const range = { ...chain(false, true), verifiedRange: { fromUtime: 10, toUtime: 20 } };
for (const [utime, covered] of [[9, false], [10, true], [19, true], [20, false]] as const) assert.equal(chainCoversTransaction(range, transaction(utime)), covered);
assert.equal(chainAtBoundary(range), false);
assert.equal(chainAtBoundary({ ...range, historyComplete: true }), false, 'A bounded-range producer cannot grant all-history absence evidence');
console.log('ledger positive coverage and boundary coverage ok');
