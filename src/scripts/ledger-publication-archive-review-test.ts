import assert from 'node:assert/strict';
import { LedgerGraphBuilder } from '../ledger/graph';
import { decidePublication, type PublicationInputs } from '../ledger/publication';
import type { PostgresLedgerStore } from '../ledger/store';
import type { WalletIdentityStore } from '../ledger/identities';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';

// Independent reviewer: a decoder catches archive read errors as unavailable
// proof. The input publication rule must still retain its prior authority.
async function main() {
  const owner = `0:${'01'.repeat(32)}`, account = `0:${'02'.repeat(32)}`, hash = Buffer.alloc(32, 3).toString('base64');
  const snapshot = { account, lt: '10', hash, seqno: 80, state: { balance: '0', accountState: 'active', lastTxLt: '10', lastTxHash: hash } };
  let fail = false;
  const store = { rawHistory: async () => [], pool: { query: async (sql: string) => {
    if (sql.includes('SELECT snapshot FROM ledger_account_states')) {
      if (fail) throw Error('temporary database read failure');
      return { rows: [{ snapshot }] };
    }
    return { rows: [{ source_complete: true, head_lt: '10', head_hash: hash }] };
  } } } as unknown as PostgresLedgerStore;
  const identities = {} as WalletIdentityStore;
  const build = () => new LedgerGraphBuilder('testnet', fakeChainSource(), store, [], undefined, identities,
    async () => { throw Error('unexpected dependency'); }).build(owner, 'owner-generation', { boundary: fixtureHead(100) });
  const first = await build();
  assert.deepEqual(await first.stateAt(account, '10', hash), snapshot);
  const previous: PublicationInputs = { accounts: [{ account: owner, headLt: '10', headHash: hash }], bindings: structuredClone(first.bindings) };
  fail = true;
  const next = await build();
  await next.stateAt(account, '10', hash).catch(() => null); // existing product decoders do this
  assert.equal(decidePublication(previous, { accounts: previous.accounts, bindings: next.bindings }).publish, false,
    'a previously resolved immutable archive cannot disappear from a newly published projection on a caught DB read failure');
  fail = false;
  assert.deepEqual(await next.stateAt(account, '10', hash), snapshot);
  assert.equal(decidePublication(previous, { accounts: previous.accounts, bindings: next.bindings }).publish, false,
    'a later successful reread cannot erase an earlier caught proof failure in the same projection');
  const recovered = await build();
  assert.deepEqual(await recovered.stateAt(account, '10', hash), snapshot);
  assert.equal(decidePublication(previous, { accounts: previous.accounts, bindings: recovered.bindings }).publish, true,
    'a fresh cycle can publish after all historical inputs recover');
  console.log('review: archive failure retains publication authority, remains sticky per cycle, and recovers next cycle');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
