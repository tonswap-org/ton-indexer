import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { beginCell, Cell } from '@ton/core';
import { loadConfig } from '../config';
import type { TonDataSource } from '../data/dataSource';
import { SingleRootBocValidationCache } from '../data/freshBocValidation';
import { assertFreshReadBatch, type FreshReadBatch, type FreshReadCall } from '../data/freshRead';
import { ResilientTonDataSource } from '../data/resilientSource';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';

const boc = (value: number) => beginCell().storeUint(value, 32).endCell().toBoc().toString('base64');
const charge = (value: string) => 2 * value.length + 64;
function countingCache(maxEntries = 2, maxRetainedBytes = 4096) {
  let parses = 0;
  const limits = { maxEntries, maxRetainedBytes };
  const cache = new SingleRootBocValidationCache(limits, bytes => { parses++; return Cell.fromBoc(bytes); });
  return { cache, limits, parses: () => parses };
}

function parseFactsAndEviction() {
  const a = boc(1), b = boc(2), c = boc(3);
  const counted = countingCache();
  assert.equal(counted.cache.hasSingleRoot(a), true);
  assert.equal(counted.cache.hasSingleRoot(a), true);
  assert.equal(counted.parses(), 1, 'Exactly equal original bytes parse once');
  assert.equal(counted.cache.hasSingleRoot(b), true);
  assert.equal(counted.parses(), 2, 'One changed cell bit is a new parse fact');
  counted.cache.hasSingleRoot(a); counted.cache.hasSingleRoot(c); counted.cache.hasSingleRoot(a);
  assert.equal(counted.parses(), 3, 'A hit moves the exact content to the LRU front');
  counted.cache.hasSingleRoot(b);
  assert.equal(counted.parses(), 4, 'The least recently used content is parsed again after count eviction');
  const bytes = countingCache(64, charge(a) + charge(b) - 1);
  bytes.cache.hasSingleRoot(a); bytes.cache.hasSingleRoot(b); bytes.cache.hasSingleRoot(a);
  assert.equal(bytes.parses(), 3, 'Retained-key byte budget evicts even below the entry-count cap');
  const oversized = countingCache(64, charge(a) - 1);
  oversized.cache.hasSingleRoot(a); oversized.cache.hasSingleRoot(a);
  assert.equal(oversized.parses(), 2, 'Valid oversized BOCs remain accepted but are never retained');
  const immutableLimits = countingCache(1, 4096);
  immutableLimits.limits.maxEntries = 1000;
  immutableLimits.cache.hasSingleRoot(a); immutableLimits.cache.hasSingleRoot(b); immutableLimits.cache.hasSingleRoot(a);
  assert.equal(immutableLimits.parses(), 3, 'Caller mutation cannot enlarge the retained budget');
  for (const limits of [{ maxEntries: 0, maxRetainedBytes: 100 }, { maxEntries: 1, maxRetainedBytes: 0 },
    { maxEntries: 1.1, maxRetainedBytes: 100 }, { maxEntries: 1, maxRetainedBytes: Number.NaN }])
    assert.throws(() => new SingleRootBocValidationCache(limits), /positive integers/);
}

function failuresNeverRetained() {
  const counted = countingCache();
  const valid = boc(8), malformed = Buffer.from([0xde, 0xad]).toString('base64');
  for (let index = 0; index < 2; index++) assert.throws(() => counted.cache.hasSingleRoot(malformed));
  assert.equal(counted.parses(), 2, 'Malformed parser outcomes never become cached success');
  assert.equal(counted.cache.hasSingleRoot(valid + '\n'), false);
  assert.equal(counted.cache.hasSingleRoot(valid.slice(0, -1)), false);
  assert.equal(counted.parses(), 2, 'Noncanonical encodings fail before parser reuse');
  // Authentic BOC framing with two empty roots, no index and no CRC.
  const multiple = Buffer.from('b5ee9c72010102020004000100000000', 'hex');
  assert.equal(Cell.fromBoc(multiple).length, 2);
  assert.equal(counted.cache.hasSingleRoot(multiple.toString('base64')), false);
  assert.equal(counted.cache.hasSingleRoot(multiple.toString('base64')), false);
  assert.equal(counted.parses(), 4, 'A valid multiple-root container never supplies a single-root certificate');
  assert.equal(counted.cache.hasSingleRoot(valid), true);
  assert.equal(counted.parses(), 5, 'A prior failed spelling cannot certify changed bytes');
}

async function actualFreshLayers() {
  const address = `0:${'1'.repeat(64)}`;
  const calls: FreshReadCall[] = [{ kind: 'account', address }];
  let codeBoc = boc(90), dataBoc = boc(91), balance = '1';
  let stale = false, wrongNetwork = false, invalidHead = false;
  let invalidAddress = false, invalidKind = false, invalidCount = false;
  let lastTxLt: string | undefined, lastTxHash: string | undefined;
  const primary: TonDataSource = {
    network: 'testnet',
    async readFresh(requested) {
      const startedAt = Date.now();
      const batch: FreshReadBatch = { network: wrongNetwork ? 'mainnet' : 'testnet',
        readContext: { source: 'lite', queriedAt: startedAt - (stale ? 60_000 : 0),
          head: { workchain: -1, shard: '-9223372036854775808', seqno: invalidHead ? -1 : 123,
            rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) } },
        results: invalidCount ? [] : invalidKind ? [{ kind: 'getter', address, exitCode: 0, stack: [] }] :
          [{ kind: 'account', address: invalidAddress ? `0:${'2'.repeat(64)}` : address,
            state: { accountState: 'active', balance, codeBoc, dataBoc, lastTxLt, lastTxHash } }] };
      assertFreshReadBatch(batch, requested, 'testnet', startedAt); // Actual source's first boundary.
      return batch;
    },
    async getMasterchainInfo() { return { seqno: 1 }; }, async getAccountState() { throw Error('ordinary state forbidden'); },
    async getTransactions() { return []; }, async runGetMethod() { throw Error('ordinary getter forbidden'); },
    async getJettonBalance() { return null; }, async getJettonMetadata() { return null; }, async close() {},
  };
  const fallback = { ...primary, readFresh: undefined };
  const config = { ...loadConfig(), network: 'testnet' as const };
  const service = new IndexerService(config, new MemoryStore(config), new ResilientTonDataSource(primary, fallback), loadOpcodes(), []);
  const original = Cell.fromBoc;
  let parses = 0;
  const parser = mock.method(Cell, 'fromBoc', (bytes: Buffer) => { parses++; return original(bytes); });
  try {
    const first = await service.readFresh(calls);
    assert.equal(parses, 2, 'Source, Resilient and Indexer validators parse each exact code/data BOC once in total');
    assert.equal(first.results[0].kind === 'account' && first.results[0].balance_raw, '1');
    balance = '987654321'; lastTxLt = '42'; lastTxHash = Buffer.alloc(32, 7).toString('base64');
    const current = await service.readFresh(calls);
    assert.equal(parses, 2);
    assert.equal(current.results[0].kind === 'account' && current.results[0].balance_raw, balance, 'Current financial state is never cached');
    assert.equal(current.results[0].kind === 'account' && current.results[0].last_tx_lt, '42');
    codeBoc = boc(92); await service.readFresh(calls);
    assert.equal(parses, 3, 'A changed original code BOC cannot reuse another content certificate');
    stale = true; await assert.rejects(service.readFresh(calls)); stale = false;
    wrongNetwork = true; await assert.rejects(service.readFresh(calls)); wrongNetwork = false;
    invalidHead = true; await assert.rejects(service.readFresh(calls)); invalidHead = false;
    balance = '-1'; await assert.rejects(service.readFresh(calls)); balance = '1';
    lastTxHash = undefined; await assert.rejects(service.readFresh(calls));
    lastTxHash = Buffer.alloc(32, 7).toString('base64');
    invalidAddress = true; await assert.rejects(service.readFresh(calls)); invalidAddress = false;
    invalidKind = true; await assert.rejects(service.readFresh(calls)); invalidKind = false;
    invalidCount = true; await assert.rejects(service.readFresh(calls)); invalidCount = false;
    assert.equal(parses, 3, 'Existing content certificates never bypass current network, head, query time, balance, pointer or result identity gates');
    dataBoc = Buffer.from([0xde, 0xad]).toString('base64'); lastTxLt = undefined; lastTxHash = undefined;
    await assert.rejects(service.readFresh(calls)); await assert.rejects(service.readFresh(calls));
    assert.equal(parses, 5, 'Invalid changed data is rejected and parsed again rather than retained');
  } finally { parser.mock.restore(); }
}

async function main() {
  parseFactsAndEviction(); failuresNeverRetained(); await actualFreshLayers();
  console.log('fresh BOC exact-content certificates, strict fresh gates and bounded eviction ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
