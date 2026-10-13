import assert from 'node:assert/strict';
import { Address, beginCell, contractAddress, type Cell, type TupleItem } from '@ton/core';
import { createJettonWalletReader } from '../data/jettonWallet';
import { buildTonswapJettonWalletInitialData } from '../data/jettonAbi';
import { ChainReadError, type AccountStateResponse, type ChainHead, type ReadOptions } from '../data/dataSource';
import { readCurrentJettonWalletStorage, writeCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { fakeChainSource } from './support/fakeChainSource';
import { deriveRuntimeManifestBindings } from '../config/runtimeManifestBindings';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';

const owner = Address.parse(`0:${'1'.repeat(64)}`);
const roots = ['2', '3', '4', '5', '6'].map(digit => Address.parse(`0:${digit.repeat(64)}`));
const walletCode = beginCell().storeUint(0xaabb, 16).endCell();
const rootCode = beginCell().storeUint(0xccdd, 16).endCell();
const foreignCode = beginCell().storeUint(0xeeff, 16).endCell();
const foreignWallet = `0:${'7'.repeat(64)}`;
const boc = (cell: Cell) => cell.toBoc().toString('base64');
const head: ChainHead = { workchain: -1, shard: '-9223372036854775808', seqno: 100,
  rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64), utime: 1_700_000_000 };
const addresses = roots.map(root => contractAddress(0, { code: walletCode, data: buildTonswapJettonWalletInitialData(owner, root) }).toRawString());
const hash = Buffer.alloc(32, 1).toString('base64');
const active = (root: Address): AccountStateResponse => ({ balance: '100', accountState: 'active', codeBoc: boc(walletCode),
  dataBoc: boc(writeCurrentJettonWalletStorage({ ...readCurrentJettonWalletStorage(buildTonswapJettonWalletInitialData(owner, root)), balance: 123n })),
  lastTxLt: '1000', lastTxHash: hash });
const rootStack = (code: Cell): TupleItem[] => [{ type: 'int', value: 100n }, { type: 'int', value: -1n },
  { type: 'null' }, { type: 'cell', cell: beginCell().storeUint(0, 8).storeBit(false).endCell() }, { type: 'cell', cell: code }];
let batchCount = 0, getters: string[] = [], timeout = true, mismatch = false, rootFailure = true, ownerFailure = false;
const checked = (options?: ReadOptions) => { assert.deepEqual(options?.at, head, 'all account and getter reads use one head'); };
const state = async (address: string, options?: ReadOptions): Promise<AccountStateResponse> => {
  checked(options);
  if (address === owner.toRawString()) {
    if (ownerFailure) throw new ChainReadError('upstream_unavailable');
    return { accountState: 'uninitialized', balance: '123456' };
  }
  if (roots.some(root => root.toRawString() === address)) return { accountState: 'active', balance: '0', codeBoc: boc(rootCode) };
  if (address === addresses[0]) return { ...active(roots[0]), codeBoc: boc(mismatch ? foreignCode : walletCode) };
  if (address === addresses[1]) return { accountState: 'uninitialized', balance: '0' };
  if (address === addresses[2] && timeout) throw new ChainReadError('upstream_timeout');
  if (address === foreignWallet) return { ...active(roots[3]), codeBoc: boc(foreignCode) };
  const index = addresses.indexOf(address);
  if (index >= 0) return active(roots[index]);
  throw new Error(`Unexpected account ${address}`);
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
      if (address === roots[4].toRawString() && rootFailure) return { exitCode: 9, stack: [] };
      return { exitCode: 0, stack: rootStack(address === roots[3].toRawString() ? foreignCode : walletCode) };
    }
    if (method === 'get_wallet_address') {
      assert.equal(args[0].type, 'slice');
      assert.ok(args[0].type === 'slice' && args[0].cell.beginParse().loadAddress().equals(owner));
      return { exitCode: 0, stack: [{ type: 'slice', cell: beginCell().storeAddress(Address.parse(foreignWallet)).endCell() }] };
    }
    if (method === 'get_wallet_data') return { exitCode: 0, stack: [{ type: 'int', value: 456n },
      { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
      { type: 'slice', cell: beginCell().storeAddress(roots[3]).endCell() }, { type: 'cell', cell: foreignCode }] };
    throw new Error(`Unexpected getter ${method}`);
  },
});

async function main() {
  const reader = createJettonWalletReader({ source, walletTemplateCodeHash: walletCode.hash().toString('hex') });
  const first = await reader.wallets(roots.slice(0, 3).map(root => root.toRawString()), owner.toRawString());
  assert.deepEqual(first.head, head); assert.equal(first.owner.balance, '123456');
  assert.deepEqual(first.rows.map(row => row.status), ['ok', 'not_deployed', 'unavailable']);
  assert.equal(first.rows[0].status === 'ok' && first.rows[0].balanceRaw, '123');
  assert.equal(first.rows[1].status === 'not_deployed' && first.rows[1].balanceRaw, '0');
  assert.equal(first.rows[2].status === 'unavailable' && first.rows[2].reason, 'timeout');
  timeout = false; getters = []; batchCount = 0;
  const warm = await reader.wallets(roots.slice(0, 3).map(root => root.toRawString()), owner.toRawString());
  assert.equal(batchCount, 1, 'one warm batch includes owner and all qualified wallets');
  assert.deepEqual(getters, [], 'template balance hot path has no getter');
  assert.deepEqual(warm.rows.map(row => row.status), ['ok', 'not_deployed', 'ok']);
  mismatch = true;
  const wrong = await reader.wallet(roots[0].toRawString(), owner.toRawString());
  assert.equal(wrong.status, 'unavailable');
  assert.equal(wrong.status === 'unavailable' && wrong.reason, 'code_mismatch');
  mismatch = false;

  getters = [];
  for (let n = 0; n < 2; n++) {
    const foreign = await reader.wallet(roots[3].toRawString(), owner.toRawString());
    assert.equal(foreign.status === 'ok' && foreign.balanceRaw, '456');
    assert.equal(foreign.wallet, foreignWallet);
  }
  assert.equal(getters.filter(name => name.endsWith(':get_wallet_address')).length, 1, 'foreign address is resolved once');
  assert.equal(getters.filter(name => name.endsWith(':get_wallet_data')).length, 2, 'foreign storage always uses same-head canonical getter');

  const denied = await reader.wallet(roots[4].toRawString(), owner.toRawString());
  assert.equal(denied.status === 'unavailable' && denied.reason, 'root_unqualified');
  rootFailure = false;
  assert.equal((await reader.wallet(roots[4].toRawString(), owner.toRawString())).status, 'ok', 'failed qualification is retried');
  ownerFailure = true;
  await assert.rejects(reader.wallets([roots[0].toRawString()], owner.toRawString()), ChainReadError);
  ownerFailure = false;
  assert.deepEqual(await reader.metadata(roots[0].toRawString(), { at: head }), {});

  const bindings = deriveRuntimeManifestBindings({ network: 'ton:testnet', contracts: {}, templates: { JettonWallet: walletCode.hash().toString('hex') },
    tokens: [{ symbol: 'T3', root: roots[0].toRawString(), decimals: 9 }], spotMarkets: [] } as unknown as RuntimeReleaseManifest);
  assert.equal(bindings.jettonRoots[0].decimals, 9);
  assert.equal(bindings.walletTemplateCodeHash, walletCode.hash().toString('hex'));
  console.log('Jetton wallets: held, undeployed and unavailable stay distinct; same-head template batch, code qualification, foreign roots and retries passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
