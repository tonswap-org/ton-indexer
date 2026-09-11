import assert from 'node:assert/strict';
import { Address, beginCell, serializeTuple } from '@ton/core';
import { RawTransaction, TonDataSource } from '../data/dataSource';
import { evaluateTransactionStatus, LiteClientDataSource } from '../data/liteClientSource';
import { ResilientTonDataSource } from '../data/resilientSource';
import {
  createTonClient4CompatibilityAdapter,
  TonClient4DataSource,
  type TonClient4HttpAdapter
} from '../data/tonClient4Source';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';

const opcodes = loadOpcodes(undefined);
const account = Address.parseRaw(`0:${'1'.repeat(64)}`);
const counterparty = Address.parseRaw(`0:${'2'.repeat(64)}`);
const pool = Address.parseRaw(`0:${'3'.repeat(64)}`);
const decoy = Address.parseRaw(`0:${'6'.repeat(64)}`);

const makeRawTransaction = (overrides: Partial<RawTransaction>): RawTransaction => ({
  lt: '1',
  hash: Buffer.alloc(32, 1).toString('base64'),
  utime: 1,
  success: true,
  status: 'success',
  outMessages: [],
  ...overrides,
});

const testDlmmForwardLayout = () => {
  const owner = Address.parseRaw(`0:${'4'.repeat(64)}`);
  const senderWallet = Address.parseRaw(`0:${'5'.repeat(64)}`);
  const forwardPayload = beginCell()
    .storeUint(0x444c4144, 32)
    .storeUint(42n, 64)
    .storeAddress(owner)
    .storeInt(-7, 32)
    .storeUint(123n, 256)
    .endCell();
  const notificationBody = beginCell()
    .storeUint(0x7362d09c, 32)
    .storeUint(9n, 64)
    .storeCoins(555n)
    .storeAddress(owner)
    .storeAddress(senderWallet)
    .storeCoins(0n)
    .storeRef(forwardPayload)
    .endCell()
    .toBoc({ idx: false })
    .toString('base64');

  const indexed = classifyTransaction(
    pool.toRawString(),
    makeRawTransaction({
      inMessage: {
        source: senderWallet.toString(),
        destination: pool.toString(),
        value: '1',
        op: 0x7362d09c,
        body: notificationBody,
      },
    }),
    opcodes
  );

  assert.equal(indexed.kind, 'lp_deposit');
  const action = indexed.actions[0];
  assert.equal(action?.kind, 'lp_deposit');
  if (action?.kind === 'lp_deposit') {
    assert.equal(action.amountA, '555');
    assert.equal(action.binId, -7);
    assert.equal(action.minLpOut, '123');
    assert.ok(action.owner && Address.parse(action.owner).equals(owner));
  }

  const fallbackForwardPayload = beginCell()
    .storeUint(0x444c4144, 32)
    .storeUint(43n, 64)
    .storeAddress(null)
    .storeInt(-8, 32)
    .storeUint(124n, 256)
    .endCell();
  const fallbackNotificationBody = beginCell()
    .storeUint(0x7362d09c, 32)
    .storeUint(10n, 64)
    .storeCoins(556n)
    .storeAddress(owner)
    .storeAddress(senderWallet)
    .storeCoins(0n)
    .storeRef(fallbackForwardPayload)
    .endCell()
    .toBoc({ idx: false })
    .toString('base64');
  const fallbackIndexed = classifyTransaction(
    pool.toRawString(),
    makeRawTransaction({
      inMessage: {
        source: senderWallet.toString(),
        destination: pool.toString(),
        value: '1',
        op: 0x7362d09c,
        body: fallbackNotificationBody,
      },
    }),
    opcodes
  );
  const fallbackAction = fallbackIndexed.actions[0];
  assert.equal(fallbackAction?.kind, 'lp_deposit');
  if (fallbackAction?.kind === 'lp_deposit') {
    assert.ok(fallbackAction.owner && Address.parse(fallbackAction.owner).equals(owner));
  }
};

const testCanonicalTransferDirection = () => {
  const indexed = classifyTransaction(
    account.toRawString(),
    makeRawTransaction({
      inMessage: {
        source: counterparty.toString(),
        destination: account.toString({ urlSafe: true, bounceable: true }),
        value: '10',
      },
    }),
    opcodes
  );
  const action = indexed.actions[0];
  assert.equal(action?.kind, 'transfer');
  if (action?.kind === 'transfer') assert.equal(action.source, 'in');
};

const testUnknownOpWithValueIsContractCall = () => {
  const indexed = classifyTransaction(
    account.toRawString(),
    makeRawTransaction({
      inMessage: {
        source: counterparty.toString(),
        destination: account.toString(),
        value: '10000000',
        op: 0x12345678,
      },
    }),
    opcodes
  );
  assert.equal(indexed.kind, 'contract_call');
  assert.equal(indexed.actions[0]?.kind, 'contract_call');
};

const testDirectActionsUseMatchedMessagePool = () => {
  const directTransaction = (op: number, body: string) =>
    makeRawTransaction({
      inMessage: {
        source: counterparty.toString(),
        destination: account.toString(),
        value: '1',
      },
      outMessages: [
        { source: account.toString(), destination: decoy.toString(), value: '1' },
        { source: account.toString(), destination: pool.toString(), value: '1', op, body },
      ],
    });
  const assertPool = (transaction: RawTransaction, expectedKind: string) => {
    const indexed = classifyTransaction(account.toRawString(), transaction, opcodes);
    assert.equal(indexed.kind, expectedKind);
    const action = indexed.actions[0];
    assert.ok(
      action && 'pool' in action && action.pool && Address.parse(action.pool).equals(pool),
      `${expectedKind} should use the matched message destination as its pool`
    );
  };

  const swapBody = beginCell()
    .storeUint(0x53574150, 32)
    .storeUint(7n, 64)
    .storeUint(1, 8)
    .storeCoins(100n)
    .storeCoins(90n)
    .endCell()
    .toBoc({ idx: false })
    .toString('base64');
  assertPool(directTransaction(0x53574150, swapBody), 'swap');

  const depositBody = beginCell()
    .storeUint(0x44414444, 32)
    .storeInt(-2, 32)
    .storeUint(11n, 128)
    .storeUint(22n, 128)
    .endCell()
    .toBoc({ idx: false })
    .toString('base64');
  assertPool(directTransaction(0x44414444, depositBody), 'lp_deposit');

  const withdrawBody = beginCell()
    .storeUint(0x44524d56, 32)
    .storeUint(7n,64)
    .storeInt(-3, 32)
    .storeUint(44n, 256)
    .storeAddress(account)
    .endCell()
    .toBoc({ idx: false })
    .toString('base64');
  assertPool(directTransaction(0x44524d56, withdrawBody), 'lp_withdraw');
};

const makeSource = (
  getTransactions: TonDataSource['getTransactions']
): TonDataSource => ({
  network: 'testnet',
  async getMasterchainInfo() {
    return { seqno: 1 };
  },
  async getAccountState() {
    return { balance: '0' };
  },
  getTransactions,
  async runGetMethod() {
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
  },
});

const testExplicitCursorFallsBackOnEmptyPrimary = async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const fallbackPage = [makeRawTransaction({ lt: '10' })];
  const primary = makeSource(async () => {
    primaryCalls += 1;
    return [];
  });
  const fallback = makeSource(async () => {
    fallbackCalls += 1;
    return fallbackPage;
  });
  const resilient = new ResilientTonDataSource(primary, fallback);

  const explicitPage = await resilient.getTransactions(
    account.toRawString(),
    20,
    '10',
    Buffer.alloc(32, 10).toString('base64')
  );
  assert.equal(explicitPage, fallbackPage);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);

  const latestPage = await resilient.getTransactions(account.toRawString(), 20);
  assert.deepEqual(latestPage, []);
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 1);
};

const testPartialActiveStateUsesFallbackCells = async () => {
  const readMerged = async (
    primaryCells: { codeBoc: string | null; dataBoc: string | null },
    fallbackCells: { codeBoc: string | null; dataBoc: string | null }
  ) => {
    let fallbackCalls = 0;
    const primary: TonDataSource = {
      ...makeSource(async () => []),
      async getAccountState() {
        return {
          balance: '10',
          lastTxLt: '10',
          accountState: 'active',
          ...primaryCells,
        };
      },
    };
    const fallback: TonDataSource = {
      ...makeSource(async () => []),
      async getAccountState() {
        fallbackCalls += 1;
        return { balance: '9', accountState: 'active', ...fallbackCells };
      },
    };
    const merged = await new ResilientTonDataSource(primary, fallback).getAccountState(account.toRawString());
    assert.equal(fallbackCalls, 1);
    assert.equal(merged.balance, '10');
    assert.equal(merged.lastTxLt, '10');
    return merged;
  };

  const missingData = await readMerged(
    { codeBoc: 'primary-code', dataBoc: null },
    { codeBoc: null, dataBoc: 'fallback-data' }
  );
  assert.equal(missingData.codeBoc, 'primary-code');
  assert.equal(missingData.dataBoc, 'fallback-data');

  const missingCode = await readMerged(
    { codeBoc: null, dataBoc: 'primary-data' },
    { codeBoc: 'fallback-code', dataBoc: null }
  );
  assert.equal(missingCode.codeBoc, 'fallback-code');
  assert.equal(missingCode.dataBoc, 'primary-data');
};

const testTonClient4HashRoundTrip = async () => {
  const cursorBytes = Buffer.alloc(32, 0x11);
  const transactionBytes = Buffer.alloc(32, 0x22);
  const predecessorBytes = Buffer.alloc(32, 0x33);
  const requestedHashes: Buffer[] = [];
  const fakeClient = {
    async getAccountTransactionsParsed(_address: Address, _lt: bigint, hash: Buffer) {
      requestedHashes.push(Buffer.from(hash));
      return {
        transactions: [
          {
            lt: '100',
            hash: transactionBytes.toString('base64'),
            prevTransaction: { lt: '99', hash: predecessorBytes.toString('hex') },
            time: 1,
            parsed: { status: 'success' },
            fees: '9007199254740993123',
            inMessage: null,
            outMessages: [{body:beginCell().endCell().toBoc().toString('base64'),info:{type:'internal',src:account.toRawString(),dest:account.toRawString(),value:'9007199254740993125',createdLt:'9007199254740993126',bounced:false,fwdFee:'9007199254740993127',ihrFee:'0'}}],
          },
        ],
      };
    },
  };
  type TestConstructor = new (
    network: 'testnet',
    client: typeof fakeClient,
    endpoints: string[]
  ) => TonClient4DataSource;
  const TestableTonClient4DataSource = TonClient4DataSource as unknown as TestConstructor;
  const source = new TestableTonClient4DataSource('testnet', fakeClient, ['test']);

  const page = await source.getTransactions(account.toRawString(), 1, '100', cursorBytes.toString('hex'));
  assert.ok(requestedHashes[0]?.equals(cursorBytes));
  assert.equal(page[0]?.hash, transactionBytes.toString('base64'));
  assert.equal(page[0]?.prevTransactionHash, predecessorBytes.toString('base64'));
  assert.equal(page[0]?.totalFeesRaw, '9007199254740993123');
  assert.equal(page[0]?.outMessages[0]?.createdLt,'9007199254740993126');
  assert.equal(page[0]?.outMessages[0]?.forwardFeeRaw,'9007199254740993127');
  assert.equal(page[0]?.outMessages[0]?.ihrFeeRaw,'0');
  assert.equal(page[0]?.outMessages[0]?.bounced,false);

  await source.getTransactions(
    account.toRawString(),
    1,
    page[0]?.prevTransactionLt,
    page[0]?.prevTransactionHash
  );
  assert.ok(requestedHashes[1]?.equals(predecessorBytes));
};

const testTonClient4StorageStatCompatibility = async () => {
  const fixture = {
    account: {
      state: { type: 'uninit' },
      balance: { coins: '123' },
      last: null,
      storageStat: {
        lastPaid: 1,
        duePayment: null,
        used: { bits: 2, cells: 3 }
      }
    },
    block: {
      workchain: 0,
      shard: '0',
      seqno: 1,
      rootHash: Buffer.alloc(32).toString('base64'),
      fileHash: Buffer.alloc(32).toString('base64')
    }
  };
  const fixtureAdapter: TonClient4HttpAdapter = async (config) => ({
    data: JSON.stringify(fixture),
    status: 200,
    statusText: 'OK',
    headers: {},
    config
  });
  type TestClient = {
    getAccount(seqno: number, address: Address): Promise<any>;
  };
  type TestClientConstructor = new (args: {
    endpoint: string;
    httpAdapter: TonClient4HttpAdapter;
  }) => TestClient;
  const InstalledTonClient4 = require('ton').TonClient4 as TestClientConstructor;

  const incompatibleClient = new InstalledTonClient4({
    endpoint: 'https://fixture.invalid',
    httpAdapter: fixtureAdapter
  });
  await assert.rejects(incompatibleClient.getAccount(1, account), /Mailformed response/);

  const compatibleClient = new InstalledTonClient4({
    endpoint: 'https://fixture.invalid',
    httpAdapter: createTonClient4CompatibilityAdapter(fixtureAdapter)
  });
  const response = await compatibleClient.getAccount(1, account);
  assert.deepEqual(response.account.storageStat.used, {
    bits: 2,
    cells: 3,
    publicCells: 0
  });
};

const testFinalizedStorageStatus = () => {
  assert.deepEqual(evaluateTransactionStatus({ description: { type: 'storage' } }), {
    status: 'success',
    success: true,
  });
  assert.deepEqual(evaluateTransactionStatus({ description: { type: 'split-install', installed: false } }), {
    status: 'failed',
    reason: 'Split installation failed.',
    success: false,
  });
};

const testSccpBurnGetterUsesHistoricalTarget = async () => {
  const block = (seqno: number, byte: number) => ({
    seqno,
    workchain: -1,
    shard: '-9223372036854775808',
    rootHash: Buffer.alloc(32, byte),
    fileHash: Buffer.alloc(32, byte + 1),
  });
  const trusted = block(10, 0x10);
  const target = block(20, 0x20);
  const latest = block(30, 0x30);
  const tupleBoc = (items: Parameters<typeof serializeTuple>[0]) =>
    serializeTuple(items).toBoc({ idx: false, crc32: false }).toString('base64');
  const runCase = async (getterResult: string, present: boolean) => {
    const getterBlocks: typeof target[] = [];
    let latestHeadCalls = 0;
    let accountStateCalls = 0;
    const fakeClient = {
      async lookupBlockByID(request: { seqno: number }) {
        return { id: request.seqno === trusted.seqno ? trusted : target };
      },
      async getMasterchainInfo() {
        latestHeadCalls += 1;
        return { last: latest };
      },
      async runMethod(
        _address: Address,
        _method: string,
        _params: Buffer,
        requestedBlock: typeof target
      ) {
        getterBlocks.push(requestedBlock);
        return {
          exitCode: 0,
          result: getterResult,
          block: requestedBlock,
          shardBlock: requestedBlock,
        };
      },
      async getAccountStateRaw() {
        accountStateCalls += 1;
        // Stop after the getter assertion point without constructing full SCCP proofs.
        return { block: latest };
      },
    };
    type TestConstructor = new (
      network: 'testnet',
      client: typeof fakeClient
    ) => LiteClientDataSource;
    const TestableLiteClientDataSource = LiteClientDataSource as unknown as TestConstructor;
    const source = new TestableLiteClientDataSource('testnet', fakeClient);
    const proofPromise = source.getTonSccpBurnProofMaterial({
      jettonMaster: account.toRawString(),
      messageIdHex: `0x${'ab'.repeat(32)}`,
      trustedCheckpointSeqno: trusted.seqno,
      trustedCheckpointHashHex: `0x${trusted.rootHash.toString('hex')}`,
      targetSeqno: target.seqno,
    });

    await assert.rejects(
      proofPromise,
      present ? /SCCP account-state masterchain block/ : /Burn record is not available/
    );
    assert.equal(latestHeadCalls, 0);
    assert.equal(getterBlocks.length, 1);
    assert.equal(getterBlocks[0], target);
    assert.equal(accountStateCalls, present ? 1 : 0);
  };

  await runCase(tupleBoc([{ type: 'cell', cell: beginCell().storeUint(1, 1).endCell() }]), true);
  await runCase(tupleBoc([{ type: 'null' }]), false);
  await runCase(tupleBoc([]), false);
  await runCase(tupleBoc([{ type: 'int', value: 1n }]), false);
};

const run = async () => {
  testDlmmForwardLayout();
  testCanonicalTransferDirection();
  testUnknownOpWithValueIsContractCall();
  testDirectActionsUseMatchedMessagePool();
  await testExplicitCursorFallsBackOnEmptyPrimary();
  await testPartialActiveStateUsesFallbackCells();
  await testTonClient4HashRoundTrip();
  await testTonClient4StorageStatCompatibility();
  testFinalizedStorageStatus();
  await testSccpBurnGetterUsesHistoricalTarget();
};

run()
  .then(() => console.log('dataflow regressions ok'))
  .catch((error) => {
    console.error('dataflow regression test failed', error);
    process.exit(1);
  });
