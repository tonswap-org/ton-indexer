import assert from 'node:assert/strict';
import { Address, beginCell, convertToMerkleProof, type Cell, type TupleItem } from '@ton/core';
import { createJettonWalletReader } from '../data/jettonWallet';
import { ChainReadError, type AccountStateResponse, type ReadOptions } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';

const raw = (digit: number) => `0:${digit.toString(16).repeat(64)}`;
const owner = Address.parse(raw(1));
const roots = [2, 3, 4, 5, 6].map(raw), addresses = [7, 8, 9, 10, 11].map(raw);
// Three current implementations have distinct root and wallet code identities.
const codes = [1, 2, 3].map(value => beginCell().storeUint(value, 8).endCell());
const masters = [11, 12, 13].map(value => beginCell().storeUint(value, 8).endCell());
const tokens = roots.map((master, index) => ({ master, masterCodeHash: masters[index % 3].hash().toString('hex'),
  walletCodeHash: codes[index % 3].hash().toString('hex') }));
const boc = (cell: Cell) => cell.toBoc().toString('base64');
const addr = (address: string): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(Address.parse(address)).endCell() });
const rootStack = (code: Cell): TupleItem[] => [{ type: 'int', value: 100n }, { type: 'int', value: -1n },
  { type: 'null' }, { type: 'cell', cell: beginCell().storeUint(0, 8).storeBit(false).endCell() }, { type: 'cell', cell: code }];
let head = fixtureHead(100, 1_700_000_000);
let batchCount = 0, getters: string[] = [], timeout = true, mismatch = false, rootMismatch = false;
let rootFailure = true, ownerFailure = false, wrongOwner = false, wrongRoot = false, wrongGetterCode = false;
const checked = (options?: ReadOptions) => assert.deepEqual(options?.at, head, 'every account and getter read uses the selected head');
const state = async (address: string, options?: ReadOptions): Promise<AccountStateResponse> => {
  checked(options);
  if (address === owner.toRawString()) {
    if (ownerFailure) throw new ChainReadError('upstream_unavailable');
    return { accountState: 'uninitialized', balance: '123456' };
  }
  const root = roots.indexOf(address);
  if (root >= 0) return { accountState: 'active', balance: '0', codeBoc: boc(rootMismatch ? codes[0] : masters[root % 3]) };
  const index = addresses.indexOf(address);
  assert(index >= 0, `Unexpected account ${address}`);
  if (index === 1) return { accountState: 'uninitialized', balance: '0' };
  if (index === 2 && timeout) throw new ChainReadError('upstream_timeout');
  return { balance: '100', accountState: 'active', codeBoc: boc(mismatch ? masters[0] : codes[index % 3]),
    dataBoc: boc(beginCell().storeUint(0xfeed, 16).endCell()), // Storage layout is intentionally not JTW1.
    lastTxLt: '1000', lastTxHash: '1'.repeat(64) };
};
const source = fakeChainSource({
  head: async () => head,
  getAccountState: state,
  read: async (calls, options) => {
    batchCount++; checked(options);
    return { head, results: await Promise.all(calls.map(async call => {
      assert.equal(call.kind, 'account');
      return { kind: 'account' as const, address: call.address, state: await state(call.address, options) };
    })) };
  },
  runGetMethod: async (address, method, args = [], options) => {
    checked(options); getters.push(`${address}:${method}`);
    if (method === 'get_jetton_data') {
      const index = roots.indexOf(address); assert(index >= 0);
      if (index === 4 && rootFailure) return { exitCode: 9, stack: [] };
      return { exitCode: 0, stack: rootStack(codes[index % 3]) };
    }
    if (method === 'get_wallet_address') {
      const index = roots.indexOf(address); assert(index >= 0);
      assert.equal(args[0].type, 'slice');
      assert.ok(args[0].type === 'slice' && args[0].cell.beginParse().loadAddress().equals(owner));
      return { exitCode: 0, stack: [addr(addresses[index])] };
    }
    assert.equal(method, 'get_wallet_data');
    const index = addresses.indexOf(address); assert(index >= 0);
    return { exitCode: 0, stack: [{ type: 'int', value: BigInt(head.seqno + index) },
      addr(wrongOwner ? raw(15) : owner.toRawString()), addr(wrongRoot ? roots[(index + 1) % roots.length] : roots[index]),
      { type: 'cell', cell: wrongGetterCode ? masters[0] : codes[index % 3] }] };
  },
});

async function main() {
  const reader = createJettonWalletReader({ source, tokens });
  const first = await reader.wallets(roots.slice(0, 3), owner.toRawString());
  assert.deepEqual(first.head, head); assert.equal(first.owner.balance, '123456');
  assert.deepEqual(first.rows.map(row => row.status), ['ok', 'not_deployed', 'unavailable']);
  assert.equal(first.rows[0].status === 'ok' && first.rows[0].balanceRaw, '100');
  assert.equal(first.rows[1].status === 'not_deployed' && first.rows[1].balanceRaw, '0');
  assert.equal(first.rows[2].status === 'unavailable' && first.rows[2].reason, 'timeout');
  timeout = false; getters = []; batchCount = 0; head = fixtureHead(101, 1_700_000_001);
  const next = await reader.wallets(roots.slice(0, 3), owner.toRawString());
  assert.equal(batchCount, 1, 'one owner/wallet batch at the new head');
  assert.equal(getters.filter(name => name.endsWith(':get_jetton_data')).length, 3);
  assert.equal(getters.filter(name => name.endsWith(':get_wallet_address')).length, 3);
  assert.equal(getters.filter(name => name.endsWith(':get_wallet_data')).length, 2);
  assert.deepEqual(next.rows.map(row => row.status), ['ok', 'not_deployed', 'ok']);
  assert.equal(next.rows[0].status === 'ok' && next.rows[0].balanceRaw, '101', 'completed balances are never reused');
  mismatch = true;
  const wrong = await reader.wallet(roots[0], owner.toRawString());
  assert.equal(wrong.status === 'unavailable' && wrong.reason, 'code_mismatch'); mismatch = false;
  rootMismatch = true;
  const changed = await reader.wallet(roots[0], owner.toRawString());
  assert.equal(changed.status === 'unavailable' && changed.reason, 'root_unqualified', 'a previous qualification cannot hide changed master code');
  rootMismatch = false;
  for (const field of ['owner', 'root', 'code']) {
    wrongOwner = field === 'owner'; wrongRoot = field === 'root'; wrongGetterCode = field === 'code';
    assert.equal((await reader.wallet(roots[0], owner.toRawString())).status, 'unavailable', `reject getter ${field} mismatch`);
  }
  wrongOwner = wrongRoot = wrongGetterCode = false;
  getters = [];
  for (let n = 0; n < 2; n++) assert.equal((await reader.wallet(roots[3], owner.toRawString())).status, 'ok');
  assert.equal(getters.filter(name => name.endsWith(':get_wallet_address')).length, 2, 'no completed wallet-address cache');
  assert.equal(getters.filter(name => name.endsWith(':get_jetton_data')).length, 2, 'no completed qualification cache');
  assert.equal((await reader.wallet(raw(14), owner.toRawString())).status, 'unavailable', 'unlisted roots never qualify');
  const denied = await reader.wallet(roots[4], owner.toRawString());
  assert.equal(denied.status === 'unavailable' && denied.reason, 'root_unqualified');
  rootFailure = false;
  assert.equal((await reader.wallet(roots[4], owner.toRawString())).status, 'ok', 'failed qualification is retried');
  ownerFailure = true;
  await assert.rejects(reader.wallets([roots[0]], owner.toRawString()), ChainReadError); ownerFailure = false;
  assert.deepEqual(await reader.metadata(roots[0], { at: head }), {});
  assert.throws(() => createJettonWalletReader({ source, tokens: [tokens[0], tokens[0]] }), /pins/);
  // Current vendor libraries retain the hash of their executable reference;
  // this is an explicit identity, never permission to accept a partial proof.
  const ordinary = codes[0], library = beginCell().storeUint(2, 8).storeBuffer(ordinary.hash()).endCell({ exotic: true });
  codes[0] = library;
  const libraryReader = createJettonWalletReader({ source, tokens: [{ ...tokens[0], walletCodeHash: library.hash().toString('hex') }] });
  assert.equal((await libraryReader.wallet(roots[0], owner.toRawString())).status, 'ok');
  assert.equal((await reader.wallet(roots[0], owner.toRawString())).status, 'unavailable', 'ordinary code pin cannot authorize a different library reference');
  const identity = await libraryReader.identity(roots[0], owner.toRawString()); assert.equal(identity.wallet, addresses[0]);
  assert(identity.walletCode.equals(library));
  codes[0] = convertToMerkleProof(ordinary);
  const partialReader = createJettonWalletReader({ source, tokens: [{ ...tokens[0], walletCodeHash: codes[0].hash().toString('hex') }] });
  assert.equal((await partialReader.wallet(roots[0], owner.toRawString())).status, 'unavailable', 'a declared Merkle hash is not executable code');
  await assert.rejects(partialReader.identity(roots[0], owner.toRawString())); codes[0] = ordinary;
  console.log('Per-token master and wallet qualification, current TEP-74 getters, same-head batches, partial failures and no completed caches passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
