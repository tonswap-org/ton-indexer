import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { BackfillWorker } from '../workers/backfillWorker';
import { MetricsCollector } from '../metricsCollector';
import { MetricsService } from '../metrics';
import { IndexerService } from '../indexerService';
import { loadOpcodes } from '../utils/opcodes';
import { createLogger } from '../utils/logger';
import { TonDataSource } from '../data/dataSource';

const config = {
  ...loadConfig(),
  responseCacheEnabled: true,
  metricsCacheTtlMs: 10_000,
};

const store = new MemoryStore({ ...config, maxAddresses: 10 });
const opcodes = loadOpcodes(undefined);
const logger = createLogger('fatal');

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

const service = new IndexerService(config, store, dummySource, opcodes, []);
const backfill = new BackfillWorker(config, store, dummySource, opcodes, logger);
const collector = new MetricsCollector();
const metrics = new MetricsService(config, store, backfill, service, collector);

const first = metrics.getMetrics();
collector.recordRequest(50);
const second = metrics.getMetrics();
assert.equal(second.request_stats.count, first.request_stats.count);

console.log('metrics cache ok');
