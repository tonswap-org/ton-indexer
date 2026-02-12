import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { DebugService } from '../debugService';
import { BackfillWorker } from '../workers/backfillWorker';
import { createLogger } from '../utils/logger';
import { loadOpcodes } from '../utils/opcodes';
import { TonDataSource } from '../data/dataSource';

const config = loadConfig();
const store = new MemoryStore({ ...config, maxAddresses: 10 });
const logger = createLogger('fatal');
const opcodes = loadOpcodes(undefined);

const dummySource: TonDataSource = {
  network: 'mainnet',
  async getMasterchainInfo() {
    return { seqno: 0 };
  },
  async getAccountState() {
    return { balance: '0' };
  },
  async getTransactions() {
    return [];
  },
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
};

const backfill = new BackfillWorker(config, store, dummySource, opcodes, logger);

store.addTransactions('addr1', [
  {
    address: 'addr1',
    lt: '2',
    hash: 'b',
    utime: 2,
    success: true,
    inMessage: undefined,
    outMessages: [],
    kind: 'transfer',
    actions: [],
    ui: {
      txId: '2:b',
      utime: 2,
      status: 'success',
      txType: 'Transfer',
      outCount: 0,
      detail: { kind: 'transfer' },
      kind: 'transfer',
      actions: [],
    },
  },
]);

const debug = new DebugService(config, store, backfill);
const status = debug.getStatus(10);
assert.equal(status.watchlist_size, 1);
assert.equal(status.entries.length, 1);
assert.equal(status.entries[0]?.address, 'addr1');

console.log('debug service ok');
