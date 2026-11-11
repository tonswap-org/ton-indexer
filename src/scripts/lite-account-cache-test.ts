import assert from 'node:assert/strict';
import { Address, beginCell, type Cell } from '@ton/core';
import { LiteClient, type LiteEngine } from 'ton-lite-client';
import type { ClientAccountState } from 'ton-lite-client/dist/types';
import { createLiteClientCache, LiteAccountCache, liteAccountLoaderCache } from '../data/liteAccountCache';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const state = (bytes: number, code?: Cell, data?: Cell): ClientAccountState => ({
  raw: Buffer.alloc(bytes), proof: Buffer.alloc(bytes), shardProof: Buffer.alloc(bytes),
  state: code || data ? { storage: { state: { type: 'active', state: { code, data } } } } : null,
  balance: { coins: 17n }, lastTx: null,
} as ClientAccountState);

async function main() {
  assert.throws(() => new LiteAccountCache({ entries: 0, rawBytes: 10, cells: 10 }), /positive/);
  const cache = new LiteAccountCache({ entries: 2, rawBytes: 12, cells: 4 });
  const a = deferred<ClientAccountState>(), b = deferred<ClientAccountState>(), c = deferred<ClientAccountState>();
  cache.set('a', a.promise).set('b', b.promise);
  assert.equal(cache.get('a'), a.promise, 'Concurrent callers share the original promise');
  cache.set('c', c.promise);
  assert.equal(cache.get('b'), undefined, 'Least recently used pending entry is evicted');
  b.resolve(state(4)); await b.promise; await tick();
  assert.equal(cache.get('b'), undefined, 'Late settlement cannot reinsert an evicted read');
  assert.equal(cache.retainedRawBytes, 0);
  a.resolve(state(2)); c.resolve(state(3)); await tick();
  assert.equal(cache.get('a'), undefined, 'Settled bytes trigger LRU eviction, independently of entry count');
  assert.equal(cache.get('c'), c.promise);
  assert.equal(cache.retainedRawBytes, 9);
  assert.equal((await c.promise).balance.coins, 17n, 'Eviction does not alter callers results');

  const oversized = Promise.resolve(state(5)); cache.set('large', oversized); await tick();
  assert.equal(cache.get('large'), undefined);
  assert.equal(cache.get('c'), c.promise, 'An oversized result does not displace admissible settled entries');
  assert.equal((await oversized).raw.length, 5, 'An oversized result remains available to its caller');

  const old = deferred<ClientAccountState>(), replacement = deferred<ClientAccountState>();
  cache.clear(); cache.set('same', old.promise).set('same', replacement.promise);
  old.resolve(state(4)); await tick();
  assert.equal(cache.get('same'), replacement.promise);
  assert.equal(cache.retainedRawBytes, 0, 'Replaced pending settlement cannot charge its successor');
  replacement.resolve(state(2)); await tick(); assert.equal(cache.retainedRawBytes, 6);
  cache.delete('same'); assert.equal(cache.retainedRawBytes, 0);

  const pending = deferred<ClientAccountState>(); cache.set('clear', pending.promise); cache.clear();
  pending.resolve(state(4)); await tick(); assert.equal(cache.size, 0); assert.equal(cache.retainedRawBytes, 0);
  const rejected = deferred<ClientAccountState>(); cache.set('failure', rejected.promise);
  const error = new Error('original wire failure'); rejected.reject(error);
  await assert.rejects(rejected.promise, failure => failure === error); await tick();
  assert.equal(cache.get('failure'), undefined, 'A failed wire does not poison future reads');

  const leaf = beginCell().storeUint(1, 8).endCell();
  const parent = beginCell().storeRef(leaf).endCell();
  const other = beginCell().storeRef(beginCell().storeUint(2, 8).endCell()).storeRef(parent).endCell();
  const cells = new LiteAccountCache({ entries: 8, rawBytes: 100, cells: 4 });
  const shared = Promise.resolve(state(1, parent, parent)); cells.set('shared', shared); await tick();
  assert.equal(cells.retainedCells, 2, 'Shared code/data DAG nodes count once per retained account');
  const different = Promise.resolve(state(1, other)); cells.set('different', different); await tick();
  assert.equal(cells.get('shared'), undefined, 'Decoded graph limit evicts old states even when raw bytes are small');
  assert.equal(cells.retainedCells, 4); assert.equal(cells.retainedRawBytes, 3);
  const tooMany = Promise.resolve(state(1, beginCell().storeRef(other).endCell())); cells.set('too-many', tooMany); await tick();
  assert.equal(cells.get('too-many'), undefined); assert.equal(cells.get('different'), different);
  cells.clear(); assert.equal(cells.retainedCells, 0); assert.equal(cells.retainedRawBytes, 0);

  // Exercise the installed SDK's actual DataLoader cache contract and block keys.
  const accountMap = new LiteAccountCache({ entries: 2, rawBytes: 100, cells: 4 });
  const client = new LiteClient({ engine: {} as LiteEngine, cacheMap: kind => {
    return kind === 'account' ? liteAccountLoaderCache(accountMap) : createLiteClientCache(kind);
  } });
  let calls = 0;
  client.getAccountStateRaw = async () => { calls++; return state(1); };
  const address = Address.parseRaw('0:' + '1'.repeat(64));
  const block = (seqno: number) => ({ seqno, workchain: -1, shard: '-9223372036854775808', rootHash: Buffer.alloc(32, seqno), fileHash: Buffer.alloc(32, seqno) });
  const pair = await Promise.all([client.getAccountState(address, block(1)), client.getAccountState(address, block(1))]);
  assert.equal(calls, 1); assert.equal(pair[0], pair[1]);
  await client.getAccountState(address, block(2)); assert.equal(calls, 2, 'A newer block is independently queried');
  await client.getAccountState(address, block(3)); assert.equal(calls, 3);
  await client.getAccountState(address, block(1)); assert.equal(calls, 4, 'Evicted historical key is queried again, never replaced by current state');
  assert.equal(accountMap.size, 2);

  for (const replacementSettled of [false, true]) {
    const oldWire = deferred<ClientAccountState>(), newWire = deferred<ClientAccountState>();
    const owned = new LiteAccountCache({ entries: 1, rawBytes: 100, cells: 4 });
    const sdk = new LiteClient({ engine: {} as LiteEngine, cacheMap: kind =>
      kind === 'account' ? liteAccountLoaderCache(owned) : createLiteClientCache(kind) });
    const dispatched: number[] = [];
    sdk.getAccountStateRaw = async (_address, block) => {
      dispatched.push(block.seqno);
      if (block.seqno === 2) return state(1);
      return dispatched.length === 1 ? oldWire.promise : newWire.promise;
    };
    const oldRead = sdk.getAccountState(address, block(1));
    const rejectedOld = assert.rejects(oldRead, /original failed batch/);
    await tick(); await sdk.getAccountState(address, block(2));
    const newer = sdk.getAccountState(address, block(1)); await tick();
    if (replacementSettled) { newWire.resolve(state(2)); await newer; await tick(); }
    oldWire.reject(new Error('original failed batch')); await rejectedOld; await tick();
    const join = sdk.getAccountState(address, block(1)); await tick();
    assert.deepEqual(dispatched, [1, 2, 1], 'SDK late key-only failure-clear cannot evict a replacement');
    if (!replacementSettled) newWire.resolve(state(2));
    assert.equal(await join, await newer);
    assert.equal(owned.size, 1); assert.equal(owned.retainedRawBytes, 6);
  }

  const failureCache = new LiteAccountCache();
  const failing = new LiteClient({ engine: {} as LiteEngine, cacheMap: kind =>
    kind === 'account' ? liteAccountLoaderCache(failureCache) : createLiteClientCache(kind) });
  let attempts = 0;
  failing.getAccountStateRaw = async () => {
    if (++attempts === 1) throw Error('current failed batch');
    return state(1);
  };
  await assert.rejects(failing.getAccountState(address, block(1)), /current failed batch/); await tick();
  assert.equal(failureCache.size, 0);
  await failing.getAccountState(address, block(1)); assert.equal(attempts, 2, 'Current failure remains retryable');
  console.log('PASS bounded LiteClient pending/account/byte/graph retention and exact-block cache behavior');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
