import assert from 'node:assert/strict';
import { beginCell, Dictionary, type Cell } from '@ton/core';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { PGlite } from '@electric-sql/pglite';
import { parseJettonMetadata } from '../utils/jettonMetadata';
import { loadOpcodes } from '../utils/opcodes';

const offchainCell = beginCell().storeUint(0x01, 8).storeStringTail('https://example.com/meta.json').endCell();
const offchain = parseJettonMetadata(offchainCell);
assert.equal(offchain.uri, 'https://example.com/meta.json');

const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
const keySymbol = createHash('sha256').update('symbol').digest();
const keyDecimals = createHash('sha256').update('decimals').digest();
const symbolCell = beginCell().storeUint(0, 8).storeStringTail('TST').endCell();
const decimalsCell = beginCell().storeUint(0, 8).storeStringTail('9').endCell();

dict.set(keySymbol, symbolCell);
dict.set(keyDecimals, decimalsCell);

const onchainCell = beginCell().storeUint(0x00, 8).storeDict(dict).endCell();
const onchain = parseJettonMetadata(onchainCell);
assert.equal(onchain.symbol, 'TST');
assert.equal(onchain.decimals, 9);
const metadataValue = (cell: Cell) =>
  beginCell().storeUint(0, 8).storeDict(Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell()).set(keySymbol, cell)).endCell();
assert.deepEqual(parseJettonMetadata(metadataValue(beginCell().storeStringTail('TST').endCell())), {}, 'unprefixed legacy value is not TEP-64');
assert.deepEqual(parseJettonMetadata(metadataValue(beginCell().storeUint(1, 8).storeStringTail('TST').endCell())), {}, 'unknown/chunked format is not guessed');
assert.deepEqual(parseJettonMetadata(metadataValue(beginCell().storeUint(0, 8).storeStringTail('T\0ST').endCell())), {}, 'embedded NUL remains invalid optional text');
assert.equal(parseJettonMetadata(metadataValue(beginCell().storeUint(0, 8).storeStringTail('T').storeRef(beginCell().storeStringTail('3').endCell()).endCell())).symbol, 'T3');
const testPostgresMetadata = async () => {
  const db = new PGlite();
  try {
    await assert.rejects(() => db.query('SELECT $1::jsonb', [JSON.stringify({ symbol: '\0T3' })]), /Unicode escape|converted to text/);
    const parsed = parseJettonMetadata(metadataValue(beginCell().storeUint(0, 8).storeStringTail('T3').endCell()));
    assert.equal(parsed.symbol, 'T3');
    await db.query('SELECT $1::jsonb', [JSON.stringify(parsed)]);
  } finally { await db.close(); }
};

const testUnknownJettonDecimalsAreOmitted = async () => {
  const config = { ...loadConfig(), responseCacheEnabled: false };
  const owner = `0:${'1'.repeat(64)}`;
  const master = `0:${'2'.repeat(64)}`;
  const wallet = `0:${'3'.repeat(64)}`;
  const source = {
    network: 'testnet',
    async getMasterchainInfo() {
      return { seqno: 1 };
    },
    async getAccountState() {
      return { balance: '5' };
    },
    async getTransactions() {
      return [];
    },
    async runGetMethod() {
      return null;
    },
    async getJettonBalance() {
      return { wallet, balance: '7' };
    },
    async getJettonMetadata() {
      return null;
    },
    async close() {
      return;
    },
  };
  const service = new IndexerService(
    config,
    new MemoryStore(config),
    source as any,
    loadOpcodes(undefined),
    [{ master, symbol: 'UNKNOWN' }]
  );
  const balance = await service.getBalance(owner);
  assert.equal(balance.jettons.length, 1);
  assert.equal(Object.hasOwn(balance.jettons[0], 'decimals'), false);

  const balances = await service.getBalances(owner);
  const jetton = balances.assets.find((asset) => asset.kind === 'jetton');
  assert.ok(jetton);
  assert.equal(jetton.balance_raw, '7');
  assert.equal(Object.hasOwn(jetton, 'decimals'), false);
  assert.equal(Object.hasOwn(jetton, 'balance'), false);
};

const testPartialBalancePreservesSourceFreshness = async () => {
  const config = {
    ...loadConfig(),
    responseCacheEnabled: false,
    jettonBalanceTimeoutMs: 5,
  };
  const owner = `0:${'4'.repeat(64)}`;
  const master = `0:${'5'.repeat(64)}`;
  const store = new MemoryStore(config);
  store.setBalance(owner, {
    address: owner,
    balance: '11',
    updatedAt: 1_234_000,
  });
  const source = {
    network: 'testnet',
    async getMasterchainInfo() {
      return { seqno: 1 };
    },
    async getAccountState() {
      throw new Error('cached state should be used');
    },
    async getTransactions() {
      return [];
    },
    async runGetMethod() {
      return null;
    },
    async getJettonBalance() {
      return new Promise<null>(() => undefined);
    },
    async getJettonMetadata() {
      return null;
    },
    async close() {
      return;
    },
  };
  const service = new IndexerService(
    config,
    store,
    source as any,
    loadOpcodes(undefined),
    [{ master, symbol: 'UNKNOWN' }]
  );

  const balance = await service.getBalance(owner);
  assert.equal(balance.ton.balance, '11');
  assert.equal(balance.jettons.length, 0);
  assert.equal(balance.confirmed, false);
  assert.equal(balance.updated_at, 1_234);
};

Promise.all([
  testPostgresMetadata(),
  testUnknownJettonDecimalsAreOmitted(),
  testPartialBalancePreservesSourceFreshness(),
])
  .then(() => console.log('metadata ok'))
  .catch((error) => {
    console.error('metadata test failed', error);
    process.exit(1);
  });
