import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { currentOrderWalletAbsent, type CurrentOrderWalletAbsence } from '../ledger/currentDlmmOrderAbsence';
// Synthetic transport capability tests only. The source's authenticated shard
// absence is independently covered by lite-proof-test; native scenarios below
// supply original empty accounts and never substitute missing history.
const address = new Address(0, Buffer.alloc(32, 7)).toRawString();
const boundary = { workchain: -1, shard: '-9223372036854775808', seqno: 123, utime: 456, rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) };
const good: CurrentOrderWalletAbsence = { address, boundary, state: { sourceMasterchain: { ...boundary }, provenAbsent: true,
  anchor: { shardBlock: { ...boundary, workchain: 0, seqno: 12 }, genUtime: 450 }, accountState: 'uninitialized', balance: '0', codeBoc: null, dataBoc: null } };
assert(currentOrderWalletAbsent(good, address));
for (const patch of [
  { provenAbsent: undefined }, { sourceMasterchain: undefined }, { anchor: undefined }, { balance: '1' },
  { codeBoc: undefined }, { dataBoc: undefined }, { codeBoc: 'AA==' }, { shardAccountBoc: 'AA==' },
  { accountState: 'frozen' }, { lastTxLt: '0' }, { lastTxHash: '0'.repeat(64) },
  { sourceMasterchain: { ...boundary, rootHashHex: 'c'.repeat(64) } },
  { sourceMasterchain: { ...boundary, fileHashHex: 'c'.repeat(64) } },
  { sourceMasterchain: { ...boundary, seqno: 124 } },
  { sourceMasterchain: { ...boundary, utime: 457 } },
  { anchor: { ...good.state.anchor!, genUtime: 457 } },
]) assert(!currentOrderWalletAbsent({ ...good, state: { ...good.state, ...patch } } as CurrentOrderWalletAbsence, address), JSON.stringify(patch));
assert(!currentOrderWalletAbsent(good, new Address(0, Buffer.alloc(32, 8)).toRawString()));
assert(!currentOrderWalletAbsent({ ...good, boundary: { ...boundary, seqno: 0 } }, address));
console.log('Current Order zero-custody closure: exact authenticated current absence admission and 18 negative context/state cases passed.');
