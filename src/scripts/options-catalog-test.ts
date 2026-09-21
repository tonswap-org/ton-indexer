import assert from 'node:assert/strict';
import { Address, beginCell, type TupleItem } from '@ton/core';
import { IndexerService } from '../indexerService';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import type { TonDataSource } from '../data/dataSource';
const address = `0:${'1'.repeat(64)}`, option = `0:${'2'.repeat(64)}`;
const config = { ...loadConfig(), responseCacheEnabled: false, network: 'testnet' as const };
let ids = [2n, 18_000_000_000_000_000_000n], failure = false, malformed = false;
const requested: bigint[] = [];
const integer = (value: bigint): TupleItem => ({ type: 'int', value });
const source: TonDataSource = { network: 'testnet', async getMasterchainInfo() { return { seqno: 1 }; },
  async getAccountState() { return { balance: '0' }; }, async getTransactions() { return []; },
  async getJettonBalance() { return null; }, async getJettonMetadata() { return null; }, async close() {},
  async runGetMethod(_address, method, args) {
    if (method === 'series_catalog') {
      const after = (args![0] as { value: bigint }).value, limit = Number((args![1] as { value: bigint }).value);
      const remaining = ids.filter(id => id > after), page = remaining.slice(0, limit);
      const node = page.reduce((tail, id) => beginCell().storeUint(id, 64).storeRef(tail).endCell(), beginCell().endCell());
      return { exitCode: 0, stack: [{ type: 'cell', cell: node }, integer(malformed ? after : (page.at(-1) ?? after)), integer(remaining.length > page.length ? 1n : 0n)] };
    }
    if (method === 'governance') return { exitCode: 0, stack: [{ type: 'slice', cell: beginCell().storeAddress(Address.parse(address)).endCell() }] };
    if (method === 'registry_enabled') return { exitCode: 0, stack: [integer(1n)] };
    if (method !== 'series_info') return null;
    const id = (args![0] as { value: bigint }).value; requested.push(id);
    if (failure) return null;
    const stack = Array.from({ length: 18 }, () => integer(0n));
    stack[0] = integer(1n); stack[3] = { type: 'slice', cell: beginCell().storeAddress(Address.parse(option)).endCell() };
    stack[4] = integer(9_999_999_999n); stack[5] = integer(100n); stack[8] = integer(10n);
    return { exitCode: 0, stack };
  } };
const service = new IndexerService(config, new MemoryStore(config), source,
  { swap: new Set(), lpDeposit: new Set(), lpWithdraw: new Set(), jettonTransfer: new Set(), jettonNotify: new Set() }, []);
async function main() {
  const first = await service.getOptionsSnapshot(address, { limit: 1 });
  assert.equal(first.next_after_id, '2'); assert.equal(first.page_complete, true);
  assert.deepEqual(first.series.map(entry => entry.seriesId), ['2']);
  const second = await service.getOptionsSnapshot(address, { afterId: '2', limit: 1 });
  assert.equal(second.next_after_id, null); assert.equal(second.series[0].seriesId, '18000000000000000000');
  assert.equal(second.series[0].remainingNotional, '90'); assert.equal(second.series[0].isActive, true);
  assert.deepEqual(requested, ids, 'Only dictionary-confirmed IDs may be looked up');
  failure = true; await assert.rejects(() => service.getOptionsSnapshot(address), /details unavailable/);
  failure = false; malformed = true; await assert.rejects(() => service.getOptionsSnapshot(address), /continuation/);
  malformed = false; ids = [];
  assert.deepEqual((await service.getOptionsSnapshot(address)).series, []);
  await assert.rejects(() => service.getOptionsSnapshot(address, { afterId: (1n << 64n).toString() }), /Invalid/);
  console.log('options catalog: exact sparse pages, missing-details failure, malformed cursor and empty catalog passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
