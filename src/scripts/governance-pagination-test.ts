import assert from 'node:assert/strict';
import { beginCell, type TupleItem } from '@ton/core';
import Fastify from 'fastify';
import { governanceProposalRange } from '../utils/governanceStorage';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { IndexerService } from '../indexerService';
import { registerRoutes } from '../api/routes';
import type { TonDataSource } from '../data/dataSource';
const address = `0:${'1'.repeat(64)}`;
const empty = beginCell().endCell();
function storage(next: bigint) { return beginCell().storeRef(empty).storeUint(0, 320).storeRef(empty)
  .storeCoins(100).storeCoins(200).storeUint(next, 64).storeRef(empty).storeRef(empty).endCell(); }
assert.equal(governanceProposalRange(storage(131n).toBoc().toString('base64'))?.nextProposalId, 131n);
assert.equal(governanceProposalRange(empty.toBoc().toString('base64')), null);
assert.equal(governanceProposalRange('invalid'), null);
const config = { ...loadConfig(), responseCacheEnabled: false, network: 'testnet' as const };
const calls: bigint[] = []; let failingId: bigint | null = null; let malformedState = false;
const source: TonDataSource = { network: 'testnet', async getMasterchainInfo() { return { seqno: 1 }; },
  async getAccountState() { return { balance: '0', dataBoc: (malformedState ? empty : storage(131n)).toBoc().toString('base64') }; },
  async getTransactions() { return []; }, async getJettonBalance() { return null; }, async getJettonMetadata() { return null; }, async close() {},
  async runGetMethod(_address, method, args) {
    if (method !== 'governance_proposal') return null;
    const id = (args?.[0] as { value: bigint }).value; calls.push(id);
    if (id === failingId) return null;
    const stack: TupleItem[] = Array.from({ length: 15 }, (_, index) => index === 12 ? { type: 'null' } : { type: 'int', value: index === 0 ? id : 0n });
    return { exitCode: 0, stack };
  } };
const service = new IndexerService(config, new MemoryStore(config), source, { swap: new Set(), lpDeposit: new Set(), lpWithdraw: new Set(), jettonTransfer: new Set(), jettonNotify: new Set() }, []);
async function main() {
  const first = await service.getGovernanceSnapshot(address, { maxScan: 64 });
  assert.equal(first.proposals.length, 64); assert.equal(first.next_start_id, '65'); assert.equal(first.coverage.scanComplete, false);
  const second = await service.getGovernanceSnapshot(address, { startId: '65', maxScan: 64 });
  assert.equal(second.next_start_id, '129'); assert.ok(second.proposals.some(proposal => proposal.id === '100'));
  const last = await service.getGovernanceSnapshot(address, { startId: '129', maxScan: 64 });
  assert.equal(last.proposals.length, 2); assert.equal(last.next_start_id, null); assert.equal(last.coverage.scanComplete, true);
  assert.ok(calls.every(id => id < 131n));
  failingId = 67n;
  const incomplete = await service.getGovernanceSnapshot(address, { startId: '65', maxScan: 64 });
  assert.equal(incomplete.coverage.pageComplete, false); assert.equal(incomplete.next_start_id, '65');
  assert.ok(incomplete.proposals.some(proposal => proposal.id === '128'), 'A transient hole must not truncate later proposals');
  malformedState = true;
  const unknown = await service.getGovernanceSnapshot(address, { maxScan: 2 });
  assert.equal(unknown.coverage.rangeKnown, false); assert.equal(unknown.coverage.scanComplete, false);
  const app = Fastify(); registerRoutes(app, config, service);
  assert.equal((await app.inject({ url: `/api/indexer/v1/governance/${address}/snapshot?start_id=18446744073709551616` })).statusCode, 400);
  await app.close(); console.log('governance pagination ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
