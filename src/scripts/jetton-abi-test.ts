import assert from 'node:assert/strict';
import {
  Address,
  Cell,
  TupleItem,
  beginCell,
  contractAddress,
  loadStateInit
} from '@ton/core';
import { loadConfig } from '../config';
import {
  buildTonswapJettonWalletInitialData,
  parseCanonicalJettonRootData,
  parseCanonicalJettonWalletAddress,
  parseCanonicalJettonWalletData,
  readCanonicalJettonBalance
} from '../data/jettonAbi';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';

const owner = Address.parse(`0:${'1'.repeat(64)}`);
const root = Address.parse(`0:${'2'.repeat(64)}`);
const wallet = Address.parse(`0:${'3'.repeat(64)}`);
const wrongOwner = Address.parse(`0:${'4'.repeat(64)}`);
const wrongRoot = Address.parse(`0:${'5'.repeat(64)}`);
const admin = Address.parse(`0:${'6'.repeat(64)}`);
const walletCode = beginCell().storeUint(0x74, 8).endCell();
const wrongCode = beginCell().storeUint(0x75, 8).endCell();
const content = beginCell().storeUint(0, 8).endCell();
const EXPECTED_INITIAL_DATA_HASH =
  'db838c715172ef794539a28db01ec0151ad53daf099f6d5fe4193522b24d2f9e';
const EXPECTED_INITIAL_WALLET_ADDRESS =
  '0:ad4304430e859464b8abfd3941f775e3732d275c655caa0da8f3e4059762b8f2';

const addressItem = (address: Address): TupleItem => ({
  type: 'slice',
  cell: beginCell().storeAddress(address).endCell()
});

const rootStack = (): TupleItem[] => [
  { type: 'int', value: 1_000n },
  { type: 'int', value: -1n },
  addressItem(admin),
  { type: 'cell', cell: content },
  { type: 'cell', cell: walletCode }
];

const walletAddressStack = (): TupleItem[] => [addressItem(wallet)];

const walletStack = (
  overrides: {
    balance?: bigint;
    owner?: Address;
    root?: Address;
    code?: Cell;
  } = {}
): TupleItem[] => [
  { type: 'int', value: overrides.balance ?? 77n },
  addressItem(overrides.owner ?? owner),
  addressItem(overrides.root ?? root),
  { type: 'cell', cell: overrides.code ?? walletCode }
];

type GetterName = 'get_jetton_data' | 'get_wallet_address' | 'get_wallet_data';

const runBalanceRead = async (overrides: {
  result?: Partial<Record<GetterName, { exitCode: number; stack: TupleItem[] } | null>>;
  accountCode?: Cell | null;
  calls?: string[];
} = {}) => {
  const calls = overrides.calls ?? [];
  const defaults: Record<GetterName, { exitCode: number; stack: TupleItem[] }> = {
    get_jetton_data: { exitCode: 0, stack: rootStack() },
    get_wallet_address: { exitCode: 0, stack: walletAddressStack() },
    get_wallet_data: { exitCode: 0, stack: walletStack() }
  };
  return readCanonicalJettonBalance({
    owner: owner.toRawString(),
    master: root.toRawString(),
    runGetMethod: async (_address, method) => {
      calls.push(method);
      return Object.prototype.hasOwnProperty.call(overrides.result ?? {}, method)
        ? overrides.result?.[method] ?? null
        : defaults[method];
    },
    readAccountCode: async () =>
      overrides.accountCode === undefined ? walletCode : overrides.accountCode
  });
};

const legacyWalletInitialData = () =>
  beginCell()
    .storeCoins(0n)
    .storeAddress(owner)
    .storeAddress(root)
    .storeCoins(0n)
    .storeCoins(0n)
    .storeAddress(null)
    .storeUint(0, 32)
    .storeUint(0n, 64)
    .storeCoins(0n)
    .endCell();

const assertCanonicalInitialWalletLayout = () => {
  const data = buildTonswapJettonWalletInitialData(owner, root);
  assert.equal(data.hash().toString('hex'), EXPECTED_INITIAL_DATA_HASH);
  assert.equal(
    contractAddress(0, { code: walletCode, data }).toRawString(),
    EXPECTED_INITIAL_WALLET_ADDRESS
  );

  const storage = data.beginParse();
  assert.equal(storage.loadUint(32), 0x4a545731);
  assert.equal(storage.remainingBits, 0);
  assert.equal(storage.remainingRefs, 3);
  const identity = storage.loadRef().beginParse();
  const accounting = storage.loadRef().beginParse();
  const journals = storage.loadRef().beginParse();
  assert.equal(identity.loadInt(8), owner.workChain);
  assert.equal(identity.loadUintBig(256), BigInt(`0x${owner.hash.toString('hex')}`));
  assert.equal(identity.loadInt(8), root.workChain);
  assert.equal(identity.loadUintBig(256), BigInt(`0x${root.hash.toString('hex')}`));
  assert.equal(identity.loadBoolean(), false);
  assert.equal(identity.loadInt(8), 0);
  assert.equal(identity.loadUintBig(256), 0n);
  assert.equal(identity.remainingBits, 0);
  assert.equal(identity.remainingRefs, 0);
  assert.equal(accounting.loadCoins(), 0n);
  assert.equal(accounting.loadCoins(), 0n);
  assert.equal(accounting.loadCoins(), 0n);
  assert.equal(accounting.loadUint(32), 0);
  assert.equal(accounting.loadUintBig(64), 0n);
  assert.equal(accounting.loadCoins(), 0n);
  assert.equal(accounting.remainingBits, 0);
  assert.equal(accounting.remainingRefs, 0);

  const burnJournal = journals.loadRef().beginParse();
  assert.equal(burnJournal.loadUint(8), 0);
  assert.equal(burnJournal.loadUintBig(64), 0n);
  assert.equal(burnJournal.loadCoins(), 0n);
  assert.equal(burnJournal.loadUintBig(256), 0n);
  assert.equal(burnJournal.loadMaybeAddress(), null);
  assert.equal(burnJournal.remainingBits, 0);
  assert.equal(burnJournal.remainingRefs, 0);

  const mintJournal = journals.loadRef().beginParse();
  assert.equal(mintJournal.loadUint(8), 0);
  assert.equal(mintJournal.loadUintBig(64), 0n);
  assert.equal(mintJournal.loadUintBig(64), 0n);
  assert.equal(mintJournal.loadCoins(), 0n);
  assert.equal(mintJournal.loadUintBig(256), 0n);
  assert.equal(mintJournal.remainingBits, 0);
  assert.equal(mintJournal.remainingRefs, 0);
  assert.equal(journals.loadBit(), false, "Initial permanent mint receipt map must be empty.");
  assert.equal(journals.loadBit(), false, "Initial referral notification map must be empty.");
  assert.equal(journals.remainingBits, 0);
  assert.equal(journals.remainingRefs, 0);

  const legacyData = legacyWalletInitialData();
  assert.notEqual(legacyData.hash().toString('hex'), EXPECTED_INITIAL_DATA_HASH);
  assert.notEqual(
    contractAddress(0, { code: walletCode, data: legacyData }).toRawString(),
    EXPECTED_INITIAL_WALLET_ADDRESS
  );
};

const transferPayloadSource = (
  getterWallet: Address,
  accountStateCalls: string[]
): TonDataSource => ({
  network: 'testnet',
  async getMasterchainInfo() {
    return { seqno: 0 };
  },
  async getAccountState(address) {
    accountStateCalls.push(address);
    return { balance: '0', accountState: 'uninitialized' };
  },
  async getTransactions() {
    return [];
  },
  async runGetMethod(address, method) {
    if (address !== root.toRawString()) return null;
    if (method === 'get_wallet_address') {
      return { exitCode: 0, stack: [addressItem(getterWallet)] };
    }
    if (method === 'get_jetton_data') {
      return { exitCode: 0, stack: rootStack() };
    }
    return null;
  },
  async getJettonBalance() {
    return null;
  },
  async getJettonMetadata() {
    return null;
  },
  async close() {
    return;
  }
});

const assertTransferPayloadUsesExactWalletLayout = async () => {
  const config = loadConfig();
  const canonicalData = buildTonswapJettonWalletInitialData(owner, root);
  const canonicalWallet = contractAddress(0, {
    code: walletCode,
    data: canonicalData
  });
  const accountStateCalls: string[] = [];
  const service = new IndexerService(
    config,
    new MemoryStore(config),
    transferPayloadSource(canonicalWallet, accountStateCalls),
    loadOpcodes(undefined),
    []
  );

  const payload = await service.getJettonTransferPayload(
    root.toRawString(),
    owner.toRawString()
  );
  assert.equal(accountStateCalls.length, 1);
  assert.equal(accountStateCalls[0], canonicalWallet.toRawString());
  assert.ok(payload.state_init);

  const stateCell = Cell.fromBoc(Buffer.from(payload.state_init, 'base64'));
  assert.equal(stateCell.length, 1);
  const stateInit = loadStateInit(stateCell[0].beginParse());
  assert.ok(stateInit.code?.hash().equals(walletCode.hash()));
  assert.ok(stateInit.data?.hash().equals(canonicalData.hash()));

  const legacyWallet = contractAddress(0, {
    code: walletCode,
    data: legacyWalletInitialData()
  });
  const legacyAccountStateCalls: string[] = [];
  const legacyService = new IndexerService(
    config,
    new MemoryStore(config),
    transferPayloadSource(legacyWallet, legacyAccountStateCalls),
    loadOpcodes(undefined),
    []
  );
  const rejected = await legacyService.getJettonTransferPayload(
    root.toRawString(),
    owner.toRawString()
  );
  assert.deepEqual(rejected, { custom_payload: null, state_init: null });
  assert.deepEqual(legacyAccountStateCalls, []);
};

const main = async () => {
  assertCanonicalInitialWalletLayout();
  await assertTransferPayloadUsesExactWalletLayout();

  const canonical = await runBalanceRead();
  assert.ok(canonical);
  assert.equal(canonical.balance, '77');
  assert.equal(Address.parse(canonical.wallet).toRawString(), wallet.toRawString());

  const legacyAddressCalls: string[] = [];
  const legacyAddressOnlyResults: Record<string, { exitCode: number; stack: TupleItem[] }> = {
    get_jetton_data: { exitCode: 0, stack: rootStack() },
    wallet_address: { exitCode: 0, stack: walletAddressStack() },
    wallet_data: { exitCode: 0, stack: walletStack() }
  };
  const legacyAddressOnly = await readCanonicalJettonBalance({
    owner: owner.toRawString(),
    master: root.toRawString(),
    runGetMethod: async (_address, method) => {
      legacyAddressCalls.push(method);
      return legacyAddressOnlyResults[method] ?? null;
    },
    readAccountCode: async () => walletCode
  });
  assert.equal(legacyAddressOnly, null);
  assert.deepEqual(legacyAddressCalls, ['get_jetton_data', 'get_wallet_address']);
  assert.ok(legacyAddressOnlyResults.wallet_address);
  assert.ok(legacyAddressOnlyResults.wallet_data);

  const legacyWalletCalls: string[] = [];
  const legacyWalletOnlyResults: Record<string, { exitCode: number; stack: TupleItem[] }> = {
    get_jetton_data: { exitCode: 0, stack: rootStack() },
    get_wallet_address: { exitCode: 0, stack: walletAddressStack() },
    wallet_data: { exitCode: 0, stack: walletStack() }
  };
  const legacyWalletOnly = await readCanonicalJettonBalance({
    owner: owner.toRawString(),
    master: root.toRawString(),
    runGetMethod: async (_address, method) => {
      legacyWalletCalls.push(method);
      return legacyWalletOnlyResults[method] ?? null;
    },
    readAccountCode: async () => walletCode
  });
  assert.equal(legacyWalletOnly, null);
  assert.deepEqual(legacyWalletCalls, [
    'get_jetton_data',
    'get_wallet_address',
    'get_wallet_data'
  ]);
  assert.ok(legacyWalletOnlyResults.wallet_data);

  for (const invalidRoot of [
    rootStack().slice(0, 4),
    [...rootStack(), { type: 'int', value: 0n } as TupleItem],
    [{ type: 'int', value: -1n } as TupleItem, ...rootStack().slice(1)],
    [rootStack()[0], { type: 'int', value: 1n } as TupleItem, ...rootStack().slice(2)]
  ]) {
    assert.equal(parseCanonicalJettonRootData(invalidRoot), null);
    assert.equal(
      await runBalanceRead({ result: { get_jetton_data: { exitCode: 0, stack: invalidRoot } } }),
      null
    );
  }

  for (const invalidAddress of [
    [] as TupleItem[],
    [...walletAddressStack(), addressItem(owner)]
  ]) {
    assert.equal(parseCanonicalJettonWalletAddress(invalidAddress), null);
    assert.equal(
      await runBalanceRead({ result: { get_wallet_address: { exitCode: 0, stack: invalidAddress } } }),
      null
    );
  }

  for (const invalidWallet of [
    walletStack().slice(0, 3),
    [...walletStack(), { type: 'int', value: 0n } as TupleItem]
  ]) {
    assert.equal(
      parseCanonicalJettonWalletData(invalidWallet, { owner, root, walletCode }),
      null
    );
    assert.equal(
      await runBalanceRead({ result: { get_wallet_data: { exitCode: 0, stack: invalidWallet } } }),
      null
    );
  }

  for (const invalidWallet of [
    walletStack({ owner: wrongOwner }),
    walletStack({ root: wrongRoot }),
    walletStack({ code: wrongCode }),
    walletStack({ balance: -1n })
  ]) {
    assert.equal(
      parseCanonicalJettonWalletData(invalidWallet, { owner, root, walletCode }),
      null
    );
    assert.equal(
      await runBalanceRead({ result: { get_wallet_data: { exitCode: 0, stack: invalidWallet } } }),
      null
    );
  }

  assert.equal(await runBalanceRead({ accountCode: wrongCode }), null);
  assert.equal(await runBalanceRead({ accountCode: null }), null);

  console.log('jetton canonical ABI adversarial tests passed');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
